import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PdfViewer from './pdf-viewer';

// react-pdf/pdf.js cannot run in jsdom, so <Document>/<Page> are stubs that expose what the viewer
// passes them: the file source, the page number, and the text renderer's output.
const pdf = vi.hoisted(() => ({
  worker: {} as { workerSrc?: string },
  numPages: 5,
  /** Called with each <Document> mount; return an error to make that load fail. */
  loadError: (_file: unknown): (Error & { status?: number }) | undefined => undefined,
}));

vi.mock('react-pdf', async () => {
  const React = await import('react');
  return {
    pdfjs: { GlobalWorkerOptions: pdf.worker },
    Document: ({
      file,
      children,
      loading,
      error,
      onLoadSuccess,
      onLoadError,
    }: {
      file: { url: string; httpHeaders: Record<string, string> };
      children: React.ReactNode;
      loading: React.ReactNode;
      error: React.ReactNode;
      onLoadSuccess: (d: { numPages: number }) => void;
      onLoadError: (e: Error) => void;
    }) => {
      const [phase, setPhase] = React.useState<'loading' | 'ok' | 'error'>('loading');
      React.useEffect(() => {
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
        <div data-testid="document" data-url={file.url} data-auth={file.httpHeaders.Authorization}>
          {phase === 'loading' ? loading : phase === 'error' ? error : children}
        </div>
      );
    },
    Page: ({
      pageNumber,
      width,
      customTextRenderer,
    }: {
      pageNumber: number;
      width: number;
      customTextRenderer: (item: { str: string }) => string;
    }) => (
      <div
        data-testid="page"
        data-page={pageNumber}
        data-width={width}
        data-marked={customTextRenderer({ str: 'covered only after 24 months' })}
        data-plain={customTextRenderer({ str: '<b>Ambulance</b>' })}
      />
    ),
  };
});

const session = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  loadSession: vi.fn(),
  clearSession: vi.fn(),
}));
vi.mock('@/lib/session', () => session);

const PASSAGE = 'The following procedures are covered only after 24 months';

beforeEach(() => {
  Object.values(session).forEach((fn) => fn.mockReset());
  pdf.numPages = 5;
  pdf.loadError = () => undefined;
  session.ensureSession.mockResolvedValue({ token: 'tok-1', role: 'guest', expiresAt: '' });
  session.loadSession.mockReturnValue({ token: 'tok-1', role: 'guest', expiresAt: '' });
});

describe('PdfViewer', () => {
  it('loads the file with the bearer token and starts at the requested page', async () => {
    render(<PdfViewer documentId="doc-1" page={3} passage={PASSAGE} />);
    expect(screen.getByText('Loading PDF…')).toBeInTheDocument();
    const doc = await screen.findByTestId('document');
    expect(doc).toHaveAttribute('data-url', 'http://localhost:3001/documents/doc-1/file');
    expect(doc).toHaveAttribute('data-auth', 'Bearer tok-1');
    expect(await screen.findByText('Page 3 of 5')).toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '3');
  });

  it('configures the pdf.js worker from the pdfjs-dist package', () => {
    render(<PdfViewer documentId="doc-1" page={1} passage={PASSAGE} />);
    expect(pdf.worker.workerSrc).toContain('pdf.worker.min.mjs');
  });

  it('highlights text items that belong to the passage, escaping the rest', async () => {
    render(<PdfViewer documentId="doc-1" page={3} passage={PASSAGE} />);
    const page = await screen.findByTestId('page');
    expect(page).toHaveAttribute('data-marked', '<mark>covered only after 24 months</mark>');
    expect(page).toHaveAttribute('data-plain', '&lt;b&gt;Ambulance&lt;/b&gt;');
  });

  it('keeps Prev/Next within [1, numPages]', async () => {
    const user = userEvent.setup();
    pdf.numPages = 4;
    render(<PdfViewer documentId="doc-1" page={3} passage={PASSAGE} />);
    const prev = await screen.findByRole('button', { name: /prev/i });
    const next = screen.getByRole('button', { name: /next/i });
    await screen.findByText('Page 3 of 4');
    await user.click(next);
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '4');
    expect(next).toBeDisabled();
    await user.click(prev);
    await user.click(prev);
    await user.click(prev);
    expect(screen.getByTestId('page')).toHaveAttribute('data-page', '1');
    expect(prev).toBeDisabled();
  });

  it('clamps a stale page number to the document length', async () => {
    pdf.numPages = 2;
    render(<PdfViewer documentId="doc-1" page={9} passage={PASSAGE} />);
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('shows an error when the PDF cannot be loaded', async () => {
    pdf.loadError = () => Object.assign(new Error('missing'), { status: 404 });
    render(<PdfViewer documentId="doc-1" page={1} passage={PASSAGE} />);
    expect(await screen.findByText('Could not load the PDF.')).toBeInTheDocument();
    expect(session.clearSession).not.toHaveBeenCalled();
  });

  it('shows an error when no session can be obtained', async () => {
    session.ensureSession.mockRejectedValue(new Error('offline'));
    render(<PdfViewer documentId="doc-1" page={1} passage={PASSAGE} />);
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
    render(<PdfViewer documentId="doc-1" page={2} passage={PASSAGE} />);
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
    render(<PdfViewer documentId="doc-1" page={2} passage={PASSAGE} />);
    await waitFor(() =>
      expect(screen.getByTestId('document')).toHaveAttribute('data-auth', 'Bearer tok-2'),
    );
    expect(await screen.findByText('Could not load the PDF.')).toBeInTheDocument();
    expect(session.ensureSession).toHaveBeenCalledTimes(2);
  });
});
