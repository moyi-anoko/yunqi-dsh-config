import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = 'C:/Users/35218/.dsh/sessions'
const DAYS = Number(process.argv[2] ?? 7)
const APPLY = process.argv.includes('--apply')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const cutoff = Date.now() - DAYS * 86400000

function header(file) {
  try {
    const b = readFileSync(file)
    const s = b.indexOf(MAGIC)
    if (s === -1) return null
    const n = b.indexOf(MAGIC, s + 4)
    const t = zstdDecompressSync(b.subarray(s, n === -1 ? b.length : n)).toString('utf8')
    const line = t.split('\n').find((l) => l.trim())
    return JSON.parse(line)
  } catch {
    return null
  }
}

let targets = 0
let bytes = 0
const skipped = []
for (const ws of readdirSync(ROOT, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const wsPath = join(ROOT, ws.name)
  for (const d of readdirSync(wsPath, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(wsPath, d.name)
    const file = join(dir, 'session.v4.jsonl.zstd')
    let size = 0
    try { size = statSync(file).size } catch { continue }
    const h = header(file)
    if (!h || h.origin !== 'subagent') { skipped.push(d.name); continue }
    if ((h.createdAt ?? 0) >= cutoff) continue
    targets++
    bytes += size
    if (APPLY) rmSync(dir, { recursive: true, force: true })
  }
}
console.log(JSON.stringify({ apply: APPLY, days: DAYS, subagentDirsDeleted: targets, freedMB: +(bytes / 1048576).toFixed(1), nonSubagentDirs: skipped.length }))
