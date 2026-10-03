export function CitationChip({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Source ${n}`}
      onClick={onClick}
      className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-sky-100 px-1 align-baseline text-xs font-semibold text-sky-800 hover:bg-sky-200 dark:bg-sky-900/50 dark:text-sky-200 dark:hover:bg-sky-800"
    >
      {n}
    </button>
  );
}
