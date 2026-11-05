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
