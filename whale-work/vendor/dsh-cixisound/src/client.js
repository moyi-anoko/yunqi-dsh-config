/**
 * client.js — 「插件 → 已安装 → dsh-cixisound」详情页里的 **声音分析** 区块。
 * 宿主侧只提供 /dsh-cixisound/api/*；本文件只负责渲染与读写。
 *
 * 契约（照 @deepseek-ai/dsh-client-modules 与 slot-contract 的实现）：
 *   - package.json 的 `exports["./client"]` 指向本文件
 *   - package.json 里声明 `dsh.client = { platform: "web" }`
 *   - 模块用 `window.__ModuleLoader__.load({ id, factory })` 包装，React 由 require("react") 取
 *   - 客户端 `inject = ["slots"]`；用 ctx.slots.inject("plugins.detail.section", register, desc) 挂载
 *   - 契约要求：不是自己负责的 subject 必须返回 null，否则会挂到所有插件详情页
 */
window.__ModuleLoader__.load({
  id: 'dsh-cixisound',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = '/dsh-cixisound/api';
    const CSS_ID = 'dsh-cixisound/section.css';
    const CSS = `
.sdt{max-width:760px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}
.sdt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.sdt-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}
.sdt-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.sdt-row:last-child{border-bottom:none}
.sdt-label{font-size:13px;line-height:19px}
.sdt-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}
.sdt-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:190px;outline:none}
.sdt-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.sdt-warn{margin-top:10px;padding:8px 10px;border-radius:6px;font-size:12.5px;line-height:18px;background:rgba(255,176,32,.12);border:1px solid rgba(255,176,32,.35);color:#ffb020}
.sdt-ok{color:#3fb950}
.sdt-actions{margin-top:14px;display:flex;gap:8px;align-items:center}
.sdt-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:13px;height:30px;padding:0 14px;cursor:pointer}
.sdt-btn:disabled{opacity:.5;cursor:default}
.sdt-btn2{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.sdt-dirty{font-size:12.5px;color:#ffb020}
.sdt-err{margin-top:10px;color:#f85149;font-size:12.5px;white-space:pre-wrap}
`;

    function injectCss() {
      if (document.getElementById(CSS_ID)) return;
      const el = document.createElement('style');
      el.id = CSS_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    const DEVICE_OPTS = [
      ['auto', '自动（显存 ≥ 4 GB 用 GPU，否则 CPU）'],
      ['gpu', '只用 GPU（显存不足会自动退回 CPU）'],
      ['cpu', '只用 CPU（最稳，最慢）'],
    ];
    const SEP_OPTS = [
      ['auto', '自动（ONNX → Demucs → HPSS）'],
      ['onnx', 'MDX-Net ONNX（不需要 torch）'],
      ['demucs', 'Demucs（需要 torch，GPU 时更快）'],
      ['hpss', 'HPSS（零依赖兜底，质量差）'],
    ];
    const MODEL_OPTS = [['medium', 'medium（1.46 GB）'], ['large-v3', 'large-v3（2.95 GB，可选）']];

    function Row({ label, hint, children }) {
      return h('div', { className: 'sdt-row' },
        h('div', null,
          h('div', { className: 'sdt-label' }, label),
          hint ? h('div', { className: 'sdt-hint' }, hint) : null),
        children);
    }

    function SoundTrySection() {
      const [cfg, setCfg] = useState(null);
      const [saved, setSaved] = useState(null);
      const [meta, setMeta] = useState(null);
      const [busy, setBusy] = useState('');
      const [err, setErr] = useState('');
      const [out, setOut] = useState('');

      const load = useCallback(async () => {
        setBusy('load'); setErr('');
        try {
          const r = await fetch(`${API}/settings`, { credentials: 'same-origin' });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '读取失败');
          setCfg(j.config); setSaved(j.config); setMeta(j);
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(''); }
      }, []);

      useEffect(() => { injectCss(); load(); }, [load]);

      const save = useCallback(async () => {
        setBusy('save'); setErr(''); setOut('');
        try {
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cfg),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '保存失败');
          setCfg(j.config); setSaved(j.config); setMeta(j);
          setOut('已保存。下一次工具调用就生效，不用重启。');
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(''); }
      }, [cfg]);

      if (!cfg) {
        return h('div', { className: 'sdt' },
          h('h3', { className: 'sdt-title' }, '声音分析'),
          err ? h('div', { className: 'sdt-err' }, err) : h('div', { className: 'sdt-hint' }, '读取中…'));
      }

      const dirty = saved && JSON.stringify(cfg) !== JSON.stringify(saved);
      const vram = meta?.vram;
      const eff = meta?.effective;
      const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.value });

      return h('div', { className: 'sdt' },
        h('h3', { className: 'sdt-title' }, '声音分析'),
        h('p', { className: 'sdt-intro' }, '转写、节奏、旋律、和弦、结构。全本地，零 API。'),

        h(Row, { label: '推理设备', hint: '显存小于 4 GB 时 GPU 不可用，会自动使用 CPU。' },
          h('select', { className: 'sdt-select', value: cfg.device, onChange: set('device'), disabled: !!busy },
            DEVICE_OPTS.map(([v, t]) => h('option', { key: v, value: v }, t)))),

        h(Row, { label: '分离后端', hint: 'MDX-Net 不需要 torch；Demucs 质量略低但 GPU 上更快。' },
          h('select', { className: 'sdt-select', value: cfg.separator, onChange: set('separator'), disabled: !!busy },
            SEP_OPTS.map(([v, t]) => h('option', { key: v, value: v }, t)))),

        h(Row, { label: '转写模型', hint: 'medium 已够用；large-v3 需另下 1.5 GB。' },
          h('select', { className: 'sdt-select', value: cfg.model, onChange: set('model'), disabled: !!busy },
            MODEL_OPTS.map(([v, t]) => h('option', { key: v, value: v }, t)))),

        h(Row, { label: '检测到的 GPU' },
          h('div', { className: vram === null ? 'sdt-hint' : 'sdt-ok' },
            vram === null ? '未检测到 NVIDIA 显卡' : `${vram} GB 显存 · 实际使用 ${eff === 'gpu' ? 'GPU' : 'CPU'}`)),

        meta?.warning ? h('div', { className: 'sdt-warn' }, meta.warning) : null,

        h('div', { className: 'sdt-actions' },
          h('button', { className: 'sdt-btn', onClick: save, disabled: !!busy || !dirty },
            busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'sdt-btn sdt-btn2', onClick: load, disabled: !!busy }, '重新读取'),
          dirty ? h('span', { className: 'sdt-dirty' }, '● 有改动还没保存') : null),

        err ? h('div', { className: 'sdt-err' }, err) : null,
        out ? h('div', { className: 'sdt-hint' }, out) : null,
        meta?.configPath ? h('div', { className: 'sdt-hint' }, `配置文件：${meta.configPath}`) : null);
    }

    const inject = ['slots'];
    const OWN = 'dsh-cixisound';

    /**
     * 插件详情页（插件 → 已安装 → 点进来）的 subject 形状：
     *   { kind: 'bundle' | 'row' | 'package', name, version, spec, pkg? }
     * 契约要求：不是自己负责的页面就返回 null，否则这个区块会挂到所有插件上。
     */
    function isOwnSubject(subject) {
      if (!subject) return false;
      const bag = [
        subject.name, subject.spec, subject.key, subject.id,
        subject.pkg?.name, subject.pkg?.spec,
      ].filter(Boolean).map(String).join(' ');
      return bag.includes(OWN);
    }

    function SoundTryDetailSection(props) {
      if (!isOwnSubject(props?.subject)) return null;
      return h(SoundTrySection, null);
    }

    function apply(ctx) {
      // 「插件 → 已安装 → dsh-cixisound」详情页里的区块。
      // 不挂全局「设置」页：用户要的是"跟着插件走"，两处都放会重复。
      ctx.effect(
        () => ctx.slots.inject(
          'plugins.detail.section',
          () => ctx.slots.register(
            { name: 'plugins.detail.section', id: 'soundtry-detail', order: 100, label: () => '声音分析' },
            SoundTryDetailSection,
          ),
          'soundtry: plugin detail section',
        ),
        'soundtry: plugin detail section',
      );
    }

    exports.SoundTrySection = SoundTrySection;
    exports.SoundTryDetailSection = SoundTryDetailSection;
    exports.isOwnSubject = isOwnSubject;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
