/**
 * dsh-persona-distill —— host 半端
 * ============================================================================
 * 把「原料 → 候选 → 人格」这条流水线插件化。
 *
 * 设计要点（经两轮审查加固）：
 *   1. **不假设用户装了任何东西**：只扫 `<家>/*\/source.json`，有原料才干活。
 *   2. **默认全开**：B站 / 微博 / 知乎三个已知源都探测，找到就问要不要接。
 *   3. **每天定时 + 补跑**：`lastFiredDay` 记「为哪天跑过」且**任何失败路径都写**
 *      （否则定时器会每分钟重试到窗口结束）。当天内任意时刻开机都会补。
 *   4. **手写段有硬保护**：跑前快照、跑后校验「内容 + 结构」，变了就回滚。
 *   5. **单实例**：`run.lock` 原子创建 + 带 pid + 只释放自己的锁。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dshHome, pluginHome, personaHome, agentsFile } from './lib/paths.mjs'
import { buildHeadlessCommand } from './lib/dsh.mjs'
import { inspectRegisteredSources, isReservedSourceDir, probeSources } from './lib/sources.mjs'
import { otherSiblings } from './lib/siblings.mjs'
import { ensurePersonaHome, ensureAgents, readAgentsSections } from './lib/init.mjs'
import { syncExternalSources, probeExternalSources } from './lib/external.mjs'
import { trustedRequestOrigin } from './lib/http.mjs'

export const name = 'persona-distill'
export const inject = ['webServer']

const DEFAULTS = {
  enabled: false,
  runAt: '04:10',
  ownerName: '',
  heart: '',
  identity: '',
  persona: 'blank',
  model: 'deepseek-flash',
  provider: 'deepseek-account',
  dshBin: '',
  wechatNotify: 'auto', // auto = 装了微信插件就发；off = 不发
  lastRun: '',
  lastResult: '',
  lastFiredDay: '', // 为「哪一天」跑过（不是跑完那天，跨午夜不会错）
}

const OVERLAY_HEADER = '# persona-distill overlay v2'
const OVERLAY_BODY = `# 蒸馏会话用的最小 overlay —— 只要账号和模型，不要 MCP
- id: credentials
  disabled: false

- id: authorization
  disabled: false

- id: deepseek-account
  disabled: false

- id: agent-default-model
  config:
    provider: __PROVIDER__
    model: __MODEL__
    reasoningEffort: high
`

const LOCK_STALE_MS = 90 * 60 * 1000
const MAX_OUT = 2 * 1024 * 1024

// ---------------------------------------------------------------- 时间

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${localDate(d)}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 归一化成 HH:mm；**不合法返回 null**（别偷偷改成 04:10） */
function normalizeRunAt(s) {
  const t = String(s ?? '').trim().replace(/：/g, ':')
  if (!t) return null
  const m = t.match(/^(\d{1,2})\s*:\s*(\d{1,2})(?::\d{1,2})?$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

// ---------------------------------------------------------------- 配置

const cfgFile = () => join(pluginHome(), 'config.json')

export function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''))
}

function readCfg() {
  try {
    const raw = parseJsonText(readFileSync(cfgFile(), 'utf8'))
    return { ...DEFAULTS, ...raw, runAt: normalizeRunAt(raw.runAt) || '04:10' }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...patch }
  next.runAt = normalizeRunAt(next.runAt) || '04:10'
  try {
    mkdirSync(pluginHome(), { recursive: true })
    writeFileSync(cfgFile(), JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, config: next }
  } catch (e) {
    return { ok: false, config: next, error: `配置写不进去：${e?.message ?? e}` }
  }
}

// ---------------------------------------------------------------- 日志

function log(msg) {
  try {
    mkdirSync(pluginHome(), { recursive: true })
    const f = join(pluginHome(), 'run.log')
    try {
      if (existsSync(f) && statSync(f).size > 2 * 1024 * 1024) {
        rmSync(f + '.1', { force: true })
        copyFileSync(f, f + '.1')
        rmSync(f)
      }
    } catch { /* 轮转失败不拦着 */ }
    appendFileSync(f, `[${localStamp()}] ${msg}\n`, 'utf8')
  } catch { /* 日志写不了就算了 */ }
}

// ---------------------------------------------------------------- overlay

function ensureOverlay(model, provider) {
  const home = personaHome()
  mkdirSync(home, { recursive: true })
  const f = join(home, 'headless-overlay.yml')
  const prov = provider || 'deepseek-account'
  const want = OVERLAY_HEADER + '\n' + OVERLAY_BODY
    .replace('__PROVIDER__', prov)
    .replace('__MODEL__', model || 'deepseek-flash')
  try {
    if (existsSync(f)) {
      const cur = readFileSync(f, 'utf8')
      if (cur.trim() === want.trim()) return f
      const line = `    model: ${model || 'deepseek-flash'}`
      const next = cur.includes('# persona-distill overlay')
        ? cur
          .replace(/^(\s*model:\s*).*$/m, line)
          .replace(/^(\s*provider:\s*).*$/m, `    provider: ${prov}`)
        : want
      writeFileSync(f, next, 'utf8')
      return f
    }
    writeFileSync(f, want, 'utf8')
  } catch (e) {
    log(`overlay 写不进去：${e?.message ?? e}`)
  }
  return f
}

// ---------------------------------------------------------------- 人格保护

const HAND_BEGIN = '<!-- HAND:BEGIN'
const HAND_END = '<!-- HAND:END -->'
const AUTO_BEGIN = '<!-- AUTO:BEGIN -->'
const AUTO_END = '<!-- AUTO:END -->'

function handSection(text) {
  const m = String(text).match(/<!-- HAND:BEGIN[^>]*-->([\s\S]*?)<!-- HAND:END -->/)
  return m ? m[1] : null
}

function autoSection(text) {
  const m = String(text).match(/<!-- AUTO:BEGIN -->([\s\S]*?)<!-- AUTO:END -->/)
  return m ? m[1].trim() : null
}

const AUTO_HEADINGS = ['**原则**', '**场景样本**', '**我怎么活**', '**判断**']
// 第五段可有可无：有就必须在最后、只出现一次；没有也不影响旧人格通过校验。
const AUTO_TAIL = '**我该少说**'

/** AUTO 是模型输出，必须当外部输入做硬校验。 */
export function verifyAutoSection(auto) {
  if (!auto) return { ok: false, why: 'AUTO 段是空的' }
  if ([...auto].length > 6000 || auto.split(/\r?\n/).length > 200) {
    return { ok: false, why: 'AUTO 段超过 6000 字符或 200 行' }
  }
  if (/```|~~~/.test(auto)) return { ok: false, why: 'AUTO 段含代码块' }

  let last = -1
  for (const heading of AUTO_HEADINGS) {
    const at = auto.indexOf(heading)
    if (at < 0 || at <= last || auto.indexOf(heading, at + heading.length) >= 0) {
      return { ok: false, why: `AUTO 固定四段必须按顺序且只出现一次：${AUTO_HEADINGS.join('、')}` }
    }
    last = at
  }
  const life = auto.slice(auto.indexOf('**我怎么活**') + '**我怎么活**'.length, auto.indexOf('**判断**')).trim()
  if (!life) return { ok: false, why: 'AUTO 段的“我怎么活”为空；没学够就明确写没学够' }

  const tailAt = auto.indexOf(AUTO_TAIL)
  if (tailAt >= 0) {
    if (tailAt < auto.indexOf('**判断**')) return { ok: false, why: `AUTO 段的「${AUTO_TAIL}」必须放在最后一段` }
    if (auto.indexOf(AUTO_TAIL, tailAt + AUTO_TAIL.length) >= 0) return { ok: false, why: `AUTO 段的「${AUTO_TAIL}」只能出现一次` }
  }

  const forbidden = [
    [/[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/]|~[\\/]\.dsh(?:[\\/]|\b)|\/(?:Users|home|etc)\//i, '本机路径'],
    [/(?:忽略|无视|绕过).{0,16}(?:之前|此前|上面|系统|开发者|规则|指令|要求)/i, '提示词注入'],
    [/(?:系统|开发者|用户).{0,4}(?:提示词|消息|指令)|(?:泄露|输出|复述).{0,12}(?:提示词|系统消息)/i, '提示词内容'],
    [/(?:执行|运行|调用).{0,10}(?:命令|PowerShell|cmd|bash|shell|工具|API)|(?:rm\s+-rf|Remove-Item|Invoke-Expression|curl\s+|wget\s+)/i, '命令或工具指令'],
    [/(?:从现在起|以后|今后).{0,10}(?:我|你).{0,5}(?:是|叫|成为)|(?:修改|覆盖|重写|替换).{0,10}(?:身份|名字|称呼|红线)|(?:我的|你的)(?:身份|名字|称呼)是/i, '身份改写'],
  ]
  for (const [pattern, label] of forbidden) {
    if (pattern.test(auto)) return { ok: false, why: `AUTO 段含${label}` }
  }
  return { ok: true }
}

function snapshotAgents() {
  const file = agentsFile()
  if (!existsSync(file)) return ''
  try {
    const dir = join(personaHome(), 'archive')
    mkdirSync(dir, { recursive: true })
    const dst = join(dir, `pre-${localStamp()}.md`)
    copyFileSync(file, dst)
    return dst
  } catch (e) {
    log(`快照失败：${e?.message ?? e}`)
    return ''
  }
}

/**
 * 校验「内容 + 结构」：
 *   - HAND 段内容没被改
 *   - 四个标记都还在（少一个就是结构坏了）
 *   - HAND:END 到 AUTO:BEGIN 之间没被塞东西
 *   - AUTO 段不能消失；一旦被重写，还要通过内容硬校验
 */
function verifyPersona(before, after) {
  const b = handSection(before)
  const a = handSection(after)

  // HAND 段：本来就没有就不管
  if (b !== null) {
    if (a === null) return { ok: false, why: 'HAND 段整个不见了' }
    if (b.trim() !== a.trim()) return { ok: false, why: 'HAND 段内容被改了' }
  }

  // 结构：原文件里的标记，跑完必须还在
  for (const mark of [HAND_BEGIN, HAND_END, AUTO_BEGIN, AUTO_END]) {
    if (before.includes(mark) && !after.includes(mark)) {
      return { ok: false, why: `结构标记丢了：${mark}` }
    }
  }

  // 两个段之间的空白区不能长出新内容
  const gap = (t) => {
    const x = t.indexOf(HAND_END)
    const y = t.indexOf(AUTO_BEGIN)
    return x >= 0 && y > x ? t.slice(x + HAND_END.length, y).trim() : null
  }
  const gb = gap(before)
  const ga = gap(after)
  if (gb !== null && ga !== null && gb !== ga) {
    return { ok: false, why: 'HAND:END 与 AUTO:BEGIN 之间多了内容（可能是注入）' }
  }

  // AUTO 段不能整个消失
  const hasAutoBefore = before.includes(AUTO_BEGIN) && before.includes(AUTO_END)
  const hasAutoAfter = after.includes(AUTO_BEGIN) && after.includes(AUTO_END)
  if (hasAutoBefore && !hasAutoAfter) return { ok: false, why: 'AUTO 段整个消失了（每周的产物）' }

  const autoBefore = autoSection(before)
  const autoAfter = autoSection(after)
  if (autoBefore !== autoAfter) {
    const checked = verifyAutoSection(autoAfter)
    if (!checked.ok) return checked
  }

  return { ok: true }
}

/** 兼容旧名字（测试里用过 verifyHand） */
export const verifyHand = verifyPersona

function restoreFrom(path) {
  if (!path || !existsSync(path)) return false
  try {
    copyFileSync(path, agentsFile())
    return true
  } catch (e) {
    log(`回滚失败：${e?.message ?? e}`)
    return false
  }
}

// ---------------------------------------------------------------- 单实例锁

const lockFile = () => join(pluginHome(), 'run.lock')

function lockToken() {
  try { return readFileSync(lockFile(), 'utf8').trim() } catch { return '' }
}

function pidOf(token) {
  const p = Number(String(token || '').split(':')[0])
  return Number.isFinite(p) ? p : 0
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 拿锁：token = pid:时间:随机。
 * ⚠️ **只抢死进程的锁**（pid 不存在）。活进程哪怕跑了一整天也不抢 ——
 *    不然长跑会被自己二次触发，两轮互滚。
 */
function acquireLock() {
  try { mkdirSync(pluginHome(), { recursive: true }) } catch { return '' }
  const cur = lockToken()
  if (cur) {
    const pid = pidOf(cur)
    if (pidAlive(pid)) return ''
    log('陈旧锁（pid=' + pid + ' 已不在），抢占')
    try { rmSync(lockFile(), { force: true }) } catch { return '' }
  }
  const token = process.pid + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)
  try {
    writeFileSync(lockFile(), token, { encoding: 'utf8', flag: 'wx' })
    return token
  } catch {
    return ''
  }
}

/** 只释放自己的锁（token 完全一致才删） */
function releaseLock(token) {
  if (!token) return
  if (lockToken() === token) {
    try { rmSync(lockFile(), { force: true }) } catch { /* 忽略 */ }
  }
}

function isRunning() {
  const cur = lockToken()
  if (!cur) return false
  return pidAlive(pidOf(cur))
}

// ---------------------------------------------------------------- 跑一次

function countPendingLines() {
  try {
    return readFileSync(join(personaHome(), 'pending.md'), 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function runOnce(cfg, { manual = false } = {}) {
  const owner = acquireLock()
  if (!owner) return { ok: false, error: '上一轮还在跑（或锁没释放），这次先跳过' }

  // 「为哪一天跑的」——跨午夜也不会记错
  const runForDay = localDate()

  /** 任何结束路径都要走到这里：写结果 + 记「今天跑过」（避免每分钟重试） */
  let finalized = false
  const finalize = (result) => {
    if (finalized) return
    finalized = true
    try {
      writeCfg({ lastRun: localStamp(), lastResult: result, lastFiredDay: runForDay })
      log(`结束 · ${result}`)
    } catch (e) {
      log(`写结果失败：${e?.message ?? e}`)
    }
    releaseLock(owner)
  }

  try {
    ensurePersonaHome()
    ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity, persona: cfg.persona })
    try {
      const ext = syncExternalSources().filter((x) => x.active)
      if (ext.length) log('外部源已同步：' + ext.map(function (x) { return x.id + '(' + x.entries + ' 条)' }).join('、'))
    } catch (e) { log('外部源同步失败：' + (e?.message ?? e)) }

    const sourceCheck = inspectRegisteredSources()
    if (sourceCheck.issues.length) {
      const msg = '源路径不安全，已停止：' + sourceCheck.issues.map((x) => x.dir).join('、')
      log(msg)
      finalize(msg)
      return { ok: false, error: msg }
    }

    const charter = join(personaHome(), 'distill.md')
    const overlay = ensureOverlay(cfg.model, cfg.provider)
    const today = runForDay

    // 基线
    const agentsBefore = existsSync(agentsFile()) ? readFileSync(agentsFile(), 'utf8') : ''
    const snap = snapshotAgents()
    const pendingBefore = countPendingLines()
    const stateFile = join(personaHome(), 'state.json')
    const runLogFile = join(personaHome(), 'run.log')
    let runLogBefore = 0
    try { runLogBefore = existsSync(runLogFile) ? statSync(runLogFile).mtimeMs : 0 } catch { /* 忽略 */ }
    let stateMtimeBefore = 0
    try { stateMtimeBefore = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0 } catch { /* 忽略 */ }

    const prompt = `读 ${charter}，按它做今天的蒸馏。今天是 ${today}。做完在 ${join(personaHome(), 'run.log')} 追加一行。`
    const cmd = buildHeadlessCommand({ overlay, prompt })
    if (cmd.missing) {
      finalize('找不到 dsh CLI（可设置 DSH_BIN 环境变量）')
      return { ok: false, error: '找不到 dsh CLI：请设置 DSH_BIN 环境变量后重启' }
    }

    log(`开始蒸馏${manual ? '（手动）' : ''}：${today}，pid=${pidOf(owner)}`)
    const child = spawn(cmd.command, cmd.args, {
      cwd: dshHome(),
      env: { ...process.env, ...cmd.env, DSH_HOME: dshHome() },
      windowsHide: true,
    })

    let out = ''
    let settled = false
    let spawnErr = ''

    const finish = (code) => {
      if (settled) return
      settled = true
      let result = ''
      try {
        // 1) 内容 + 结构校验
        const after = existsSync(agentsFile()) ? readFileSync(agentsFile(), 'utf8') : ''
        const v = verifyPersona(agentsBefore, after)
        if (!v.ok) {
          const ok = restoreFrom(snap)
          result = `⚠️ ${v.why}，${ok ? '已回滚到跑之前' : '回滚失败'}`
          log(`人格异常：${v.why}；回滚=${ok}；快照=${snap || '无'}`)
        }
      } catch (e) {
        log(`校验人格时出错：${e?.message ?? e}`)
      }

      // 2) 有没有产出
      if (!result) {
        try {
          const pendingAfter = countPendingLines()
          let stateMtimeAfter = 0
          let runLogAfter = 0
          try { stateMtimeAfter = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0 } catch { /* 忽略 */ }
          try { runLogAfter = existsSync(runLogFile) ? statSync(runLogFile).mtimeMs : 0 } catch { /* 忽略 */ }
          const changed = pendingAfter !== pendingBefore || stateMtimeAfter !== stateMtimeBefore || runLogAfter !== runLogBefore
          if (spawnErr) result = spawnErr
          else if (code === null) result = '进程异常结束（没有退出码）'
          else if (code !== 0) result = `exit=${code}`
          else if (!changed) result = '完成，但没有任何产出（看日志）'
          else result = '完成'
        } catch (e) {
          result = `完成（判定产出时出错：${e?.message ?? e}）`
        }
      }

      // 3) 定型了就说一声
      try {
        if (cfg.wechatNotify !== 'off') {
          const sec = (x) => {
            const m = String(x).match(/<!-- AUTO:BEGIN -->([\s\S]*?)<!-- AUTO:END -->/)
            return m ? m[1].trim() : null
          }
          const b = sec(agentsBefore)
          const a = sec(existsSync(agentsFile()) ? readFileSync(agentsFile(), 'utf8') : '')
          if (b !== null && a !== null && b !== a) {
            const ok = notifyWechat('🐋 人格更新 · ' + runForDay + '\n「我学来的」重写了。详见 ~/.dsh/AGENTS.md')
            log(ok ? '微信通知已发' : '微信通知跳过（没装微信插件）')
          }
        }
      } catch (e) {
        log('微信通知出错：' + (e?.message ?? e))
      }
      if (out) {
        try { writeFileSync(join(pluginHome(), 'last-run.txt'), out, 'utf8') } catch { /* 忽略 */ }
      }
      finalize(result)
    }

    child.stdout?.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString() })
    child.stderr?.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString() })
    child.on('error', (e) => {
      spawnErr = `启动失败：${e?.message ?? e}`
      finish(null)
    })
    child.on('close', (code) => finish(code))

    return { ok: true, pid: child.pid }
  } catch (e) {
    const msg = `启动异常：${e?.message ?? e}`
    log(msg)
    finalize(msg)
    return { ok: false, error: msg }
  }
}

// ---------------------------------------------------------------- 到点判断

/**
 * 当天内任意时刻都算「该跑」—— 不再设 6 小时窗口。
 * 窗口的副作用是「10:30 之后才开机的人永远不跑」，比补跑晚一点糟糕得多。
 */
function dueNow(cfg, now = new Date()) {
  if (!cfg.enabled) return false
  const today = localDate(now)
  if (cfg.lastFiredDay === today || memoryFiredDay === today) return false
  const t = normalizeRunAt(cfg.runAt)
  if (!t) return false
  const [h, m] = t.split(':').map(Number)
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  return now >= target
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, code, obj) {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let size = 0
    let done = false
    const finish = (v) => { if (done) return; done = true; resolve(v) }
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); finish({}); return }
      data += c
    })
    req.on('end', () => {
      try { finish(data ? JSON.parse(data) : {}) } catch { finish({}) }
    })
    req.on('error', () => finish({}))
    req.on('aborted', () => finish({}))
  })
}

// ---------------------------------------------------------------- 微信通知（可选）

/**
 * 定型了就跟主人说一声。没装微信插件就安静跳过 —— 不报错、不打扰。
 * 用 Electron 当 node 跑微信插件的 cli，跟本机脚本里那条路一样。
 */
function notifyWechat(text) {
  try {
    const cli = join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-wechat-plugin', 'cli.js')
    if (!existsSync(cli)) return false
    const child = spawn(process.execPath, [cli, text], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome() },
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    if (child.unref) child.unref()
    return true
  } catch (e) {
    log('微信通知失败：' + (e?.message ?? e))
    return false
  }
}

// ---------------------------------------------------------------- 插件入口

let cliCache = { v: null, at: 0 }
let memoryFiredDay = '' // 配置写不进去时的兜底，避免每分钟重试

export function apply(ctx, config) {
  // 只在用户开过、或已经有面板时补骨架 —— 不替用户凭空造人格
  try {
    const cfg = readCfg()
    if (cfg.enabled) {
      ensurePersonaHome()
      ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity, persona: cfg.persona })
      try { syncExternalSources() } catch (e) { log('外部源同步失败：' + (e?.message ?? e)) }
    }
  } catch (e) {
    log(`初始化失败：${e?.message ?? e}`)
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method !== 'GET' && !trustedRequestOrigin(req)) {
      return sendJson(res, 403, { ok: false, error: '请求来源不匹配' })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/status') {
      const cfg = readCfg()
      if (Date.now() - cliCache.at > 5 * 60 * 1000) {
        cliCache = { v: !buildHeadlessCommand({ prompt: 'x' }).missing, at: Date.now() }
      }
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        sources: probeSources(),
        // ⭐ 装了人格插件就推荐另外七个兄弟插件（各装各的，缺谁都能跑）
        siblings: otherSiblings('dsh-persona-distill'),
        agents: readAgentsSections(),
        home: dshHome(),
        hasDsh: cliCache.v,
        hasWechat: existsSync(join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-wechat-plugin', 'cli.js')),
        running: isRunning(),
        dueNow: dueNow(cfg),
        external: probeExternalSources(),
      })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/probe') {
      return sendJson(res, 200, { ok: true, sources: probeSources() })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/log') {
      const lines = Math.min(200, Math.max(10, Number(url.searchParams.get('lines')) || 60))
      try {
        const all = readFileSync(join(pluginHome(), 'run.log'), 'utf8').split('\n')
        return sendJson(res, 200, { ok: true, lines: all.slice(-lines) })
      } catch {
        return sendJson(res, 200, { ok: true, lines: [] })
      }
    }

    if (req.method === 'POST' && path === '/api/persona-distill/config') {
      const body = await readBody(req)
      const clean = {}
      if ('enabled' in body) clean.enabled = body.enabled === true || body.enabled === 'true'
      if ('runAt' in body) {
        const v = normalizeRunAt(body.runAt)
        if (!v) return sendJson(res, 400, { ok: false, error: '时间要写成 HH:mm（比如 04:10）' })
        clean.runAt = v
      }
      if ('persona' in body) clean.persona = body.persona === 'clam' ? 'clam' : 'blank'
      for (const k of ['ownerName', 'heart', 'identity']) {
        if (k in body) clean[k] = String(body[k] ?? '').slice(0, 2000)
      }
      const r = writeCfg(clean)
      if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
      if (r.config.enabled) {
        try {
          ensurePersonaHome()
          ensureAgents({
            ownerName: r.config.ownerName, heart: r.config.heart,
            identity: r.config.identity, persona: r.config.persona,
          })
        } catch (e) { log(`保存后补骨架失败：${e?.message ?? e}`) }
      }
      return sendJson(res, 200, { ok: true, config: r.config })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/run') {
      if (isRunning()) return sendJson(res, 200, { ok: false, error: '上一轮还在跑' })
      const r = runOnce(readCfg(), { manual: true })
      return sendJson(res, 200, r.ok ? r : { ok: false, error: r.error })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/connect') {
      const body = await readBody(req)
      const id = String(body.id || '').trim()
      const rawDir = String(body.dir || `${id}-duty`).trim()
      if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'id 只能用字母数字和 -' })
      if (!/^[A-Za-z0-9._-]+$/.test(rawDir) || rawDir === '.' || rawDir === '..') {
        return sendJson(res, 400, { ok: false, error: '目录名不合法' })
      }
      if (isReservedSourceDir(rawDir)) return sendJson(res, 400, { ok: false, error: '人格、全局记忆和插件运行目录不能接成蒸馏源' })
      const base = resolve(dshHome())
      const dir = join(base, rawDir)
      if (!(resolve(dir) === base || resolve(dir).startsWith(base + sep))) {
        return sendJson(res, 400, { ok: false, error: '目录必须在家目录里面' })
      }
      try {
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'source.json')
        if (existsSync(file)) {
          // 已存在但停用的：点一下就重新启用（不然这个按钮永远没反应）
          try {
            const cur = JSON.parse(readFileSync(file, 'utf8'))
            if (cur.enabled === false) {
              cur.enabled = true
              writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8')
            }
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: 'source.json 坏了，先修好它：' + (e?.message ?? e) })
          }
        } else {
          writeFileSync(file, JSON.stringify({
            id, name: String(body.name || id), charter: 'duty.md',
            voice: 'voice.md', notes: 'notes.md', digestDir: 'digest',
            enabled: true, added: localDate(),
          }, null, 2), 'utf8')
        }
        const made = [file]
        const voiceF = join(dir, 'voice.md')
        if (!existsSync(voiceF)) {
          writeFileSync(voiceF, [
            `# 说话样本 · ${String(body.name || id)}`, '',
            '> 每轮往这里记：**原句 + 一句为什么好**。只学说法，不抄去发。',
            '> 格式：`- 「原句」—— 为什么好`', '',
            '（还没样本。装好对应的抓取工具后，它会自己往里写。）', '',
          ].join('\n'), 'utf8')
          made.push(voiceF)
        }
        const notesF = join(dir, 'notes.md')
        if (!existsSync(notesF)) {
          writeFileSync(notesF, [
            `# 想明白的事 · ${String(body.name || id)}`, '',
            '> 每轮最多 3 条。**写条件，别写口号**。',
            '> 格式：`- <日期> · 结论`', '',
            '（还没结论。）', '',
          ].join('\n'), 'utf8')
          made.push(notesF)
        }
        const digestDir = join(dir, 'digest')
        if (!existsSync(digestDir)) { mkdirSync(digestDir, { recursive: true }); made.push(digestDir) }
        return sendJson(res, 200, { ok: true, file, created: made })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/persona-distill',
      handler: async (req, res) => {
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'persona-distill: /api/persona-distill 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  // ---- 定时器：整段包住，抛异常只写日志 ----
  const timer = setInterval(() => {
    try {
      const cfg = readCfg()
      if (!dueNow(cfg)) return
      if (isRunning()) return
      log(`到点触发（${cfg.runAt}${cfg.lastFiredDay ? '，上次为 ' + cfg.lastFiredDay + ' 跑' : '，首次'}）`)
      runOnce(cfg)
    } catch (e) {
      log(`定时任务异常：${e?.message ?? e}`)
      try { writeCfg({ lastResult: `定时任务异常：${e?.message ?? e}` }) } catch { /* 忽略 */ }
    }
  }, 60_000)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'persona-distill: 每日定时器')

  log(`已挂载（家=${dshHome()}，定时=${readCfg().runAt}）`)
}
