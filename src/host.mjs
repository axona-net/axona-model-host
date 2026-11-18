// host.mjs — a minimal MCP host for a small local model.
//
// It starts an Axona MCP server (a full peer with its own signed identity),
// offers that server's tools to a model served by Ollama, and runs the model's
// tool calls. No hosted model and no hosted API is in this path.
//
//   node src/host.mjs test      one task: post once to the test topic, read it back, stop
//   node src/host.mjs council   watch the topic; when a post ADDRESSES the model, let it answer
//   node src/host.mjs measure <topic> <count> [intervalMs]   run the delivery test with no model and print it
//
// Settings (environment):
//   AXONA_MCP        path to the MCP server script              (required)
//   HOST_NAME        the model's handle on the network          (default Lyra)
//   HOST_MODEL       Ollama model tag                           (default qwen3:8b)
//   HOST_TOPIC       topic watched in council mode              (default council)
//   HOST_TEST_TOPIC  topic used by test mode                    (default <name>/test, lower case)
//   HOST_DIR         identity, stop file and logs live here     (default ~/.axona)
//   HOST_OPERATOR    who runs this agent, carried in its class declaration
//   HOST_TRUSTED     comma list of signer prefixes answered on any mention (the operator)
//   HOST_SINCE       ISO time; posts from then on are answered even if they arrived before this start
//   <HOST_DIR>/<name>-brief.txt   optional: the operator's brief, added to the model's instructions
//   OLLAMA_URL       default http://127.0.0.1:11434
//   HOST_RUNNER_SIGNER  full 64-hex signer of the test runner; without it run_alert_bot_test is not offered
//   HOST_REMOTE_TOPIC   topic the runner watches               (default <name>/alert-bot, lower case)
//   HOST_NIGHT          local hours "HH-HH" in which the host starts tests by itself, e.g. 22-06 (default: never)
//   HOST_NIGHT_TOPIC    where each night run is posted         (default <name>/night, lower case)
//   HOST_NIGHT_GAP_MS   least time between two night run starts (default 300000)
//   HOST_NIGHT_RUN      which run the night uses               (default production)
//
// Stop it by creating <HOST_DIR>/<name>.stop (lower case). The host never deletes that file.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PostLimiter, readRow, shouldAnswer } from './guards.mjs';
import { planTest, runDeliveryTest, resultLine } from './measure.mjs';
import { RUNS, planRemote, runRemoteTest, remoteResultLine, inWindow, nightSummaryLine } from './remote.mjs';

const MODE = process.argv[2] || 'council';
const NAME = process.env.HOST_NAME || 'Lyra';
const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const MODEL = process.env.HOST_MODEL || 'qwen3:8b';
const TOPIC = process.env.HOST_TOPIC || 'council';
const TEST_TOPIC = process.env.HOST_TEST_TOPIC || `${SLUG}/test`;
const DIR = process.env.HOST_DIR || join(homedir(), '.axona');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MCP = process.env.AXONA_MCP;
const STOP = join(DIR, `${SLUG}.stop`);
const OUT = join(DIR, `${SLUG}-host-${MODE}.jsonl`);
const OFFERED = new Set(['axona_publish', 'axona_pull', 'axona_status', 'axona_poll', 'axona_watch']);
const TRUSTED = String(process.env.HOST_TRUSTED || '').split(',').map((x) => x.trim()).filter(Boolean);
const SINCE = Date.parse(process.env.HOST_SINCE || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERSION = '0.4.2';
const RUNNER = /^[0-9a-f]{64}$/.test(String(process.env.HOST_RUNNER_SIGNER || '').toLowerCase()) ? String(process.env.HOST_RUNNER_SIGNER).toLowerCase() : null;
const REMOTE_TOPIC = process.env.HOST_REMOTE_TOPIC || `${SLUG}/alert-bot`;
const NIGHT = RUNNER ? (process.env.HOST_NIGHT || '') : '';
const NIGHT_TOPIC = process.env.HOST_NIGHT_TOPIC || `${SLUG}/night`;
const NIGHT_GAP = Number(process.env.HOST_NIGHT_GAP_MS) >= 60_000 ? Number(process.env.HOST_NIGHT_GAP_MS) : 300_000;
const NIGHT_RUN = Object.prototype.hasOwnProperty.call(RUNS, process.env.HOST_NIGHT_RUN || '') ? process.env.HOST_NIGHT_RUN : 'production';

mkdirSync(DIR, { recursive: true });
const log = (o) => { try { appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch { /* a full disk must not stop the host */ } };
if (!MCP || !existsSync(MCP)) { console.error('AXONA_MCP must name the MCP server script'); process.exit(2); }
if (MODE !== 'test' && MODE !== 'council' && MODE !== 'measure') { console.error('mode must be "test", "council" or "measure"'); process.exit(2); }

// ── the MCP server, over stdio (newline-delimited JSON-RPC) ─────────────────
const srv = spawn(process.execPath, [MCP], {
  cwd: dirname(dirname(MCP)),
  env: { ...process.env, MCP_HANDLE: NAME, MCP_AUTHOR_PATH: join(DIR, `${SLUG}-identity.json`), MCP_AUTHOR_CLASS: 'agent', MCP_INBOX: 'off', ...(process.env.HOST_OPERATOR ? { MCP_OPERATOR: process.env.HOST_OPERATOR } : {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 0, buf = ''; const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } catch { log({ nonJson: line.slice(0, 160) }); }
  }
});
srv.stderr.on('data', (d) => { const s = String(d); if (!s.includes('ice-pair')) log({ server: s.slice(0, 300) }); });
srv.on('exit', (code, signal) => { log({ serverExit: code, signal }); process.exit(1); });
const rpc = (method, params, ms = 90_000) => new Promise((res, rej) => {
  const id = ++nextId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error('rpc timeout ' + method)); }, ms);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const callTool = async (name, args) => {
  const m = await rpc('tools/call', { name, arguments: args || {} });
  return m.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(m.error ?? m.result ?? {});
};
const stopServer = () => { try { srv.kill('SIGTERM'); } catch { /* already gone */ } };

// ── the model ───────────────────────────────────────────────────────────────
async function chat(messages, tools) {
  const r = await fetch(OLLAMA + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false, think: false, options: { num_ctx: 16384, temperature: 0.3 } }) });
  if (!r.ok) throw new Error('ollama ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  log({ model: { evalTokens: j.eval_count, promptTokens: j.prompt_eval_count, ms: Math.round((j.total_duration || 0) / 1e6) } });
  return j.message;
}

const limiter = new PostLimiter();
const testLimiter = new PostLimiter({ perHour: 6, minGapMs: 60_000 });      // delivery tests, not posts
// The one tool the HOST provides itself. The model asks for the test; the host runs and times it.
const MEASURE_TOOL = { type: 'function', function: { name: 'run_delivery_test',
  description: `Run a measured delivery test: the host publishes "count" messages to a test topic, pulls each back by id, and times both. Returns the measured result. Use it when you are asked to test delivery, latency or loss. The topic must start with "${SLUG}/". After it returns, publish ONE short post saying what you were asked to test; the host adds the measured figures under your words, so do not write figures yourself.`,
  parameters: { type: 'object', properties: { topic: { type: 'string', description: `Test topic, must start with "${SLUG}/", for example "${SLUG}/delivery"` }, count: { type: 'integer', description: 'How many messages, 1 to 50' }, intervalMs: { type: 'integer', description: 'Pause between messages in ms, 200 to 10000 (default 1000)' } }, required: ['topic', 'count'] } } };

const remoteLimiter = new PostLimiter({ perHour: 6, minGapMs: 60_000 });   // remote tests asked for on the topic, not posts
// The second tool the HOST provides. The model names a run; a runner on the test machine does it and measures it.
const REMOTE_TOOL = { type: 'function', function: { name: 'run_alert_bot_test',
  description: `Start one alert-bot stress test on the test machine and wait for its result (about one to two minutes). Returns the result measured by the test runner. Use it when you are asked to run the alert-bot test or to stress test the network. After it returns, publish ONE short post saying which run you started; the host adds the measured figures under your words, so do not write figures yourself. Runs: ${Object.entries(RUNS).map(([k, v]) => `"${k}" = ${v}`).join('; ')}.`,
  parameters: { type: 'object', properties: { run: { type: 'string', enum: Object.keys(RUNS), description: 'Which run. Use "production" unless you were asked for another.' } }, required: ['run'] } } };
const startRemote = (plan) => runRemoteTest(callTool, plan, { topic: REMOTE_TOPIC, runnerSigner: RUNNER });

// A post the HOST writes itself. Its first words always say so.
const hostPublish = async (topic, text) => { try { const r = await callTool('axona_publish', { topic, message: String(text).slice(0, 6000), confirm: true, handle: NAME }); log({ hostPost: topic, ok: /"ok":\s*true/.test(r) }); return /"ok":\s*true/.test(r); } catch (e) { log({ hostPostError: e.message }); return false; } };

// One task: the model works with the tools until it stops calling them.
// The host refuses any tool it did not offer and any topic the task does not allow.
async function runTask(system, user, tools, { allowTopics, maxSteps = 6, mustPublish = false, limited = false, remoteRuns = Object.keys(RUNS), remoteLimited = true, append = '', out = {} }) {
  let published = false, reminded = false, measured = null, remote = null, carried = false;
  // A MEASURED RESULT IS NEVER LOST. On 2026-11-17 the model posted "I will run the test" first, then ran it; one
  // post per task then kept the result off the topic. If a result exists that no post carried, the host posts it.
  const finish = async () => {
    if ((measured || remote) && !carried && allowTopics[0]) {
      const lines = [measured ? resultLine(measured) : '', remote ? remoteResultLine(remote) : '', append].filter(Boolean).join('\n\n');
      await hostPublish(allowTopics[0], `[posted by the host program: the result of the test ${NAME} started, which ${NAME}'s own post did not carry]\n\n${lines}`);
      carried = true;
    }
    return published;
  };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await chat(messages, tools); messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      log({ final: String(msg.content || '').slice(0, 1500), published });
      // A small model sometimes writes its answer as text and calls nothing. One reminder, no more.
      if (mustPublish && !published && !reminded) {
        reminded = true; log({ reminder: 'no tool call' });
        const testFirst = (tools.includes(REMOTE_TOOL) || tools.includes(MEASURE_TOOL)) && !measured && !remote;
        messages.push({ role: 'user', content: `You wrote text but did not call a tool, so nobody saw it and nothing ran. ${testFirst ? 'If you were asked to run a test, call that test tool NOW and wait for its result before you publish anything. Otherwise call' : 'Call'} the axona_publish tool with topic "${allowTopics[0]}", your reply as the message, and confirm true.` });
        continue;
      }
      return finish();
    }
    for (const c of calls) {
      const name = c.function?.name; let args = c.function?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      let result;
      const refusal = limited && name === 'axona_publish' ? limiter.refusal() : null;
      if (name === 'run_delivery_test' && tools.includes(MEASURE_TOOL)) {
        const plan = planTest(args, SLUG);
        if (plan.error) result = 'REFUSED by host: ' + plan.error;
        else if (measured) result = 'REFUSED by host: one delivery test per task';
        else if (testLimiter.refusal()) result = 'REFUSED by host: delivery test ' + testLimiter.refusal();
        else { testLimiter.record(); try { measured = await runDeliveryTest(callTool, plan); result = resultLine(measured); log({ measured }); } catch (e) { result = 'ERROR: ' + e.message; } }
        log({ tool: name, args: JSON.stringify(args).slice(0, 300), result: String(result).slice(0, 900) });
        messages.push({ role: 'tool', tool_name: name, content: String(result) });
        continue;
      }
      if (name === 'run_alert_bot_test' && tools.includes(REMOTE_TOOL)) {
        const plan = planRemote(args, remoteRuns);
        if (plan.error) result = 'REFUSED by host: ' + plan.error;
        else if (remote) result = 'REFUSED by host: one remote test per task';
        else if (remoteLimited && remoteLimiter.refusal()) result = 'REFUSED by host: remote test ' + remoteLimiter.refusal();
        else { if (remoteLimited) remoteLimiter.record(); try { remote = await startRemote(plan); out.remote = remote; result = remoteResultLine(remote); log({ remote }); } catch (e) { result = 'ERROR: ' + e.message; } }
        log({ tool: name, args: JSON.stringify(args).slice(0, 300), result: String(result).slice(0, 1200) });
        messages.push({ role: 'tool', tool_name: name, content: String(result) });
        continue;
      }
      if (!OFFERED.has(name)) result = 'REFUSED by host: tool not offered';
      else if (name === 'axona_publish' && !allowTopics.includes(String(args.topic))) result = 'REFUSED by host: this task may post only to ' + allowTopics.join(', ');
      else if (name === 'axona_publish' && published) result = 'REFUSED by host: one post per task';
      else if (refusal) result = 'REFUSED by host: ' + refusal;
      else {
        if (name === 'axona_publish') { args = { topic: String(args.topic), message: String(args.message ?? '').slice(0, 2000) + (measured ? '\n\n' + resultLine(measured) : '') + (remote ? '\n\n' + remoteResultLine(remote) : '') + (append ? '\n\n' + append : ''), confirm: true, handle: NAME }; }
        try {
          result = await callTool(name, args);
          if (name === 'axona_publish' && /"ok":\s*true/.test(String(result))) { published = true; if (measured || remote) carried = true; if (limited) limiter.record(); }
        } catch (e) { result = 'ERROR: ' + e.message; }
      }
      log({ tool: name, args: JSON.stringify(args).slice(0, 1200), result: String(result).slice(0, 600) });
      messages.push({ role: 'tool', tool_name: name, content: String(result).slice(0, 6000) });
    }
  }
  log({ note: 'step budget spent' });
  return finish();
}

let FACTS = '', BRIEF = '';
const system = () => `${SYSTEM}${FACTS ? `\n\nFACTS ABOUT YOURSELF, measured by the host program. Use these and no others when asked what you are:\n${FACTS}` : ''}${BRIEF ? `\n\nYOUR BRIEF, from the operator:\n${BRIEF}` : ''}`;
const SYSTEM = `You are ${NAME}, a small open-weight language model (${MODEL}) running on one consumer graphics card. You are a peer on the Axona network through local tools. You are new and on trial. Be brief, plain and accurate. Say "I do not know" when you do not know. Never invent facts, figures, file names or commit ids. Never claim to have read, checked or done something a tool result does not show. To post, call the axona_publish tool; text you write without a tool call is seen by nobody.`;

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'axona-model-host', version: VERSION } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  log({ start: { mode: MODE, name: NAME, model: MODEL, server: init.result?.serverInfo } });
  const list = await rpc('tools/list', {});
  const tools = (list.result?.tools || []).filter((t) => OFFERED.has(t.name))
    .map((t) => ({ type: 'function', function: { name: t.name, description: String(t.description).slice(0, 700), parameters: t.inputSchema } }));

  // What the host can measure about the model, so the model does not have to guess about itself.
  try {
    const show = await (await fetch(OLLAMA + '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }) })).json();
    const ver = await (await fetch(OLLAMA + '/api/version')).json();
    const d = show.details || {}, mi = show.model_info || {};
    const lic = String(show.license || '').split('\n').map((x) => x.trim()).find(Boolean) || 'not reported';
    FACTS = [
      `model tag: ${MODEL}`, `model family: ${d.family ?? 'not reported'}`, `parameters: ${d.parameter_size ?? 'not reported'}`,
      `quantisation: ${d.quantization_level ?? 'not reported'}`, `weights format: ${d.format ?? 'not reported'}`,
      `architecture: ${mi['general.architecture'] ?? 'not reported'}; layers: ${mi[`${mi['general.architecture']}.block_count`] ?? 'not reported'}; trained context length: ${mi[`${mi['general.architecture']}.context_length`] ?? 'not reported'} tokens; context in use here: 16384 tokens`,
      `licence (first line of the licence text shipped with the weights): ${lic.slice(0, 80)}`,
      `runtime: Ollama ${ver.version ?? '?'}, on this one machine; no hosted model is called`,
      `host program: axona-model-host ${VERSION}; network access: Axona MCP server ${init.result?.serverInfo?.version ?? '?'}`,
      `tools you have: ${tools.map((t) => t.function.name).join(', ')}, run_delivery_test (the host runs and times it)${RUNNER ? ', run_alert_bot_test (a runner on the test machine runs and measures it)' : ''}`,
      `limits set by the host: you answer when addressed; one post per answer; 4 posts an hour, 5 minutes apart; you cannot read files, run code or see the project's source`,
      `you keep no memory between answers except the few earlier posts the host shows you`,
    ].join('\n');
  } catch (e) { log({ factsError: e.message }); }
  try { BRIEF = readFileSync(join(DIR, `${SLUG}-brief.txt`), 'utf8').trim().slice(0, 3000); } catch { /* no brief */ }
  log({ facts: FACTS, brief: BRIEF.slice(0, 200) });

  let self = '';
  for (let i = 0; i < 20 && !self; i++) {
    let j = {}; try { j = JSON.parse(await callTool('axona_status', {})); } catch { /* not ready */ }
    if (j.connected) { self = String(j.authorId || ''); log({ peer: { node: String(j.nodeId || '').slice(0, 8), author: self.slice(0, 12), mesh: j.mesh ?? null } }); }
    else await sleep(3000);
  }
  if (!self) throw new Error('the peer did not connect');
  const startedAt = Number.isFinite(SINCE) ? SINCE + 60_000 : Date.now();   // guards subtract a minute of slack

  if (MODE === 'measure') {
    const plan = planTest({ topic: process.argv[3], count: process.argv[4], intervalMs: process.argv[5] }, SLUG);
    if (plan.error) { console.error(plan.error); stopServer(); await sleep(2000); process.exit(2); }
    const r = await runDeliveryTest(callTool, plan); log({ measured: r });
    console.log(JSON.stringify(r, null, 2)); console.log(resultLine(r)); stopServer(); await sleep(3000); process.exit(0);
  }

  if (MODE === 'test') {
    const ok = await runTask(system(), `Task: post exactly one message to the topic "${TEST_TOPIC}". The message must say who you are and what model you are, in one or two sentences. Then call axona_pull on "${TEST_TOPIC}" to read the topic back, and tell me in one sentence whether your message is there and what its msgId begins with.`, tools, { allowTopics: [TEST_TOPIC] });
    log({ done: 'test', published: ok }); console.log(ok ? 'test: published' : 'test: NOT published'); stopServer(); await sleep(3000); process.exit(ok ? 0 : 1);
  }

  log({ watch: (await callTool('axona_watch', { topic: TOPIC })).slice(0, 200) });
  const publishTool = tools.filter((t) => t.function.name === 'axona_publish');
  const publishOnly = [...publishTool, MEASURE_TOOL, ...(RUNNER ? [REMOTE_TOOL] : [])];
  if (RUNNER) log({ watchRemote: (await callTool('axona_watch', { topic: REMOTE_TOPIC })).slice(0, 200), runner: RUNNER.slice(0, 12), night: NIGHT || 'off' });
  const nightOuts = []; let lastNight = 0, wasNight = false;
  const recent = [];
  while (!existsSync(STOP)) {
    // NIGHT: inside the window the host starts one test every HOST_NIGHT_GAP_MS. The model is asked to start it and
    // to word the post; if it does not call the tool, the host starts the test and says so.
    const night = inWindow(NIGHT);
    if (night && Date.now() - lastNight >= NIGHT_GAP) {
      lastNight = Date.now(); const o = {};
      try {
        await runTask(`${system()}\n\nThe night test window is open. Call run_alert_bot_test with run "${NIGHT_RUN}" now. When it returns, publish ONE post of at most 40 words to "${NIGHT_TOPIC}" that starts with "${NAME} night run:" and says which run you started. Write no figures; the host adds them.`,
          'Start one alert-bot test now.', [...publishTool, REMOTE_TOOL], { allowTopics: [NIGHT_TOPIC], maxSteps: 4, mustPublish: true, remoteRuns: [NIGHT_RUN], remoteLimited: false, out: o });
        if (!o.remote) { o.remote = await startRemote({ run: NIGHT_RUN }); log({ remote: o.remote, by: 'host' }); await hostPublish(NIGHT_TOPIC, `[posted by the host program; the model did not start this run]\n\n${remoteResultLine(o.remote)}`); }
        nightOuts.push(o.remote);
      } catch (e) { log({ nightError: e.message }); }
    }
    if (wasNight && !night && nightOuts.length) {
      const line = nightSummaryLine(nightOuts); log({ nightSummary: line });
      try {
        const posted = await runTask(`${system()}\n\nThe night test window has closed. Publish ONE post of at most 50 words to "${TOPIC}" that starts with "${NAME} → Council:" and says the night stress tests have finished. Write no figures; the host adds the counts.`,
          'Report that the night tests have finished.', publishTool, { allowTopics: [TOPIC], maxSteps: 3, mustPublish: true, append: line });
        if (!posted) await hostPublish(TOPIC, `${NAME} → Council: [posted by the host program; the model did not post]\n\n${line}`);
      } catch (e) { log({ nightSummaryError: e.message }); }
      nightOuts.length = 0;
    }
    wasNight = night;
    let rows = [];
    try { rows = JSON.parse(await callTool('axona_poll', { topic: TOPIC, wait: true, timeoutSec: 25 })).messages || []; }
    catch (e) { log({ pollError: e.message }); await sleep(5000); continue; }
    for (const raw of rows) {
      const row = readRow(raw);
      recent.push(row); while (recent.length > 6) recent.shift();
      if (!shouldAnswer(row, { name: NAME, selfSigner: self, startedAt, trusted: TRUSTED })) continue;
      log({ addressed: { handle: row.handle, signer: row.signer.slice(0, 8), text: row.text.slice(0, 300) } });
      const context = recent.slice(0, -1).map((r) => `[${r.handle} ${r.signer.slice(0, 8)}] ${r.text.slice(0, 500)}`).join('\n---\n');
      try {
        await runTask(`${system()}\n\nYou are on the topic "${TOPIC}". A post addressed to you is below. Reply with ONE post to "${TOPIC}" of at most 250 words, starting with "${NAME} → " and the name of whoever addressed you. Answer only what was asked. If you are asked to test delivery, latency or loss, call run_delivery_test FIRST and then publish; never write measured figures yourself.${RUNNER ? ' If you are asked to run the alert-bot test or to stress test the network, call run_alert_bot_test FIRST and then publish.' : ''} If you were shown only part of something, say so. If you cannot answer, say so.`,
          `Earlier posts for context (cut short):\n${context || '(none)'}\n\n=== The post addressed to you, from ${row.handle} (${row.signer.slice(0, 8)}) ===\n${row.text.slice(0, 4000)}`,
          publishOnly, { allowTopics: [TOPIC], maxSteps: 4, mustPublish: true, limited: true });
      } catch (e) { log({ taskError: e.message }); }
    }
  }
  log({ stop: 'stop file present' }); stopServer(); await sleep(3000); process.exit(0);
}
main().catch(async (e) => { log({ fatal: e.message }); stopServer(); await sleep(2000); process.exit(1); });
