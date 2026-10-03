import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PdfViewer from './pdf-viewer';

// react-pdf/pdf.js cannot run in jsdom, so <Document>/<Page> are stubs. They model the react-pdf 11
// contract that matters here: `suspense` defaults to TRUE, and then Document/Page suspend while
// loading and rethrow a failed load to the nearest error boundary (the `loading`/`error` props and
// `onLoadError` are only honoured with `suspense={false}`, which `<Page>` inherits from `<Document>`).
// The stubs throw when suspense is on, so a viewer that forgets `suspense={false}` fails every test.
const pdf = vi.hoisted(() => ({
  worker: {} as { workerSrc?: string },
  numPages: 5,
  /** Called with each <Document> load; return an error to make that load fail. */
  loadError: (_file: unknown): (Error & { status?: number }) | undefined => undefined,
}));

vi.mock('react-pdf', async () => {
  const React = await import('react');
  const SuspenseContext = React.createContext(true);
  const requireSuspenseOff = (who: string, suspense: boolean) => {
    if (suspense !== false) {
      throw new Error(
        `${who}: react-pdf 11 suspends/throws to an error boundary unless suspense={false}`,
      );
    }
  };
  return {
    pdfjs: { GlobalWorkerOptions: pdf.worker },
    Document: ({
      file,
      children,
      loading,
      error,
      suspense = true,
      externalLinkTarget,
      externalLinkRel,
      onLoadSuccess,
      onLoadError,
    }: {
      file: { url: string; httpHeaders: Record<string, string> };
      children: React.ReactNode;
      loading: React.ReactNode;
      error: React.ReactNode;
      suspense?: boolean;
      externalLinkTarget?: string;
      externalLinkRel?: string;
      onLoadSuccess: (d: { numPages: number }) => void;
      onLoadError: (e: Error) => void;
    }) => {
      requireSuspenseOff('Document', suspense);
      const [phase, setPhase] = React.useState<'loading' | 'ok' | 'error'>('loading');
      React.useEffect(() => {
        setPhase('loading');
        const err = pdf.loadError(file);
        if (err) {
          setPhase('error');
          onLoadError(err);
        } else {
          setPhase('ok');
          onLoadSuccess({ numPages: pdf.numPages });
        }
        // Loads once per file, like pdf.js.
      }, [file]);
      return (
        <SuspenseContext.Provider value={suspense}>
          <div
            data-testid="document"
            data-url={file.url}
            data-auth={file.httpHeaders.Authorization}
            data-link-target={externalLinkTarget}
            data-link-rel={externalLinkRel}
          >
            {phase === 'loading' ? loading : phase === 'error' ? error : children}
          </div>
        </SuspenseContext.Provider>
      );
    },
    Page: ({
      pageNumber,
      width,
      suspense,
      customTextRenderer,
    }: {
      pageNumber: number;
      width: number;
      suspense?: boolean;
      customTextRenderer: (item: { str: string }) => string;
    }) => {
      const inherited = React.useContext(SuspenseContext);
      requireSuspenseOff('Page', suspense ?? inherited);
      return (
        <div
          data-testid="page"
          data-page={pageNumber}
          data-width={width}
          data-marked={customTextRenderer({ str: 'covered only after 24 months' })}
          data-plain={customTextRenderer({ str: '<b>Ambulance</b>' })}
        />
      );
    },
  };
});

const session = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  loadSession: vi.fn(),
  clearSession: vi.fn(),
}));
vi.mock('@/lib/session', () => session);

const PASSAGE = 'The following procedures are covered only after 24 months';
const MARKED = '<mark>covered only after 24 months</mark>';
const ESCAPED = 'covered only after 24 months';

const viewer = (props: Partial<React.ComponentProps<typeof PdfViewer>> = {}) => (
  <PdfViewer documentId="doc-1" pageStart={3} pageEnd={3} passage={PASSAGE} {...props} />
);

beforeEach(() => {
  Object.values(session).forEach((fn) => fn.mockReset());
  pdf.numPages = 5;
  pdf.loadError = () => undefined;
  session.ensureSession.mockResolvedValue({ token: 'tok-1', role: 'guest', expiresAt: '' });
  session.loadSession.mockReturnValue({ token: 'tok-1', role: 'guest', expiresAt: '' });
});

describe('PdfViewer', () => {
  it('loads the file with the bearer token and starts at the first cited page', async () => {
    render(viewer());
    expect(screen.getByText('Loading PDF…')).toBeInTheDocument();
    const doc = await screen.findByTestId('document');
    expect(doc).toHaveAttribute('data-url', 'http://localhost:3001/documents/doc-1/file');
    expect(doc).toHaveAttribute('data-auth', 'Bearer tok-1');
    expect(await screen.findByText('Page 3 of 5')).toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '3');
  });

  it('runs under the react-pdf 11 contract: suspense off, links open safely in a new tab', async () => {
    // The mocked <Document>/<Page> throw unless the viewer passed `suspense={false}`.
    render(viewer());
    const doc = await screen.findByTestId('document');
    expect(doc).toHaveAttribute('data-link-target', '_blank');
    expect(doc).toHaveAttribute('data-link-rel', 'noopener noreferrer');
  });

  it('percent-encodes the document id in the file URL', async () => {
    render(viewer({ documentId: 'a/b c?x=1' }));
    expect(await screen.findByTestId('document')).toHaveAttribute(
      'data-url',
      'http://localhost:3001/documents/a%2Fb%20c%3Fx%3D1/file',
    );
  });

  it('configures the pdf.js worker from the pdfjs-dist package', () => {
    render(viewer({ pageStart: 1, pageEnd: 1 }));
    expect(pdf.worker.workerSrc).toContain('pdf.worker.min.mjs');
  });

  it('highlights text items only on the cited pages, escaping everything', async () => {
    const user = userEvent.setup();
    render(viewer({ pageStart: 3, pageEnd: 4 }));
    const page = await screen.findByTestId('page');
    expect(page).toHaveAttribute('data-page', '3');
    expect(page).toHaveAttribute('data-marked', MARKED);
    expect(page).toHaveAttribute('data-plain', '&lt;b&gt;Ambulance&lt;/b&gt;');

    await user.click(screen.getByRole('button', { name: /next/i })); // page 4: still cited
    expect(screen.getByTestId('page')).toHaveAttribute('data-marked', MARKED);

    await user.click(screen.getByRole('button', { name: /next/i })); // page 5: not cited
    const outside = screen.getByTestId('page');
    expect(outside).toHaveAttribute('data-page', '5');
    expect(outside).toHaveAttribute('data-marked', ESCAPED);
    expect(outside).toHaveAttribute('data-plain', '&lt;b&gt;Ambulance&lt;/b&gt;');

    await user.click(screen.getByRole('button', { name: /prev/i }));
    await user.click(screen.getByRole('button', { name: /prev/i }));
    await user.click(screen.getByRole('button', { name: /prev/i })); // page 2: not cited
    expect(screen.getByTestId('page')).toHaveAttribute('data-marked', ESCAPED);
  });

  it('keeps Prev/Next within [1, numPages]', async () => {
    const user = userEvent.setup();
    pdf.numPages = 4;
    render(viewer());
    await screen.findByText('Page 3 of 4');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '4');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: /prev/i }));
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '1');
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
  });

  it('clamps a stale page number to the document length', async () => {
    pdf.numPages = 2;
    render(viewer({ pageStart: 9, pageEnd: 9 }));
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('shows the error state, without a pager, when the PDF cannot be loaded', async () => {
    pdf.loadError = () => Object.assign(new Error('missing'), { status: 404 });
    render(viewer());
    expect(await screen.findByText('Could not load the PDF.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /prev|next/i })).toBeNull();
    expect(screen.queryByTestId('page')).toBeNull();
    expect(session.clearSession).not.toHaveBeenCalled();
  });

  it('shows an error when no session can be obtained', async () => {
    session.ensureSession.mockRejectedValue(new Error('offline'));
    render(viewer());
    expect(await screen.findByText('Could not load the PDF.')).toBeInTheDocument();
    expect(screen.queryByTestId('document')).toBeNull();
  });

  it('replaces a rejected token once and reloads the file', async () => {
    pdf.loadError = (file) =>
      (file as { httpHeaders: Record<string, string> }).httpHeaders.Authorization === 'Bearer tok-1'
        ? Object.assign(new Error('unauthorized'), { status: 401 })
        : undefined;
    session.ensureSession
      .mockResolvedValueOnce({ token: 'tok-1', role: 'guest', expiresAt: '' })
      .mockResolvedValueOnce({ token: 'tok-2', role: 'guest', expiresAt: '' });
    render(viewer({ pageStart: 2, pageEnd: 2 }));
    await waitFor(() =>
      expect(screen.getByTestId('document')).toHaveAttribute('data-auth', 'Bearer tok-2'),
    );
    expect(await screen.findByText('Page 2 of 5')).toBeInTheDocument();
    expect(session.clearSession).toHaveBeenCalledOnce();
  });

  it('gives up after one refresh when the new token is rejected too', async () => {
    pdf.loadError = () => Object.assign(new Error('unauthorized'), { status: 401 });
    session.ensureSession
      .mockResolvedValueOnce({ token: 'tok-1', role: 'guest', expiresAt: '' })
      .mockResolvedValueOnce({ token: 'tok-2', role: 'guest', expiresAt: '' });
    render(viewer({ pageStart: 2, pageEnd: 2 }));
    await waitFor(() =>
      expect(screen.getByTestId('document')).toHaveAttribute('data-auth', 'Bearer tok-2'),
    );
    expect(await screen.findByText('Could not load the PDF.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /prev|next/i })).toBeNull();
    expect(session.ensureSession).toHaveBeenCalledTimes(2);
  });

  describe('page width', () => {
    let resize: (width: number) => void;
    const disconnect = vi.fn();

    beforeEach(() => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
            resize = (width) => cb([{ contentRect: { width } }]);
          }
          observe() {}
          disconnect = disconnect;
        },
      );
    });

    it('fits the page to its container, capped at 800 px, and stops observing on unmount', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
      const { unmount } = render(viewer());
      expect(await screen.findByTestId('page')).toHaveAttribute('data-width', '400');
      resize(317.9);
      await waitFor(() => expect(screen.getByTestId('page')).toHaveAttribute('data-width', '317'));
      resize(1400);
      await waitFor(() => expect(screen.getByTestId('page')).toHaveAttribute('data-width', '800'));
      unmount();
      expect(disconnect).toHaveBeenCalled();
    });

    it('uses a default width until the container has been measured', async () => {
      render(viewer()); // jsdom has no layout: clientWidth is 0
      expect(await screen.findByTestId('page')).toHaveAttribute('data-width', '520');
    });
  });
});
