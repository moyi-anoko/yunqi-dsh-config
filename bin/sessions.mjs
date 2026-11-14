#!/usr/bin/env node
/**
 * 列出本机所有 DSH 会话：id、最后活动、最后一条人话、大小。
 *
 * 会话文件是多帧 zstd 拼接（session.v4.jsonl.zstd），
 * 一帧 = 一批事件。这里只解第一帧（header）和最后三帧（找最后一条用户消息）。
 *
 * 用法：
 *   node bin/sessions.mjs          全部
 *   node bin/sessions.mjs --active 24 小时内活动过的
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = 'C:/Users/35218/.dsh/sessions';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function frameOffsets(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      out.push(i);
    }
  }
  if (out.length === 0) out.push(0);
  return out;
}

function decodeRange(buf, from, to) {
  try {
    return zstdDecompressSync(buf.subarray(from, to)).toString('utf8');
  } catch {
    return '';
  }
}

function lines(text) {
  return text.split('\n').filter((l) => l.trim().startsWith('{'));
}

function parse(file) {
  const buf = readFileSync(file);
  const offs = frameOffsets(buf);
  const headText = decodeRange(buf, offs[0], offs[1] ?? buf.length);
  const header = lines(headText).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find(Boolean) || {};

  // 从末尾往前扫，最多 80 帧：取最新时间、会话标题、最后一条人话
  let lastUser = '';
  let title = '';
  let lastTs = 0;
  const floor = Math.max(0, offs.length - 80);
  for (let i = offs.length - 1; i >= floor; i--) {
    const text = decodeRange(buf, offs[i], offs[i + 1] ?? buf.length);
    const evs = [];
    for (const line of lines(text)) {
      try { evs.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    for (const ev of evs) {
      const raw = ev.time ?? ev.ts ?? ev.at;
      const ts = typeof raw === 'number' ? raw : (Date.parse(raw || '') || 0);
      if (ts > lastTs) lastTs = ts;
      if (!title && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') title = ev.data.title;
    }
    if (!lastUser) {
      for (let j = evs.length - 1; j >= 0; j--) {
        const ev = evs[j];
        const data = ev.data || {};
        if (ev.type !== 'user/message' || !Array.isArray(data.content)) continue;
        const kind = data.source?.kind;
        if (!(kind === undefined || kind === 'user' || String(kind).startsWith('plugin:'))) continue;
        const t = data.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
        const injected = /^<(hindsight_knowledge|system-reminder|developer_message|acp)/.test(t) || t.startsWith('Current runtime context');
        if (t && !injected) { lastUser = t.replace(/^<user_message[^>]*>\s*/, '').replace(/\s*<\/user_message>$/, ''); break; }
      }
    }
    if (lastUser && lastTs && title) break;
  }
  if (!title) title = header.title || '';
  return { id: header.id || '', createdAt: header.createdAt || 0, lastTs, title, lastUser, size: buf.length };
}

const args = process.argv.slice(2);
const activeOnly = args.includes('--active');
const hours = Number(args[args.indexOf('--active') + 1]) || 24;

const rows = [];
for (const ws of readdirSync(ROOT, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  for (const s of readdirSync(join(ROOT, ws.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue;
    const f = join(ROOT, ws.name, s.name, 'session.v4.jsonl.zstd');
    try {
      statSync(f);
      rows.push(parse(f));
    } catch {
      /* 没有 session.v4.jsonl.zstd 的目录跳过 */
    }
  }
}

const cutoff = Date.now() - hours * 3600 * 1000;
const shown = rows.filter((r) => (activeOnly ? r.lastTs >= cutoff : true)).sort((a, b) => b.lastTs - a.lastTs);

const fmt = (ts) => {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

console.log(`会话总数 ${rows.length}，显示 ${shown.length}${activeOnly ? `（${hours}h 内）` : ''}\n`);
for (const r of shown) {
  const mb = (r.size / 1048576).toFixed(1);
  const name = r.title || r.lastUser || '-';
  console.log(`${r.id}`);
  if (name !== '-') console.log(`  名称: ${name.slice(0, 50)}`);
  
  console.log(`  最后活动 ${fmt(r.lastTs)}   ${mb}MB   最后一条: ${(r.lastUser || '-').slice(0, 50)}`);
}
