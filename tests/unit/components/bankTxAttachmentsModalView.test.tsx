/**
 * The attachments modal opens a file in the viewer instead of only offering a download. Opened from a highlighted
 * paperclip (openFirst) it goes straight to the first file; closing the viewer leaves the list, so upload and remove
 * stay one click away. It reports the count after every load and remove, so the row's highlight follows.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const FILES = [
  { id: 'a1', bank_transaction_id: 'bt-1', file_name: 'slip.png', file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' },
  { id: 'a2', bank_transaction_id: 'bt-1', file_name: 'note.html', file_url: 'data:text/html;base64,PHNjcmlwdD4=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' },
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'DELETE' ? ok({ deleted: true }) : ok(FILES)));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/1');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('BankTxAttachmentsModal viewing', () => {
  it('opens a previewable file in the viewer from its View button, and back to the list on close', async () => {
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View slip.png' }));
    expect(screen.getByRole('img', { name: 'slip.png' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Attachments' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Attachments' }).contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape, and keeps Escape in the viewer while the viewer is open', async () => {
    const onClose = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View slip.png' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Attachment preview' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Attachments' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Attachments' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the file whose View was pressed, counting only the files it can show', async () => {
    const third = { ...FILES[0]!, id: 'a3', file_name: 'till.png' };
    vi.mocked(apiFetch).mockImplementation(async () => ok([...FILES, third]));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View till.png' }));
    expect(screen.getByRole('img', { name: 'till.png' })).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('reports no count, and opens nothing, when the list cannot be read', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 500 }));
    const onCountChange = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onCountChange={onCountChange} onClose={() => undefined} />);
    expect(await screen.findByText('No attachments yet')).toBeTruthy();
    expect(onCountChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
  });

  it('offers no View button for a file it will not preview', async () => {
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View slip.png' });
    expect(screen.queryByRole('button', { name: 'View note.html' })).toBeNull();
  });

  it('goes straight to the first file when opened with openFirst', async () => {
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'slip.png' })).toBeTruthy();
    // It steps through the files it can show: note.html stays in the list, never in the viewer.
    expect(screen.getByText('1 of 1')).toBeTruthy();
  });

  it('reports the count after loading and after a remove', async () => {
    const onCountChange = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCountChange} onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View slip.png' });
    expect(onCountChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove slip.png' }));
    await vi.waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
  });
});

describe('BankTxAttachmentsModal openFirst and a changing list', () => {
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'new.png', { type: 'image/png' });
  const upload = (file: File) => fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

  it('opens the viewer once only: an upload after closing it stays on the list', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? ok({ id: 'n' }) : ok(FILES)));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }));
    const reads = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => !i?.method).length;
    const before = reads();
    upload(png());
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'View slip.png' })).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
  });

  it('does not open the viewer later when the first load failed', async () => {
    let reads = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (init?.method === 'POST') return ok({ id: 'n' });
      reads += 1;
      return reads === 1 ? new Response(JSON.stringify({ success: false }), { status: 500 }) : ok(FILES);
    });
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    await screen.findByText('No attachments yet');
    upload(png());
    await screen.findByRole('button', { name: 'View slip.png' });
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
  });

  it('stays on the list when openFirst finds nothing it can show', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([FILES[1]]));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    await screen.findByText('note.html');
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
  });

  it('closes the viewer when an upload finishes behind it, since its index no longer names the same file', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST'
      ? new Promise<Response>((r) => { release = r; }) : ok(FILES)));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View slip.png' });
    upload(png());
    await vi.waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'View slip.png' }));
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeTruthy();
    release(ok({ id: 'n' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Attachments' })).toBeTruthy();
  });

  it('keeps the list on screen while it refreshes after an upload', async () => {
    let gate: (r: Response) => void = () => undefined;
    let reads = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (init?.method === 'POST') return ok({ id: 'n' });
      reads += 1;
      return reads === 1 ? ok(FILES) : new Promise<Response>((r) => { gate = r; });
    });
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View slip.png' });
    upload(png());
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('button', { name: 'View slip.png' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    gate(ok(FILES));
  });
});

describe('BankTxAttachmentsModal placement', () => {
  it('renders into document.body, outside the layout column whose stacking context the top nav draws over', async () => {
    const { container } = render(<main style={{ position: 'relative', zIndex: 0 }}>
      <BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />
    </main>);
    const dialog = await screen.findByRole('dialog', { name: 'Attachments' });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
  });
});
