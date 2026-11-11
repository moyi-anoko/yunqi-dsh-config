import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = 'C:/Users/35218/.dsh/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const APPLY = process.argv.includes('--apply')
const MAX_BYTES = 1024
const PROTECT = [/^onebot-/, /^bili-whale/, /^orchestrator-/, /^worker-/, /^session-832ef0fd/, /^session-b3ede19e/, /^session-3d6083e0/]

function header(file) {
  try {
    const b = readFileSync(file)
    const s = b.indexOf(MAGIC)
    if (s === -1) return null
    const n = b.indexOf(MAGIC, s + 4)
    const t = zstdDecompressSync(b.subarray(s, n === -1 ? b.length : n)).toString('utf8')
    return JSON.parse(t.split('\n').find((l) => l.trim()))
  } catch { return null }
}

const picked = []
for (const ws of readdirSync(ROOT, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const wsPath = join(ROOT, ws.name)
  for (const d of readdirSync(wsPath, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (PROTECT.some((re) => re.test(d.name))) continue
    const dir = join(wsPath, d.name)
    const file = join(dir, 'session.v4.jsonl.zstd')
    let size = 0
    try { size = statSync(file).size } catch { continue }
    if (size >= MAX_BYTES) continue
    const h = header(file)
    if (h?.origin === 'subagent') continue
    picked.push({ ws: ws.name, name: d.name, size, at: h?.createdAt ? new Date(h.createdAt).toISOString().slice(0, 10) : '?' })
    if (APPLY) rmSync(dir, { recursive: true, force: true })
  }
}
console.log(JSON.stringify({ apply: APPLY, count: picked.length, sessions: picked.map((p) => `${p.at} ${p.ws.slice(2, 26)} ${p.name} (${p.size}B)`) }, null, 2))
