// remote.mjs — a test the model can START on another machine and that neither
// the model nor this host measures.
//
// The model asks for a named run. The host publishes a signed request to one
// topic. A runner on the test machine, which trusts exactly one signer, runs
// one fixed script and publishes what the script printed, reduced to figures.
// The host accepts a result only from the runner's signer and only for the
// nonce it sent, and writes the result line itself. The model never supplies a
// command, an argument, a tag or a number.

export const WIRE = 'axona-remote-test/1';
/** The runs a requester may name. The runner maps each to one fixed script; nothing else can run. */
export const RUNS = {
  production: 'the alert-bot test with the option set production runs, three hosts in one region, on testnet',
  guard: 'the alert-bot test with the testnet experiment set and the write-flight address guard, three hosts in one region, on testnet',
};
const HEX = /^[0-9a-f]+$/;

/** Validate what the model asked for. Only a run NAME passes. */
export function planRemote({ run } = {}, allowed = Object.keys(RUNS)) {
  const r = String(run ?? '').trim().toLowerCase();
  if (!allowed.includes(r)) return { error: `run must be one of: ${allowed.join(', ')}` };
  return { run: r };
}

export function newNonce() { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
export const requestText = (plan, nonce) => JSON.stringify({ t: WIRE, op: 'run', run: plan.run, nonce });
export const replyText = (op, nonce, fields = {}) => JSON.stringify({ t: WIRE, op, nonce, ...fields });

/** A poll row's text → a wire object, or null. Never throws. */
export function readWire(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('{') || s.length > 8000) return null;
  let o; try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object' || o.t !== WIRE || typeof o.op !== 'string') return null;
  if (typeof o.nonce !== 'string' || o.nonce.length !== 16 || !HEX.test(o.nonce)) return null;
  return o;
}

/** A row from axona_poll → { text, signer, ts }. The body may be an object or a JSON string. */
export function rowOf(raw) {
  let body = raw?.message ?? raw?.text ?? '';
  if (body && typeof body === 'object') body = body.text ?? '';
  // A std/message arrives as an object or as its JSON string; the wire text is its `text`. A bare wire object is itself.
  if (typeof body === 'string' && body.trim().startsWith('{')) { try { const j = JSON.parse(body); if (j && typeof j === 'object' && j.t !== WIRE && typeof j.text === 'string') body = j.text; } catch { /* plain */ } }
  return { text: String(body ?? ''), signer: String(raw?.signer ?? ''), ts: Number(raw?.ts) || 0 };
}

const parse = (txt) => { try { return JSON.parse(txt); } catch { return {}; } };

/**
 * Host side. Publish the request, then read the topic until the runner answers
 * for this nonce or the time runs out. `callTool(name, args)` returns MCP text.
 */
export async function runRemoteTest(callTool, plan, { topic, runnerSigner, timeoutMs = 420_000, now = Date.now, nonce = newNonce() } = {}) {
  const out = { nonce, run: plan.run, status: 'error', reason: null, tag: null, result: null, waitedMs: 0 };
  if (typeof runnerSigner !== 'string' || runnerSigner.length !== 64 || !HEX.test(runnerSigner)) { out.reason = 'no runner signer is configured'; return out; }
  const t0 = now();
  const pub = parse(await callTool('axona_publish', { topic, message: requestText(plan, nonce), confirm: true }));
  if (pub.ok !== true) { out.reason = 'the request was not accepted for publishing'; return out; }
  out.status = 'timeout'; out.reason = 'no answer from the runner in time';
  while (now() - t0 < timeoutMs) {
    let rows = [];
    try { rows = parse(await callTool('axona_poll', { topic, wait: true, timeoutSec: 20 })).messages || []; } catch { /* a failed poll is a missed turn, not a result */ }
    for (const raw of rows) {
      const row = rowOf(raw);
      if (row.signer !== runnerSigner) continue;                       // only the runner speaks for the runner
      const w = readWire(row.text);
      if (!w || w.nonce !== nonce) continue;
      if (w.op === 'accepted') { out.tag = typeof w.tag === 'string' ? w.tag.slice(0, 24) : null; continue; }
      if (w.op === 'refused') { out.status = 'refused'; out.reason = String(w.reason ?? 'refused').slice(0, 120); out.waitedMs = now() - t0; return out; }
      if (w.op === 'result') { out.status = 'done'; out.reason = null; out.result = cleanResult(w); out.tag = out.result.tag ?? out.tag; out.waitedMs = now() - t0; return out; }
    }
  }
  out.waitedMs = now() - t0;
  return out;
}

const int = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
/** Keep only the fields a result may carry, each checked for type. A runner bug must not put prose in the line. */
export function cleanResult(w) {
  const warn = {};
  if (w.warn && typeof w.warn === 'object') for (const [k, v] of Object.entries(w.warn).slice(0, 12)) if (/^[a-z:-]{3,40}$/.test(k) && int(v) !== null) warn[k] = v;
  return { tag: /^[A-Z0-9]{3,24}$/.test(String(w.tag ?? '')) ? w.tag : null, run: String(w.run ?? '').slice(0, 20), kernel: /^\d+\.\d+\.\d+$/.test(String(w.kernel ?? '')) ? w.kernel : null,
    rc: int(w.rc), botExit: int(w.botExit), publications: int(w.publications), alerts: int(w.alerts), botTopics: int(w.botTopics),
    mismatchedPubs: int(w.mismatchedPubs), mismatchedKills: int(w.mismatchedKills), topics: int(w.topics), twoRoot: int(w.twoRoot), noRoot: int(w.noRoot), passedOver: int(w.passedOver),
    hosts: int(w.hosts), survivors: int(w.survivors), seconds: int(w.seconds), foreignTopics: int(w.foreignTopics), timedOut: w.timedOut === true, warn };
}

/** Is this result a clean run? Every figure must be present and right; a missing figure is not clean. */
export function isClean(r) {
  return !!r && r.timedOut === false && r.rc === 0 && r.botExit === 0 && r.publications > 0 && r.mismatchedPubs === 0 && r.mismatchedKills === 0 && r.twoRoot === 0 && r.noRoot === 0 && r.survivors === 0;
}

/** Runner side. The script's printed output (+ its summary file's warning lines) → figures. */
export function parseRunOutput(stdout, summaryText = '') {
  const s = String(stdout ?? ''); const num = (m, i = 1) => (m ? Number(m[i]) : null);
  const there = s.match(/There were (\d+) pubs and (\d+) kills with mismatched events.*?from the (\d+) total publications \((\d+) alerts in (\d+) topics\)/);
  const st = s.match(/S topics (\d+) \| two-root at end (\d+) \| no root (\d+) \| passed over (\d+)/);
  const hostsLine = s.match(/^S hosts (.*)$/m);
  const surv = s.match(/stopped [0-9:Z]+; survivors:([^\n]*)/);
  const warn = {};
  for (const m of String(summaryText ?? '').matchAll(/^\s*(\d+) ([a-z:-]{3,40})\s*$/gm)) if (m[2] !== 'total') warn[m[2]] = Number(m[1]);   // 'total' is the script's sum of all rows, not a warning
  return { rc: num(s.match(/^== \S+ rc=(\d+)/m)), botExit: num(s.match(/bot exit (\d+)/)),
    mismatchedPubs: num(there, 1), mismatchedKills: num(there, 2), publications: num(there, 3), alerts: num(there, 4), botTopics: num(there, 5),
    topics: num(st, 1), twoRoot: num(st, 2), noRoot: num(st, 3), passedOver: num(st, 4),
    hosts: hostsLine ? (hostsLine[1].match(/rooted \d+/g) || []).length : null,
    survivors: surv ? surv[1].trim().split(/\s+/).filter(Boolean).length : null, warn };
}

/**
 * Runner side. The hosts' own end-of-run reports → which topics belong to this run's regions.
 *
 * The script counts a topic as "no root" when none of the run's hosts roots it. On a shared test network the hosts
 * also hold COPIES of topics from other regions, whose roots are other people's nodes. On 2026-11-18 the first night
 * run held 32 such topics and read "no root 32" with every publication delivered. A topic is FOREIGN when its region
 * byte is not the region byte of any host of the run. Foreign topics are counted and reported, and are not a fault.
 */
export function regionSplit(hostsLogText) {
  const hosts = [];
  for (const l of String(hostsLogText ?? '').split('\n')) { const i = l.indexOf('BOT-HEALTH '); if (i < 0) continue; try { hosts.push(JSON.parse(l.slice(i + 11))); } catch { /* a torn line */ } }
  if (!hosts.length) return null;
  const regions = new Set(hosts.map((h) => String(h?.health?.nodeId ?? '').slice(0, 2).toLowerCase()).filter((x) => /^[0-9a-f]{2}$/.test(x)));
  if (!regions.size) return null;
  const rooted = new Set(); const all = new Set();
  for (const h of hosts) for (const r of (h?.health?.axonRoles || [])) { const t = String(r?.topic ?? '').toLowerCase(); if (!/^[0-9a-f]{4,}$/.test(t)) continue; all.add(t); if (r.isRoot) rooted.add(t); }
  let topics = 0, noRoot = 0, foreignTopics = 0;
  for (const t of all) { if (regions.has(t.slice(0, 2))) { topics++; if (!rooted.has(t)) noRoot++; } else foreignTopics++; }
  return { topics, noRoot, foreignTopics };
}

/** The line the host writes under the model's words. */
export function remoteResultLine(o) {
  const head = '[measured by the test runner on the test machine, not written by the model]';
  if (o.status !== 'done' || !o.result) return `${head} run "${o.run}" did not produce a result: ${o.status}${o.reason ? ' (' + o.reason + ')' : ''}${o.tag ? ', tag ' + o.tag : ''}, after ${Math.round(o.waitedMs / 1000)} s.`;
  const r = o.result; const n = (x) => (x === null ? 'not reported' : String(x));
  const w = Object.entries(r.warn).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${head} run "${o.run}", tag ${r.tag ?? 'none'}, kernel ${r.kernel ?? 'not reported'}, on testnet: ${isClean(r) ? 'CLEAN' : 'NOT CLEAN'}. `
    + `Publications ${n(r.publications)} (${n(r.alerts)} alerts in ${n(r.botTopics)} topics); mismatched ${n(r.mismatchedPubs)} publications and ${n(r.mismatchedKills)} kills. `
    + `Hosts reporting ${n(r.hosts)}; topics of this run's region they hold ${n(r.topics)}; two roots at the end ${n(r.twoRoot)}; no root ${n(r.noRoot)}; passed over ${n(r.passedOver)}. `
    + (r.foreignTopics ? `Copies of ${r.foreignTopics} topics from other regions were also held; their roots are other nodes on the test network and they are not counted. ` : '')
    + `Script exit ${n(r.rc)}, bot exit ${n(r.botExit)}, processes left running ${n(r.survivors)}${r.timedOut ? ', TIMED OUT' : ''}; ${n(r.seconds)} s. `
    + (w ? `Warning rows counted: ${w}. ` : '')
    + 'One run of one small mesh; it shows what this run did and nothing about a larger one.';
}

/** Is `d` inside a night window "HH-HH" in the machine's local time? "22-06" wraps midnight. Null window = never. */
export function inWindow(window, d = new Date()) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(window ?? '').trim()); if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]), h = d.getHours();
  if (a > 23 || b > 23 || a === b) return false;
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

/** The line the host writes under the morning summary. */
export function nightSummaryLine(outs) {
  const done = outs.filter((o) => o.status === 'done' && o.result); const clean = done.filter((o) => isClean(o.result));
  const sum = (f) => done.reduce((a, o) => a + (o.result[f] ?? 0), 0);
  const bad = outs.filter((o) => !(o.status === 'done' && o.result && isClean(o.result)));
  return `[counted by the host program from the runner's results, not written by the model] Night runs started ${outs.length}; finished with a result ${done.length}; clean ${clean.length}. `
    + `Across finished runs: publications ${sum('publications')}, mismatched publications ${sum('mismatchedPubs')}, mismatched kills ${sum('mismatchedKills')}, two-root topics ${sum('twoRoot')}, topics with no root ${sum('noRoot')}. `
    + (bad.length ? `Not clean or no result (first ${Math.min(bad.length, 8)}): ${bad.slice(0, 8).map((o) => `${o.result?.tag ?? o.tag ?? o.nonce.slice(0, 6)} ${o.status === 'done' ? 'not clean' : o.status}`).join('; ')}. ` : 'Every run was clean. ')
    + 'Each run is three hosts in one region on testnet.';
}
