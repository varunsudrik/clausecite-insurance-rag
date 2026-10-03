'use client';

/**
 * App-level error boundary: a render error anywhere below the layout shows this instead of a blank
 * page. "Reload" re-renders the page from scratch (Next's `reset`).
 */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="mx-auto max-w-md space-y-3 py-16 text-center">
      <p className="text-lg font-semibold tracking-tight">Something went wrong</p>
      <p className="text-sm text-zinc-500">
        The page hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        Reload
      </button>
    </div>
  );
}
