import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SourceRef } from '@/lib/types';
import { CitationPanel } from './citation-panel';

// react-pdf/pdf.js cannot run in jsdom. The panel loads the viewer through `next/dynamic`
// (`ssr: false`), which in jsdom resolves the (mocked) module asynchronously, so assertions on the
// viewer use `findBy*`. The stub exposes the props the panel passes down.
vi.mock('./pdf-viewer', () => ({
  default: ({
    documentId,
    page,
    passage,
  }: {
    documentId: string;
    page: number;
    passage: string;
  }) => (
    <div
      data-testid="pdf-viewer"
      data-document={documentId}
      data-page={page}
      data-passage={passage}
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

  it('opens the PDF viewer at the first page of the clause and toggles it closed', async () => {
    const user = userEvent.setup();
    render(<CitationPanel source={source} onClose={() => {}} />);
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open PDF at page 3' }));
    const viewer = await screen.findByTestId('pdf-viewer');
    expect(viewer).toHaveAttribute('data-page', '3');
    expect(viewer).toHaveAttribute('data-document', 'doc-1');
    expect(viewer).toHaveAttribute('data-passage', source.content);
    await user.click(screen.getByRole('button', { name: 'Hide PDF' }));
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
  });

  it('calls onClose from the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CitationPanel source={source} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
