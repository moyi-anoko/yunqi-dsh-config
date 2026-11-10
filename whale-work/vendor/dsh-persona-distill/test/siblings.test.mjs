import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIBLINGS, otherSiblings } from '../lib/siblings.mjs'

const 根 = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(根, 'package.json'), 'utf8'))

test('兄弟清单覆盖八个插件，包名不重复', () => {
  assert.equal(SIBLINGS.length, 8)
  assert.equal(new Set(SIBLINGS.map((x) => x.pkg)).size, 8)
})

test('每个条目都有中文名和安装用的包名', () => {
  for (const x of SIBLINGS) {
    assert.ok(x.name && x.name.length > 0, x.pkg + ' 缺名字')
    assert.match(x.pkg, /^dsh-(yu-|persona-distill)/)
    assert.ok(x.desc && x.desc.length > 8, x.pkg + ' 缺说明')
  }
})

test('推荐给自己之外的那七个，且不含自己', () => {
  const 别人 = otherSiblings(pkg.name)
  assert.equal(别人.length, 7)
  assert.ok(!别人.some((x) => x.pkg === pkg.name), '推荐列表里不应该有自己')
})

test('本仓的包名在清单里（名字和 package.json 一致）', () => {
  assert.ok(SIBLINGS.some((x) => x.pkg === pkg.name), pkg.name + ' 不在兄弟清单里，清单过期了')
})
