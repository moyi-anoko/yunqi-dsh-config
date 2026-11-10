/**
 * dsh-memewiki —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册一个「梗百科」设置页（slot: settings.section）：
 *   - 看词库有多少条、搜词条；
 *   - 点开一条改「用法 / 出处 / 摘要 / 标签」；
 *   - 自己新建词条（标题 + 内容），马上生效（下一轮对话就能查到）。
 *
 * 与宿主端只走同源 HTTP（/api/memewiki/*），不碰 RPC。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memewiki',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useState = React.useState

    var API = '/api/memewiki'

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = data && data.error ? data.error : ('HTTP ' + res.status)
          throw new Error(msg)
        }
        return data
      })
    }
    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.mw-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;min-width:0;font-size:13px}',
      '.mw-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.mw-title{font-size:15px;font-weight:600}',
      '.mw-sub{opacity:.62;font-size:12px}',
      '.mw-search{display:flex;gap:8px;flex:1;min-width:220px}',
      '.mw-input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;font:inherit;outline:none}',
      '.mw-input:focus{border-color:rgba(120,170,255,.8)}',
      '.mw-btn{padding:7px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
      '.mw-btn:hover{background:rgba(127,127,127,.12)}',
      '.mw-btn.primary{border-color:rgba(120,170,255,.75);background:rgba(120,170,255,.16)}',
      '.mw-btn.danger{border-color:rgba(255,110,110,.5);color:rgba(255,130,130,.95)}',
      '.mw-list{display:flex;flex-direction:column;border:1px solid rgba(127,127,127,.22);border-radius:10px;overflow:hidden;max-height:46vh;overflow-y:auto}',
      '.mw-row{display:flex;align-items:flex-start;gap:10px;padding:9px 11px;border-bottom:1px solid rgba(127,127,127,.14)}',
      '.mw-row:last-child{border-bottom:none}',
      '.mw-row:hover{background:rgba(127,127,127,.08)}',
      '.mw-row-main{flex:1;min-width:0}',
      '.mw-name{font-weight:600;margin-bottom:2px}',
      '.mw-tags{font-size:11px;opacity:.6;margin-left:6px;font-weight:400}',
      '.mw-desc{font-size:12px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mw-empty{padding:18px;text-align:center;opacity:.55}',
      '.mw-edit{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:9px;background:rgba(127,127,127,.05)}',
      '.mw-field{display:flex;flex-direction:column;gap:4px}',
      '.mw-field label{font-size:12px;opacity:.68}',
      '.mw-area{min-height:64px;resize:vertical;font:inherit;line-height:1.5;padding:7px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;outline:none}',
      '.mw-area:focus{border-color:rgba(120,170,255,.8)}',
      '.mw-actions{display:flex;gap:8px;justify-content:flex-end}',
      '.mw-note{font-size:12px;padding:8px 10px;border-radius:8px;background:rgba(120,170,255,.12);border:1px solid rgba(120,170,255,.28)}',
      '.mw-note.err{background:rgba(255,110,110,.12);border-color:rgba(255,110,110,.4)}',
      '.mw-pager{display:flex;align-items:center;gap:10px;justify-content:center;font-size:12px;opacity:.8}',
      '.mw-toggle{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.05)}',
      '.mw-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600}',
      '.mw-check input{width:15px;height:15px;cursor:pointer}',
      '.mw-slider{display:flex;align-items:center;gap:10px;margin-top:8px}',
      '.mw-slider input[type=range]{flex:1;cursor:pointer}',
      '.mw-slider span{font-size:12px;opacity:.85;white-space:nowrap}',
    ].join('\n')

    function 串子档(v) {
      if (v <= 20) return '很低：很尊重，黑称不接'
      if (v <= 45) return '偏低：损操作可以，损长相不行'
      if (v <= 70) return '中等：跟着社区玩'
      return '很高：放开串，黑称也玩'
    }

    // ---- 设置页 -----------------------------------------------------------

    var PAGE = 40

    function Section(props) {
      var [q, setQ] = useState('')
      var [items, setItems] = useState([])
      var [total, setTotal] = useState(0)
      var [offset, setOffset] = useState(0)
      var [stats, setStats] = useState(null)
      var [editing, setEditing] = useState(null)
      var [busy, setBusy] = useState(false)
      var [msg, setMsg] = useState(null)
      var [auto, setAuto] = useState(true)
      var [串子开, set串子开] = useState(false)
      var [串子度, set串子度] = useState(50)
      var [版本, set版本] = useState('')
      var [更新, set更新] = useState(null)
      var [查更新中, set查更新中] = useState(false)

      var load = useCallback(function (query, off) {
        setBusy(true)
        apiGet('/list?q=' + encodeURIComponent(query || '') + '&limit=' + PAGE + '&offset=' + (off || 0))
          .then(function (d) {
            setItems((d && d.items) || [])
            setTotal((d && d.total) || 0)
            setOffset(off || 0)
            setMsg(null)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '读词库失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }, [])

      useEffect(function () {
        apiGet('/state').then(function (d) {
          setStats(d)
          set版本((d && d.版本) || '')
          setAuto(d && typeof d.自动思考梗 === 'boolean' ? d.自动思考梗 : true)
          set串子开(!!(d && d.串子开关))
          set串子度(d && typeof d.串子程度 === 'number' ? d.串子程度 : 50)
        }).catch(function () {})
        load('', 0)
      }, [])

      function 检查更新() {
        set查更新中(true)
        set更新(null)
        apiGet('/check-update')
          .then(function (d) {
            set更新(d || { ok: false, error: '没拿到结果' })
            if (d && d.ok) set版本(d.当前 || 版本)
          })
          .catch(function (e) { set更新({ ok: false, error: e.message }) })
          .then(function () { set查更新中(false) })
      }

      function 切换串子() {
        var 下一个 = !串子开
        set串子开(下一个)
        apiPost('/config', { 串子开关: 下一个, 串子程度: 串子度 })
          .then(function (d) {
            set串子开(!!(d && d.串子开关))
            setMsg({
              kind: 'ok',
              text: 下一个
                ? '串子程度：接管了。以后玩梗的尺度按你拉的这根杆来。'
                : '串子程度：关。以后玩梗我自己判断，看它冲谁去。',
            })
          })
          .catch(function (e) { set串子开(!下一个); setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 存串子度(值) {
        var v = Math.max(0, Math.min(100, Math.round(值)))
        set串子度(v)
        apiPost('/config', { 串子开关: 串子开, 串子程度: v })
          .then(function (d) { set串子度(d && typeof d.串子程度 === 'number' ? d.串子程度 : v) })
          .catch(function (e) { setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 切换自动() {
        var 下一个 = !auto
        setAuto(下一个)
        apiPost('/config', { 自动思考梗: 下一个 })
          .then(function (d) {
            setAuto(!!(d && d.自动思考梗))
            setMsg({ kind: 'ok', text: 下一个 ? '自动思考梗：开。以后我察觉你在问梗，会自己去查。' : '自动思考梗：关。以后我不主动查，你叫我查我才查。' })
          })
          .catch(function (e) { setAuto(!下一个); setMsg({ kind: 'err', text: '改不了：' + e.message }) })
      }

      function 搜索() { load(q, 0) }

      function 新建() {
        setEditing({ title: '', tags: '', usage: '', origin: '', summary: '', aliases: '', isNew: true })
        setMsg(null)
      }

      function 编辑(it) {
        setMsg(null)
        var 用行 = function (row) {
          setEditing({
            title: row.title,
            tags: row.tags || '',
            usage: row.usage || '',
            origin: row.origin || '',
            summary: row.summary || '',
            aliases: row.aliases || '',
            isNew: false,
          })
        }
        // 列表里带不全所有字段，编辑前先按标题拉一次完整词条（别名就丢在这上面过）
        apiGet('/get?title=' + encodeURIComponent(it.title))
          .then(function (d) { 用行((d && d.item) || it) })
          .catch(function () { 用行(it) })
      }

      function 保存() {
        if (!editing) return
        var title = String(editing.title || '').trim()
        if (!title) { setMsg({ kind: 'err', text: '标题不能空' }); return }
        setBusy(true)
        apiPost('/save', editing)
          .then(function () {
            setMsg({ kind: 'ok', text: '存好了：' + title })
            setEditing(null)
            load(q, offset)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '保存失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }

      function 删除(it) {
        if (!it) return
        if (!window.confirm('删掉「' + it.title + '」？撤不回来。')) return
        setBusy(true)
        apiPost('/delete', { title: it.title })
          .then(function () {
            setMsg({ kind: 'ok', text: '删了：' + it.title })
            load(q, offset)
          })
          .catch(function (e) { setMsg({ kind: 'err', text: '删除失败：' + e.message }) })
          .then(function () { setBusy(false) })
      }

      var 共 = stats && typeof stats.total === 'number' ? stats.total : total
      var 页数 = Math.max(1, Math.ceil(total / PAGE))
      var 第几页 = Math.floor(offset / PAGE) + 1

      return h('div', { className: 'mw-root' },
        h('div', { className: 'mw-top' },
          h('div', null,
            h('div', { className: 'mw-title' }, '梗百科' + (版本 ? ' · v' + 版本 : '')),
            h('div', { className: 'mw-sub' },
              '词库 ' + 共 + ' 条' + (stats && stats.builtAt ? ' · 建于 ' + stats.builtAt : '') +
              (stats && stats.writable === false ? ' · 只读' : '') +
              ' · 新加的词条下一轮对话就能查到'),
          ),
          h('div', { className: 'mw-search' },
            h('input', {
              className: 'mw-input',
              value: q,
              placeholder: '搜标题 / 标签 / 摘要…',
              onChange: function (e) { setQ(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') 搜索() },
            }),
            h('button', { className: 'mw-btn', onClick: 搜索, disabled: busy }, '搜'),
            h('button', { className: 'mw-btn primary', onClick: 新建 }, '＋ 新建词条'),
            h('button', { className: 'mw-btn', onClick: 检查更新, disabled: 查更新中 }, 查更新中 ? '查…' : '检查更新'),
          ),
        ),

        更新
          ? h('div', { className: 'mw-note' + (更新.ok === false || 更新.有更新 ? ' err' : '') },
              !更新.ok
                ? '检查更新失败：' + (更新.error || '不知道为啥')
                : 更新.有更新
                  ? '有新版本：v' + 更新.最新 + '（你现在 v' + 更新.当前 + '）→ ' + (更新.仓库 || '去 GitHub 拉新版')
                  : '已经是最新版本：v' + 更新.当前,
            )
          : null,

        msg ? h('div', { className: 'mw-note' + (msg.kind === 'err' ? ' err' : '') }, msg.text) : null,

        h('div', { className: 'mw-toggle' },
          h('label', { className: 'mw-check' },
            h('input', { type: 'checkbox', checked: auto, onChange: 切换自动 }),
            h('span', null, '自动思考梗'),
          ),
          h('div', { className: 'mw-sub' },
            auto
              ? '开着：我察觉到你在问梗，会自己去词库查好再接话（每轮带一小段接梗规则）。'
              : '关着：我不主动查。想知道某个梗，直接说「查一下 xxx」或者问我，我再动手。',
          ),
        ),

        h('div', { className: 'mw-toggle' },
          h('label', { className: 'mw-check' },
            h('input', { type: 'checkbox', checked: 串子开, onChange: 切换串子 }),
            h('span', null, '串子程度（手动接管玩梗尺度）'),
          ),
          h('div', { className: 'mw-sub' },
            串子开
              ? '开着：玩梗的尺度按下面这根杆来。'
              : '关着：我自己判断——可以损技术、损操作，不损家人。',
          ),
          串子开
            ? h('div', { className: 'mw-slider' },
                h('input', {
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 5,
                  value: 串子度,
                  onChange: function (e) { set串子度(Number(e.target.value)) },
                  onMouseUp: function (e) { 存串子度(Number(e.target.value)) },
                  onTouchEnd: function (e) { 存串子度(Number(e.target.value)) },
                }),
                h('span', null, 串子度 + ' / 100 · ' + 串子档(串子度)),
              )
            : null,
        ),

        editing
          ? h(Editor, {
              value: editing,
              busy: busy,
              onChange: setEditing,
              onSave: 保存,
              onCancel: function () { setEditing(null); setMsg(null) },
            })
          : null,

        h('div', { className: 'mw-list' },
          items.length === 0
            ? h('div', { className: 'mw-empty' }, busy ? '读着…' : (q ? '没搜到「' + q + '」' : '词库是空的'))
            : items.map(function (it) {
                return h('div', { className: 'mw-row', key: it.title },
                  h('div', { className: 'mw-row-main' },
                    h('div', { className: 'mw-name' }, it.title,
                      it.tags ? h('span', { className: 'mw-tags' }, it.tags) : null),
                    h('div', { className: 'mw-desc' }, it.summary || it.usage || it.origin || '（还没写内容）'),
                  ),
                  h('div', { style: { display: 'flex', gap: '6px' } },
                    h('button', { className: 'mw-btn', onClick: function () { 编辑(it) } }, '改'),
                    h('button', { className: 'mw-btn danger', onClick: function () { 删除(it) } }, '删'),
                  ),
                )
              }),
        ),

        页数 > 1
          ? h('div', { className: 'mw-pager' },
              h('button', { className: 'mw-btn', disabled: busy || offset === 0, onClick: function () { load(q, Math.max(0, offset - PAGE)) } }, '上一页'),
              h('span', null, 第几页 + ' / ' + 页数 + ' 页 · 共 ' + total + ' 条'),
              h('button', { className: 'mw-btn', disabled: busy || offset + PAGE >= total, onClick: function () { load(q, offset + PAGE) } }, '下一页'),
            )
          : null,
      )
    }

    function Editor(props) {
      var v = props.value
      function 改(k) {
        return function (e) {
          var next = Object.assign({}, v)
          next[k] = e.target.value
          props.onChange(next)
        }
      }
      return h('div', { className: 'mw-edit' },
        h('div', { className: 'mw-field' },
          h('label', null, '标题（梗名 / 黑话）'),
          h('input', {
            className: 'mw-input',
            value: v.title,
            disabled: !v.isNew,
            placeholder: '比如：去码头整点薯条',
            onChange: 改('title'),
          }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '标签（空格或逗号隔开都行）'),
          h('input', { className: 'mw-input', value: v.tags, placeholder: '比如：海鸥 人生意义', onChange: 改('tags') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '别名（逗号隔开，打这个词也能查到；缩写就填这儿）'),
          h('input', { className: 'mw-input', value: v.aliases, placeholder: '比如：kskbl,zdjd,wkzkbl', onChange: 改('aliases') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '怎么用 / 怎么接（模型优先看这一段）'),
          h('textarea', { className: 'mw-area', value: v.usage, onChange: 改('usage') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '出处 / 来历'),
          h('textarea', { className: 'mw-area', value: v.origin, onChange: 改('origin') }),
        ),
        h('div', { className: 'mw-field' },
          h('label', null, '摘要（列表里显示的一行解释）'),
          h('textarea', { className: 'mw-area', style: { minHeight: '44px' }, value: v.summary, onChange: 改('summary') }),
        ),
        h('div', { className: 'mw-actions' },
          h('button', { className: 'mw-btn', onClick: props.onCancel, disabled: props.busy }, '取消'),
          h('button', { className: 'mw-btn primary', onClick: props.onSave, disabled: props.busy }, props.busy ? '存着…' : '保存'),
        ),
      )
    }

    /** 设置页错误边界：崩了也要看得见原因，别整块白屏。 */
    class ErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        console.error('[dsh-memewiki] 设置页渲染失败：', error)
      }
      render() {
        if (this.state.error) {
          var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'mw-root' },
            h('div', { className: 'mw-note err' }, '这个设置页渲染时出错了：' + msg),
          )
        }
        return this.props.children
      }
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-memewiki-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-memewiki: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'memewiki',
          order: 47,
          label: function () { return '梗百科' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, null, h(Section, p))
        })
      })
    }

    module.exports = {
      name: 'memewiki',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
