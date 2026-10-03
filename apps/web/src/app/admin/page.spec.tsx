import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { loadSession } from '@/lib/session';
import AdminPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function submitCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
  await user.type(screen.getByLabelText(/password/i), 'dummy-test-password');
  await user.click(screen.getByRole('button', { name: /log in/i }));
}

describe('AdminPage', () => {
  it('logs in, stores the admin session and goes to /documents', async () => {
    push.mockClear();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(200, {
        token: 'adm',
        user: { id: 'a', role: 'admin' },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminPage />);
    await submitCredentials();

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/documents'));
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/auth/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: 'admin@example.com',
      password: 'dummy-test-password',
    });
    expect(loadSession()).toMatchObject({ token: 'adm', role: 'admin' });
  });

  it('shows the wait time when the 429 body carries retryAfterSeconds', async () => {
    push.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          429,
          { statusCode: 429, message: 'Rate limit exceeded', retryAfterSeconds: 42 },
          { 'retry-after': '42' },
        ),
      ),
    );
    render(<AdminPage />);
    await submitCredentials();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rate limit exceeded. Try again in 42 s.',
    );
    expect(push).not.toHaveBeenCalled();
    expect(loadSession()).toBeNull();
  });

  it('falls back to the Retry-After header when the 429 body has no seconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(429, { message: 'Rate limit exceeded' }, { 'retry-after': '840' })),
    );
    render(<AdminPage />);
    await submitCredentials();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rate limit exceeded. Try again in 14 min.',
    );
  });

  it('shows the API message for bad credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { message: 'Invalid credentials', statusCode: 401 })),
    );
    render(<AdminPage />);
    await submitCredentials();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  });
});
