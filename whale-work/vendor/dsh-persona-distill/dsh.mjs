/**
 * 找 dsh CLI，并组装一条「跑一次 headless 会话」的命令。
 *
 * 实测过的形状（DSH 0.2.x 桌面版）：
 *   "<应用目录>/DeepSeek Harness.exe" --expose-internals <asar>/.../dsh-desktop-host/lib/cli.js \
 *       headless --patch <overlay.yml> "<任务>"
 * 普通 node 环境则是：
 *   node <dsh>/lib/bin.js headless --patch <overlay.yml> "<任务>"
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

function scanForDsh(dir, depth, budget) {
  if (depth > 7 || budget.n > 4000) return ''
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const d of ents) {
    if (!d.isDirectory()) continue
    if (++budget.n > 4000) return ''
    const p = join(dir, d.name)
    if (d.name === 'dsh') {
      const bin = join(p, 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
    const hit = scanForDsh(p, depth + 1, budget)
    if (hit) return hit
  }
  return ''
}

/** 找 CLI 入口（可能是 asar 里的路径，普通 fs 看不见，所以只做字符串判断不 Test-Path） */
export function findDshCli() {
  const explicit = String(process.env.DSH_BIN || '').trim()
  if (explicit) return explicit

  try {
    const req = createRequire(import.meta.url)
    for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
      try { const p = req.resolve(spec); if (p && existsSync(p)) return p } catch { /* 下一个 */ }
    }
  } catch { /* 解析器不可用 */ }

  for (const g of [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean)) if (existsSync(g)) return g

  // 桌面版：应用目录里搜一遍「dsh/lib/bin.js」
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  try { roots.push(join(dirname(process.execPath), 'resources')) } catch { /* 没有就算了 */ }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const hit = scanForDsh(root, 0, { n: 0 })
    if (hit) return hit
  }
  return ''
}

/** 桌面版专用：在 asar 里找 desktop-host 的 cli.js（bili-scroll 用的就是这条路） */
function findDesktopHostCli() {
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  try { roots.push(join(dirname(process.execPath), 'resources')) } catch { /* 没有就算了 */ }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const asar = join(root, 'app.asar')
    if (!existsSync(asar)) continue
    // asar 内部路径不能 Test-Path，按约定拼
    return join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  }
  return ''
}

/**
 * 返回 { command, args, env } —— args 已经排好序，直接 spawn(command, args, { env })
 * 找不到 CLI 时返回 { missing: true }
 */
export function buildHeadlessCommand({ profile = 'headless', overlay = '', prompt = '' } = {}) {
  const isElectron = Boolean(process.versions.electron)
  let cli = ''

  if (isElectron) {
    // 桌面版优先走 desktop-host/cli.js（实测这条路能起来）
    cli = findDesktopHostCli()
  }
  if (!cli) cli = findDshCli()
  if (!cli) return { missing: true }

  const args = []
  if (isElectron) args.push('--expose-internals')
  args.push(cli, profile)
  if (overlay) args.push('--patch', overlay)
  args.push(prompt)

  return {
    command: process.execPath,
    args,
    env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    cli,
  }
}
