// Pure helper for `ingest-sources.ts`: the script logs in with ADMIN_EMAIL/ADMIN_PASSWORD, so it must
// never do that over plain http to a remote host. No I/O, so it is unit-testable.

/** Hosts where plain http is acceptable: the credentials never leave this machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why `apiUrl` is not safe to send the admin credentials to, or `undefined` when it is.
 * https is always accepted; http only for `localhost`, `127.0.0.1` and `[::1]`.
 * The message names the host but never echoes the URL itself (it may carry userinfo).
 */
export function apiUrlProblem(apiUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return 'API_URL is not a valid URL (expected e.g. https://<domain>/api).';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol !== 'http:') {
    return `API_URL must be an http(s) URL, not "${url.protocol}".`;
  }
  if (LOCAL_HOSTS.has(url.hostname)) return undefined;
  return (
    `Refusing to send ADMIN_EMAIL/ADMIN_PASSWORD over plain http to "${url.hostname}". ` +
    'Use an https:// API_URL (plain http is only allowed for localhost, 127.0.0.1 and [::1]).'
  );
}
