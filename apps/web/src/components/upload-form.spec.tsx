import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadForm } from './upload-form';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText(/pdf file/i),
    new File(['%PDF-1.4'], 'policy.pdf', { type: 'application/pdf' }),
  );
  await user.type(screen.getByLabelText(/slug/i), 'star-comprehensive');
  await user.type(screen.getByLabelText(/title/i), 'Star Comprehensive');
  await user.type(screen.getByLabelText(/insurer/i), 'Star Health');
  await user.type(screen.getByLabelText(/product/i), 'Comprehensive');
  // jsdom's constraint validation does not see files set by user-event, so submit the form directly.
  fireEvent.submit(screen.getByRole('button', { name: /upload/i }).closest('form')!);
}

describe('UploadForm', () => {
  it('posts multipart form data with the bearer token and no content-type, then resets', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'adm', role: 'admin', expiresAt: future() }),
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(201, { id: 'd1', deduplicated: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onUploaded = vi.fn();
    render(<UploadForm onUploaded={onUploaded} />);

    await fillAndSubmit();

    expect(await screen.findByText('Uploaded — ingesting…')).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/documents');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer adm');
    expect(headers.get('content-type')).toBeNull();
    const body = init?.body as FormData;
    // jsdom's FormData does not carry user-event's file through, so only the field's presence is checked.
    expect(body.has('file')).toBe(true);
    expect(body.get('slug')).toBe('star-comprehensive');
    expect(body.get('policy_type')).toBe('health');
    expect(screen.getByLabelText(/slug/i)).toHaveValue('');
  });

  it('reports a deduplicated upload', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'adm', role: 'admin', expiresAt: future() }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { id: 'd1', deduplicated: true })),
    );
    render(<UploadForm onUploaded={vi.fn()} />);
    await fillAndSubmit();
    expect(await screen.findByText('Already ingested (deduplicated)')).toBeInTheDocument();
  });

  it('shows the API error message and keeps the form values', async () => {
    localStorage.setItem(
      'clausecite.session',
      JSON.stringify({ token: 'adm', role: 'admin', expiresAt: future() }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(409, { message: 'slug already exists' })),
    );
    const onUploaded = vi.fn();
    render(<UploadForm onUploaded={onUploaded} />);
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('slug already exists');
    expect(onUploaded).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(/slug/i)).toHaveValue('star-comprehensive'));
  });
});
