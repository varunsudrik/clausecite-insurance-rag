import type { ChatTurn } from './rewrite.js';

/** A `[n]` / `[n, m]` citation marker with the single space or tab that precedes it. */
const MARKER_RE = /[ \t]?\[\d+(?:\s*,\s*\d+)*\]/g;

/**
 * Prepares stored turns for replay to a model.
 *
 * - Assistant turns lose their `[n]` markers: those numbers pointed at the sources of that earlier answer,
 *   and replayed next to a new `<source id="n">` list they would invite the model to mis-attribute.
 * - Turns that are blank (after that) are dropped, and so are assistant turns before the first user turn,
 *   because a replayed conversation has to open with the user.
 * - Consecutive turns of the same role (left behind by dropped or errored exchanges) are merged with a blank
 *   line, so roles strictly alternate.
 */
export function sanitizeHistory(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    const content = turn.role === 'assistant' ? turn.content.replace(MARKER_RE, '') : turn.content;
    if (content.trim() === '') continue;
    const last = out.at(-1);
    if (last?.role === turn.role) {
      last.content = `${last.content}\n\n${content}`;
    } else if (last !== undefined || turn.role === 'user') {
      out.push({ role: turn.role, content });
    }
  }
  return out;
}
