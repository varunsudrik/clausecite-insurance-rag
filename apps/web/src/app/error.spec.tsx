import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ErrorPage from './error';

describe('app error boundary', () => {
  it('shows a recovery message and re-renders the segment on Reload', async () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('boom')} reset={reset} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
