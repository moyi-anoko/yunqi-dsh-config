#!/usr/bin/env node
/**
 * 从 cnmeme.wiki 公开 API 同步词库到 data/memes.db
 *
 * 用法：
 *   node scripts/sync-cnmeme.mjs             # 扫描全站 + 增量更新（默认）
 *   node scripts/sync-cnmeme.mjs --dry-run   # 只报告会改什么，不写库
 *   node scripts/sync-cnmeme.mjs --no-existing  # 只补新词条，不动已有词条
 *
 * 做的事：
 *   1. 按更新时间从新到旧翻完公开词条列表（每页 30 条，带重试和限速）
 *   2. 对比本地库：站点有、本地没有的 → 新增；本地有、站点更新时间晚于
 *      本地 built_at 的 → 更新
 *   3. 拉详情，把 HTML 正文拆成「来源 / 用法 / 其他」三段
 *   4. 写库前备份，写完后更新 meta.built_at / count
 *
 * 已有词条的 aliases 不会被冲掉（本地填过的优先）；正文为空时保留本地旧值。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)))
const 词库文件 = join(根目录, 'data', 'memes.db')
const API = 'https://cnmeme.wiki/api/v1/public/memes'

const 参数 = new Set(process.argv.slice(2))
const 试运行 = 参数.has('--dry-run')
const 只加新条 = 参数.has('--no-existing')

// ---------- HTML → 纯文本 ----------

function 解实体(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 行内文本：去标签、`<br>` 转换行、解码实体 */
function 行内(html) {
  return 解实体(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** 块级内容：p 段落、ul/ol 列表、blockquote 引用 */
function 转块(html) {
  const 输出 = []
  const 正则 = /<(p|ul|ol|blockquote|pre)[^>]*>([\s\S]*?)<\/\1>/gi
  let m
  while ((m = 正则.exec(html))) {
    const 标签 = m[1].toLowerCase()
    if (标签 === 'ul' || 标签 === 'ol') {
      const 项 = [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((x) => 行内(x[1]).replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
      if (项.length) 输出.push(项.map((t) => '- ' + t).join('\n\n'))
    } else if (标签 === 'blockquote') {
      const 内 = 转块(m[2]) || 行内(m[2])
      if (内) 输出.push(内)
    } else {
      const 文本 = 行内(m[2])
      if (文本) 输出.push(文本)
    }
  }
  return 输出.join('\n\n')
}

/** 正文 HTML → [{ 标题, 内容 }]（按 h2 分节） */
function 拆节(html) {
  const 节 = []
  const 正则 = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/gi
  for (const m of String(html || '').matchAll(正则)) {
    const 标题 = 行内(m[1]).trim()
    const 内容 = 转块(m[2]).trim()
    if (标题) 节.push({ 标题, 内容 })
  }
  return 节
}

/** API 词条 → 数据库行（字段一律兜成字符串：站点偶尔会缺 title/aliases，node:sqlite 不收 undefined） */
function 转行(item) {
  const 节 = 拆节(item.content_html)
  const 取 = (名) => (节.find((s) => s.标题 === 名)?.内容 || '').trim()
  const 其他 = 节
    .filter((s) => s.标题 !== '来源' && s.标题 !== '用法')
    .map((s) => (s.内容 ? `${s.标题}\n${s.内容}` : s.标题))
    .join('\n\n')
  const 文本 = (v) => (v == null ? '' : String(v))
  return {
    title: 文本(item.title).trim(),
    slug: 文本(item.slug).trim() || 文本(item.title).trim(),
    tags: Array.isArray(item.tags) ? item.tags.map(文本).join('、') : 文本(item.tags),
    usage: 取('用法'),
    origin: 取('来源'),
    other: 其他,
    summary: 文本(item.summary),
    aliases: Array.isArray(item.aliases) ? item.aliases.map(文本).join(',') : 文本(item.aliases),
    updated_at: 文本(item.updated_at),
  }
}

// ---------- 网络 ----------

const 等待 = (ms) => new Promise((r) => setTimeout(r, ms))

async function 取JSON(路径, 重试 = 4) {
  for (let i = 0; i < 重试; i++) {
    try {
      const res = await fetch(API + 路径, {
        headers: { 'user-agent': 'dsh-memewiki-sync' },
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 429 || res.status >= 500) {
        const 等 = Math.min(15000, 1500 * 2 ** i)
        console.log(`  ${res.status}，${(等 / 1000).toFixed(1)} 秒后重试（${i + 1}/${重试}）`)
        await 等待(等)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      if (i === 重试 - 1) throw e
      await 等待(1500 * (i + 1))
    }
  }
  throw new Error('重试次数用尽')
}

/** 翻完全部公开词条列表 */
async function 扫列表() {
  const 全部 = []
  let offset = 0
  let 页 = 0
  const 开始 = Date.now()
  for (;;) {
    const 数据 = await 取JSON(`?limit=30&offset=${offset}`)
    const 条 = 数据.items || []
    if (!条.length) break
    for (const it of 条) 全部.push({ slug: it.slug, title: it.title, updated_at: it.updated_at })
    offset += 条.length
    页++
    if (页 % 25 === 0) {
      console.log(`  已翻 ${页} 页 / ${全部.length} 条（${((Date.now() - 开始) / 1000).toFixed(0)}s）`)
    }
    if (!数据.has_more) break
    await 等待(120)
  }
  return 全部
}

// ---------- 主流程 ----------

const 开始时间 = Date.now()

if (!existsSync(词库文件)) {
  console.error('没找到词库：' + 词库文件)
  process.exit(1)
}

const db = new DatabaseSync(词库文件)
db.exec('PRAGMA busy_timeout = 8000')

const 本地 = db.prepare('SELECT title, slug, aliases FROM memes').all()
const 本地标题 = new Set(本地.map((r) => r.title))
const 本地slug = new Set(本地.map((r) => r.slug))
const 本地数 = 本地.length

let 构建时间 = ''
try {
  构建时间 = String(db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()?.value || '')
} catch (e) { /* 老库没有 meta 表 */ }
const 截止 = 构建时间 ? Date.parse(构建时间.replace(' ', 'T')) : 0

console.log(`本地词库 ${本地数} 条${构建时间 ? `，上次构建 ${构建时间}` : ''}`)
console.log('扫描 cnmeme.wiki 公开词条列表…')
const 站点 = await 扫列表()
console.log(`站点公开词条 ${站点.length} 条`)

const 站点slug = new Set(站点.map((x) => x.slug))
const 新增 = []
const 待更新 = []
for (const it of 站点) {
  const 已有 = 本地标题.has(it.title) || 本地slug.has(it.slug)
  if (!已有) {
    新增.push(it)
  } else if (!只加新条 && 截止 && it.updated_at && Date.parse(it.updated_at) > 截止) {
    待更新.push(it)
  }
}

// 本地有、站点没有的（下架/改名），只报告不动
const 下架 = 本地.filter((r) => !站点slug.has(r.slug)).map((r) => r.title)

console.log(`新增 ${新增.length} 条，需更新 ${待更新.length} 条${下架.length ? `，站点已无 ${下架.length} 条（保留）` : ''}`)
if (!新增.length && !待更新.length) {
  console.log('已经是最新，不用改。')
  db.close()
  process.exit(0)
}

const 目标 = [...新增, ...待更新]
const 详情 = []
let 失败 = 0
for (let i = 0; i < 目标.length; i++) {
  const it = 目标[i]
  try {
    // 详情接口有两种形状：老的扁平词条，新的 { schema_version, item }——统一取 item
    const 体 = await 取JSON('/' + encodeURIComponent(it.slug))
    详情.push(体 && 体.item && typeof 体.item === 'object' ? 体.item : 体)
  } catch (e) {
    失败++
    console.log(`  失败：${it.title}（${e.message}）`)
  }
  if ((i + 1) % 10 === 0) console.log(`  详情 ${i + 1}/${目标.length}`)
  await 等待(250)
}

if (试运行) {
  console.log('\n[试运行] 会新增：')
  新增.forEach((x) => console.log('  + ' + x.title))
  console.log('[试运行] 会更新：')
  待更新.forEach((x) => console.log('  * ' + x.title))
  if (失败) console.log(`失败 ${失败} 条`)
  db.close()
  process.exit(0)
}

// 写库前备份
const 时间戳 = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString().replace(/[-:T]/g, '').slice(0, 14)
const 备份 = join(根目录, 'data', `memes.db.bak-${时间戳}`)
copyFileSync(词库文件, 备份)

let 插入数 = 0
let 更新数 = 0
const 更新过的 = []

db.exec('BEGIN')
try {
  for (const item of 详情) {
    const 行 = 转行(item)
    if (!行.title) {
      console.log('跳过没有标题的详情：' + JSON.stringify(item).slice(0, 160))
      continue
    }
    const 旧 = db.prepare('SELECT * FROM memes WHERE title = ?').get(行.title)
    if (!旧) {
      db.prepare(
        'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?,?,?,?,?,?,?,?)',
      ).run(行.title, 行.slug, 行.tags, 行.usage, 行.origin, 行.other, 行.summary, 行.aliases)
      插入数++
    } else {
      const 合并 = {
        slug: 行.slug || 旧.slug,
        tags: 行.tags || 旧.tags,
        usage: 行.usage || 旧.usage,
        origin: 行.origin || 旧.origin,
        other: 行.other || 旧.other,
        summary: 行.summary || 旧.summary,
        aliases: 行.aliases || 旧.aliases || '',
      }
      const 变了 = ['slug', 'tags', 'usage', 'origin', 'other', 'summary', 'aliases'].some(
        (k) => String(旧[k] ?? '') !== String(合并[k] ?? ''),
      )
      if (变了) {
        db.prepare('UPDATE memes SET slug=?, tags=?, usage=?, origin=?, other=?, summary=?, aliases=? WHERE title=?')
          .run(合并.slug, 合并.tags, 合并.usage, 合并.origin, 合并.other, 合并.summary, 合并.aliases, 行.title)
        更新数++
        更新过的.push(行.title)
      }
    }
  }
  const 总数 = db.prepare('SELECT COUNT(*) AS n FROM memes').get().n
  const 时间 = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().replace('T', ' ').slice(0, 19)
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)").run(时间)
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('count', ?)").run(String(总数))
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('source', ?)").run('cnmeme.wiki /api/v1/public/memes')
  db.exec('COMMIT')
  console.log(`\n完成：${本地数} → ${总数} 条（新增 ${插入数}，更新 ${更新数}${失败 ? `，失败 ${失败}` : ''}）`)
  if (更新过的.length) console.log('更新：' + 更新过的.join('、'))
  console.log('备份：' + 备份)
  console.log(`耗时 ${((Date.now() - 开始时间) / 1000).toFixed(0)} 秒`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('写库失败，已回滚：' + (e && e.message))
  process.exitCode = 1
} finally {
  db.close()
}
