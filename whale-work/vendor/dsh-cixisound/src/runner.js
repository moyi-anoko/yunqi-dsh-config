/**
 * runner.js — 1.0：先确保依赖就绪，再跑 python/soundtry.py。
 *
 * 和旧版最大的差别：不再"假设"venv 已经建好、torch 已经借到。每次调用都会经过
 * deps.ensureReady()——它幂等地检查 runtime/ready.json 与模型文件，缺什么装什么，
 * 装完再执行。所以第一次调用会慢（可能要下 1.4 GB 模型），之后就是秒级。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PLUGIN_ROOT, ensureReady, status, loadConfig,
} from './deps.js';
import { resolveDevice } from './settings.js';

const SCRIPT = join(PLUGIN_ROOT, 'python', 'soundtry.py');
const JSON_MARK = '@@JSON@@';

/** CUDA 运行库（cuDNN 9 / cuBLAS 12）在哪：基础解释器的 torch/lib。 */
export function cudaLibFor(basePython) {
  if (!basePython) return null;
  const p = join(dirname(basePython), 'Lib', 'site-packages', 'torch', 'lib');
  return existsSync(p) ? p : null;
}

/** 启动时用：不触发安装，只报看到的状况。 */
export function environmentReport(env = process.env) {
  const st = status({ env });
  const cfg = loadConfig(env);
  return {
    ...st,
    cudaLib: cudaLibFor(st.base),
    ffmpeg: env.DSH_FFMPEG_PATH || env.SOUNDTRY_FFMPEG || cfg.ffmpeg || null,
    device: env.SOUNDTRY_DEVICE || cfg.device || 'cuda',
    compute: env.SOUNDTRY_COMPUTE || cfg.compute || 'float16',
    pluginRoot: PLUGIN_ROOT,
    hint: st.ready
      ? null
      : '首次调用 sound_* 会自动安装依赖并下载模型（medium ≈ 1.46 GB）。有 ComfyUI 的话会直接借它的 torch，省 7 GB。',
  };
}

/**
 * 跑一个子命令。
 * @param {string} subcommand
 * @param {{args?: string[], env?: object, signal?: AbortSignal, timeoutMs?: number, onProgress?: (line: string) => void}} opts
 * @returns {Promise<{report: string, json: any, stderr: string}>}
 */
export async function runSoundtry(subcommand, opts = {}) {
  const {
    args = [], env = process.env, signal, timeoutMs = 60 * 60 * 1000, onProgress,
  } = opts;
  const cfg = loadConfig(env);

  // 依赖没就绪时，这一段可能跑几分钟（下模型）。日志走 onProgress / stderr。
  const ready = await ensureReady({
    env,
    signal,
    log: (line) => { try { onProgress?.(line); } catch { /* 日志失败不影响安装 */ } },
  });

  // 设置页里的设备选择 → 实际的 cuda/cpu。显存不足时会带一条警告。
  const dev = await resolveDevice(env);
  const cudaLib = cudaLibFor(ready.base);
  const childEnv = { ...env, PYTHONIOENCODING: 'utf-8', KMP_DUPLICATE_LIB_OK: 'TRUE' };
  if (cudaLib) {
    childEnv.PATH = `${cudaLib};${env.PATH ?? ''}`;
    childEnv.CUDA_PATH = childEnv.CUDA_PATH || dirname(cudaLib);
  }
  for (const extra of cfg.extraPath ?? []) {
    if (extra) childEnv.PATH = `${extra};${childEnv.PATH}`;
  }
  if (cfg.ffmpeg) childEnv.DSH_FFMPEG_PATH = childEnv.DSH_FFMPEG_PATH || cfg.ffmpeg;
  childEnv.SOUNDTRY_DEVICE = dev.effective === 'gpu' ? 'cuda' : 'cpu';
  // CPU 上 float16 慢一个数量级（实测 252s 歌：224s vs 13s），所以按设备给默认 compute
  if (!childEnv.SOUNDTRY_COMPUTE && !cfg.compute) {
    childEnv.SOUNDTRY_COMPUTE = dev.effective === 'gpu' ? 'float16' : 'int8';
  }
  if (cfg.compute) childEnv.SOUNDTRY_COMPUTE = childEnv.SOUNDTRY_COMPUTE || cfg.compute;
  if (cfg.prompt) childEnv.SOUNDTRY_PROMPT = childEnv.SOUNDTRY_PROMPT || cfg.prompt;
  childEnv.SOUNDTRY_MODEL = childEnv.SOUNDTRY_MODEL || ready.model;

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(ready.python, [SCRIPT, subcommand, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnv,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`soundtry ${subcommand} 超过 ${Math.round(timeoutMs / 1000)}s 未完成`));
      }, timeoutMs);
      timer.unref?.();
    }
    if (signal) {
      const onAbort = () => { child.kill('SIGKILL'); finish(reject, new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const idx = stdout.lastIndexOf(JSON_MARK);
      const report = (idx >= 0 ? stdout.slice(0, idx) : stdout).trim();
      let json = null;
      if (idx >= 0) {
        try {
          json = JSON.parse(stdout.slice(idx + JSON_MARK.length).trim());
        } catch { /* 交给下面报错 */ }
      }
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        finish(reject, new Error(
          `soundtry ${subcommand} 退出码 ${code}\n${report}\n${tail}`.trim(),
        ));
        return;
      }
      const head = dev.warning ? '⚠ ' + dev.warning + '\n' : '';
      finish(resolvePromise, {
        report: head + report, json, stderr,
        mode: ready.mode, model: ready.model, device: dev.effective,
      });
    });
  });
}
