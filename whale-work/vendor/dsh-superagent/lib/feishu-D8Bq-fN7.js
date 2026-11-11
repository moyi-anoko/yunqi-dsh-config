import { I as key, J as threadKey, S as FeishuBotSchema, a as polled, b as validItems, c as sourceContext, i as pollThreads$1, j as checkedImText, n as cursorAt, o as KV, s as health, v as CliError } from "./poll-BZfc2pr3.js";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region src/sources/feishu-image.ts
/** Downloads Feishu message images and commits them as model-visible attachments during assessment. */
/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
function admissionImageKeys(text) {
	return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])];
}
async function readAdmissionImage(agent, commands, ref, text, imageKey, stateDir, signal) {
	if (!admissionImageKeys(text).includes(imageKey)) throw new Error("Choose an image key from this source message");
	const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId);
	const attachments = agent.ctx.get("attachments");
	if (!attachments) throw new Error("Image reading is unavailable: no attachment service is mounted");
	const route = agent.session.requestHeader()?.config;
	const provider = route?.provider ?? agent.options.provider;
	const model = route?.model ?? agent.options.model;
	const llm = agent.ctx.get("llm");
	if (!llm || !provider || !model) throw new Error("Image reading is unavailable: the current model route is unresolved");
	if (!(await llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes("image")) throw new Error(`Model ${model} does not support image input; the image has not been inspected`);
	signal.throwIfAborted();
	const directory = await mkdtemp(join(stateDir, "admission-image-"));
	try {
		const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
			"im",
			"+messages-resources-download",
			"--message-id",
			messageId,
			"--file-key",
			imageKey,
			"--type",
			"image",
			"--output",
			"./image"
		], directory));
		const path = await realpath(result.saved_path);
		if (dirname(path) !== await realpath(directory)) throw new Error("Image download returned a path outside its temporary directory");
		const mediaType = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".webp": "image/webp",
			".gif": "image/gif"
		}[extname(path).toLowerCase()];
		if (!mediaType) throw new Error("The downloaded resource is not a supported PNG/JPEG/WebP/GIF image");
		const file = await stat(path);
		if (!file.isFile() || file.size > Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)) throw new Error("The image exceeds the deployment byte limit or is not a regular file");
		const data = await readFile(path, { signal });
		signal.throwIfAborted();
		const image = await attachments.saveImage({
			data,
			mediaType,
			name: `${imageKey}${extname(path)}`
		});
		signal.throwIfAborted();
		return {
			source_message_id: messageId,
			image_key: imageKey,
			image
		};
	} finally {
		await rm(directory, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region src/sources/feishu-trigger.ts
/** Normalizes Feishu live events, chat history items, and topic replies into domain Triggers. */
const SOURCE = "feishu";
/** Constructs a Feishu reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
const feishuChannel = (chatId, messageId, direct = false) => ({
	source: SOURCE,
	thread: `feishu:${chatId}`,
	address: {
		chatId,
		messageId,
		...direct ? { direct: "true" } : {}
	}
});
/** A message as the live event consumer prints it; the history and topic-page paths normalize what they read into this shape. */
const EventSchema = z.object({
	message_id: z.string(),
	chat_id: z.string(),
	chat_type: z.enum(["p2p", "group"]),
	sender_id: z.string(),
	sender_type: z.enum(["user", "bot"]),
	content: z.string(),
	create_time: z.string(),
	mentions: z.array(z.object({
		id: z.string(),
		key: z.string().optional(),
		name: z.string().optional()
	})).default([]),
	root_id: z.string().optional(),
	parent_id: z.string().optional(),
	thread_id: z.string().optional(),
	message_app_link: z.url().optional()
});
const feishuThreadId = (chatId, rootId, messageId) => `${chatId}:${rootId ?? messageId}`;
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
const feishuTriggerId = (messageId) => key("feishu", messageId);
const withMentionNames = (text, mentions) => mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text);
/**
* Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
* string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
*/
function feishuTime(value) {
	const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
	if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`);
	return new Date(time).toISOString();
}
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
function feishuTrigger(input, botId, botAppId) {
	const event = EventSchema.parse(input);
	if (event.sender_id === botId || event.sender_id === botAppId) return;
	const direct = event.chat_type === "p2p";
	const mentioned = event.mentions.some((mention) => mention.id === botId || mention.id === botAppId);
	const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id);
	return {
		id: feishuTriggerId(event.message_id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: thread
		}],
		actor: {
			source: SOURCE,
			id: event.sender_id
		},
		human: event.sender_type === "user",
		...direct ? { addressed: "direct" } : mentioned ? { addressed: "mention" } : {},
		at: feishuTime(event.create_time),
		text: withMentionNames(event.content, event.mentions),
		channel: feishuChannel(event.chat_id, event.message_id, direct),
		...event.message_app_link ? { url: event.message_app_link } : {},
		meta: {
			chatId: event.chat_id,
			messageId: event.message_id,
			direct,
			mentioned,
			...event.root_id ? { rootId: event.root_id } : {},
			...event.parent_id ? { parentId: event.parent_id } : {},
			...event.thread_id ? { threadId: event.thread_id } : {}
		}
	};
}
function feishuRef(trigger) {
	const meta = trigger.meta;
	if (trigger.source !== "feishu" || !meta.chatId || !meta.messageId) return void 0;
	return {
		triggerId: trigger.id,
		chatId: meta.chatId,
		messageId: meta.messageId,
		at: trigger.at
	};
}
/** A message from the history API; a deleted message may have no body/content. */
const HistoricalMessageSchema = z.looseObject({
	message_id: z.string(),
	chat_id: z.string(),
	create_time: z.string(),
	root_id: z.string().optional(),
	parent_id: z.string().optional(),
	thread_id: z.string().optional(),
	deleted: z.boolean().optional(),
	message_app_link: z.string().optional(),
	sender: z.looseObject({
		id: z.string().default(""),
		sender_type: z.string()
	}),
	body: z.looseObject({ content: z.string() }).optional(),
	mentions: z.array(z.looseObject({
		id: z.string(),
		key: z.string().optional(),
		name: z.string().optional()
	})).optional()
});
/** One page of the history API; items are validated individually so an unreadable item is skipped alone. */
const HistoryPageSchema = z.looseObject({
	items: z.array(z.unknown()).default([]),
	has_more: z.boolean().default(false),
	page_token: z.string().optional()
});
function historyText(message) {
	let content;
	try {
		content = JSON.parse(message.body?.content ?? "");
	} catch {
		content = message.body?.content ?? "";
	}
	const plain = content && typeof content === "object" && "text" in content && typeof content.text === "string" ? content.text : void 0;
	return typeof content === "string" ? content : plain ?? JSON.stringify(content);
}
function historyEvent(message, chatId, direct) {
	return {
		message_id: message.message_id,
		chat_id: chatId,
		chat_type: direct ? "p2p" : "group",
		create_time: message.create_time,
		sender_id: message.sender.id,
		sender_type: message.sender.sender_type === "user" ? "user" : "bot",
		content: historyText(message),
		mentions: message.mentions ?? [],
		root_id: message.root_id,
		parent_id: message.parent_id,
		thread_id: message.thread_id,
		message_app_link: message.message_app_link
	};
}
/**
* Adapts a topic-page message into the live-event schema, falling back to `root` when Feishu omits `root_id` on replies;
* an app's message carries its bot's `open_bot_id`, and a deleted message may have no content.
*/
function topicEvent(message, chatId, direct, root) {
	return {
		message_id: message.message_id,
		chat_id: chatId,
		chat_type: direct ? "p2p" : "group",
		create_time: message.create_time,
		sender_id: message.sender.open_bot_id ?? message.sender.id,
		sender_type: message.sender.sender_type === "user" ? "user" : "bot",
		content: message.content ?? "",
		mentions: message.mentions ?? [],
		parent_id: message.parent_id,
		thread_id: message.thread_id,
		root_id: message.root_id ?? (message.message_id === root ? void 0 : root),
		message_app_link: message.message_app_link
	};
}
//#endregion
//#region src/sources/feishu-read.ts
/** Trigger-scoped Feishu context reader; retrieved messages are returned for model inspection without entering intake. */
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/);
const sourceSchema = z.object({
	message_id: messageId,
	chat_id: z.string(),
	root_id: messageId.optional(),
	parent_id: messageId.optional(),
	thread_id: z.string().regex(/^omt?_[a-zA-Z0-9_-]+$/).optional(),
	deleted: z.boolean().optional()
});
const messageSchema = z.object({
	message_id: messageId,
	chat_id: z.string(),
	content: z.string().optional(),
	msg_type: z.string(),
	sender: z.object({
		id: z.string(),
		name: z.string().optional(),
		open_bot_id: z.string().optional(),
		sender_type: z.string()
	}),
	create_time: z.string(),
	update_time: z.string().optional(),
	updated: z.boolean().optional(),
	deleted: z.boolean().optional(),
	mentions: z.array(z.object({
		id: z.string(),
		name: z.string().optional(),
		key: z.string().optional()
	})).optional(),
	message_app_link: z.string().optional(),
	thread_id: z.string().optional(),
	root_id: z.string().optional(),
	parent_id: z.string().optional()
});
/** A topic page; messages are validated individually so an unreadable item is skipped alone and counted. */
const threadSchema = z.object({
	messages: z.array(z.unknown()),
	has_more: z.boolean(),
	page_token: z.string().optional(),
	thread_id: z.string()
});
/** Reads the CLI-provided AppLink for the source message alone, without retaining expanded thread content. */
async function readFeishuLink(commands, ref) {
	const id = messageId.parse(ref.messageId);
	const message = z.object({ messages: z.array(z.object({
		message_id: messageId,
		chat_id: z.string(),
		message_app_link: z.url().optional(),
		deleted: z.boolean().optional()
	})) }).parse(await commands.lark([
		"im",
		"+messages-mget",
		"--message-ids",
		id,
		"--no-reactions"
	])).messages.find((item) => item.message_id === id);
	if (!message || message.deleted || message.chat_id !== ref.chatId || !message.message_app_link) throw new Error("Source message link unavailable");
	return message.message_app_link;
}
/** Resource references are anchored to an accepted trigger instead of arbitrary chat or message IDs. */
function feishuReferences(ref) {
	const read = (section) => `feishu/${ref.triggerId}/${section}`;
	return {
		skill: "dsh-superagent-feishu",
		message: read("message"),
		root: read("root"),
		parent: read("parent"),
		thread: read("thread"),
		around: read("around")
	};
}
/** Validates a model-supplied resource string before any network request; only `thread` and `around` take pagination cursors. */
function feishuResource(resource) {
	const match = /^feishu\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource);
	if (!match || match[3] && match[2] !== "thread" && match[2] !== "around") throw new Error("Use feishu/<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page");
	return {
		triggerId: match[1],
		section: match[2],
		cursor: match[3] ? decodeURIComponent(match[3]) : void 0
	};
}
async function sourceOf(commands, ref) {
	const id = messageId.parse(ref.messageId);
	const params = JSON.stringify({ message_ids: [id] });
	const listed = await commands.lark([
		"api",
		"GET",
		"/open-apis/im/v1/messages/mget",
		"--params",
		params
	]);
	const source = z.object({ items: z.array(sourceSchema) }).parse(listed).items.find((message) => message.message_id === id);
	if (!source || source.deleted) throw new Error("The source Feishu message is unavailable or deleted; retained trigger text is still readable");
	if (source.chat_id !== ref.chatId) throw new Error("Feishu source chat does not match the accepted trigger");
	return source;
}
/** Fetches one message or a bounded topic page of a Trigger's source message with explicit pagination continuation. */
async function readFeishu(commands, ref, resource, pageSize, order = "asc") {
	const request = feishuResource(resource);
	if (request.triggerId !== ref.triggerId) throw new Error("A Feishu source trigger is required");
	if (request.section === "around") throw new Error("The chat around a message is read with feishuRead");
	const source = await sourceOf(commands, ref);
	if (request.section === "thread") {
		if (!source.thread_id) return {
			status: "no_thread",
			messages: [],
			next_resource: null
		};
		const args = [
			"im",
			"+threads-messages-list",
			"--thread",
			source.thread_id,
			"--order",
			order,
			"--page-size",
			String(pageSize),
			"--no-reactions"
		];
		if (request.cursor) args.push("--page-token", request.cursor);
		const result = threadSchema.parse(await commands.lark(args));
		const tally = { skipped: 0 };
		const messages = validItems(messageSchema, result.messages, tally);
		const outside = messages.some((message) => message.chat_id !== source.chat_id || message.thread_id && message.thread_id !== source.thread_id);
		if (result.thread_id !== source.thread_id || outside) throw new Error("Feishu returned messages outside the source thread");
		if (result.has_more && (!result.page_token || result.page_token === request.cursor)) throw new Error("Feishu thread pagination did not advance; history is incomplete");
		return {
			status: "available",
			thread_id: result.thread_id,
			messages,
			...tally.skipped ? { skipped: tally.skipped } : {},
			next_resource: result.has_more ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(result.page_token)}` : null
		};
	}
	const target = request.section === "root" ? source.root_id : request.section === "parent" ? source.parent_id : source.message_id;
	if (!target) return {
		status: `no_${request.section}`,
		message: null
	};
	const message = z.object({ messages: z.array(messageSchema) }).parse(await commands.lark([
		"im",
		"+messages-mget",
		"--message-ids",
		target,
		"--no-reactions"
	])).messages.find((message) => message.message_id === target);
	if (!message) throw new Error("The requested Feishu message is unavailable; do not infer its contents");
	if (message.chat_id !== source.chat_id) throw new Error("Feishu returned a message outside the source chat");
	return {
		status: message.deleted ? "deleted" : "available",
		message
	};
}
function isoTime(value) {
	try {
		return feishuTime(value);
	} catch {
		return value;
	}
}
function feishuView(message) {
	return {
		id: message.message_id,
		from: message.sender.name || message.sender.id,
		at: isoTime(message.create_time),
		text: message.deleted ? "" : withMentionNames(message.content ?? "", message.mentions ?? []),
		...message.sender.sender_type !== "user" ? { bot: true } : {},
		...message.deleted ? { deleted: true } : {},
		...message.parent_id ? { reply_to: message.parent_id } : {},
		...message.message_app_link ? { url: message.message_app_link } : {}
	};
}
/** Formats a chat history API message for model inspection; the history API identifies senders by `open_id` only. */
function historyView(message) {
	return {
		id: message.message_id,
		from: message.sender.id,
		at: isoTime(message.create_time),
		text: message.deleted ? "" : withMentionNames(historyText(message), message.mentions ?? []),
		...message.sender.sender_type !== "user" ? { bot: true } : {},
		...message.deleted ? { deleted: true } : {},
		...message.parent_id ? { reply_to: message.parent_id } : {},
		...message.message_app_link ? { url: message.message_app_link } : {}
	};
}
/** Reads chat messages surrounding `ref.at` (five before and five after on initial read, then pages of ten older messages). */
async function chatAround(commands, ref, cursor, before = 5, after = 5) {
	const time = Date.parse(ref.at ?? "");
	if (!Number.isFinite(time)) throw new Error("The source Feishu message has no time to read the chat around");
	const list = async (parameters) => {
		const params = JSON.stringify({
			container_id_type: "chat",
			container_id: ref.chatId,
			...parameters
		});
		const page = HistoryPageSchema.parse(await commands.lark([
			"api",
			"GET",
			"/open-apis/im/v1/messages",
			"--params",
			params
		]));
		return {
			...page,
			items: validItems(HistoricalMessageSchema, page.items).filter((item) => item.chat_id === ref.chatId)
		};
	};
	const earlier = await list({
		end_time: String(Math.ceil(time / 1e3)),
		sort_type: "ByCreateTimeDesc",
		page_size: cursor ? 10 : before + 1,
		...cursor ? { page_token: cursor } : {}
	});
	const later = cursor || !after ? [] : (await list({
		start_time: String(Math.floor(time / 1e3)),
		sort_type: "ByCreateTimeAsc",
		page_size: after + 1
	})).items;
	const seen = /* @__PURE__ */ new Set();
	return {
		status: "available",
		messages: [...earlier.items.reverse(), ...later].filter((item) => !seen.has(item.message_id) && seen.add(item.message_id)).map(historyView),
		next_resource: earlier.has_more && earlier.page_token && earlier.page_token !== cursor ? `feishu/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token)}` : null
	};
}
async function feishuRead(commands, ref, resource, pageSize) {
	const request = feishuResource(resource);
	if (request.section === "around") {
		if (request.triggerId !== ref.triggerId) throw new Error("A Feishu source trigger is required");
		await sourceOf(commands, ref);
		return chatAround(commands, ref, request.cursor);
	}
	const result = await readFeishu(commands, ref, resource, pageSize);
	if ("messages" in result) return {
		...result,
		messages: result.messages.map(feishuView)
	};
	return {
		status: result.status,
		message: result.message ? feishuView(result.message) : null
	};
}
function sourceRef(trigger) {
	const ref = feishuRef(trigger);
	if (!ref) throw new Error("A Feishu source trigger is required");
	return ref;
}
const feishuThreadContext = {
	messageId: (trigger) => String(trigger.meta.messageId ?? ""),
	read: async (commands, trigger, part, cursor, config) => {
		const ref = sourceRef(trigger);
		const body = await feishuRead(commands, ref, `feishu/${trigger.id}/${part}${cursor ? "/" + encodeURIComponent(cursor) : ""}`, config.readPageSize);
		if (part === "thread" && body.status === "no_thread") {
			const around = await chatAround(commands, ref, void 0, 5, 0);
			return {
				messages: around.messages,
				body: {
					status: "chat_neighbours",
					messages: around.messages
				},
				status: "chat_neighbours"
			};
		}
		return {
			messages: "messages" in body ? body.messages : body.message ? [body.message] : [],
			next: "next_resource" in body && body.next_resource ? decodeURIComponent(body.next_resource.split("/").at(-1)) : void 0,
			body: { ...body },
			status: body.status
		};
	},
	images: admissionImageKeys,
	image: (agent, commands, trigger, message, key, stateDir, signal) => readAdmissionImage(agent, commands, {
		...sourceRef(trigger),
		messageId: message.id
	}, message.text, key, stateDir, signal)
};
//#endregion
//#region src/sources/feishu-channel.ts
/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
const feishuChatLink = (brand, chatId) => `https://applink.${brand === "lark" ? "larksuite.com" : "feishu.cn"}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
/**
* True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
* Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
*/
const gone = (error) => error instanceof CliError && error.code !== void 0 && (error.code === 230011 || /withdrawn/i.test(error.message) || Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message));
/** Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
async function sendFeishu(host, message) {
	const messageId = message.channel.address.messageId;
	if (!messageId) throw new Error("Missing Feishu reply target");
	const reply = [
		"im",
		"+messages-reply",
		"--message-id",
		messageId,
		"--markdown",
		checkedImText(message.text),
		"--reply-in-thread",
		"--idempotency-key",
		message.id
	];
	let data;
	try {
		data = await host.commands.lark(reply);
	} catch (error) {
		if (gone(error)) return { outcome: "gone" };
		throw error;
	}
	return {
		outcome: "sent",
		...data?.message_id ? { externalId: data.message_id } : {}
	};
}
/**
* Looks up a previously sent reply by the Feishu message ID kept on its effect.
* Without one the channel cannot tell whether an ambiguous reply landed, so it reports `unsupported` and the caller retries idempotently.
*/
async function queryFeishu(host, _message, externalId) {
	if (!externalId) return { outcome: "unsupported" };
	try {
		return (await host.commands.lark([
			"im",
			"+messages-mget",
			"--message-ids",
			externalId,
			"--no-reactions"
		])).messages.find((item) => item.message_id === externalId && !item.deleted) ? {
			outcome: "sent",
			externalId
		} : { outcome: "absent" };
	} catch (error) {
		if (error instanceof CliError && error.code === 230001) return { outcome: "absent" };
		throw error;
	}
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
const feishuLink = (address, links) => ({
	url: feishuChatLink(links.feishu?.brand ?? "feishu", address.chatId ?? ""),
	label: {
		zh: "飞书消息",
		en: "Feishu message"
	},
	...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {}
});
//#endregion
//#region src/sources/feishu-loops.ts
/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
const runFeishu = (ctx, signal) => Promise.allSettled([
	watch,
	backfillLoop,
	chatNamesLoop
].map((loop) => loop(ctx, signal)));
const enabled = (ctx) => ctx.config(SOURCE);
const bot = (ctx) => {
	const resolved = ctx.deployment.feishu;
	if (!resolved) throw new Error("The Feishu Source has no working bot CLI");
	return resolved;
};
async function receive(ctx, trigger) {
	await ctx.receive(trigger);
	const chatId = String(trigger.meta.chatId ?? "");
	if (!chatId) return;
	const name = ctx.state.get(KV.sources.labels("feishu"))?.[chatId] ?? chatId;
	const chat = trigger.meta.direct === true ? { value: {
		zh: "私聊",
		en: "Direct message"
	} } : { value: name };
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
		url: chatLink(ctx, chatId),
		facts: { chat }
	});
}
const chatLink = (ctx, chatId) => feishuChatLink(ctx.deployment.feishu?.brand ?? "feishu", chatId);
function available(ctx) {
	if (ctx.configured() && ctx.deployment.feishu) return true;
	const waiting = health("paused", ctx.configured() ? "feishuCliUnset" : "setupPending");
	ctx.report("feishu", ctx.problem ? {
		state: "paused",
		detail: ctx.problem.detail
	} : waiting);
	return false;
}
/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	let retry;
	while (!signal.aborted) {
		if (!enabled(ctx)) {
			ctx.report("feishu", health("paused", "sourceOff"));
			await setTimeout$1(5e3, void 0, { signal }).catch(() => {});
			continue;
		}
		const running = new AbortController();
		const check = setInterval(() => {
			if (!enabled(ctx)) running.abort();
		}, 5e3);
		const stop = () => running.abort();
		signal.addEventListener("abort", stop, { once: true });
		const began = Date.now();
		try {
			await consume(ctx, running.signal);
		} catch (error) {
			if (!running.signal.aborted) ctx.report("feishu", {
				state: "error",
				detail: String(error)
			});
		} finally {
			clearInterval(check);
			signal.removeEventListener("abort", stop);
		}
		if (running.signal.aborted) continue;
		retry = consumerRetry(retry, Date.now() - began);
		await setTimeout$1(retry, void 0, { signal }).catch(() => {});
	}
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
const consumerRetry = (previous, ranMs) => previous === void 0 || ranMs >= 6e4 ? 1e3 : Math.min(previous * 2, 6e4);
async function consume(ctx, signal) {
	const child = spawn(bot(ctx).cli, [
		"event",
		"consume",
		"im.message.receive_v1",
		"--as",
		"bot"
	], {
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		env: {
			...process.env,
			LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
			LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
		}
	});
	const stdout = createInterface({ input: child.stdout });
	const stderr = createInterface({ input: child.stderr });
	let chain = Promise.resolve();
	let diagnostic = "";
	let ready = false;
	const stop = () => {
		child.stdin.end();
		child.kill("SIGTERM");
	};
	signal.addEventListener("abort", stop, { once: true });
	const timeout = setTimeout(() => {
		diagnostic = "Feishu event consumer did not become ready within 45 seconds";
		stop();
	}, 45e3);
	stderr.on("line", (line) => {
		diagnostic = line.slice(0, 4e3);
		if (line.startsWith("[event] ready")) {
			ready = true;
			clearTimeout(timeout);
			ctx.report("feishu", {
				state: "ready",
				detail: "Listening for bot events",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
		} else if (/WARN|drop|error/.test(line)) ctx.report("feishu", {
			state: "error",
			detail: diagnostic
		});
	});
	stdout.on("line", (line) => {
		chain = chain.then(async () => {
			if (line.length > 1048576) throw new Error("Feishu event exceeds 1 MiB");
			const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId);
			if (!trigger || !enabled(ctx)) return;
			const chats = ctx.state.get(KV.feishu.chats) ?? {};
			chats[String(trigger.meta.chatId)] = trigger.meta.direct === true;
			ctx.state.set(KV.feishu.chats, chats);
			await receive(ctx, trigger);
		}).catch((error) => {
			ctx.report("feishu", {
				state: "error",
				detail: String(error)
			});
		});
	});
	try {
		await new Promise((resolve, reject) => {
			child.once("error", reject);
			const exited = (code) => /* @__PURE__ */ new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`);
			child.once("close", (code) => signal.aborted ? resolve() : reject(exited(code)));
		});
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", stop);
		stdout.close();
		stderr.close();
		await chain;
	}
}
/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
async function refreshChatNames(ctx, signal) {
	const commands = ctx.commands.withSignal(signal);
	const result = z.looseObject({ chats: z.array(z.looseObject({
		chat_id: z.string(),
		name: z.string().nullish()
	})).optional() }).parse(await commands.lark([
		"im",
		"+chat-list",
		"--page-all",
		"--page-size",
		"100"
	]));
	const names = Object.fromEntries((result.chats ?? []).filter((chat) => chat.name).map((chat) => [chat.chat_id, chat.name]));
	ctx.state.set(KV.sources.labels(SOURCE), names);
	return names;
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	while (!signal.aborted) {
		if (enabled(ctx)) try {
			await refreshChatNames(ctx, signal);
		} catch {}
		await setTimeout$1(6e4, void 0, { signal }).catch(() => {});
	}
}
async function backfillLoop(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) {
		ctx.report("history", health("paused", "feishuBotMissing"));
		return;
	}
	while (!signal.aborted) {
		const config = enabled(ctx);
		if (!config) {
			ctx.report("history", health("paused", "sourceOff"));
			await setTimeout$1(6e4, void 0, { signal }).catch(() => {});
			continue;
		}
		const seen = ctx.state.get(KV.feishu.chats) ?? {};
		const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages);
		const chats = {
			...Object.fromEntries(config.chats.map((chat) => [chat.chatId, false])),
			...Object.fromEntries(known)
		};
		const errors = [];
		const tally = { skipped: 0 };
		for (const [chatId, direct] of Object.entries(chats)) {
			if (signal.aborted) break;
			const started = (/* @__PURE__ */ new Date()).toISOString();
			const cursorKey = KV.feishu.history(chatId);
			const since = ctx.state.get(cursorKey);
			if (since === void 0) {
				ctx.state.set(cursorKey, started);
				continue;
			}
			try {
				await backfillChat(ctx, chatId, direct, since, started, signal, tally);
				if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started));
			} catch (error) {
				if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`);
			}
		}
		await pollThreads(ctx, signal, tally);
		const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : "";
		if (!signal.aborted) ctx.report("history", errors.length ? {
			state: "error",
			detail: errors.join("\n")
		} : {
			state: "ready",
			detail: `Configured groups and known direct chats recovered${skipped}`,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		await setTimeout$1(6e4, void 0, { signal }).catch(() => {});
	}
}
/**
* Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
* Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
*/
async function backfillChat(ctx, chatId, direct, since, until, signal, tally = { skipped: 0 }) {
	const commands = ctx.commands.withSignal(signal);
	const topicsKey = KV.feishu.topics(chatId);
	const topics = { ...ctx.state.get(topicsKey) };
	const scan = async (kind, id) => {
		let page;
		const pages = /* @__PURE__ */ new Set();
		do {
			if (signal.aborted) throw signal.reason;
			const seconds = (time) => String(Math.floor(Date.parse(time) / 1e3));
			const parameters = {
				container_id_type: kind,
				container_id: id,
				start_time: seconds(since),
				end_time: seconds(until),
				sort_type: "ByCreateTimeAsc",
				page_size: 50,
				...page ? { page_token: page } : {}
			};
			const request = [
				"api",
				"GET",
				"/open-apis/im/v1/messages",
				"--params",
				JSON.stringify(parameters)
			];
			const result = HistoryPageSchema.parse(await commands.lark(request));
			for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
				if (message.chat_id !== chatId || kind === "thread" && message.thread_id !== id) throw new Error("Feishu history returned a message outside the requested chat or thread");
				if (message.deleted) continue;
				const at = feishuTime(message.create_time);
				if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? "") >= Date.parse(at))) topics[message.thread_id] = at;
				const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId);
				if (trigger) await receive(ctx, trigger);
			}
			if (result.has_more && (!result.page_token || pages.has(result.page_token))) throw new Error("Feishu history pagination did not advance");
			page = result.has_more ? result.page_token : void 0;
			if (page) pages.add(page);
		} while (page);
	};
	await scan("chat", chatId);
	const followed = new Set(ctx.threads.subscribed(SOURCE).filter((thread) => polled(ctx, thread)).map((thread) => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? "")));
	for (const [id, seen] of Object.entries(topics)) if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= 12096e5) delete topics[id];
	ctx.state.set(topicsKey, topics);
	for (const id of Object.keys(topics)) await scan("thread", id);
	ctx.state.set(topicsKey, topics);
}
/** Resolves the retained source message reference for polling a subscribed thread. */
function threadRef(ctx, thread) {
	const meta = thread.meta;
	if (meta.chatId && meta.messageId && meta.sourceTriggerId) return {
		triggerId: meta.sourceTriggerId,
		chatId: meta.chatId,
		messageId: meta.messageId
	};
	const trigger = ctx.triggers.latest(thread.key);
	return trigger ? feishuRef(trigger) : void 0;
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
async function pollThreads(ctx, signal, tally) {
	await pollThreads$1(ctx, SOURCE, () => !!signal?.aborted, (thread) => pollThread(ctx, thread, signal, tally));
}
async function pollThread(ctx, thread, signal, tally) {
	const ref = threadRef(ctx, thread);
	if (!ref) throw new Error("Subscribed thread has no retained source message");
	const config = enabled(ctx);
	if (!config) return;
	const commands = ctx.commands.withSignal(signal);
	const pageSize = config.readPageSize;
	const checkpoint = KV.feishu.seen(thread.key);
	const known = new Set(ctx.state.get(checkpoint) ?? []);
	const initialized = ctx.state.get(KV.feishu.initialized(thread.key));
	if (!initialized) {
		for (const section of ["root", "parent"]) {
			const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize);
			if ("message" in result && result.message) known.add(result.message.message_id);
		}
		ctx.state.set(checkpoint, [...known]);
	}
	const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true;
	const since = Date.parse(thread.createdAt);
	const root = thread.ref.id.slice(thread.ref.id.indexOf(":") + 1);
	let resource = `feishu/${ref.triggerId}/thread`;
	while (resource) {
		if (signal?.aborted) return;
		const result = await readFeishu(commands, ref, resource, pageSize, "desc");
		if (!("messages" in result)) throw new Error("Expected Feishu thread messages");
		if (tally && "skipped" in result) tally.skipped += result.skipped ?? 0;
		if ("thread_id" in result && result.thread_id && thread.meta.threadId !== result.thread_id) ctx.threads.patch(thread.key, { threadId: result.thread_id });
		const encounteredKnown = result.messages.some((message) => known.has(message.message_id));
		const { botId, appId } = bot(ctx);
		for (const message of result.messages.filter((item) => !known.has(item.message_id) && !item.deleted).reverse()) {
			if (signal?.aborted) return;
			const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId);
			if (!trigger || !initialized && Date.parse(trigger.at) < since) continue;
			await receive(ctx, trigger);
		}
		result.messages.forEach((message) => known.add(message.message_id));
		ctx.state.set(checkpoint, [...known]);
		if (initialized && encounteredKnown) break;
		resource = result.next_resource;
	}
	ctx.state.set(KV.feishu.initialized(thread.key), true);
}
//#endregion
//#region src/sources/feishu.ts
const MembersSchema = z.looseObject({
	users: z.array(z.looseObject({
		member_id: z.string(),
		name: z.string()
	})),
	has_more: z.boolean(),
	truncations: z.array(z.unknown()).optional()
});
const FeishuConfigSchema = FeishuBotSchema.extend({
	readPageSize: z.number().int().min(1).max(50).default(20),
	linkTimeoutMs: z.number().int().min(1).max(9e4).default(5e3),
	chats: z.array(z.object({
		chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
		name: z.string().trim().max(60).optional(),
		listen: z.enum(["mentions", "all"])
	}).strict()).refine((chats) => new Set(chats.map((chat) => chat.chatId)).size === chats.length, "Duplicate chat IDs").default([]),
	directMessages: z.boolean().default(true),
	otherChats: z.enum(["none", "mentions"]).default("none")
}).strict();
const feishuKind = {
	kind: SOURCE,
	refreshLabels: (host, signal) => refreshChatNames(sourceContext(host, feishuKind), signal),
	title: {
		zh: "飞书",
		en: "Feishu"
	},
	description: {
		zh: "接收下列群和私聊中发给机器人的消息，补收群历史并轮询订阅的线程。",
		en: "Receives messages to the bot in these chats and direct messages, recovers chat history and polls subscribed Threads."
	},
	schema: FeishuConfigSchema,
	fields: [
		{
			key: "cli",
			type: "text",
			label: {
				zh: "机器人的 lark-cli",
				en: "Bot lark-cli"
			},
			hint: {
				zh: "命令名或绝对路径，指向只允许机器人身份（strict mode bot）的 lark-cli 配置；执行器以 lark-cli 调用它。保存时读取应用和机器人，然后重启 dsh-superagent。",
				en: "A command name or absolute path of a lark-cli configuration that allows only the bot identity (strict mode bot); the Executor calls it as lark-cli. Saving reads the app and the bot, then restarts dsh-superagent."
			}
		},
		{
			key: "chats",
			type: "rows",
			label: {
				zh: "接收的群",
				en: "Chats"
			},
			hint: {
				zh: "“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作，需要机器人有读取全部消息的权限。",
				en: "\"@ only\" receives messages that mention the bot and Threads that have Tickets; \"All\" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all messages."
			},
			columns: [{
				key: "chatId",
				type: "text",
				label: {
					zh: "群",
					en: "Chat"
				},
				pattern: "oc_[a-zA-Z0-9]+",
				choose: {
					zh: "选择机器人已加入的群",
					en: "Choose a chat the bot has joined"
				},
				refresh: {
					zh: "刷新群列表",
					en: "Refresh chats"
				}
			}, {
				key: "listen",
				type: "select",
				label: {
					zh: "接收",
					en: "Receive"
				},
				options: [{
					value: "mentions",
					label: {
						zh: "仅 @",
						en: "@ only"
					}
				}, {
					value: "all",
					label: {
						zh: "全部消息",
						en: "All"
					}
				}]
			}]
		},
		{
			key: "otherChats",
			type: "select",
			label: {
				zh: "其他群",
				en: "Other chats"
			},
			options: [{
				value: "none",
				label: {
					zh: "不接收",
					en: "Not received"
				}
			}, {
				value: "mentions",
				label: {
					zh: "仅 @",
					en: "@ only"
				}
			}],
			hint: {
				zh: "机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。",
				en: "Chats the bot has joined that are not listed above. \"@ only\" receives messages there that mention the bot; whose messages may originate work is the Policy's admission."
			}
		},
		{
			key: "directMessages",
			type: "switch",
			label: {
				zh: "接收私聊",
				en: "Direct messages"
			}
		},
		{
			key: "readPageSize",
			type: "number",
			advanced: true,
			min: 1,
			max: 50,
			label: {
				zh: "每页消息数",
				en: "Messages per page"
			},
			hint: {
				zh: "智能体读取线程和群历史时，每页的消息数。",
				en: "Messages per page when agents read Threads and chat history."
			}
		},
		{
			key: "linkTimeoutMs",
			type: "number",
			advanced: true,
			min: 1,
			max: 9e4,
			label: {
				zh: "原消息链接的查询时限 / 毫秒",
				en: "Original message link time limit / ms"
			},
			hint: {
				zh: "查询原消息链接最多等待的时间；超时后智能体改为直接读取原消息。",
				en: "How long to wait for an original message's link; after that, agents read the message itself."
			}
		}
	],
	health: ["feishu", "history"],
	scope({ meta }, config) {
		if (meta.direct === true) return config.directMessages ? {
			listened: true,
			observed: false,
			row: "direct"
		} : {
			listened: false,
			reason: "direct_messages_not_allowed"
		};
		const chat = config.chats.find((item) => item.chatId === meta.chatId);
		if (chat) return {
			listened: true,
			observed: chat.listen === "all",
			row: chat.chatId
		};
		return config.otherChats === "mentions" ? {
			listened: true,
			observed: false,
			row: "other"
		} : {
			listened: false,
			reason: "chat_not_allowed"
		};
	},
	channel: {
		allowed: (address, config) => feishuKind.scope({ meta: {
			chatId: address.chatId ?? "",
			direct: address.direct === "true"
		} }, config).listened,
		send: sendFeishu,
		query: queryFeishu,
		link: feishuLink
	},
	threadContext: feishuThreadContext,
	find: (query) => ({
		threads: [],
		terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])]
	}),
	repliesTo: (trigger) => typeof trigger.meta.parentId === "string" ? feishuTriggerId(trigger.meta.parentId) : void 0,
	policy: {
		unnamed: {
			person: {
				zh: "飞书用户",
				en: "Feishu user"
			},
			bot: {
				zh: "飞书机器人",
				en: "Feishu bot"
			}
		},
		schema: z.object({
			allowed: z.array(z.object({
				id: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Duplicate open_ids").default([]),
			syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(""),
			bots: z.array(z.object({
				id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((bots) => new Set(bots.map((bot) => bot.id)).size === bots.length, "Duplicate bot ids").optional()
		}).strict(),
		fields: [
			{
				key: "allowed",
				type: "rows",
				label: {
					zh: "能发起工作的飞书用户",
					en: "Feishu users who may originate work"
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "open_id",
						en: "open_id"
					},
					pattern: "ou_[a-zA-Z0-9]+"
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name"
					},
					optional: true
				}]
			},
			{
				key: "syncChat",
				type: "text",
				pattern: "(oc_[a-zA-Z0-9]+)?",
				label: {
					zh: "同步来源群",
					en: "Sync chat"
				},
				choose: {
					zh: "不同步",
					en: "Do not sync"
				},
				hint: {
					zh: "同步时，名单变成这个群里的人：新成员加入，离开的人移除，名字取群里的名字。启动时和点同步时进行。",
					en: "Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync."
				}
			},
			{
				key: "bots",
				type: "rows",
				label: {
					zh: "消息可以成为候选的机器人",
					en: "Bots whose messages may become candidates"
				},
				hint: {
					zh: "名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。",
					en: "Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots' messages are not admitted."
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "App ID 或 open_id",
						en: "App ID or open_id"
					},
					pattern: "(cli|ou)_[a-zA-Z0-9]+"
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name"
					},
					optional: true
				}]
			}
		],
		explicit: {
			zh: "名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。",
			en: "Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting."
		},
		rows(stored) {
			const config = FeishuConfigSchema.parse(stored);
			const mentions = {
				zh: "仅 @",
				en: "@ only"
			};
			return [
				...config.chats.map((chat) => ({
					id: chat.chatId,
					label: chat.name || chat.chatId,
					note: chat.listen === "all" ? {
						zh: "全部消息",
						en: "All"
					} : mentions,
					cells: {
						listedUnaddressed: chat.listen === "all",
						unlistedAddressed: true,
						unlistedUnaddressed: chat.listen === "all"
					}
				})),
				{
					id: "other",
					label: {
						zh: "其他群",
						en: "Other chats"
					},
					note: config.otherChats === "mentions" ? mentions : {
						zh: "不接收",
						en: "Not received"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.otherChats === "mentions",
						unlistedUnaddressed: false
					}
				},
				{
					id: "direct",
					label: {
						zh: "私聊",
						en: "Direct messages"
					},
					note: config.directMessages ? {
						zh: "接收",
						en: "Received"
					} : {
						zh: "不接收",
						en: "Not received"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.directMessages,
						unlistedUnaddressed: false
					}
				}
			];
		},
		sync: {
			label: {
				zh: "立即同步",
				en: "Sync now"
			},
			ready: (part) => !!part.syncChat,
			async run(host, part, signal) {
				const commands = sourceContext(host, feishuKind).commands.withSignal(signal);
				const members = [
					"im",
					"+chat-members-list",
					"--chat-id",
					String(part.syncChat),
					"--member-types",
					"user",
					"--page-all",
					"--page-limit",
					"0"
				];
				const result = MembersSchema.parse(await commands.lark(members));
				if (result.has_more || result.truncations?.length) throw new Error("Feishu returned an incomplete member list");
				const users = new Map(result.users.map((user) => [user.member_id, user.name]));
				const known = new Set(part.allowed.map((entry) => entry.id));
				return {
					...part,
					allowed: [...part.allowed.filter((entry) => users.has(entry.id)).map((entry) => ({
						...entry,
						name: users.get(entry.id)
					})), ...result.users.filter((user) => !known.has(user.member_id)).map((user) => ({
						id: user.member_id,
						name: user.name
					}))]
				};
			}
		}
	},
	environment: {
		variables: [{
			key: "DSH_SUPERAGENT_FEISHU_BOT",
			description: {
				zh: "飞书机器人；lark-cli 以它行事",
				en: "The Feishu bot; lark-cli acts as it"
			}
		}, {
			key: "DSH_SUPERAGENT_FEISHU_CHAT",
			description: {
				zh: "接下工单的飞书群 chat_id；工单不是从飞书来的时为空",
				en: "chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu"
			}
		}],
		values: ({ deployment, trigger }) => ({
			DSH_SUPERAGENT_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : "",
			DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === "feishu" ? String(trigger.meta.chatId ?? "") : ""
		})
	},
	facts: (deployment) => deployment?.feishu ? { cli: {
		zh: `当前机器人 ${deployment.feishu.name || deployment.feishu.botId}`,
		en: `Current bot ${deployment.feishu.name || deployment.feishu.botId}`
	} } : {}
};
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
const feishuSettings = (sources) => sources.instance("feishu")?.config ?? FeishuConfigSchema.parse({});
const name = "dsh-superagent-feishu";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(feishuKind), "feishu: source kind");
	ctx.effect(() => {
		const controller = new AbortController();
		const running = runFeishu(sourceContext(ctx.orchestrator, feishuKind), controller.signal);
		return async () => {
			controller.abort();
			await running;
		};
	});
}
//#endregion
export { withMentionNames as S, feishuThreadId as _, name as a, feishuTriggerId as b, pollThreads as c, feishuChatLink as d, feishuRead as f, feishuRef as g, SOURCE as h, inject as i, refreshChatNames as l, readFeishuLink as m, feishuKind as n, backfillChat as o, feishuReferences as p, feishuSettings as r, consumerRetry as s, apply as t, threadRef as u, feishuTime as v, historyEvent as x, feishuTrigger as y };
