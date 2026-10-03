/** Turn valid [n] markers into #cite-n links so react-markdown can render them as chips. */
export function linkifyCitations(text: string, validNs: ReadonlySet<number>): string {
  // Split out fenced blocks and inline code; only transform prose segments.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d+)\](?!\()/g, (m, n: string) =>
            validNs.has(Number(n)) ? `[${n}](#cite-${n})` : m,
          ),
    )
    .join('');
}
