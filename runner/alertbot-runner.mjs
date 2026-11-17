// alertbot-runner.mjs — runs ONE fixed test script when ONE signer asks.
//
// It is a peer on the Axona network with its own identity. It watches one
// topic. A request counts only if it is signed by RUNNER_REQUESTER (a full
// 64-hex signer), arrived after this process started, names a run in the fixed
// table below, and carries a nonce not seen before. It then runs that run's
// script with a tag IT generates and publishes the figures the script printed.
//
// What it will not do: take a command, a path, an argument or a tag from the
// network; run two tests at once; kill a process it did not start; run any
// script outside the table.
//
// Settings (environment):
//   RUNNER_MCP         path to the Axona MCP server script                    (required)
//   RUNNER_REQUESTER   the one signer whose requests are honoured, 64 hex     (required)
//   RUNNER_WORKDIR     where the test scripts live                            (default ~/axona-loadtest)
//   RUNNER_TOPIC       request and result topic                               (default lyra/alert-bot)
//   RUNNER_NAME        handle on the network                                  (default alertbot-runner)
//   RUNNER_DIR         identity, stop file and log                            (default ~/.axona)
//   RUNNER_MIN_GAP_MS  least time between two run STARTS                      (default 180000)
//   RUNNER_MAX_PER_DAY most runs in any 24 hours                              (default 200)
//   RUNNER_RUN_TIMEOUT_MS  when a run is reported as timed out                (default 1200000)
//
// Stop it by creating <RUNNER_DIR>/<name>.stop. It finishes a run in progress first.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startMcp } from '../src/mcp-client.mjs';
import { RUNS, readWire, rowOf, replyText, parseRunOutput } from '../src/remote.mjs';

// THE WHOLE LIST of what this runner can execute. Each entry is argv after "bash", relative to RUNNER_WORKDIR.
const SCRIPTS = { production: 'yz/zz-prod-run.sh', guard: 'yz/zz-g1-run.sh' };

const MCP = process.env.RUNNER_MCP;
const REQUESTER = String(process.env.RUNNER_REQUESTER || '').toLowerCase();
const WORK = process.env.RUNNER_WORKDIR || join(homedir(), 'axona-loadtest');
const TOPIC = process.env.RUNNER_TOPIC || 'lyra/alert-bot';
const NAME = process.env.RUNNER_NAME || 'alertbot-runner';
const DIR = process.env.RUNNER_DIR || join(homedir(), '.axona');
const MIN_GAP = Number(process.env.RUNNER_MIN_GAP_MS) >= 30_000 ? Number(process.env.RUNNER_MIN_GAP_MS) : 180_000;
const MAX_DAY = Number(process.env.RUNNER_MAX_PER_DAY) > 0 ? Number(process.env.RUNNER_MAX_PER_DAY) : 200;
const RUN_TIMEOUT = Number(process.env.RUNNER_RUN_TIMEOUT_MS) > 0 ? Number(process.env.RUNNER_RUN_TIMEOUT_MS) : 1_200_000;
const STOP = join(DIR, `${NAME}.stop`);
const OUT = join(DIR, `${NAME}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(DIR, { recursive: true });
const log = (o) => { try { appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch { /* keep running */ } };

if (!MCP || !existsSync(MCP)) { console.error('RUNNER_MCP must name the MCP server script'); process.exit(2); }
if (!/^[0-9a-f]{64}$/.test(REQUESTER)) { console.error('RUNNER_REQUESTER must be the full 64-hex signer allowed to ask'); process.exit(2); }
for (const [k, v] of Object.entries(SCRIPTS)) if (!RUNS[k] || !existsSync(join(WORK, v))) { console.error(`script for run "${k}" not found: ${join(WORK, v)}`); process.exit(2); }

const mcp = startMcp(MCP, { MCP_HANDLE: NAME, MCP_AUTHOR_PATH: join(DIR, `${NAME}-identity.json`), MCP_AUTHOR_CLASS: 'agent', MCP_OPERATOR: process.env.RUNNER_OPERATOR || '' },
  { log, onExit: (code, signal) => { log({ serverExit: code, signal }); process.exit(1); } });
const say = async (text) => { try { const r = await mcp.callTool('axona_publish', { topic: TOPIC, message: text, confirm: true, handle: NAME }); log({ said: text.slice(0, 200), ok: /"ok":\s*true/.test(r), confirmed: /"confirmed":\s*true/.test(r) }); } catch (e) { log({ sayError: e.message }); } };

const seen = new Set(); const starts = []; let busy = null;
const kernelVersion = () => { try { return JSON.parse(readFileSync(join(WORK, 'yz', 'axona-protocol', 'package.json'), 'utf8')).version; } catch { return null; } };
const tagNow = () => 'LY' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);       // LYyymmddHHMMSS, made here, never taken from the network

function runScript(run, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let timedOut = false;
    const child = spawn('bash', [SCRIPTS[run], tag], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { if (out.length < 200_000) out += d; });
    child.stderr.on('data', (d) => { if (out.length < 200_000) out += d; });
    // A run that outlives the timeout is REPORTED, not killed: the script has its own on-host watchdog, and this
    // runner does not kill what it cannot account for. `busy` stays set until the child really exits.
    const timer = setTimeout(() => { timedOut = true; resolve({ out, timedOut, seconds: Math.round((Date.now() - t0) / 1000), stillRunning: true }); }, RUN_TIMEOUT);
    child.on('exit', () => { clearTimeout(timer); busy = null; if (!timedOut) resolve({ out, timedOut: false, seconds: Math.round((Date.now() - t0) / 1000), stillRunning: false }); else log({ lateExit: tag }); });
    child.on('error', (e) => { clearTimeout(timer); busy = null; resolve({ out: out + '\nspawn error: ' + e.message, timedOut: false, seconds: 0, stillRunning: false }); });
  });
}

async function handle(w) {
  if (!Object.prototype.hasOwnProperty.call(SCRIPTS, w.run)) return say(replyText('refused', w.nonce, { reason: 'unknown run' }));
  if (existsSync(STOP)) return say(replyText('refused', w.nonce, { reason: 'the runner is stopping' }));
  if (busy) return say(replyText('refused', w.nonce, { reason: 'a run is in progress' }));
  const now = Date.now();
  while (starts.length && now - starts[0] > 86_400_000) starts.shift();
  if (starts.length >= MAX_DAY) return say(replyText('refused', w.nonce, { reason: 'daily limit reached' }));
  if (starts.length && now - starts[starts.length - 1] < MIN_GAP) return say(replyText('refused', w.nonce, { reason: 'too soon after the last run' }));
  const tag = tagNow(); busy = tag; starts.push(now);
  log({ start: { run: w.run, tag, nonce: w.nonce } });
  await say(replyText('accepted', w.nonce, { run: w.run, tag }));
  const r = await runScript(w.run, tag);
  let summary = ''; try { summary = readFileSync(join(WORK, 'runs', `${tag}-S1R1`, 'summary.txt'), 'utf8'); } catch { /* no summary file */ }
  const figures = parseRunOutput(r.out, summary);
  log({ done: { tag, seconds: r.seconds, timedOut: r.timedOut, figures } });
  await say(replyText('result', w.nonce, { run: w.run, tag, kernel: kernelVersion(), seconds: r.seconds, timedOut: r.timedOut, ...figures }));
}

async function main() {
  const server = await mcp.init('alertbot-runner', '0.4.0');
  let self = '';
  for (let i = 0; i < 20 && !self; i++) { let j = {}; try { j = JSON.parse(await mcp.callTool('axona_status', {})); } catch { /* not ready */ } if (j.connected) self = String(j.authorId || ''); else await sleep(3000); }
  if (!self) throw new Error('the peer did not connect');
  const startedAt = Date.now();
  log({ ready: { name: NAME, signer: self, topic: TOPIC, requester: REQUESTER.slice(0, 12), runs: Object.keys(SCRIPTS), minGapMs: MIN_GAP, maxPerDay: MAX_DAY, server } });
  console.log(`runner ready signer=${self} topic=${TOPIC}`);
  log({ watch: (await mcp.callTool('axona_watch', { topic: TOPIC })).slice(0, 200) });
  while (!(existsSync(STOP) && !busy)) {
    let rows = [];
    try { rows = JSON.parse(await mcp.callTool('axona_poll', { topic: TOPIC, wait: true, timeoutSec: 25 })).messages || []; }
    catch (e) { log({ pollError: e.message }); await sleep(5000); continue; }
    for (const raw of rows) {
      const row = rowOf(raw);
      if (row.signer !== REQUESTER) continue;                           // one signer may ask; the full id, not a prefix
      if (!row.ts || row.ts < startedAt) continue;                      // nothing replayed from before this start
      const w = readWire(row.text);
      if (!w || w.op !== 'run' || seen.has(w.nonce)) continue;
      seen.add(w.nonce); if (seen.size > 5000) seen.delete(seen.values().next().value);
      handle(w).catch((e) => { log({ handleError: e.message }); busy = null; });
    }
  }
  log({ stop: 'stop file present' }); mcp.stop(); await sleep(3000); process.exit(0);
}
main().catch(async (e) => { log({ fatal: e.message }); mcp.stop(); await sleep(2000); process.exit(1); });
