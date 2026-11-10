/**
 * 外部记忆源适配器
 * ============================================================================
 * 有些源不按我们的「三份原料」形状写东西 —— 比如刷B站的手账（长文反思），
 * 或者 dsh-bili-humanism 的 inbox.md。
 *
 * 这一层的活：**把别人的形状，转成我们的形状**。
 *   · 只读，不写别人的目录
 *   · 镜像到 <家>/external-<id>/，蒸馏照常扫 source.json
 *   · 加新源 = 往 ADAPTERS 里加一条，主流程不动
 *
 * 2026-10-23：humanism 的「值得才写」已经合并进刷B站的 duty.md，
 *             所以现在主打的是 bili-journal（journal-<月>.md）。
 *             humanism 那条留着读历史手账（插件卸了，文件还在）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'

// ---------------------------------------------------------------- 切分工具

/** 按篇切：优先 `## ` 标题，其次 `---` 分隔线，都没有就整篇一条 */
function splitByEntry(text) {
  const parts = String(text).split(/^##\s+/m)
  if (parts.length > 1) {
    const chunks = parts.slice(1).map((s) => s.trim()).filter(Boolean)
    if (chunks.length) return chunks
  }
  const byHr = String(text).split(/^\s*---+\s*$/m).map((s) => s.trim()).filter(Boolean)
  if (byHr.length > 1) return byHr
  const whole = String(text).replace(/^#\s+.*$/m, '').trim()
  return whole ? [whole] : []
}

/** 抠一个 `**小节名**` 下面的正文，到下一个 `**小节名**` 为止 */
function extractSection(raw, name) {
  const marker = '**' + name + '**'
  const idx = raw.indexOf(marker)
  if (idx < 0) return ''
  const rest = raw.slice(idx + marker.length)
  const next = rest.search(/\n\s*\*\*[^*]+\*\*/)
  const seg = next >= 0 ? rest.slice(0, next) : rest
  return seg.replace(/\s+/g, ' ').replace(/^-+\s*/, '').trim()
}

/** 从一段里抠出：日期 / 标题 / 摘要 / 认识的修正 / 下一次如何回应 */
function toEntry(chunk, fallbackDate = '') {
  const raw = chunk.replace(/^##\s+/, '').trim()
  if (!raw) return null
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = lines[0] || ''
  const body = lines.slice(1).join(' ').replace(/\s+/g, ' ').trim()
  const date = (raw.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || fallbackDate
  const title = head.replace(/\d{4}-\d{2}-\d{2}/, '').replace(/^[·\-—\s]+/, '').trim() || '一篇手账'

  return {
    date,
    title,
    excerpt: body.slice(0, 300) || '（无正文摘要）',
    revision: extractSection(raw, '认识的修正').slice(0, 240),
    nextResponse: extractSection(raw, '下一次如何回应').slice(0, 240),
  }
}

// ---------------------------------------------------------------- 适配器清单

/**
 * 每个适配器：
 *   id      —— 源 id（写进 source.json，也是来源前缀）
 *   name    —— 人看的名字
 *   plugin  —— 产它的插件名（推荐列表里用）
 *   install —— 怎么装（推荐列表里显示）
 *   files   —— 返回要读的文件路径数组（可以是多个月的 journal）
 *   parse   —— 把文件内容切成条目
 *   note    —— 一句话说明「这个源擅长教什么」
 */
export const ADAPTERS = [
  {
    id: 'bili-journal',
    name: 'B站手账',
    plugin: 'dsh-yu-bili',
    install: '（刷B站自带，duty.md 里已经配好，不用额外装）',
    note: '值得才写的那种 —— 每篇分开写事实/作者观点/我的推测，教「怎么活」',
    files: (home) => {
      const dir = join(home, 'bili-duty')
      if (!existsSync(dir)) return []
      try {
        return readdirSync(dir)
          .filter((f) => /^journal-\d{4}-\d{2}\.md$/.test(f))
          .sort()
          .map((f) => join(dir, f))
      } catch {
        return []
      }
    },
    parse: (text) => splitByEntry(text).map((c) => toEntry(c)).filter(Boolean),
  },

]

// ---------------------------------------------------------------- 同步

/**
 * 把能发现的外部源同步成我们的形状。
 * 返回每个源的状态（给设置页看）。
 */
export function syncExternalSources() {
  const home = dshHome()
  const out = []

  for (const a of ADAPTERS) {
    const base = { id: a.id, name: a.name, plugin: a.plugin, install: a.install, setup: a.setup || '', note: a.note }
    let files = []
    try {
      files = (a.files ? a.files(home) : []).filter((f) => existsSync(f))
    } catch {
      files = []
    }
    if (!files.length) {
      out.push({ ...base, active: false })
      continue
    }
    try {
      const dir = join(home, `external-${a.id}`)
      mkdirSync(join(dir, 'digest'), { recursive: true })

      // 1) 登记（已存在就不覆盖 —— 用户可能改过 enabled）
      const sj = join(dir, 'source.json')
      if (!existsSync(sj)) {
        writeFileSync(sj, JSON.stringify({
          id: a.id,
          name: a.name,
          charter: '',
          voice: 'voice.md',
          notes: 'notes.md',
          digestDir: 'digest',
          enabled: true,
          external: true,
          from: files[0],
        }, null, 2), 'utf8')
      }

      // 2) 说话样本：【外部源不产】—— 但文件要在，免得触发「源读不出」的降级保护
      const voiceF = join(dir, 'voice.md')
      if (!existsSync(voiceF)) {
        writeFileSync(voiceF, `# ${a.name} · voice\n\n（这个外部源不产说话样本，别当它是空的。）\n`, 'utf8')
      }

      // 3) 正文：多个文件合起来切条目
      const text = files.map((f) => readFileSync(f, 'utf8')).join('\n\n')
      const entries = a.parse(text)
      const digestLines = entries.map((e) => `- ${e.date || '—'} · ${e.title} · ${e.excerpt}`)
      writeFileSync(
        join(dir, 'digest', `${a.id}.md`),
        `# ${a.name} · 外部源（从 ${files.length} 个文件同步，只读）\n\n${digestLines.join('\n')}\n`,
        'utf8',
      )

      // 4) 结论：把「认识的修正 / 下一次如何回应」摘进 notes —— 这才是 [活] 的料
      const notesLines = entries
        .map((e) => {
          const bits = [e.revision, e.nextResponse].filter(Boolean)
          if (!bits.length) return null
          return `- ${e.date || '—'} · ${e.title} · ${bits.join(' ／ ')}`
        })
        .filter(Boolean)
      writeFileSync(
        join(dir, 'notes.md'),
        `# ${a.name} · notes（从手账里摘的「修正」和「下次怎么回应」）\n\n` +
          (notesLines.length
            ? notesLines.join('\n')
            : '（这几篇手账里没有「认识的修正」或「下一次如何回应」，暂时没有可摘的结论。）') +
          '\n',
        'utf8',
      )

      out.push({ ...base, active: true, entries: entries.length, notes: notesLines.length, dir, files: files.length })
    } catch (e) {
      out.push({ ...base, active: false, error: String(e?.message ?? e) })
    }
  }

  return out
}

/** 只看状态、不写文件（设置页用） */
export function probeExternalSources() {
  const home = dshHome()
  return ADAPTERS.map((a) => {
    let files = []
    try {
      files = (a.files ? a.files(home) : []).filter((f) => existsSync(f))
    } catch {
      files = []
    }
    return {
      id: a.id,
      name: a.name,
      note: a.note,
      plugin: a.plugin,
      install: a.install,
      setup: a.setup || '',
      active: files.length > 0,
      files: files.length,
      dir: join(home, `external-${a.id}`),
    }
  })
}
