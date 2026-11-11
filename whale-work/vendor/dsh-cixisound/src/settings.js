/**
 * settings.js — 宿主侧的配置读写 + 显存探测。
 *
 * 和 Python 侧共用同一份文件：~/.dsh/soundtry.json（`loadConfig` 早就读它）。
 * 关键点：**读-改-写**，只动我们认识的键，别把用户手写的 python/comfyui 抹掉。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_NAME = 'cixisound.json';

export function configPath(env = process.env) {
  return join(env.DSH_HOME?.trim() || join(homedir(), '.dsh'), CONFIG_NAME);
}

/**
 * 读 JSON 前先剥 BOM，并在解析失败时**明确警告**。
 *
 * 为什么：用户手工编辑配置（记事本默认存 UTF-8 with BOM）时，JSON.parse 会抛
 * `Unexpected token '\uFEFF'`；以前 catch 是空的，表现成"配置明明写了却不生效、
 * 还退回默认模型"，排查很费时间（B 站反馈的原话）。
 */
function readJsonFile(path) {
  const raw = fs.readFileSync(path, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

export function readRaw(env = process.env) {
  const base = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  for (const name of [CONFIG_NAME, 'soundtry.json', 'soundambi.json']) {
    // 后两个是改名前的旧文件：只读回退，不迁移不删除（用户手写的 python/comfyui 还在里面）
    const p = join(base, name);
    if (!fs.existsSync(p)) continue;
    try {
      return readJsonFile(p);
    } catch (e) {
      // 不静默：这条路以前吞掉错误，等于让人白找半天
      console.warn(`[dsh-cixisound] 配置文件解析失败，将忽略它：${p}（${e && e.message}）。`
        + ' 如果是 BOM 问题，插件会自动剥掉；其余情况请检查 JSON 语法。');
      continue;
    }
  }
  return {};
}

/** 只接受白名单里的种类，避免把任意键写进配置文件。 */
export const ALLOWED = {
  device: ['auto', 'gpu', 'cpu'],
  separator: ['auto', 'onnx', 'demucs', 'hpss'],
  model: ['medium', 'large-v3'],
};

export function normalize(raw = {}) {
  const pick = (k, fallback) => (ALLOWED[k].includes(raw[k]) ? raw[k] : fallback);
  return {
    device: pick('device', 'auto'),
    separator: pick('separator', 'auto'),
    model: pick('model', 'medium'),
  };
}

/** 读-改-写：只覆盖白名单里的键。 */
export function writeSettings(patch, env = process.env) {
  const current = readRaw(env);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!ALLOWED[k]) continue;
    if (!ALLOWED[k].includes(v)) throw new Error(`${k} 只能是 ${ALLOWED[k].join(' / ')}`);
    next[k] = v;
  }
  const file = configPath(env);
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * 第一块 NVIDIA 显卡的显存（GB）。查不到返回 null —— 不假装知道。
 * 用 nvidia-smi 而不是 torch：torch 只存在于 borrow 环境里，设置页必须在没有它时也能工作。
 * 诊断用：SOUNDTRY_FAKE_VRAM=3.2 可模拟小显存机器，验证"降级 + 提示"这条路径。
 */
export function vramGb() {
  const fake = Number.parseFloat(process.env.SOUNDTRY_FAKE_VRAM ?? '');
  if (Number.isFinite(fake)) return Promise.resolve(fake);
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const first = String(stdout).trim().split(/\r?\n/)[0];
        const mb = Number.parseFloat(first);
        resolve(Number.isFinite(mb) ? Math.round((mb / 1024) * 10) / 10 : null);
      },
    );
  });
}

export const MIN_GPU_GB = 4;

/** 把「用户想要什么」翻译成「实际会怎么跑」，并把原因说清楚。 */
export async function resolveDevice(env = process.env) {
  const cfg = normalize(readRaw(env));
  const want = cfg.device;
  if (want === 'cpu') {
    return { want, effective: 'cpu', vram: await vramGb(), reason: 'user-cpu', warning: null };
  }
  const vram = await vramGb();
  if (want === 'gpu') {
    if (vram === null) {
      return {
        want, effective: 'cpu', vram,
        reason: 'no-gpu',
        warning: '没有检测到可用的 NVIDIA 显卡，已改用 CPU 推理。',
      };
    }
    if (vram < MIN_GPU_GB) {
      return {
        want, effective: 'cpu', vram,
        reason: 'vram-too-small',
        warning: `显存 ${vram} GB，小于 ${MIN_GPU_GB} GB，暂不支持 GPU 推理加速（已强制 CPU）。`,
      };
    }
    return { want, effective: 'gpu', vram, reason: 'ok', warning: null };
  }
  // auto
  const effective = vram !== null && vram >= MIN_GPU_GB ? 'gpu' : 'cpu';
  return {
    want, effective, vram, reason: effective === 'gpu' ? 'auto-gpu' : 'auto-cpu',
    warning: effective === 'cpu' && vram !== null && vram < MIN_GPU_GB
      ? `显存 ${vram} GB，小于 ${MIN_GPU_GB} GB，自动使用 CPU。`
      : null,
  };
}
