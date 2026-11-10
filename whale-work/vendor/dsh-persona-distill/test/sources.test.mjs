import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReservedSourceDir, KNOWN_SOURCES, scanRegisteredSources } from '../lib/sources.mjs'
import { parseJsonText } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

test('人格、全局记忆和插件运行目录永远不是蒸馏源', () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = join(here, 'fixtures')
  try {
    assert.deepEqual(scanRegisteredSources().map((x) => x.id), ['allowed'])
    assert.equal(isReservedSourceDir('global-memory'), true)
    assert.equal(isReservedSourceDir('persona'), true)
    assert.equal(isReservedSourceDir('persona-distill'), true)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

test('蒸馏章程明确隔离自我与记忆', () => {
  const prompt = readFileSync(join(here, '..', 'prompts', 'distill.md'), 'utf8')
  assert.match(prompt, /不要把记忆蒸馏成人格/)
  assert.match(prompt, /global-memory/)
  assert.match(prompt, /当前用户这一次明确说的话/)
})

test('带 UTF-8 BOM 的原有配置仍能读取', () => {
  assert.equal(parseJsonText('\uFEFF{"enabled":true}').enabled, true)
})

test('三个并列内容源都有明确插件入口', () => {
  assert.deepEqual(Object.fromEntries(KNOWN_SOURCES.map((source) => [source.id, source.plugin])), {
    bili: 'dsh-yu-bili',
    weibo: 'dsh-yu-weibo',
    zhihu: 'dsh-yu-zhihu',
  })
})
