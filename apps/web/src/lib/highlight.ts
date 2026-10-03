const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Text items shorter than this are skipped: "the" or "and" would light up all over the page. */
const MIN_FRAGMENT = 4;

/**
 * Builds a pdf.js `customTextRenderer` for one cited passage. pdf.js hands it each text item of the
 * page, and it returns the HTML for that item: escaped (the string becomes `innerHTML`), and wrapped
 * in `<mark>` when the item's normalized text occurs in the normalized passage.
 */
export function makeHighlighter(passage: string): (text: string) => string {
  const haystack = normalize(passage);
  return (text: string) => {
    const escaped = escapeHtml(text);
    const needle = normalize(text);
    return needle.length >= MIN_FRAGMENT && haystack.includes(needle)
      ? `<mark>${escaped}</mark>`
      : escaped;
  };
}
