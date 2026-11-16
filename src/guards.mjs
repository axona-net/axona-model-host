// guards.mjs — the rules the HOST enforces. None of them is left to the model.

/** Escape a name for use inside a RegExp. */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this post ADDRESSED to `name`? The name used as a vocative: at the start
 * of a line or a sentence, or after a greeting, and followed by a dash, comma
 * or colon ("Lyra —", "Hello Lyra-", "… are. Lyra, please …"), or "@Name"
 * anywhere. A passing mention is not a question: on 2026-11-15 a mention made
 * the model answer a post that asked it nothing. The first rule was then too
 * strict: it missed "Hello Lyra-" and a mid-paragraph "Lyra, please".
 */
export function isAddressed(text, name) {
  const n = esc(name);
  return new RegExp(`(^|\\n|[.!?]\\s+|\\b(?:hello|hi|hey|dear|thanks|thank you),?\\s+)\\s*\\**@?${n}\\**\\s*(—|–|-|,|:)|@${n}\\b`, 'i').test(String(text ?? ''));
}

/** Does the text contain the name as a whole word at all? */
export function mentions(text, name) { return new RegExp(`\\b${esc(name)}\\b`).test(String(text ?? '')); }

/** A std/message row from axona_poll → { text, handle, signer, ts }. The body may be an object or a JSON string. */
export function readRow(row) {
  let body = row?.message ?? row?.text ?? '';
  if (typeof body === 'string' && body.trim().startsWith('{')) { try { body = JSON.parse(body); } catch { /* plain text */ } }
  const text = typeof body === 'string' ? body : String(body?.text ?? JSON.stringify(body));
  const handle = (body && typeof body === 'object' && typeof body.handle === 'string') ? body.handle : '?';
  return { text, handle, signer: String(row?.signer ?? ''), ts: Number(row?.ts) || 0 };
}

/** At most `perHour` posts in any hour and `minGapMs` between two. */
export class PostLimiter {
  constructor({ perHour = 4, minGapMs = 5 * 60_000, now = Date.now } = {}) { this.perHour = perHour; this.minGapMs = minGapMs; this.now = now; this.times = []; }
  /** null when a post is allowed, else the reason it is not. */
  refusal() {
    const t = this.now();
    while (this.times.length && t - this.times[0] > 3_600_000) this.times.shift();
    if (this.times.length >= this.perHour) return 'hourly limit reached';
    if (this.times.length && t - this.times[this.times.length - 1] < this.minGapMs) return 'too soon after the last post';
    return null;
  }
  record() { this.times.push(this.now()); }
}

/** Should the host hand this row to the model? */
export function shouldAnswer(row, { name, selfSigner, startedAt, trusted = [] }) {
  if (row.handle === name) return false;                               // never answer myself, by handle
  if (selfSigner && row.signer === selfSigner) return false;           // … or by signer
  if (row.ts && row.ts < startedAt - 60_000) return false;             // history replayed at start is context, not a question
  // A trusted signer (the operator) is answered on any mention; everyone else must address it.
  if (trusted.some((t) => t && row.signer.startsWith(t)) && mentions(row.text, name)) return true;
  return isAddressed(row.text, name);
}
