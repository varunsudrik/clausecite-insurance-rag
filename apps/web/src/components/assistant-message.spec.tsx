import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClauseCiteUIMessage, SourceRef } from '@/lib/types';
import { AssistantMessage } from './assistant-message';

const source = (n: number, clauseId: string): SourceRef => ({
  n,
  chunkId: `c${n}`,
  documentId: 'd',
  slug: 'star',
  documentTitle: 'Star Comprehensive',
  insurer: 'Star',
  clauseId,
  clauseIds: [clauseId],
  sectionPath: ['Section C: Exclusions'],
  pageStart: 3,
  pageEnd: 3,
  content: `text ${clauseId}`,
  rerankScore: 0.9,
});

const msg = (parts: ClauseCiteUIMessage['parts']): ClauseCiteUIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts,
});

const meta = (over: Record<string, unknown>) => ({
  type: 'data-meta' as const,
  data: {
    messageId: 'a1',
    conversationId: 'c',
    status: 'complete' as const,
    answer: '',
    citations: [],
    uncited: false,
    usage: null,
    latencyMs: {},
    rerankDegraded: false,
    suggestions: [],
    ...over,
  },
});

describe('AssistantMessage', () => {
  it('renders the cleaned meta answer with clickable chips for valid citations only', async () => {
    const onCite = vi.fn();
    render(
      <AssistantMessage
        onCite={onCite}
        message={msg([
          {
            type: 'data-sources',
            data: { conversationId: 'c', question: 'q', sources: [source(1, 'C.3')] },
          },
          { type: 'text', text: 'Raw streamed [1] and bogus [9].' },
          meta({
            answer: 'Cataract waits **24 months** [1].',
            citations: [
              { n: 1, chunkId: 'c1', documentId: 'd', clauseId: 'C.3', pageStart: 3, pageEnd: 3 },
            ],
          }),
        ])}
      />,
    );
    expect(screen.queryByText(/bogus/)).toBeNull();
    expect(screen.getByText('24 months')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /source 1/i }));
    expect(onCite).toHaveBeenCalledWith(expect.objectContaining({ clauseId: 'C.3' }));
  });

  it('shows a refusal callout with clickable suggestions', async () => {
    const onCite = vi.fn();
    render(
      <AssistantMessage
        onCite={onCite}
        message={msg([
          { type: 'data-sources', data: { conversationId: 'c', question: 'q', sources: [] } },
          meta({
            status: 'refused',
            answer: 'I could not find an answer…',
            suggestions: [source(1, 'B.2')],
          }),
        ])}
      />,
    );
    expect(screen.getByText(/not found in the selected policies/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /B\.2/ }));
    expect(onCite).toHaveBeenCalledWith(expect.objectContaining({ clauseId: 'B.2' }));
  });

  it('turns every streamed [n] into a chip while no meta has arrived yet', () => {
    render(
      <AssistantMessage
        onCite={vi.fn()}
        message={msg([
          {
            type: 'data-sources',
            data: {
              conversationId: 'c',
              question: 'q',
              sources: [source(1, 'C.3'), source(2, 'C.4')],
            },
          },
          { type: 'text', text: 'Streaming [1] then [2] then [5].' },
        ])}
      />,
    );
    expect(screen.getByRole('button', { name: /source 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /source 2/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /source 5/i })).toBeNull();
    expect(screen.getByText(/then \[5\]\./)).toBeInTheDocument();
  });

  it('keeps the same chip element while more text streams in, so a click is never lost to a remount', () => {
    const parts = (text: string): ClauseCiteUIMessage['parts'] => [
      {
        type: 'data-sources',
        data: { conversationId: 'c', question: 'q', sources: [source(1, 'C.3')] },
      },
      { type: 'text', text },
    ];
    const { rerender } = render(
      <AssistantMessage onCite={vi.fn()} message={msg(parts('Waits [1]'))} />,
    );
    const chip = screen.getByRole('button', { name: /source 1/i });
    rerender(<AssistantMessage onCite={vi.fn()} message={msg(parts('Waits [1] 24 months'))} />);
    expect(screen.getByRole('button', { name: /source 1/i })).toBe(chip);
  });

  it('flags an answer without citations as uncited', () => {
    render(
      <AssistantMessage
        onCite={vi.fn()}
        message={msg([
          {
            type: 'data-sources',
            data: { conversationId: 'c', question: 'q', sources: [source(1, 'C.3')] },
          },
          meta({ answer: 'General remark.', uncited: true }),
        ])}
      />,
    );
    expect(screen.getByText('uncited')).toBeInTheDocument();
  });
});
