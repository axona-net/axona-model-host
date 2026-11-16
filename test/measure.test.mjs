import assert from 'node:assert/strict';
import { planTest, spread, runDeliveryTest, resultLine, LIMITS } from '../src/measure.mjs';
let n = 0; const check = (name, ok) => { assert(ok, name); n++; console.log('PASS ' + name); };

check('topic outside the prefix is refused', !!planTest({ topic: 'council', count: 3 }, 'lyra').error);
check('prefix must be a path segment', !!planTest({ topic: 'lyrax/t', count: 3 }, 'lyra').error);
check('topic with a space is refused', !!planTest({ topic: 'lyra/a b', count: 3 }, 'lyra').error);
check('count zero is refused', !!planTest({ topic: 'lyra/t', count: 0 }, 'lyra').error);
check('count not a number is refused', !!planTest({ topic: 'lyra/t', count: 'many' }, 'lyra').error);
check('missing arguments do not throw', !!planTest(undefined, 'lyra').error);
check('count is capped', planTest({ topic: 'lyra/t', count: 9999 }, 'lyra').count === LIMITS.maxCount);
check('a string count is read', planTest({ topic: 'lyra/t', count: '7' }, 'lyra').count === 7);
check('interval is floored and capped', planTest({ topic: 'lyra/t', count: 1, intervalMs: 1 }, 'lyra').intervalMs === LIMITS.minIntervalMs && planTest({ topic: 'lyra/t', count: 1, intervalMs: 1e9 }, 'lyra').intervalMs === LIMITS.maxIntervalMs);
check('interval defaults to one second', planTest({ topic: 'lyra/t', count: 1 }, 'lyra').intervalMs === 1000);

const s = spread([5, 1, 9, 3, NaN, 7]);
check('spread ignores non-numbers and orders', s.n === 5 && s.min === 1 && s.median === 5 && s.max === 9 && s.p95 === 9);
check('spread of nothing is nulls', spread([]).n === 0 && spread([]).median === null);

// A fake network: message 2 is never confirmed, message 3 comes back with other text, message 4's pull throws.
let now = 0; const store = new Map(); let seq = 0;
const fake = async (name, a) => {
  if (name === 'axona_publish') { seq++; now += 10 * seq; const id = String(seq).padStart(64, 'a'); store.set(id, seq === 3 ? 'someone else' : a.message); return JSON.stringify({ ok: true, confirmed: seq !== 2, msgId: id }); }
  if (name === 'axona_pull') { now += 4; if (a.msgId.endsWith('4')) throw new Error('boom'); return JSON.stringify({ found: true, message: { text: store.get(a.msgId) } }); }
  throw new Error('unexpected tool');
};
const plan = planTest({ topic: 'lyra/t', count: 5, intervalMs: 200 }, 'lyra');
const r = await runDeliveryTest(fake, plan, { clock: () => now, sleep: async () => {}, runId: 'r1' });
check('all five were sent and accepted', r.sent === 5 && r.accepted === 5);
check('the unconfirmed one is counted', r.confirmed === 4);
check('different text and a thrown pull are not counted as pulled back', r.pulledBack === 3);
check('failures name each bad message', r.failures.length === 3 && r.failures.map((f) => f.seq).join() === '2,3,4');
check('publish times are the measured durations', r.publishMs.min === 10 && r.publishMs.max === 50 && r.publishMs.n === 5);
check('pull times cover only messages that came back', r.pullMs.n === 3 && r.pullMs.min === 4);
check('ids are cut to a prefix', r.firstMsgId.length === 12 && r.failures.every((f) => f.msgId.length === 12));
const line = resultLine(r);
check('the result line says who measured', line.startsWith('[measured by the host program, not written by the model]'));
check('the result line carries the counts and the failures', line.includes('sent 5') && line.includes('confirmed at the holder 4') && line.includes('#3') && line.includes('pull returned different text'));

const refused = await runDeliveryTest(async () => JSON.stringify({ ok: false }), planTest({ topic: 'lyra/t', count: 2, intervalMs: 200 }, 'lyra'), { clock: () => 0, sleep: async () => {}, runId: 'r2' });
check('a refused publish is a failure with no pull', refused.accepted === 0 && refused.pulledBack === 0 && refused.failures.length === 2 && refused.pullMs.n === 0);
const garbage = await runDeliveryTest(async () => 'not json', planTest({ topic: 'lyra/t', count: 1 }, 'lyra'), { clock: () => 0, sleep: async () => {}, runId: 'r3' });
check('an unreadable tool answer is a failure, not a crash', garbage.accepted === 0 && resultLine(garbage).includes('no samples'));
console.log(`measure: ${n} passed`);
