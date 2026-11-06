/**
 * A captured document linked to a bank line but too large to copy is one of the line's attachments: listed with no
 * Remove (document capture owns the link), viewable when it claims an inert type, and shown only if its fetched bytes
 * are that type. A claimed PDF whose bytes are HTML shows "Preview not available" and downloads as octet-stream.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { AttachmentViewer } from '@/components/accounting/AttachmentViewer';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { BankLineDrawerBody } from '@/components/accounting/bank-transactions/BankLineDrawerBody';
import { bytesToBlob, canDownload, isCapturedFile, previewKind, safeDownloadName } from '@/components/accounting/attachmentPreview';

useApiJsonOverMock();
const DOC = '22222222-2222-4222-8222-222222222222';
const URL_ = `/api/accounting/captured-document-file?id=${DOC}`;
const PDF = new TextEncoder().encode('%PDF-1.7\n%big scanned invoice');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bytes = (b: Uint8Array) => new Response(b, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
const captured = (over: Record<string, unknown> = {}) => ({
  id: `captured-${DOC}`, bank_transaction_id: 'bt-1', file_url: URL_, file_name: 'scan.pdf', file_size: 7_400_000,
  uploaded_by: null, created_at: '2026-11-06', source: 'captured' as const, content_type: 'application/pdf', ...over,
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/1');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('captured-document preview rules', () => {
  it('offers View only for an inert claimed type, and links every captured document', () => {
    expect(isCapturedFile(URL_)).toBe(true);
    expect(isCapturedFile(`${URL_}&x=1`)).toBe(false);
    expect(isCapturedFile('/api/accounting/captured-document-file?id=../../x')).toBe(false);
    expect(previewKind(URL_, 'application/pdf')).toBe('pdf');
    expect(previewKind(URL_, 'image/jpeg')).toBe('image');
    expect(previewKind(URL_, 'image/tiff')).toBe('none');
    expect(previewKind(URL_, null)).toBe('none');
    expect(previewKind(URL_)).toBe('none');
    expect(canDownload(URL_)).toBe(true);
  });

  it('names the download from the claimed type, else .bin', () => {
    expect(safeDownloadName(URL_, 'scan.pdf', 'application/pdf')).toBe('scan.pdf');
    expect(safeDownloadName(URL_, 'evil.html', 'application/pdf')).toBe('evil.html.pdf');
    expect(safeDownloadName(URL_, 'scan', 'image/tiff')).toBe('scan.tif');
    expect(safeDownloadName(URL_, 'evil.html', null)).toBe('evil.html.bin');
    expect(safeDownloadName(URL_, 'x.svg', 'image/svg+xml')).toBe('x.svg.bin');
  });

  it('types fetched bytes from their own first bytes, inert types only', () => {
    expect(bytesToBlob(PDF.buffer as ArrayBuffer)!.type).toBe('application/pdf');
    expect(bytesToBlob(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)!.type).toBe('image/jpeg');
    expect(bytesToBlob(HTML.buffer as ArrayBuffer)).toBeNull();
    expect(bytesToBlob(new Uint8Array([0x49, 0x49, 0x2a, 0x00]).buffer)).toBeNull();
    expect(bytesToBlob(new ArrayBuffer(0))).toBeNull();
  });
});

describe('the viewer on a captured document', () => {
  it('fetches the bytes, shows Loading…, then the PDF from a blob', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((r) => { release = r; }));
    render(<AttachmentViewer attachments={[captured()]} startIndex={0} onClose={() => undefined} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(URL_);
    release(bytes(PDF));
    expect((await screen.findByTitle('scan.pdf')).getAttribute('src')).toBe('blob:test/1');
    const created = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(created.type).toBe('application/pdf');
  });

  it('never shows bytes that are not what they claim, and downloads them from the route instead', async () => {
    vi.mocked(apiFetch).mockResolvedValue(bytes(HTML));
    render(<AttachmentViewer attachments={[captured({ file_name: 'evil.html' })]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByText('Preview not available for this file')).toBeTruthy();
    expect(document.querySelector('iframe, img')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: 'Download evil.html' });
    expect(link.getAttribute('href')).toBe(URL_);
    expect(link.getAttribute('download')).toBe('evil.html.pdf');
  });

  it('says so when the bytes cannot be fetched', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 404 }));
    render(<AttachmentViewer attachments={[captured()]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByText('Preview not available for this file')).toBeTruthy();
  });
});

describe('a captured document in the bank line\'s lists', () => {
  const upload = { id: 'a1', bank_transaction_id: 'bt-1', file_name: 'slip.png', file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' };

  it('is listed in the modal as a captured document, viewable, downloadable, with no Remove', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u) === URL_ ? bytes(PDF) : ok([upload, captured()])));
    const onCountChange = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCountChange} onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View scan.pdf' });
    expect(onCountChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByText(/Captured document/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove scan.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove slip.png' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download scan.pdf' }).getAttribute('href')).toBe(URL_);
    fireEvent.click(screen.getByRole('button', { name: 'View scan.pdf' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
  });

  it('opens straight to a captured document when it is the only file', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u) === URL_ ? bytes(PDF) : ok([captured()])));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeTruthy();
  });

  it('is listed in the drawer with a View and a link to its route', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      const url = String(u);
      if (url === URL_) return bytes(PDF);
      if (url.includes('bank-tx-attachments')) return ok([captured()]);
      return ok({ id: 'je', entryNumber: 'JE-1', entryDate: '2026-01-01', status: 'posted', lines: [] });
    });
    render(<BankLineDrawerBody tx={{ id: 'bt-1', transactionDate: '2026-06-01', amount: -5, status: 'imported' }} />);
    expect((await screen.findByRole('link', { name: 'scan.pdf' })).getAttribute('href')).toBe(URL_);
    fireEvent.click(screen.getByRole('button', { name: 'View scan.pdf' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
  });
});
