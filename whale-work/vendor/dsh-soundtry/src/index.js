/**
 * index.js — DSH-SoundTry 插件入口。
 *
 * 1.0.2：六个工具 + 设置 API（/dsh-soundtry/api/settings）。
 * 客户端半边 src/client.js 在 DSH「设置」里渲染「声音分析」section，读写同一份配置。
 *
 * 分离默认走 MDX-Net ONNX（onnxruntime，无 torch）；依赖声明在 deps.manifest.json，
 * 首次调用自动装、自动下权重。
 */
import { readSpec, transcribeSpec, rhythmSpec, melodySpec, chordsSpec, structureSpec } from './tools.js';
import { environmentReport } from './runner.js';
import {
  configPath, normalize, readRaw, resolveDevice, writeSettings,
} from './settings.js';

export const name = 'dsh-soundtry';
export const inject = ['tools', 'webServer'];

function fail(error) {
  const message = String(error?.message ?? error);
  return { text: `sound error: ${message}` };
}

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function snapshot() {
  const dev = await resolveDevice();
  return {
    ok: true,
    config: normalize(readRaw()),
    configPath: configPath(),
    vram: dev.vram,
    effective: dev.effective,
    warning: dev.warning,
    minGpuGb: 4,
  };
}

export async function apply(ctx) {
  // 只报状态，不在这里装东西（安装放到第一次真实调用，避免启动时卡住）
  const env = environmentReport();
  if (!env.ready) {
    console.error(`[soundtry] ${env.hint}`);
    console.error(`[soundtry] 依赖源: ${env.base ?? '未找到'}${env.baseWhy ? ` (${env.baseWhy})` : ''}`);
  } else if (process.env.DSH_SOUNDTRY_DEBUG) {
    console.error(`[soundtry] ${JSON.stringify(env)}`);
  }

  const disposers = [];

  // ── 设置 API：给客户端 section 用 ──
  if (ctx.webServer?.register) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-soundtry/api/settings',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') { sendJson(res, 200, await snapshot()); return; }
          if (req.method === 'POST') {
            writeSettings(await readBody(req));
            sendJson(res, 200, await snapshot());
            return;
          }
          sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
        }
      },
    }));
  } else {
    console.error('[soundtry] 没有 webServer 服务，设置页不可用（工具仍可用）');
  }

  const register = (spec) => {
    try {
      disposers.push(ctx.tools.register(spec));
    } catch (error) {
      console.error(`[soundtry] failed to register ${spec.name}: ${error?.message ?? error}`);
    }
  };

  const wrap = (spec) => {
    const inner = spec.execute;
    spec.execute = async (args, exec) => {
      try {
        return await inner(args, exec);
      } catch (error) {
        return fail(error);
      }
    };
    return spec;
  };

  register(wrap(readSpec()));
  register(wrap(transcribeSpec()));
  register(wrap(rhythmSpec()));
  register(wrap(melodySpec()));
  register(wrap(chordsSpec()));
  register(wrap(structureSpec()));

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.(); } catch { /* ignore */ }
    }
  };
}
