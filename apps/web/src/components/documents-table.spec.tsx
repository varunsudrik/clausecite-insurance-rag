import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PublicDocument } from '@/lib/types';
import { DocumentsTable } from './documents-table';

const doc = (over: Partial<PublicDocument>): PublicDocument => ({
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

describe('DocumentsTable', () => {
  it('renders status, pages and chunks; hides admin actions for guests', () => {
    render(
      <DocumentsTable
        documents={[
          doc({}),
          doc({ id: 'd2', title: 'Broken', status: 'failed', error: 'NO_TEXT_LAYER' }),
        ]}
        isAdmin={false}
        onReingest={vi.fn()}
      />,
    );
    expect(screen.getByText('Star Comprehensive')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('NO_TEXT_LAYER')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-ingest/i })).toBeNull();
  });

  it('shows re-ingest for admins and calls back with the id', async () => {
    const onReingest = vi.fn();
    render(<DocumentsTable documents={[doc({})]} isAdmin onReingest={onReingest} />);
    await userEvent.click(screen.getByRole('button', { name: /re-ingest/i }));
    expect(onReingest).toHaveBeenCalledWith('d1');
  });
});
