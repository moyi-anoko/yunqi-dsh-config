#!/usr/bin/env node
// orch.mjs — 投任务给 Superagent、查工单、等结果。
// 端口每次 DSH 重启都会变，所以不写死：先看 ORCH_PORT，再扫本机 LISTENING 端口试 API。
// 只读 sqlite 看工单；投任务走 /orchestrator/api/inputs。
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';

const DB = 'C:/Users/35218/.dsh/state/superagent/orchestrator.sqlite';
const H = { 'x-orchestrator-request': '1', 'content-type': 'application/json' };

function log(...a) { console.log(...a); }

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, {
      headers: H, signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && (j.masterId || j.subject || j.health) ? j : null;
  } catch { return null; }
}

async function findPort() {
  if (process.env.ORCH_PORT) {
    const p = Number(process.env.ORCH_PORT);
    if (await probe(p)) return p;
  }
  let out = '';
  try { out = execSync('netstat -ano', { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
  // 监听 socket 在 netstat 里未必标 LISTENING，所以只取出现过的本地端口，并行探。
  const ports = new Set();
  for (const m of out.matchAll(/127\.0\.0\.1:(\d+)/g)) ports.add(Number(m[1]));
  const hits = await Promise.all([...ports].map(async (p) => ((await probe(p)) ? p : 0)));
  const found = hits.filter(Boolean);
  return found.length ? found[0] : null;
}

function openDb() { return new DatabaseSync(DB, { readOnly: true }); }

function tickets() {
  const db = openDb();
  try {
    return db.prepare('SELECT value FROM ticket ORDER BY rowid DESC').all().map((r) => JSON.parse(r.value));
  } finally { db.close(); }
}

function ticket(id) {
  const db = openDb();
  try {
    const r = db.prepare('SELECT value FROM ticket WHERE id = ?').get(id);
    return r ? JSON.parse(r.value) : null;
  } finally { db.close(); }
}

function brief(t) {
  const a = (t.assignments || [])[0] || {};
  const rep = a.report || {};
  return {
    id: t.id,
    title: t.title,
    ended: t.ended ? `${t.ended.outcome} by ${t.ended.by}` : 'open',
    assignment: a.state || '-',
    summary: rep.summary || '',
  };
}

function deriveThread(sessionId) {
  if (!sessionId) return '';
  let m = /^onebot-private-(\d+)/.exec(sessionId);
  if (m) return `qq:private:${m[1]}`;
  m = /^onebot-group-(\d+)/.exec(sessionId);
  if (m) return `qq:group:${m[1]}`;
  const bili = /^bili-(whale(?:-\d+)?)/.exec(sessionId);
  if (bili) return `bili:${bili[1]}`;
  m = /^(?:session-)?([0-9a-f]{8})/i.exec(sessionId);
  if (m) return `session:${m[1].toLowerCase()}`;
  return '';
}

async function submit(text, thread, session) {
  const port = await findPort();
  if (!port) throw new Error('找不到 superagent（DSH 没起或面板没开）');
  const sres = await fetch(`http://127.0.0.1:${port}/orchestrator/api/subject`, { headers: H, signal: AbortSignal.timeout(4000) });
  if (!sres.ok) throw new Error(`拿 subject 失败 HTTP ${sres.status}`);
  const sj = await sres.json();
  const subjectId = sj.subjectId || sj.id;
  if (!subjectId) throw new Error('subject 返回里没有 id');
  const stamp = `yunqi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`http://127.0.0.1:${port}/orchestrator/api/inputs`, {
    method: 'POST',
    headers: H,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      subjectId,
      sourceId: 'local',
      externalEventId: stamp,
      dedupeKey: thread ? thread + '#' + stamp : stamp,
      payload: { text },
      layer: 'person',
      human: true,
      ...(session || thread
        ? {
            provenance: {
              note: [session ? 'session:' + session : '', thread ? 'thread:' + thread : '']
                .filter(Boolean)
                .join('|'),
            },
          }
        : {}),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`投递失败 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return { port, subjectId, ...j };
}

async function waitFor(id, timeoutMs = 300000, everyMs = 3000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const t = ticket(id);
    if (t) {
      const b = brief(t);
      if (b.ended !== 'open') return t;
      if (b.assignment !== last) { last = b.assignment; log(`  ...${b.assignment}`); }
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return ticket(id);
}

const cmd = process.argv[2] || 'status';

try {
  if (cmd === 'status') {
    const port = await findPort();
    if (!port) { log('superagent 不在线（DSH 没起，或面板没开）'); process.exit(1); }
    const st = await (await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, { headers: H })).json();
    const all = tickets();
    const open = all.filter((t) => !t.ended);
    log(`port      ${port}`);
    log(`master    ${st.masterId || '-'}`);
    log(`subject   ${st.subject?.subjectId || '-'}  ${st.subject?.displayName || ''}`);
    log(`health    ${st.health?.runtime?.state || '-'}  load ${JSON.stringify(st.load || {})}`);
    log(`tickets   ${all.length} 总 / ${open.length} 未结`);
    for (const t of all.slice(0, 5)) {
      const b = brief(t);
      log(`  ${b.id.slice(0, 8)}  ${b.ended.padEnd(18)}  ${b.title.slice(0, 40)}`);
    }
  } else if (cmd === 'submit') {
    const raw = process.argv.slice(3);
    let thread = '';
    let session = process.env.DSH_SESSION_ID || ''; const rest = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '--thread' && raw[i + 1]) { thread = raw[++i]; }
      else if (raw[i] === '--session' && raw[i + 1]) {
        const v = raw[++i];
        session = v === 'auto' ? (process.env.DSH_SESSION_ID || '') : v === 'none' ? '' : v;
      }
      else rest.push(raw[i]);
    }
    const text = rest.join(' ').trim();
    if (!text) { log('用法: orch.mjs submit [--thread <线程|auto>] [--session <会话id|auto|none>] "任务文本"'); process.exit(2); }
    const resolved = thread === 'auto' || !thread ? deriveThread(session) || `yunqi-${Date.now()}` : thread;
    const r = await submit(text, resolved, session);
    log(`triggerId ${r.triggerId}  outcome ${r.outcome}  port ${r.port}  thread ${resolved}`);
  } else if (cmd === 'wait') {
    const id = process.argv[3];
    if (!id) { log('用法: orch.mjs wait <ticketId>'); process.exit(2); }
    const t = await waitFor(id);
    if (!t) { log('没有这个工单'); process.exit(1); }
    const b = brief(t);
    log(`\n${b.id}  ${b.ended}`);
    log(`标题: ${b.title}`);
    if (b.summary) log(`报告: ${b.summary}`);
  } else if (cmd === 'tickets') {
    for (const t of tickets()) {
      const b = brief(t);
      log(`${b.id}  ${b.ended.padEnd(18)}  ${b.title}`);
      if (b.summary) log(`    ${b.summary.slice(0, 160)}`);
    }
  } else {
    log('命令: status | submit [--thread <线程>] [--session <会话id>] "任务" | wait <id> | tickets');
    process.exit(2);
  }
} catch (e) {
  log(`错误: ${e.message}`);
  process.exit(1);
}
