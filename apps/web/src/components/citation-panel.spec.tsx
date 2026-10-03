import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SourceRef } from '@/lib/types';
import { CitationPanel } from './citation-panel';

// react-pdf/pdf.js cannot run in jsdom. The panel loads the viewer through `next/dynamic`
// (`ssr: false`), which in jsdom resolves the (mocked) module asynchronously, so assertions on the
// viewer use `findBy*`. The stub exposes the props the panel passes down.
vi.mock('./pdf-viewer', () => ({
  default: (props: { documentId: string; pageStart: number; pageEnd: number; passage: string }) => (
    <div
      data-testid="pdf-viewer"
      data-document={props.documentId}
      data-page-start={props.pageStart}
      data-page-end={props.pageEnd}
      data-passage={props.passage}
    />
  ),
}));

const source: SourceRef = {
  n: 1,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  slug: 'sample-health-shield',
  documentTitle: 'Sample Health Shield',
  insurer: 'Sample Insurance Co.',
  clauseId: 'C.3',
  clauseIds: ['C.3'],
  sectionPath: ['Section C: Exclusions'],
  pageStart: 3,
  pageEnd: 3,
  content: 'C.3 Specified Disease Waiting Period\nCataract surgery is covered after 24 months.',
  rerankScore: 0.92,
};
const other: SourceRef = {
  ...source,
  chunkId: 'chunk-2',
  clauseId: 'B.1',
  pageStart: 2,
  pageEnd: 2,
};

describe('CitationPanel', () => {
  it('renders nothing without a source', () => {
    const { container } = render(<CitationPanel source={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the document, clause, section path, pages and the clause text', () => {
    render(<CitationPanel source={source} onClose={() => {}} />);
    expect(screen.getByText('Sample Health Shield')).toBeInTheDocument();
    expect(screen.getByText(/clause C\.3/)).toBeInTheDocument();
    expect(screen.getByText(/Sample Insurance Co\./)).toBeInTheDocument();
    expect(screen.getByText(/p\. 3/)).toBeInTheDocument();
    expect(screen.getByText('Section C: Exclusions › C.3')).toBeInTheDocument();
    // The clause text keeps its line breaks (whitespace-pre-wrap).
    const text = screen.getByText(/Cataract surgery is covered after 24 months/);
    expect(text).toHaveTextContent('C.3 Specified Disease Waiting Period Cataract surgery');
    expect(text.className).toContain('whitespace-pre-wrap');
  });

  it('shows a page range for a multi-page clause and omits an empty section path', () => {
    render(
      <CitationPanel source={{ ...source, pageEnd: 4, sectionPath: [] }} onClose={() => {}} />,
    );
    expect(screen.getByText(/pp\. 3–4/)).toBeInTheDocument();
    expect(screen.queryByText(/›/)).toBeNull();
  });

  it('opens the PDF viewer with the cited page range and toggles it closed', async () => {
    const user = userEvent.setup();
    render(<CitationPanel source={{ ...source, pageEnd: 4 }} onClose={() => {}} />);
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open PDF at page 3' }));
    const viewer = await screen.findByTestId('pdf-viewer');
    expect(viewer).toHaveAttribute('data-page-start', '3');
    expect(viewer).toHaveAttribute('data-page-end', '4');
    expect(viewer).toHaveAttribute('data-document', 'doc-1');
    expect(viewer).toHaveAttribute('data-passage', source.content);
    await user.click(screen.getByRole('button', { name: 'Hide PDF' }));
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
  });

  it('closes the viewer when another clause is selected', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CitationPanel source={source} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Open PDF at page 3' }));
    await screen.findByTestId('pdf-viewer');
    rerender(<CitationPanel source={other} onClose={() => {}} />);
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open PDF at page 2' })).toBeInTheDocument();
  });

  it('starts closed again when the same clause is reopened after the panel was dismissed', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CitationPanel source={source} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Open PDF at page 3' }));
    await screen.findByTestId('pdf-viewer');
    rerender(<CitationPanel source={null} onClose={() => {}} />);
    rerender(<CitationPanel source={source} onClose={() => {}} />);
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open PDF at page 3' })).toBeInTheDocument();
  });

  it('calls onClose from the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CitationPanel source={source} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus to the heading when a source opens or changes', () => {
    const { rerender } = render(<CitationPanel source={source} onClose={() => {}} />);
    const heading = screen.getByRole('heading', { name: 'Sample Health Shield' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    rerender(<CitationPanel source={other} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Sample Health Shield' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CitationPanel source={source} onClose={onClose} />);
    await user.keyboard('{Escape}'); // focus starts on the heading, inside the panel
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('is a labelled complementary region, or a non-modal dialog when shown as a sheet', () => {
    const { rerender } = render(<CitationPanel source={source} onClose={() => {}} />);
    const region = screen.getByRole('complementary', { name: 'Sample Health Shield' });
    expect(region).not.toHaveAttribute('aria-modal');
    rerender(<CitationPanel source={source} onClose={() => {}} sheet />);
    const dialog = screen.getByRole('dialog', { name: 'Sample Health Shield' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
  });
});
