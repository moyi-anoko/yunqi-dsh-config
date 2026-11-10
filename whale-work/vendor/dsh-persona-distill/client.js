/**
 * dsh-persona-distill —— 浏览器半端（设置在「设置」里的一页）
 * ============================================================================
 * 约定（跟 dsh-bili-scroll 学来的）：
 *   · client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 *   · 要进「设置」，用 slots.inject('settings.section', ...)，别自己糊按钮
 *   · id 必须等于 package.json 的 name
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-distill',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/persona-distill'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = (p) => fetch(API + p).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    const S = {
      card: { border: '1px solid var(--dsw-border, #e5e7eb)', borderRadius: 10, padding: 14, marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      label: { width: 120, flex: 'none', fontSize: 13, opacity: 0.8 },
      input: { flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-border, #d1d5db)', fontSize: 13 },
      btn: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsw-border, #d1d5db)', background: 'transparent', cursor: 'pointer', fontSize: 13 },
      hint: { fontSize: 12, opacity: 0.6, marginTop: 4 },
      tag: { fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid currentColor' },
    }

    const STATUS_TEXT = {
      connected: '已接上',
      detected: '发现原料，还没接',
      absent: '没找到',
    }

    function Panel() {
      const [loading, setLoading] = React.useState(true)
      const [err, setErr] = React.useState('')
      const [cfg, setCfg] = React.useState(null)
      const [sources, setSources] = React.useState([])
      const [agents, setAgents] = React.useState(null)
      const [status, setStatus] = React.useState({})
      const [external, setExternal] = React.useState([])
      const [msg, setMsg] = React.useState('')

      const load = async () => {
        setLoading(true); setErr('')
        try {
          const r = await jget('/status')
          setCfg(r.config); setSources(r.sources || []); setAgents(r.agents || null); setStatus(r); setExternal(r.external || [])
        } catch (e) { setErr(e.message) } finally { setLoading(false) }
      }
      React.useEffect(() => { load() }, [])

      const save = async () => {
        try {
          const r = await jpost('/config', cfg)
          setCfg(r.config); setMsg('已保存')
        } catch (e) { setErr(e.message) }
      }

      const run = async () => {
        setMsg('已开始，运行可能需要一两分钟…')
        try {
          await jpost('/config', cfg) // 先落盘，免得跑的是旧配置
          const r = await jpost('/run', {})
          setMsg(r.ok ? '跑起来了（看日志里的进度）' : (r.error || '没跑起来'))
        } catch (e) { setErr(e.message) }
      }

      const connect = async (s) => {
        try {
          await jpost('/connect', { id: s.id, dir: s.dir, name: s.name })
          await load()
          setMsg(`已接上 ${s.name}`)
        } catch (e) { setErr(e.message) }
      }

      if (loading) return h('div', { style: { padding: 12 } }, '加载中…')
      if (err) return h('div', { style: { padding: 12, color: '#b91c1c' } }, '出错了：' + err)

      const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.value })
      const setBool = (k) => (e) => setCfg({ ...cfg, [k]: e.target.checked })

      return h('div', { style: { padding: '4px 2px' } },

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '人格蒸馏'),
          h('div', { style: S.hint }, '上次：' + (cfg.lastRun || '从未跑过') + ' · ' + (cfg.lastResult || '—')),
          status.hasDsh === false ? h('div', { style: { ...S.hint, color: '#b91c1c' } }, '⚠️ 找不到 dsh CLI —— 蒸馏跑不起来（可设置 DSH_BIN 环境变量）') : null,
          status.running ? h('div', { style: { ...S.hint, color: '#b45309' } }, '⏳ 上一轮还在跑') : null,
          cfg.enabled && status.hasWechat === false ? h('div', { style: { ...S.hint, color: '#0369a1', borderLeft: '3px solid #0369a1', paddingLeft: 8 } }, '💬 想让人格定型那天收到一条微信通知？需要先装 dsh-wechat-plugin（装好自动生效）。搞不定就跟你的 AI 说一声，它帮你接。') : null,
          h('div', { style: S.hint },
            '原料天天攒，人格每周长。插件只负责「有原料就蒸馏」，不替你刷内容。'),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h('label', { style: S.label }, '总开关'),
            h('input', { type: 'checkbox', checked: !!cfg.enabled, onChange: setBool('enabled') }),
            h('span', { style: S.hint }, '打开后每天定时跑一次')),
          h('div', { style: S.row },
            h('label', { style: S.label }, '每天几点'),
            h('input', { style: S.input, value: cfg.runAt || '', onChange: set('runAt'), placeholder: '04:10' })),
          h('div', { style: S.row },
            h('label', { style: S.label }, '它怎么叫你'),
            h('input', { style: S.input, value: cfg.ownerName || '', onChange: set('ownerName'), placeholder: '主人' })),
          h('div', { style: S.row },
            h('label', { style: S.label }, '最想让它记住的一句话'),
            h('textarea', {
              style: { ...S.input, minHeight: 60 },
              value: cfg.heart || '', onChange: set('heart'),
              placeholder: '比如：不要当工具，要有自己的看法',
            })),
          h('div', { style: S.row },
            h('label', { style: S.label }, '它是谁（可选）'),
            h('textarea', {
              style: { ...S.input, minHeight: 60 },
              value: cfg.identity || '', onChange: set('identity'),
              placeholder: '留空也行，它会从原料里慢慢长出「我学来的」那段',
            })),
          h('div', { style: S.row },
            h('label', { style: S.label }, '人格模板'),
            h('select', { style: S.input, value: cfg.persona || 'blank', onChange: set('persona') },
              h('option', { value: 'blank' }, '空白（自己填）'),
              h('option', { value: 'clam' }, '大肥鱼（带演法参照）'))),
          h('div', { style: { ...S.hint, marginBottom: 10 } },
            '只在第一次生成人格面板时生效；已经有面板的不会覆盖。'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: save }, '保存'),
            h('button', { style: { ...S.btn, marginLeft: 8 }, onClick: run }, '立即蒸馏一次'),
            msg ? h('span', { style: { ...S.hint, marginLeft: 10 } }, msg) : null)),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '源（原料从哪来）'),
          h('div', { style: S.hint },
            '默认三个都探测，找到就能接上。没装的源不影响使用。'),
          ...sources.map((s) => h('div', {
            key: s.id,
            style: { ...S.row, justifyContent: 'space-between', marginTop: 8 },
          },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 13 } }, `${s.name}（${s.id}）`),
              h('div', { style: S.hint }, s.dirExists ? s.provides : `没找到 ${s.dir} 目录`)),
            h('span', {
              style: {
                ...S.tag,
                color: s.status === 'connected' ? '#047857' : s.status === 'detected' ? '#b45309' : '#6b7280',
              },
            }, STATUS_TEXT[s.status] || s.status),
            s.status === 'detected'
              ? h('button', { style: { ...S.btn, marginLeft: 8 }, onClick: () => connect(s) }, '接上')
              : null))),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '一起用（另外七个）'),
          h('div', { style: S.hint }, '八个插件各管一段：人格、记忆、三个内容源、心情、两个出口。装哪个都不影响别的，缺了会安静跳过。'),
          ...(status.siblings || []).map((x) => h('div', {
            key: x.pkg,
            style: { marginTop: 10, borderTop: '1px solid var(--dsw-border, #e5e7eb)', paddingTop: 8 },
          },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, x.name + '（' + x.pkg + '）'),
            h('div', { style: S.hint }, x.desc),
            h('div', { style: { ...S.hint, fontSize: 11, marginTop: 2, fontFamily: 'ui-monospace, monospace' } },
              'dsh plugin --profile desktop add github:Speraymer/' + x.pkg)))),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '外部源（只读镜像）'),
          h('div', { style: S.hint }, '有些插件不按三份原料的写法，靠适配器镜像进来。装了会自动发现。'),
          ...external.map((x) => h('div', {
            key: x.id,
            style: { ...S.row, justifyContent: 'space-between', marginTop: 8, alignItems: 'flex-start' },
          },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 13 } }, x.name + (x.plugin ? '（' + x.plugin + '）' : '')),
              h('div', { style: S.hint }, x.note),
              x.setup ? h('div', { style: { ...S.hint, color: '#b45309', fontSize: 11, marginTop: 2 } }, '⚠️ ' + x.setup) : null),
            h('span', {
              style: { ...S.tag, color: x.active ? '#047857' : '#6b7280' },
            }, x.active ? '已接上' : '没找到'),
            !x.active && x.install
              ? h('div', { style: { ...S.hint, fontSize: 11, marginLeft: 8 } }, x.install)
              : null))),

        agents && agents.exists
          ? h('div', { style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '现在的人格面板'),
              h('div', { style: S.hint }, `「我学来的」${agents.autoLines} 行 · 手写段 ${agents.hand.split('\n').length} 行`),
              h('pre', {
                style: { fontSize: 12, whiteSpace: 'pre-wrap', opacity: 0.75, maxHeight: 220, overflow: 'auto', marginTop: 8 },
              }, agents.auto || '（还没定型过）'))
          : null,

        h('div', { style: S.hint },
          '改完设置记得点保存。人格文件在 ~/.dsh/AGENTS.md，历史版本在 ~/.dsh/persona/archive/。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'persona-distill', order: 40, label: '人格蒸馏' },
          () => h(Panel),
        ))
      },
    }
  },
})
