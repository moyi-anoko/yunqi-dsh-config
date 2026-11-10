/**
 * 源探测 —— 默认不假设用户装了任何东西。
 *
 * 已知的三个源：B站 / 微博 / 知乎。
 * 每个源只要在自己的目录里放一份 source.json，蒸馏就能发现它。
 * 插件不负责刷内容，只负责「有原料就蒸馏」。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { dshHome } from './paths.mjs'

const RESERVED_SOURCE_DIRS = new Set(['global-memory', 'persona', 'persona-distill'])

export function isReservedSourceDir(name) {
  return RESERVED_SOURCE_DIRS.has(String(name || '').trim().toLowerCase())
}

const SOURCE_PATHS = {
  charter: 'duty.md',
  voice: 'voice.md',
  notes: 'notes.md',
  digestDir: 'digest',
}

function isInside(base, target) {
  return target !== base && target.startsWith(base + sep)
}

/** source.json 只能指向自己的目录；绝对路径、.. 和越界链接都拒绝。 */
export function safeSourcePath(sourceDir, value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback
  const base = resolve(sourceDir)
  if (isAbsolute(raw) || raw.split(/[\\/]+/).includes('..')) return null
  const target = resolve(base, raw)
  if (!isInside(base, target)) return null
  try {
    const realBase = realpathSync(base)
    if (existsSync(target) && !isInside(realBase, realpathSync(target))) return null
  } catch {
    return null
  }
  return raw
}

/** 已知源：dir 是家目录下的目录名，plugin 是「能产原料」的插件名（空 = 还没有现成的） */
export const KNOWN_SOURCES = [
  {
    id: 'bili',
    name: 'B站',
    dir: 'bili-duty',
    plugin: 'dsh-yu-bili',
    provides: '每天刷一轮 B 站，把说话样本 / 踩过的坑 / 看过的片子记成三份原料',
  },
  {
    id: 'weibo',
    name: '微博',
    dir: 'weibo-duty',
    plugin: 'dsh-yu-weibo',
    provides: '只读刷好友时间线或关键词搜索，把表达样本与归档写成三份人格原料',
  },
  {
    id: 'zhihu',
    name: '知乎',
    dir: 'zhihu-duty',
    plugin: 'dsh-yu-zhihu',
    provides: '刷推荐流、评论和回复，把表达样本接入人格，并按人格限量互动',
  },
]

/** 扫描 <家>/*\/source.json，返回真实存在的源 */
export function inspectRegisteredSources() {
  const home = dshHome()
  const out = []
  const issues = []
  let dirs = []
  try { dirs = readdirSync(home, { withFileTypes: true }) } catch { return { sources: out, issues } }
  for (const d of dirs) {
    if (!d.isDirectory() || isReservedSourceDir(d.name)) continue
    const sourceDir = join(home, d.name)
    const file = join(sourceDir, 'source.json')
    if (!existsSync(file)) continue
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'))
      const paths = {}
      let unsafe = ''
      for (const [field, fallback] of Object.entries(SOURCE_PATHS)) {
        paths[field] = safeSourcePath(sourceDir, meta[field], fallback)
        if (!paths[field]) unsafe = field
      }
      if (unsafe) {
        issues.push({ dir: d.name, error: `source.json 的 ${unsafe} 必须留在源目录内` })
        continue
      }
      out.push({
        id: String(meta.id || d.name),
        name: String(meta.name || meta.id || d.name),
        dir: d.name,
        enabled: meta.enabled !== false,
        ...paths,
      })
    } catch { /* 坏的 source.json 跳过，别让整个探测失败 */ }
  }
  return { sources: out, issues }
}

export function scanRegisteredSources() {
  return inspectRegisteredSources().sources
}

/**
 * 完整探测：已知的三个源各是什么状态。
 * 返回给设置页用 —— 「有了 / 没装 / 已接上」三种状态一目了然。
 */
export function probeSources() {
  const home = dshHome()
  const registered = scanRegisteredSources()
  const regById = new Map(registered.map((s) => [s.id, s]))

  const rows = KNOWN_SOURCES.map((k) => {
    const dirExists = existsSync(join(home, k.dir))
    const reg = regById.get(k.id)
    return {
      id: k.id,
      name: k.name,
      dir: k.dir,
      plugin: k.plugin,
      provides: k.provides,
      // 目录在不在、有没有登记、有没有被蒸馏接上
      dirExists,
      registered: Boolean(reg),
      connected: Boolean(reg && reg.enabled),
      status: reg && reg.enabled
        ? 'connected'
        : dirExists
          ? 'detected'   // 目录有了，但没登记 / 没接上
          : 'absent',    // 连目录都没有
    }
  })

  // 还可能有自定义源（不在已知清单里）
  const knownIds = new Set(KNOWN_SOURCES.map((k) => k.id))
  const extra = registered
    .filter((s) => !knownIds.has(s.id))
    .map((s) => ({
      id: s.id, name: s.name, dir: s.dir, plugin: '',
      provides: '自定义源', dirExists: true, registered: true,
      connected: s.enabled, status: s.enabled ? 'connected' : 'detected',
    }))

  return [...rows, ...extra]
}
