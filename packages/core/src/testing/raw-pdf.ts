/**
 * Builds a minimal, valid text PDF (Helvetica) by hand so tests can put arbitrary characters
 * (NUL, other control characters) into the text layer, which pdf-lib's encoder refuses to write.
 * Each string in `pages[n]` becomes one line at the 12 pt body size, top to bottom.
 */
export function rawTextPdf(pages: string[][]): Uint8Array {
  const escape = (s: string) =>
    [...s]
      .map((ch) => {
        const code = ch.charCodeAt(0);
        if (ch === '\\' || ch === '(' || ch === ')') return `\\${ch}`;
        if (code < 0x20) return `\\${code.toString(8).padStart(3, '0')}`;
        return ch;
      })
      .join('');

  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // returns the 1-based object number
  const catalog = add('');
  const pagesRoot = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const lines of pages) {
    const content = lines
      .map((line, i) => `BT /F1 12 Tf 50 ${740 - i * 18} Td (${escape(line)}) Tj ET`)
      .join('\n');
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  objects[pagesRoot - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
