import assert from 'node:assert/strict';
import { isAddressed, readRow, PostLimiter, shouldAnswer } from '../src/guards.mjs';
let n = 0; const check = (name, ok) => { assert(ok, name); n++; console.log('PASS ' + name); };

check('line-start dash addresses', isAddressed('Lyra — in two sentences', 'Lyra'));
check('bold name with comma addresses', isAddressed('x\n**Lyra**, what is 2+2?', 'Lyra'));
check('colon addresses', isAddressed('Lyra: status?', 'Lyra'));
check('@ anywhere addresses', isAddressed('ask @Lyra this', 'Lyra'));
check('a passing mention does not', !isAddressed('On Lyra, since the posts cross: the model', 'Lyra'));
check('a statement about it does not', !isAddressed('Lyra is on #council', 'Lyra'));
check('a longer name does not match', !isAddressed('Lyrae — hello', 'Lyra') && !isAddressed('@Lyrae hi', 'Lyra'));
check('a name with regex characters is literal', isAddressed('a.b — hi', 'a.b') && !isAddressed('axb — hi', 'a.b'));
check('non-string input does not throw', isAddressed(null, 'Lyra') === false && isAddressed(undefined, 'Lyra') === false);

check('object body is read', readRow({ message: { text: 'hi', handle: 'Vega' }, signer: 'ab', ts: 5 }).handle === 'Vega');
check('JSON-string body is read', readRow({ message: '{"text":"hi","handle":"Orion"}' }).text === 'hi');
check('plain string body is read', readRow({ message: 'hello' }).text === 'hello' && readRow({ message: 'hello' }).handle === '?');
check('broken JSON stays text', readRow({ message: '{not json' }).text === '{not json');
check('empty row does not throw', readRow(undefined).text === '');

let t = 0; const L = new PostLimiter({ perHour: 2, minGapMs: 1000, now: () => t });
check('first post allowed', L.refusal() === null); L.record();
check('second too soon', L.refusal() === 'too soon after the last post');
t = 1000; check('gap elapsed', L.refusal() === null); L.record();
t = 5000; check('hourly limit holds', L.refusal() === 'hourly limit reached');
t = 3_600_001; check('window slides', L.refusal() === null);

const ctx = { name: 'Lyra', selfSigner: 'me', startedAt: 1_000_000 };
check('addressed and fresh is answered', shouldAnswer({ text: 'Lyra — hi', handle: 'Vega', signer: 'v', ts: 1_000_500 }, ctx));
check('own handle is not', !shouldAnswer({ text: 'Lyra — hi', handle: 'Lyra', signer: 'x', ts: 1_000_500 }, ctx));
check('own signer under another handle is not', !shouldAnswer({ text: 'Lyra — hi', handle: 'Mallory', signer: 'me', ts: 1_000_500 }, ctx));
check('replayed history is not', !shouldAnswer({ text: 'Lyra — hi', handle: 'Vega', signer: 'v', ts: 900_000 }, ctx));
check('a row with no timestamp is judged on address alone', shouldAnswer({ text: 'Lyra — hi', handle: 'Vega', signer: 'v', ts: 0 }, ctx));
console.log(`guards: ${n} passed`);
