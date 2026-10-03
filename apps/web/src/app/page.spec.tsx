import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRef } from '@/lib/types';
import HomePage from './page';

// The chat and the viewer are exercised in their own specs; here the page's wiring is under test.
vi.mock('@/components/chat-view', () => ({
  ChatView: ({
    onSelectSource,
    onNewChat,
  }: {
    onSelectSource: (s: SourceRef) => void;
    onNewChat: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelectSource(source)}>
        chip 1
      </button>
      <button type="button" onClick={onNewChat}>
        new chat
      </button>
    </div>
  ),
}));
vi.mock('@/components/pdf-viewer', () => ({ default: () => null }));

const source: SourceRef = {
  n: 1,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  slug: 's',
  documentTitle: 'Sample Health Shield',
  insurer: 'Acme',
  clauseId: 'C.3',
  clauseIds: ['C.3'],
  sectionPath: ['Section C: Exclusions'],
  pageStart: 3,
  pageEnd: 3,
  content: 'Cataract surgery is covered after 24 months.',
  rerankScore: 0.9,
};

/** jsdom has no matchMedia; this one reports whether the viewport is at least `lg` wide. */
function viewport(desktop: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: desktop && query.includes('min-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('HomePage citation panel', () => {
  it('shows a hint instead of a panel until a citation is selected', () => {
    viewport(true);
    render(<HomePage />);
    expect(screen.getByText(/Select a citation number/)).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('opens the panel on the heading and, on a small screen, as a non-modal dialog', async () => {
    viewport(false);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(screen.getByRole('button', { name: 'chip 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Sample Health Shield' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(screen.getByRole('heading', { name: 'Sample Health Shield' })).toHaveFocus();
    expect(screen.queryByText(/Select a citation number/)).toBeNull();
  });

  it('is a plain complementary column from lg up', async () => {
    viewport(true);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(screen.getByRole('button', { name: 'chip 1' }));
    expect(screen.getByRole('complementary', { name: 'Sample Health Shield' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and hands focus back to the chip that opened it', async () => {
    viewport(false);
    const user = userEvent.setup();
    render(<HomePage />);
    const chip = screen.getByRole('button', { name: 'chip 1' });
    await user.click(chip);
    expect(chip).not.toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('returns focus to the chip when the Close button is used', async () => {
    viewport(false);
    const user = userEvent.setup();
    render(<HomePage />);
    const chip = screen.getByRole('button', { name: 'chip 1' });
    await user.click(chip);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('closes on New chat without stealing focus from the button', async () => {
    viewport(false);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(screen.getByRole('button', { name: 'chip 1' }));
    const newChat = screen.getByRole('button', { name: 'new chat' });
    await user.click(newChat);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(newChat).toHaveFocus();
  });

  it('pads the chat on a small screen while the sheet is open so the composer stays reachable', async () => {
    viewport(false);
    const user = userEvent.setup();
    const { container } = render(<HomePage />);
    const column = container.querySelector('.min-w-0') as HTMLElement;
    expect(column.className).not.toContain('pb-[70vh]');
    await user.click(screen.getByRole('button', { name: 'chip 1' }));
    expect(column.className).toContain('max-lg:pb-[70vh]');
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(column.className).not.toContain('pb-[70vh]');
  });
});
