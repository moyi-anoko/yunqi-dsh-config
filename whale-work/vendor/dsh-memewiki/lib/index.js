/**
 * dsh-memewiki —— 梗百科（移植自 AstrBot 的 astrbot_plugin_memewiki）
 *
 * 三件事：
 *   1. 内置 6668 条梗 / 黑话词库（data/memes.db，SQLite，只读）——本地查，毫秒级
 *   2. LLM 工具 search_meme_wiki —— 模型没把握时自己查
 *   3. 自动预查 —— 用户消息像问梗时，先把词条查好塞进系统提示，别让模型硬猜
 *
 * 词库默认不进上下文：只在真相问梗时注入**那一条**（几百字）。
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

function 自检(message) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    appendFileSync(join(home, 'memewiki.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch (e) { /* ignore */ }
}

// Node 22.5+ 自带 SQLite；没有就降级成「只有工具、没有词库」
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (e) {
  console.warn('[memewiki] 这台 Node 没有 node:sqlite：' + (e && e.message))
}

export const name = 'memewiki'
export const inject = ['tools', 'systemPrompt', 'webServer']

const 插件根 = dirname(dirname(fileURLToPath(import.meta.url)))
const 词库文件 = join(插件根, 'data', 'memes.db')

// 插件自己的版本号（从 package.json 读，改 package.json 就跟着变）
const 当前版本 = (() => {
  try {
    return String(JSON.parse(readFileSync(join(插件根, 'package.json'), 'utf8')).version || '0.0.0')
  } catch (e) { return '0.0.0' }
})()

const 远端清单 = 'https://raw.githubusercontent.com/thawline/dsh-memewiki/main/package.json'
const 仓库地址 = 'https://github.com/thawline/dsh-memewiki'

function 拆版本(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
}

/** 比较两个语义化版本：a>b 返回正数，相等 0 */
function 比版本(a, b) {
  const x = 拆版本(a)
  const y = 拆版本(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d
  }
  return 0
}

// ---------- 配置（存在 ~/.dsh/memewiki.json，改完不用重启） ----------

const 配置目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(配置目录, 'memewiki.json')
const 默认配置 = { 自动思考梗: true, 串子开关: false, 串子程度: 50 }

let 配置缓存 = null
let 配置缓存时间 = 0

function 读配置() {
  const now = Date.now()
  if (配置缓存 && now - 配置缓存时间 < 3000) return 配置缓存
  let 配置 = { ...默认配置 }
  try {
    if (existsSync(配置文件)) {
      const 原文 = JSON.parse(readFileSync(配置文件, 'utf8'))
      if (原文 && typeof 原文 === 'object' && !Array.isArray(原文)) 配置 = { ...默认配置, ...原文 }
    }
  } catch (e) { /* 文件坏了就当默认 */ }
  配置缓存 = 配置
  配置缓存时间 = now
  return 配置
}

function 写配置(patch) {
  const 当前 = 读配置()
  const 下一个 = {
    自动思考梗: typeof patch?.自动思考梗 === 'boolean' ? patch.自动思考梗 : 当前.自动思考梗 !== false,
    串子开关: typeof patch?.串子开关 === 'boolean' ? patch.串子开关 : 当前.串子开关 === true,
    串子程度: Number.isFinite(Number(patch?.串子程度))
      ? Math.max(0, Math.min(100, Math.round(Number(patch.串子程度))))
      : (Number.isFinite(Number(当前.串子程度)) ? Math.max(0, Math.min(100, Math.round(Number(当前.串子程度)))) : 50),
  }
  try {
    writeFileSync(配置文件, JSON.stringify(下一个, null, 2), 'utf8')
  } catch (e) {
    自检('写配置失败：' + (e && e.message))
  }
  配置缓存 = 下一个
  配置缓存时间 = Date.now()
  return 下一个
}

// ---------- 词库 ----------

let db = null
let 词库加载过 = false

function 开词库() {
  if (词库加载过) return db
  词库加载过 = true
  try {
    if (!existsSync(词库文件)) return db
    if (!DatabaseSync) return db
    // 只读打开；Node 24 自带 node:sqlite，不用装驱动
    db = new DatabaseSync(词库文件, { readOnly: true })
  } catch (e) {
    console.warn('[memewiki] 打开词库失败：' + (e && e.message))
    db = null
  }
  return db
}

// 设置页要能往里加/改词条，需要一条可写连接（懒开、失败不影响只读查询）
let 写库连接 = null
let 写库开过 = false

function 开写库() {
  if (写库开过) return 写库连接
  写库开过 = true
  try {
    if (!existsSync(词库文件) || !DatabaseSync) return null
    写库连接 = new DatabaseSync(词库文件)
  } catch (e) {
    console.warn('[memewiki] 打开可写词库失败：' + (e && e.message))
    写库连接 = null
  }
  return 写库连接
}

/** 只认完整梗名：消息里必须出现完整标题；反过来（消息是标题前缀）不算 */
function 查词库(query) {
  const q = String(query || '').trim()
  if (!q) return null
  const conn = 开词库()
  if (!conn) return null
  try {
    // 1) 完全一样
    const exact = conn.prepare('SELECT * FROM memes WHERE title = ?').get(q)
    if (exact) return exact
    // 1.5) 别名（缩写/俗称：「kskbl」→「康神开播了」）。别名逗号分隔，整项精确比对。
    const 别名 = conn.prepare(
      "SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1",
    ).get(q)
    if (别名) return 别名
    // 2) 标题以查询词开头（「48」→「48上单」、「tes」→「TES48」）。
    //    前缀比"包含"更精确，不会像两字中文那样乱中；取最短的那条，最接近。
    const 前缀 = conn.prepare(
      "SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT 1",
    ).get(q)
    if (前缀) return 前缀
    // 3) 查询词里包含标题（问「去码头整点薯条是什么梗」）——取最长标题，最具体
    const 反查 = conn.prepare(
      'SELECT * FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1',
    ).get(q)
    if (反查) return 反查
    // 4) 标题里包含查询词（短着问「码头整」）。
    //    中文至少 3 个字才做，否则「码头」「典」这种随手两字会乱中；
    //    纯数字/字母（「48」「233」）两字也放宽——它们够specific，不放开就查不到「48上单」。
    const 短词放宽 = q.length >= 2 && /^[0-9a-z]+$/i.test(q)
    if (q.length >= 3 || 短词放宽) {
      const 正查 = conn.prepare(
        'SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT 1',
      ).get(q)
      if (正查) return 正查
    }
    return null
  } catch (e) {
    console.warn('[memewiki] 查词库失败：' + (e && e.message))
    return null
  }
}

function 截断(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** JSON 响应。 */
function 发JSON(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** 读 JSON 请求体（设置页保存词条用）。 */
function 读请求体(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { req.destroy(); resolve({}) ; return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 词条 → 给模型看的文本：「怎么用」放前面，方便直接接梗 */
function 词条文本(row) {
  if (!row) return ''
  const 标题 = String(row.title || '')
  const 用法 = 截断(row.usage, 700)
  const 解释 = 截断(row.summary || row.origin || '', 500)
  const 标签 = 截断(row.tags, 120)
  const lines = [`[梗百科]「${标题}」`]
  if (标签) lines.push(`标签：${标签}`)
  if (用法) lines.push(`怎么用 / 怎么接：\n${用法}`)
  if (解释) lines.push(`出处与含义：\n${解释}`)
  return lines.join('\n')
}

// ---------- 判断「像不像在问梗」 ----------

const 问梗模式 = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/
const 裸词模式 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/

const 无语义词 = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面',
])

const 停用词 = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐',
])

// 明显是闲聊/问状态的整句，别当梗去查
const 闲聊短语 = new Set([
  '我是谁', '错了', '情绪', '接下一句', '你也学一个', '今天看什么', '到底多少了',
  '搜出来了吗', '来点贴吧评价', '都是同龄人', '你同事', '道德这么高',
  '这是谁的手臂', '比我能串', '宝宝你醒了', '中国人能不能飞', '你现在什么人格',
])

const 句子成分 = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/

const 唤醒词 = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek', 'ds']

function 清文本(text) {
  let t = String(text || '').trim()
  t = t.replace(/^(@\S+\s*)+/, '')
  for (const w of 唤醒词) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：]+|[，,。.！!？?:：]+$/g, '')
      break
    }
  }
  return t.trim()
}

/** 从一句话里提取候选词条；不是问梗就返回 null */
function 提取查询(text) {
  const t = 清文本(text)
  if (!t) return null
  const m = 问梗模式.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[ ，,。.！!？?]+|[ ，,。.！!？?]+$/g, '')
    head = head.replace(/^[是]+|[是]+$/g, '').trim()
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (无语义词.has(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0])) return null
    if (head.length > 1 && head.length <= 12) return head
    return null
  }
  if (裸词模式.test(t) && !停用词.has(t) && !闲聊短语.has(t)) {
    if (句子成分.test(t)) return null
    return t
  }
  return null
}

// ---------- 会话里的最后一条用户消息 ----------

function 取文本(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  const parts = payload.parts || payload.content || payload.message
  if (typeof parts === 'string') return parts
  if (Array.isArray(parts)) {
    return parts
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p.text === 'string') return p.text
        return ''
      })
      .join('\n')
  }
  if (typeof payload.text === 'string') return payload.text
  return ''
}

function 最后用户消息(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      const kind = e && (e.type || e.kind)
      if (kind !== 'user/message') continue
      const payload = e.payload !== undefined ? e.payload : e.data
      // 跳过宿主/其它插件注入的上下文
      const src = payload && payload.source && payload.source.kind ? String(payload.source.kind) : ''
      if (src && src !== 'user') continue
      const txt = 取文本(payload)
      if (txt) return txt
    }
  } catch (e) { /* ignore */ }
  return ''
}

// ---------- 注入的规则 ----------

const 接梗规则 =
  '[梗百科·内置用法]\n' +
  '1. 查到词条就**先接梗、别科普**：照「怎么用/怎么接」回一句，像本来就会；\n' +
  '2. 只有对方明确问「这是什么梗」才解释出处，一两句就够，不要念词条；\n' +
  '3. 查不到就说不知道，别硬编，也别把两个不相干的梗拼一起；\n' +
  '4. 说话用短句，别用客服腔。'

// 串子程度：0 = 很有底线，100 = 放开了串。开关关着时不注入，交给模型自己判断。
function 串子文案() {
  const 配置 = 读配置()
  if (!配置.串子开关) return ''
  const 值 = Math.max(0, Math.min(100, Math.round(Number(配置.串子程度) || 0)))
  let 档 = ''
  let 说明 = ''
  if (值 <= 20) {
    档 = '很低'
    说明 = '把对面当真人尊重。可以接正面梗、自嘲、夸人；黑称一律不接、不复读，遇到侮辱性外号直接点一句它为什么不好，不跟着起哄。'
  } else if (值 <= 45) {
    档 = '偏低'
    说明 = '可以损操作、损发挥，不损长相、不损病。别人先用黑称、且明显是玩的时候，跟着接半句；不带头用，不上纲上线。'
  } else if (值 <= 70) {
    档 = '中等'
    说明 = '按社区语境来：别人玩得开的梗就跟着玩，损操作、损战绩、损名言都行；冲家人的词不带头用。'
  } else {
    档 = '很高'
    说明 = '放开串：黑称也照玩（「马头」「四八」这种别人先甩出来的词，接着玩，别扫兴），损操作、损战绩、损长相都接，怎么损怎么来，别端着。只对真事，不自己编新攻击。'
  }
  return `[玩梗尺度·串子程度 ${值}/100（${档}）]\n${说明}\n`
}

// ---------- 插件 ----------

export function apply(ctx) {
  自检('apply 开始')
  const 日志 = (t) => {
    自检(t)
    try { ctx.logger?.info?.('[memewiki] ' + t) } catch (e) { /* ignore */ }
  }

  // 宿主的 defineTool 会做「简写 → JSON Schema」转换；这里等价实现一份，别指望拿到真货
  const defineTool = (o) => ({
    ...o,
    parameters: {
      type: 'object',
      properties: o.parameters || {},
      additionalProperties: false,
    },
  })

  // 工具：模型自己查
  try {
    ctx.tools.register(defineTool({
      name: 'search_meme_wiki',
      description: '查网络梗、缩写、黑话的意思。内置 6668 条词库，本地毫秒级返回。\n'
        + '⚠️ 看到没有十足把握的新词/梗/缩写，先查它，别硬猜、别编。',
      parameters: {
        query: { type: 'string', description: '要查的词（梗名、缩写、黑话）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const q = String(args?.query || '').trim()
        if (!q) return '要查什么？给我一个词。'
        const row = 查词库(q)
        if (!row) return `词库里没收录「${q}」。别硬解释——说不知道，或者反问一句「这什么梗」。`
        return 接梗规则 + '\n' + 串子文案() + '\n' + 词条文本(row)
      },
    }))
    日志('工具 search_meme_wiki 已注册')
  } catch (e) {
    日志('注册工具失败：' + (e && e.message))
  }

  // 注入：用户消息像问梗时，把词条塞进系统提示（每轮现算）
  try {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'memewiki:prefetch',
      order: 950,
      text: (context) => {
        try {
          if (!读配置().自动思考梗) return ''
          const session = context?.agent?.session
          const 文本 = 最后用户消息(session)
          if (!文本) return ''
          const q = 提取查询(文本)
          if (!q) return ''
          const row = 查词库(q)
          if (!row) return ''
          日志(`预查命中：${q}`)
          return 接梗规则 + '\n' + 串子文案() + '\n' + 词条文本(row)
        } catch (e) {
          自检('预查出错：' + (e && e.message))
          return ''
        }
      },
    }), 'dsh-memewiki: 预查注入')
    日志('预查注入已注册')
  } catch (e) {
    日志('注册注入失败：' + (e && e.message))
  }

  // ---- 设置页的同源 API（/api/memewiki/*）-------------------------------
  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/memewiki',
      handler: async (req, res) => {
        const route = (req.url ?? '').split('?')[0].slice('/api/memewiki'.length) || '/'
        try {
          const u = new URL(req.url ?? '/', 'http://localhost')

          if (route === '/state' && req.method === 'GET') {
            const conn = 开词库()
            let total = 0
            let builtAt = ''
            if (conn) {
              try {
                total = conn.prepare('SELECT COUNT(*) AS n FROM memes').get().n
                const meta = conn.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()
                builtAt = meta ? String(meta.value || '') : ''
              } catch (e) { /* 老库没有 meta 表也无所谓 */ }
            }
            return 发JSON(res, 200, {
              ok: true,
              total,
              builtAt,
              file: 词库文件,
              writable: 开写库() !== null,
              版本: 当前版本,
              自动思考梗: 读配置().自动思考梗,
              串子开关: 读配置().串子开关 === true,
              串子程度: Math.max(0, Math.min(100, Math.round(Number(读配置().串子程度) || 0))),
            })
          }

          if (route === '/config' && req.method === 'POST') {
            const body = await 读请求体(req)
            const 下一个 = 写配置({
              自动思考梗: body?.自动思考梗,
              串子开关: body?.串子开关,
              串子程度: body?.串子程度,
            })
            日志('配置改了：自动思考梗=' + 下一个.自动思考梗 + ' 串子=' + 下一个.串子开关 + '/' + 下一个.串子程度)
            return 发JSON(res, 200, {
              ok: true,
              自动思考梗: 下一个.自动思考梗,
              串子开关: 下一个.串子开关,
              串子程度: 下一个.串子程度,
            })
          }

          if (route === '/check-update' && req.method === 'GET') {
            try {
              const r = await fetch(远端清单, {
                headers: { 'user-agent': 'dsh-memewiki' },
                signal: AbortSignal.timeout(8000),
              })
              if (!r.ok) {
                return 发JSON(res, 200, {
                  ok: false,
                  当前: 当前版本,
                  error: `拉不到 GitHub 上的版本文件（HTTP ${r.status}）`,
                })
              }
              const 远端 = await r.json()
              const 最新 = String((远端 && 远端.version) || '')
              if (!最新) {
                return 发JSON(res, 200, { ok: false, 当前: 当前版本, error: '远端文件里没有版本号' })
              }
              return 发JSON(res, 200, {
                ok: true,
                当前: 当前版本,
                最新,
                有更新: 比版本(最新, 当前版本) > 0,
                仓库: 仓库地址,
              })
            } catch (e) {
              return 发JSON(res, 200, {
                ok: false,
                当前: 当前版本,
                error: '连不上 GitHub（' + ((e && e.message) || '超时') + '）',
              })
            }
          }

          if (route === '/list' && req.method === 'GET') {
            const conn = 开词库()
            if (!conn) return 发JSON(res, 200, { ok: true, total: 0, items: [] })
            const q = (u.searchParams.get('q') || '').trim()
            const limit = Math.min(120, Math.max(1, Number(u.searchParams.get('limit') || 40)))
            const offset = Math.max(0, Number(u.searchParams.get('offset') || 0))
            const 条件 = q ? "WHERE title LIKE ? OR tags LIKE ? OR summary LIKE ? OR aliases LIKE ?" : ''
            const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : []
            const total = conn.prepare(`SELECT COUNT(*) AS n FROM memes ${条件}`).get(...args).n
            const items = conn.prepare(
              `SELECT title, tags, usage, origin, summary, aliases FROM memes ${条件} ORDER BY title LIMIT ? OFFSET ?`,
            ).all(...args, limit, offset)
            return 发JSON(res, 200, { ok: true, total, items })
          }

          if (route === '/get' && req.method === 'GET') {
            const conn = 开词库()
            const title = (u.searchParams.get('title') || '').trim()
            if (!conn || !title) return 发JSON(res, 400, { ok: false, error: '缺 title' })
            const row = conn.prepare('SELECT * FROM memes WHERE title = ?').get(title)
            if (!row) return 发JSON(res, 404, { ok: false, error: '没有这个词条' })
            return 发JSON(res, 200, { ok: true, item: row })
          }

          if (route === '/save' && req.method === 'POST') {
            const conn = 开写库()
            if (!conn) return 发JSON(res, 500, { ok: false, error: '词库不可写' })
            const b = await 读请求体(req)
            const title = String(b.title || '').trim()
            if (!title) return 发JSON(res, 400, { ok: false, error: '标题不能空' })
            if (title.length > 60) return 发JSON(res, 400, { ok: false, error: '标题太长了（≤60 字）' })
            // 保存时保住 aliases：设置页没提供就沿用库里原来的（INSERT OR REPLACE 会整行重建）
            const 旧行 = conn.prepare('SELECT aliases FROM memes WHERE title = ?').get(title)
            const aliases = b.aliases !== undefined
              ? String(b.aliases || '')
              : String((旧行 && 旧行.aliases) || '')
            conn.prepare(
              'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(
              title,
              String(b.slug || title),
              String(b.tags || ''),
              String(b.usage || ''),
              String(b.origin || ''),
              String(b.other || ''),
              String(b.summary || ''),
              aliases,
            )
            return 发JSON(res, 200, { ok: true, title })
          }

          if (route === '/delete' && req.method === 'POST') {
            const conn = 开写库()
            if (!conn) return 发JSON(res, 500, { ok: false, error: '词库不可写' })
            const b = await 读请求体(req)
            const title = String(b.title || '').trim()
            if (!title) return 发JSON(res, 400, { ok: false, error: '缺 title' })
            conn.prepare('DELETE FROM memes WHERE title = ?').run(title)
            return 发JSON(res, 200, { ok: true })
          }

          return 发JSON(res, 404, { ok: false, error: `未知接口: ${route}` })
        } catch (e) {
          return 发JSON(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    })
    日志('设置页 API 已注册')
  } catch (e) {
    日志('注册设置页 API 失败：' + (e && e.message))
  }
}
