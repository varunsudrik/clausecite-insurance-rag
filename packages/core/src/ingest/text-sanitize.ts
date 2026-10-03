export interface SanitizedText {
  text: string;
  /** Characters dropped (controls and lone surrogates). NFKC rewrites are not counted. */
  removed: number;
}

/**
 * Makes text extracted from a PDF safe to store and embed.
 *
 * Insurer PDFs sometimes map a ligature glyph (e.g. "ffi") to U+0000 in their ToUnicode CMap, so
 * pdf.js hands back "O\0ce" for "Office". Postgres `text` cannot hold U+0000, and the other C0
 * controls are noise at best. This:
 * - normalizes with NFKC, so ligature code points (U+FB01..U+FB06), NBSP and the like become plain text;
 * - drops C0 controls except tab, line feed and carriage return (U+0000–U+0008, U+000B, U+000C,
 *   U+000E–U+001F), DEL (U+007F) and lone surrogates.
 *
 * A NUL that stood for a ligature is lost, not recovered (the CMap carries no information about
 * which letters it stood for), so "O\0ce" becomes "Oce".
 */
export function sanitizePdfText(input: string): SanitizedText {
  const s = input.normalize('NFKC');
  let out = '';
  let kept = 0; // start of the pending run of characters to keep
  let removed = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let drop = false;
    if (c < 0x20) drop = c !== 0x09 && c !== 0x0a && c !== 0x0d;
    else if (c === 0x7f) drop = true;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1); // NaN past the end
      if (next >= 0xdc00 && next <= 0xdfff)
        i++; // a valid pair: keep both halves
      else drop = true;
    } else if (c >= 0xdc00 && c <= 0xdfff) drop = true; // a low surrogate not preceded by a high one
    if (drop) {
      out += s.slice(kept, i);
      kept = i + 1;
      removed++;
    }
  }
  return { text: removed === 0 ? s : out + s.slice(kept), removed };
}
