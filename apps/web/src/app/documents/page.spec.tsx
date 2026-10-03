import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicDocument } from '@/lib/types';
import DocumentsPage from './page';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const doc = (over: Partial<PublicDocument> = {}): PublicDocument => ({
  id: 'd1',
  slug: 'star',
  title: 'Star Comprehensive',
  insurer: 'Star Health',
  product: 'Comprehensive',
  policyType: 'health',
  status: 'ready',
  error: null,
  pageCount: 42,
  chunkCount: 180,
  embeddingModel: 'm',
  attempts: 0,
  createdAt: '2026-10-03T00:00:00Z',
  updatedAt: '2026-10-03T00:00:00Z',
  ...over,
});
const storeSession = (role: 'guest' | 'admin') =>
  localStorage.setItem(
    'clausecite.session',
    JSON.stringify({ token: `${role}-tok`, role, expiresAt: future() }),
  );

/** Lets already-resolved fetch/Response promises (real timers) settle inside act(). */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 15)));
/** Advances the fake setInterval clock, then lets the resulting requests settle. */
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  });
const listCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/documents')).length;

describe('DocumentsPage polling', () => {
  // Only the interval is faked: Response/fetch plumbing keeps running on real timers.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('polls every 5 s while a document is queued or processing, then stops when all are ready', async () => {
    storeSession('guest');
    let docs = [doc({ status: 'queued' })];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, docs));
    vi.stubGlobal('fetch', fetchMock);

    render(<DocumentsPage />);
    await settle();
    expect(listCalls(fetchMock)).toBe(1);
    expect(screen.getByText('queued')).toBeInTheDocument();

    await advance(4_900);
    expect(listCalls(fetchMock)).toBe(1);
    await advance(100);
    expect(listCalls(fetchMock)).toBe(2);

    docs = [doc({ status: 'processing' })];
    await advance(5_000);
    expect(listCalls(fetchMock)).toBe(3);
    expect(screen.getByText('processing')).toBeInTheDocument();

    docs = [doc({ status: 'ready' })];
    await advance(5_000);
    expect(listCalls(fetchMock)).toBe(4);
    expect(screen.getByText('ready')).toBeInTheDocument();

    await advance(30_000);
    expect(listCalls(fetchMock)).toBe(4); // nothing ingesting any more: no further polls
  });

  it('does not poll at all when everything is already ready', async () => {
    storeSession('guest');
    const fetchMock = vi.fn(async () => json(200, [doc()]));
    vi.stubGlobal('fetch', fetchMock);
    render(<DocumentsPage />);
    await settle();
    await advance(30_000);
    expect(listCalls(fetchMock)).toBe(1);
  });

  it('clears the interval on unmount', async () => {
    storeSession('guest');
    const fetchMock = vi.fn(async () => json(200, [doc({ status: 'processing' })]));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<DocumentsPage />);
    await settle();
    await advance(5_000);
    expect(listCalls(fetchMock)).toBe(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30_000);
    expect(listCalls(fetchMock)).toBe(2);
  });

  it('skips a poll tick while the previous request is still pending', async () => {
    storeSession('guest');
    let release!: (r: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, [doc({ status: 'queued' })]))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockResolvedValue(json(200, [doc({ status: 'queued' })]));
    vi.stubGlobal('fetch', fetchMock);

    render(<DocumentsPage />);
    await settle();
    await advance(5_000); // second request starts and hangs
    expect(listCalls(fetchMock)).toBe(2);
    await advance(15_000); // three more ticks while it is pending
    expect(listCalls(fetchMock)).toBe(2);

    await act(async () => release(json(200, [doc({ status: 'queued' })])));
    await settle();
    await advance(5_000);
    expect(listCalls(fetchMock)).toBe(3);
  });
});

describe('DocumentsPage admin actions', () => {
  it('hides upload and re-ingest for guests', async () => {
    storeSession('guest');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, [doc()])),
    );
    render(<DocumentsPage />);
    expect(await screen.findByText('Star Comprehensive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-ingest/i })).toBeNull();
    expect(screen.queryByText(/upload a policy/i)).toBeNull();
  });

  it('re-ingest posts to the url-encoded id, disables the button while pending, then reloads', async () => {
    storeSession('admin');
    let release!: (r: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => (release = resolve))
        : Promise.resolve(json(200, [doc({ id: 'a/b' })])),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<DocumentsPage />);

    const button = await screen.findByRole('button', { name: 'Re-ingest Star Comprehensive' });
    expect(screen.getByText(/upload a policy/i)).toBeInTheDocument();
    await userEvent.click(button);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('http://localhost:3001/documents/a%2Fb/reingest');
    expect(button).toBeDisabled();
    await userEvent.click(button); // a second click while pending is a no-op
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);

    await act(async () => release(json(202, doc({ id: 'a/b', status: 'queued' }))));
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  it('shows a red banner when re-ingest fails', async () => {
    storeSession('admin');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? json(503, { message: 'queue unavailable' }) : json(200, [doc()]),
      ),
    );
    render(<DocumentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /re-ingest/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('queue unavailable');
  });
});
