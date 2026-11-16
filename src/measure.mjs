// measure.mjs — a delivery test whose figures the HOST measures.
//
// The model decides to run it and says what it was asked. It does not time
// anything and it does not write the figures: a small model garbles numbers.
// The host publishes `count` messages to a test topic, pulls each one back by
// its full id, times both, and writes the result line itself.

export const LIMITS = { maxCount: 50, minIntervalMs: 200, maxIntervalMs: 10_000 };

/** Clamp a request to the bounds. The topic must sit under the tester's own prefix. */
export function planTest({ topic, count, intervalMs } = {}, prefix) {
  const t = String(topic ?? '');
  if (!t.startsWith(prefix + '/') || t.length > 80 || /\s/.test(t)) return { error: `topic must start with "${prefix}/" and contain no spaces` };
  const c = Number.isInteger(count) ? count : Number.parseInt(count, 10);
  if (!Number.isInteger(c) || c < 1) return { error: 'count must be a whole number of 1 or more' };
  const i = Number(intervalMs);
  return { topic: t, count: Math.min(c, LIMITS.maxCount),
    intervalMs: Number.isFinite(i) ? Math.min(Math.max(i, LIMITS.minIntervalMs), LIMITS.maxIntervalMs) : 1000 };
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
/** min / median / p95 / max of a list of milliseconds; nulls when the list is empty. */
export function spread(ms) {
  const s = ms.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { n: s.length, min: s[0] ?? null, median: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] ?? null };
}

const parse = (txt) => { try { return JSON.parse(txt); } catch { return {}; } };

/**
 * Run the test. `callTool(name, args)` returns the MCP tool's text. Every
 * figure here is timed on this host's monotonic clock around the tool call.
 */
export async function runDeliveryTest(callTool, plan, { clock = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), runId = Date.now().toString(36) } = {}) {
  const rows = [];
  for (let i = 1; i <= plan.count; i++) {
    const row = { seq: i, msgId: null, accepted: false, confirmed: false, publishMs: null, found: false, pullMs: null, error: null };
    const text = `delivery test ${runId} message ${i} of ${plan.count}`;
    let t0 = clock();
    try {
      const r = parse(await callTool('axona_publish', { topic: plan.topic, message: text, confirm: true }));
      row.publishMs = Math.round(clock() - t0); row.accepted = r.ok === true; row.confirmed = r.confirmed === true; row.msgId = typeof r.msgId === 'string' ? r.msgId : null;
      if (!row.accepted) row.error = 'publish refused';
    } catch (e) { row.publishMs = Math.round(clock() - t0); row.error = 'publish: ' + String(e.message).slice(0, 80); }
    if (row.msgId) {
      t0 = clock();
      try {
        const r = parse(await callTool('axona_pull', { topic: plan.topic, msgId: row.msgId }));
        row.pullMs = Math.round(clock() - t0);
        const body = r.message; const got = typeof body === 'string' ? body : body?.text;
        row.found = r.found === true && got === text;                 // the SAME words came back, not just "something"
        if (r.found === true && got !== text) row.error = 'pull returned different text';
      } catch (e) { row.pullMs = Math.round(clock() - t0); row.error = 'pull: ' + String(e.message).slice(0, 80); }
    }
    rows.push(row);
    if (i < plan.count) await sleep(plan.intervalMs);
  }
  return summarise(plan, runId, rows);
}

export function summarise(plan, runId, rows) {
  const failed = rows.filter((r) => !(r.accepted && r.confirmed && r.found));
  return { runId, topic: plan.topic, sent: rows.length, intervalMs: plan.intervalMs,
    accepted: rows.filter((r) => r.accepted).length, confirmed: rows.filter((r) => r.confirmed).length, pulledBack: rows.filter((r) => r.found).length,
    publishMs: spread(rows.filter((r) => r.accepted).map((r) => r.publishMs)), pullMs: spread(rows.filter((r) => r.found).map((r) => r.pullMs)),
    failures: failed.slice(0, 10).map((r) => ({ seq: r.seq, msgId: r.msgId ? r.msgId.slice(0, 12) : null, accepted: r.accepted, confirmed: r.confirmed, found: r.found, error: r.error })),
    firstMsgId: rows.find((r) => r.msgId)?.msgId?.slice(0, 12) ?? null, lastMsgId: [...rows].reverse().find((r) => r.msgId)?.msgId?.slice(0, 12) ?? null };
}

/** The line the host writes under the model's words. Every figure carries what it is. */
export function resultLine(s) {
  const f = (x) => x.n ? `min ${x.min} / median ${x.median} / p95 ${x.p95} / max ${x.max} ms (n=${x.n})` : 'no samples';
  return `[measured by the host program, not written by the model] run ${s.runId}, topic ${s.topic}: sent ${s.sent} at ${s.intervalMs} ms apart; accepted ${s.accepted}; confirmed at the holder ${s.confirmed}; pulled back by id with the same text ${s.pulledBack}. `
    + `Publish with confirm: ${f(s.publishMs)}. Pull by id: ${f(s.pullMs)}. `
    + (s.failures.length ? `Failures (first ${s.failures.length}): ${s.failures.map((x) => `#${x.seq} ${x.msgId ?? 'no id'} ${x.error ?? (!x.confirmed ? 'not confirmed' : 'not found')}`).join('; ')}. ` : 'No failures. ')
    + `First msgId ${s.firstMsgId ?? 'none'}, last ${s.lastMsgId ?? 'none'}. Times are one node's tool-call durations on its own clock, one run.`;
}
