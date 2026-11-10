/**
 * deps.js — DSH-SoundTry 1.0 的依赖层：**声明 → 检测 → 自己装**。
 *
 * 和旧版的区别：旧版"假装 torch 是借来的"，靠 venv 的 --system-site-packages 隐式生效，
 * 文档里还得写清哪些是自带的。1.0 把这些显式列进 deps.manifest.json，并在第一次运行时
 * 按两种模式把环境备齐：
 *
 *   borrow（默认，省空间）  借一台机器上已有的 Python（例如 ComfyUI 自带那个），
 *                          只在插件 venv 里装 faster-whisper / demucs / torchcrepe。
 *                          torch / torchaudio / numpy / librosa 等继续用那边的 —— 省 7 GB。
 *   standalone（兜底）      整一套装进插件 venv，包括 torch（CUDA 轮子，约 2.5 GB 下载）。
 *
 * 幂等：装完写 runtime/ready.json，把 manifest 摘要 + 模式 + 基础解释器 + 模型记进去；
 * 三者有任一变化就重装。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, '..');
export const VENV_DIR = join(PLUGIN_ROOT, 'runtime', 'venv');
export const VENV_PY = join(VENV_DIR, 'Scripts', 'python.exe');
export const MODELS_DIR = join(PLUGIN_ROOT, 'models');
const RUNTIME_DIR = join(PLUGIN_ROOT, 'runtime');
const MARKER = join(RUNTIME_DIR, 'ready.json');
const MANIFEST_PATH = join(PLUGIN_ROOT, 'deps.manifest.json');

const TORCH_LIB_REL = join('Lib', 'site-packages', 'torch', 'lib');

export function homeDir(env = process.env) {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

/** 配置文件：优先 ~/.dsh/soundtry.json；兼容早期写成 soundtry-v1.json 的文件。 */
export function loadConfig(env = process.env) {
  const out = { python: '', comfyui: '', ffmpeg: '', device: '', compute: '', prompt: '', deps: '', model: '', extraPath: [] };
  for (const name of ['soundtry.json', 'soundtry-v1.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(join(homeDir(env), name), 'utf8'));
      for (const k of Object.keys(out)) if (raw?.[k] !== undefined) out[k] = raw[k];
      break;
    } catch { /* 没有就跳过 */ }
  }
  return out;
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function manifestKey(manifest, model) {
  const deps = {
    borrow: manifest.modes?.borrow?.pip ?? [],
    standalone: manifest.modes?.standalone?.pip ?? [],
  };
  const files = manifest.models?.[model]?.files ?? [];
  const assets = (manifest.assets ?? []).map((a) => `${a.name}:${a.expectBytes}`);
  // 不含 manifest.version：改版本号不该触发重装，只有依赖清单/模型/资产变了才重装。
  return JSON.stringify({ deps, files, assets, model });
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return null; }
}

async function writeMarker(data) {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.writeFile(MARKER, JSON.stringify(data, null, 2), 'utf8');
}

/** 跑一个命令，按行透传到 log。 */
function run(cmd, args, { log = () => {}, env = process.env, cwd } = {}) {
  // 沙箱环境里系统 TEMP 不可写：把临时目录固定到工作区内（大肥鱼补丁 2026-11-01）
  const tmpDir = process.env.SOUNDTRY_TMPDIR || 'C:\\Users\\35218\\.dsh\\whale-work\\_pyruntime\\tmp';
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* 忽略 */ }
  env = { ...env, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir };
  return new Promise((res, rej) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd });
    } catch (e) { rej(e); return; }
    const buf = [];
    const onData = (b) => {
      const s = b.toString('utf8');
      buf.push(s);
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) log(t);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', rej);
    child.on('close', (code) => {
      const all = buf.join('');
      if (code !== 0) {
        const tail = all.trim().split(/\r?\n/).slice(-8).join('\n');
        rej(new Error(`${cmd} ${args.slice(0, 3).join(' ')} … 退出码 ${code}\n${tail}`));
        return;
      }
      res(all);
    });
  });
}

/** 探一个解释器：版本、有没有 torch、torch 的 site-packages 在哪。 */
export async function probePython(exe) {
  if (!exe || !fs.existsSync(exe)) return null;
  const code = [
    'import json,sys,platform',
    'd={"version":platform.python_version(),"exe":sys.executable,"hasTorch":False,"torch":"","site":""}',
    'try:',
    ' import torch; d["hasTorch"]=True; d["torch"]=torch.__version__; d["cuda"]=bool(torch.cuda.is_available()); d["site"]=str(__import__("os").path.dirname(__import__("os").path.dirname(torch.__file__)))',
    'except Exception as e: d["torchError"]=str(e)[:120]',
    'print(json.dumps(d))',
  ].join('\n');
  try {
    const out = await run(exe, ['-c', code], { log: () => {} });
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** 找一台机器上"能当依赖源"的 Python：环境变量 → 配置 → ComfyUI → PATH。 */
export function detectBasePython(env = process.env, cfg = loadConfig(env)) {
  const tried = [];
  const take = (p, why) => {
    if (!p) return null;
    tried.push({ path: p, why, exists: fs.existsSync(p) });
    return fs.existsSync(p) ? { python: p, why } : null;
  };
  let hit = take(env.SOUNDTRY_PYTHON, 'env SOUNDTRY_PYTHON');
  if (hit) return { ...hit, tried };
  hit = take(cfg.python, 'config.python');
  if (hit) return { ...hit, tried };
  if (cfg.comfyui) {
    for (const rel of [join('python', 'python.exe'), 'python.exe']) {
      hit = take(join(cfg.comfyui, rel), `config.comfyui/${rel}`);
      if (hit) return { ...hit, tried };
    }
  }
  for (const base of ['D:/ComfyUI', 'C:/ComfyUI', 'E:/ComfyUI']) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      for (const rel of ['python/python.exe', 'python_embeded/python.exe']) {
        hit = take(join(base, d, rel), `自动发现 ${base}/${d}`);
        if (hit) return { ...hit, tried };
      }
    }
  }
  for (const cmd of ['python', 'python3']) {
    hit = take(cmd, 'PATH');
    if (hit) return { ...hit, tried };
  }
  return { python: null, tried };
}

/** 建 venv。borrow 模式必须带 --system-site-packages，否则借不到 torch。 */
async function createVenv(base, mode, log) {
  if (fs.existsSync(VENV_PY)) {
    const probe = await probePython(VENV_PY);
    if (probe) {
      // 已有 venv：只校验模式和它能看到的 torch
      if (mode === 'borrow' && !probe.hasTorch) {
        log('[deps] 现有 venv 看不到 torch，重建');
      } else {
        log('[deps] 复用现有 venv');
        return;
      }
    }
  }
  await fsp.rm(VENV_DIR, { recursive: true, force: true });
  const args = ['-m', 'venv'];
  if (mode === 'borrow') args.push('--system-site-packages');
  args.push(VENV_DIR);
  log(`[deps] 建 venv：${base.python} ${args.join(' ')}`);
  await run(base.python, args, { log });
}

async function pipInstall(py, specs, { mirror, indexUrl, log, force = false }) {
  if (!specs.length) return;
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '-q'];
  if (force) args.push('--ignore-installed', '--no-deps');
  if (indexUrl) args.push('--index-url', indexUrl); else if (mirror) args.push('-i', mirror);
  args.push(...specs);
  log(`[deps] pip install ${specs.join(' ')}`);
  await run(py, args, { log });
}

function modelReady(model, manifest) {
  const spec = manifest.models?.[model];
  if (!spec) return false;
  const dir = join(MODELS_DIR, model);
  const bin = join(dir, 'model.bin');
  if (!fs.existsSync(bin)) return false;
  if (spec.expectBytes) {
    const got = fs.statSync(bin).size;
    if (Math.abs(got - spec.expectBytes) / spec.expectBytes > 0.05) return false;
  }
  return spec.files.every((f) => fs.existsSync(join(dir, f)));
}

async function downloadFile(url, dest, log, signal) {
  log(`[deps] 下载 ${url.split('/').pop()}`);
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  await fsp.mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
}

async function ensureModel(model, manifest, log, signal) {
  const spec = manifest.models?.[model];
  if (!spec) throw new Error(`deps.manifest.json 里没有模型 ${model}`);
  const dir = join(MODELS_DIR, model);
  if (modelReady(model, manifest)) return;
  for (const f of spec.files) {
    const dest = join(dir, f);
    if (fs.existsSync(dest) && !f.endsWith('model.bin')) { log(`[deps] ${f} 已存在`); continue; }
    await downloadFile(`${spec.baseUrl}/${f}`, dest, log, signal);
    if (f === 'model.bin' && spec.expectBytes) {
      const got = fs.statSync(dest).size;
      const pct = (Math.abs(got - spec.expectBytes) / spec.expectBytes) * 100;
      log(`[deps] model.bin ${(got / 1024 ** 2).toFixed(0)} MB（期望 ${(spec.expectBytes / 1024 ** 2).toFixed(0)} MB，差 ${pct.toFixed(1)}%）`);
      if (pct > 5) throw new Error('model.bin 大小不对，可能是重定向/镜像返回了错误内容，删掉重试');
    }
  }
}

/**
 * 额外资产（1.0.2 起）：MDX-Net 分离权重。
 * 这些**不进仓库** —— 仓库只记 URL 和字节数，用户首次运行时下到 models/ 下。
 * 缺了不报错：分离会自动退到 demucs / hpss。
 */
async function ensureAssets(manifest, log, signal) {
  for (const a of manifest.assets ?? []) {
    const dest = join(PLUGIN_ROOT, a.file);
    if (fs.existsSync(dest)) {
      if (!a.expectBytes || Math.abs(fs.statSync(dest).size - a.expectBytes) / a.expectBytes < 0.01) {
        log(`[deps] ${a.name} 已存在`);
        continue;
      }
      log(`[deps] ${a.name} 大小不对，重新下载`);
      await fsp.rm(dest, { force: true });
    }
    try {
      await downloadFile(a.url, dest, log, signal);
      if (a.expectBytes) {
        const got = fs.statSync(dest).size;
        const pct = (Math.abs(got - a.expectBytes) / a.expectBytes) * 100;
        log(`[deps] ${a.name} ${(got / 1024 ** 2).toFixed(1)} MB（差 ${pct.toFixed(2)}%）`);
        if (pct > 1) throw new Error('大小不符，可能被镜像/重定向替换');
      }
    } catch (e) {
      if (a.required) throw e;
      log(`[deps] ⚠ ${a.name} 下载失败（${e.message}）；分离会退到 demucs/hpss`);
    }
  }
}

/**
 * ffmpeg 也按"自己备"处理：优先复制机器上已有的那份（PATH → 旧版插件的 vendor →
 * dsh-video-vision 自带的那份），复制不到才提示手动放。
 * 这样插件不依赖任何别的插件，也不重复下载 60 MB。
 */
async function ensureFfmpeg(env, cfg, log) {
  const dst = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(dst)) return dst;
  const cands = [
    env.DSH_FFMPEG_PATH,
    env.SOUNDTRY_FFMPEG,
    cfg.ffmpeg,
    join(PLUGIN_ROOT, '..', 'dsh-soundtry', 'vendor', 'ffmpeg', 'ffmpeg.exe'),
    join(PLUGIN_ROOT, '..', 'dsh-video-vision', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(c)) {
      await fsp.mkdir(dirname(dst), { recursive: true });
      await fsp.copyFile(c, dst);
      log(`[deps] ffmpeg ← ${c}`);
      return dst;
    }
  }
  // PATH 里找一次
  try {
    const out = await run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { log: () => {} });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) {
      await fsp.mkdir(dirname(dst), { recursive: true });
      await fsp.copyFile(first, dst);
      log(`[deps] ffmpeg ← ${first}`);
      return dst;
    }
  } catch { /* 没有就算了 */ }
  log('[deps] ⚠ 没找到 ffmpeg：把 ffmpeg.exe 放到 vendor/ffmpeg/ 或设 SOUNDTRY_FFMPEG');
  return null;
}

/**
 * 保证环境可用。首次调用会真的装东西，所以要给 log 一个出口。
 * @returns {Promise<{python:string, mode:string, base:string, model:string, ready:boolean, bootstrapped:boolean}>}
 */
export async function ensureReady({ env = process.env, log = () => {}, signal, force = false } = {}) {
  const manifest = readManifest();
  const cfg = loadConfig(env);
  const model = env.SOUNDTRY_MODEL || cfg.model || manifest.defaultModel || 'medium';
  const key = manifestKey(manifest, model);

  const marker = readMarker();
  if (!force && marker?.key === key && fs.existsSync(VENV_PY) && modelReady(model, manifest)) {
    return { python: VENV_PY, mode: marker.mode, base: marker.base, model, ready: true, bootstrapped: false };
  }

  log('[deps] 环境未就绪，开始安装（只需一次）');
  const found = detectBasePython(env, cfg);
  if (!found.python) {
    throw new Error([
      '找不到可用的 Python 作为依赖源。按优先级任选一条：',
      '  1. 环境变量 SOUNDTRY_PYTHON=<python.exe>',
      `  2. ${join(homeDir(env), 'soundtry.json')}：{"python":"C:\\\\...\\\\python.exe"}`,
      '  3. 装一个 Python 3.10–3.12 后重试',
      '（有 ComfyUI 的话直接指它的 python 最省事，torch 不用再下 2.5 GB）',
    ].join('\n'));
  }
  const probe = await probePython(found.python);
  let mode = env.SOUNDTRY_DEPS || cfg.deps || (probe?.hasTorch ? 'borrow' : 'standalone');
  if (mode === 'borrow' && !probe?.hasTorch) {
    log('[deps] 指定的解释器没有 torch，退回 standalone');
    mode = 'standalone';
  }
  log(`[deps] 依赖源 ${found.python}（${found.why}）· 模式 ${mode}${probe ? ` · torch ${probe.torch || '无'}` : ''}`);

  await createVenv({ python: found.python }, mode, log);
  const venvProbe = await probePython(VENV_PY);
  if (!venvProbe) throw new Error('venv 建好了但跑不起来：' + VENV_PY);

  const spec = manifest.modes[mode];
  const mirror = env.SOUNDTRY_PYPI || cfg.pypi || spec.mirror;
  if (mode === 'standalone' && spec.torchIndex) {
    await pipInstall(VENV_PY, spec.torchPackages ?? [], { indexUrl: spec.torchIndex, log });
  }
  await pipInstall(VENV_PY, spec.pip ?? [], { mirror, log });
  // 有些包会被 ComfyUI 的 site-packages "视为已满足"而跳过（onnxruntime 就这样）。
  // 这些要强制装进插件 venv，否则删掉 ComfyUI 就没了。
  if (spec.forceInstall?.length) {
    await pipInstall(VENV_PY, spec.forceInstall, { mirror, log, force: true });
  }

  await ensureModel(model, manifest, log, signal);
  await ensureAssets(manifest, log, signal);
  await ensureFfmpeg(env, cfg, log);

  await writeMarker({ key, mode, base: found.python, python: VENV_PY, model, at: new Date().toISOString() });
  log('[deps] 完成');
  return { python: VENV_PY, mode, base: found.python, model, ready: true, bootstrapped: true };
}

/** 不装东西、只报状态（给启动时的 environmentReport 用）。 */
export function status({ env = process.env } = {}) {
  const manifest = (() => { try { return readManifest(); } catch { return null; } })();
  const cfg = loadConfig(env);
  const model = env.SOUNDTRY_MODEL || cfg.model || manifest?.defaultModel || 'medium';
  const marker = readMarker();
  const found = detectBasePython(env, cfg);
  return {
    ready: fs.existsSync(VENV_PY) && !!marker,
    mode: marker?.mode ?? null,
    base: marker?.base ?? found.python ?? null,
    baseWhy: found.why ?? null,
    model,
    modelReady: manifest ? modelReady(model, manifest) : false,
    manifest: manifest?.version ?? null,
    cudaLib: marker?.base ? join(dirname(marker.base), TORCH_LIB_REL) : null,
  };
}

// 直接跑：node src/deps.js  → 手动触发一次安装
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  ensureReady({ log: (l) => console.error(l) })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error('安装失败：' + e.message); process.exit(1); });
}
