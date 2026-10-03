import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicDocument } from '@/lib/types';
import { PolicyScope } from './policy-scope';

const doc = (id: string, title: string): PublicDocument => ({
  id,
  slug: id,
  title,
  insurer: 'Insurer',
  product: 'P',
  policyType: 'health',
  status: 'ready',
  error: null,
  pageCount: 1,
  chunkCount: 1,
  embeddingModel: 'm',
  attempts: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const docs = [doc('a', 'Alpha'), doc('b', 'Beta'), doc('c', 'Gamma')];

function Harness({ onChange }: { onChange: (v: string[] | undefined) => void }) {
  const [value, setValue] = useState<string[] | undefined>();
  return (
    <PolicyScope
      documents={docs}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('PolicyScope', () => {
  it('starts as All policies and builds a subset from the checkboxes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText(/all policies/i, { selector: 'summary' })).toBeInTheDocument();
    await user.click(screen.getByText(/all policies/i, { selector: 'summary' }));
    await user.click(screen.getByRole('checkbox', { name: /alpha/i }));
    await user.click(screen.getByRole('checkbox', { name: /gamma/i }));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'c']);
    expect(screen.getByText(/2 policies/i, { selector: 'summary' })).toBeInTheDocument();
  });

  it('collapses to undefined when the list empties or everything is picked individually', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByText(/all policies/i, { selector: 'summary' }));
    await user.click(screen.getByRole('checkbox', { name: /alpha/i }));
    await user.click(screen.getByRole('checkbox', { name: /alpha/i }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    for (const name of [/alpha/i, /beta/i, /gamma/i]) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole('radio', { name: /all policies/i })).toBeChecked();
  });

  it('the All policies radio clears a subset', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByText(/all policies/i, { selector: 'summary' }));
    await user.click(screen.getByRole('checkbox', { name: /beta/i }));
    expect(screen.getByRole('radio', { name: /all policies/i })).not.toBeChecked();
    await user.click(screen.getByRole('radio', { name: /all policies/i }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('closes on an outside click and on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onChange={vi.fn()} />);
    const details = container.querySelector('details')!;
    await user.click(screen.getByText(/all policies/i, { selector: 'summary' }));
    expect(details.open).toBe(true);
    await user.click(document.body);
    expect(details.open).toBe(false);
    await user.click(screen.getByText(/all policies/i, { selector: 'summary' }));
    expect(details.open).toBe(true);
    await user.keyboard('{Escape}');
    expect(details.open).toBe(false);
  });
});
