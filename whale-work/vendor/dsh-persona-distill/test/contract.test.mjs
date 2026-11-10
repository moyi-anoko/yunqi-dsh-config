// 契约测试：source.json 的稳定字段 + 三种安装组合
//   A. 消费者单独装：没有任何源 → 扫描为空，不报错
//   B. 生产者单独装：只写了 source.json，也能被按最小协议读懂
//   C. 两者共同装：字段完整映射，enabled:false 视为不接
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRegisteredSources, probeSources, scanRegisteredSources } from '../lib/sources.mjs'

const 造家 = () => mkdtempSync(join(tmpdir(), 'dsh-src-contract-'))

function 在临时家(home, fn) {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { fn() } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
}

function 写源(home, 目录, meta) {
  const dir = join(home, 目录)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'source.json'), JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

test('消费者单独安装：一个源都没有 → 扫描为空、探测全 absent、不抛错', () => {
  const home = 造家()
  try {
    在临时家(home, () => {
      assert.deepEqual(scanRegisteredSources(), [])
      const rows = probeSources()
      assert.ok(rows.length >= 3)
      assert.ok(rows.every((r) => r.status === 'absent' && r.registered === false))
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('生产者单独安装：最小 source.json（只有 id）也能被读懂，其余字段有默认值', () => {
  const home = 造家()
  try {
    写源(home, 'bili-duty', { id: 'bili' })
    在临时家(home, () => {
      const [源] = scanRegisteredSources()
      assert.equal(源.id, 'bili')
      assert.equal(源.voice, 'voice.md')
      assert.equal(源.notes, 'notes.md')
      assert.equal(源.digestDir, 'digest')
      assert.equal(源.enabled, true)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('两者共同安装：字段完整映射，enabled:false 视为不接', () => {
  const home = 造家()
  try {
    const dir = 写源(home, 'bili-duty', {
      id: 'bili', name: 'B站', voice: 'voice.md', notes: 'notes.md', digestDir: 'digest', enabled: false,
    })
    writeFileSync(join(dir, 'voice.md'), '- 样本\n', 'utf8')
    writeFileSync(join(dir, 'notes.md'), '- 结论\n', 'utf8')
    mkdirSync(join(dir, 'digest'), { recursive: true })
    writeFileSync(join(dir, 'digest', '2026-10.md'), '- 2026-10-22 · BV1\n', 'utf8')
    在临时家(home, () => {
      const [源] = scanRegisteredSources()
      assert.equal(源.id, 'bili')
      assert.equal(源.name, 'B站')
      assert.equal(源.dir, 'bili-duty')
      assert.equal(源.enabled, false)
      const 行 = probeSources().find((r) => r.id === 'bili')
      assert.equal(行.status, 'detected')   // 目录在、登记了，但没接上
      assert.equal(行.connected, false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('兼容规则：缺字段用默认值、未知字段忽略、坏 JSON 只跳过那一个源', () => {
  const home = 造家()
  try {
    写源(home, 'weibo-duty', { id: 'weibo', 未来字段: 1, name: undefined })
    mkdirSync(join(home, 'zhihu-duty'), { recursive: true })
    writeFileSync(join(home, 'zhihu-duty', 'source.json'), '{ 这不是 JSON', 'utf8')
    在临时家(home, () => {
      const 源们 = scanRegisteredSources()
      assert.equal(源们.length, 1)                       // 坏的那个被跳过，不拖垮整次扫描
      assert.equal(源们[0].id, 'weibo')
      assert.equal(源们[0].name, 'weibo')                // name 缺 → 退回 id
      assert.ok(!('未来字段' in 源们[0]))                 // 不认识的字段不往外传
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('保留目录永远不会被当成源（人格/记忆/插件运行目录）', () => {
  const home = 造家()
  try {
    for (const d of ['global-memory', 'persona', 'persona-distill']) 写源(home, d, { id: d })
    在临时家(home, () => assert.deepEqual(scanRegisteredSources(), []))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('source.json 的路径不能跳出源目录', () => {
  const home = 造家()
  try {
    写源(home, 'good-duty', { id: 'good', voice: 'voice.md' })
    写源(home, 'bad-duty', { id: 'bad', voice: '../AGENTS.md' })
    在临时家(home, () => {
      const result = inspectRegisteredSources()
      assert.deepEqual(result.sources.map((x) => x.id), ['good'])
      assert.equal(result.issues.length, 1)
      assert.equal(result.issues[0].dir, 'bad-duty')
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
