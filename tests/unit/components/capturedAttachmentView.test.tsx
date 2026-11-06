/**
 * A captured document linked to a bank line but too large to copy is one of the line's attachments: listed with no
 * Remove (document capture owns the link), viewable when it claims an inert type, and shown only if its fetched bytes
 * are that type. A claimed PDF whose bytes are HTML shows "Preview not available" and downloads as octet-stream.
 */
import { StrictMode } from 'react';
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
  uploaded_by: null, created_at: '2026-11-06', source: 'captured' as const, content_type: 'application/pdf',
  document_id: DOC, ...over,
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
    expect(isCapturedFile(`https://evil.example${URL_}`)).toBe(false);
    expect(isCapturedFile(URL_.toUpperCase().replace('/API/ACCOUNTING/CAPTURED-DOCUMENT-FILE?ID=', '/api/accounting/captured-document-file?id='))).toBe(true);
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
    const pdf = bytesToBlob(PDF.buffer as ArrayBuffer)!;
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.size).toBe(PDF.length);
    expect(bytesToBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)!.type).toBe('image/png');
    expect(bytesToBlob(new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8 ').buffer as ArrayBuffer)!.type).toBe('image/webp');
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

  it('shows Loading…, never the previous document, while the next one is fetched', async () => {
    const DOC2 = '33333333-3333-4333-8333-333333333333';
    const second = captured({ id: `captured-${DOC2}`, file_url: `/api/accounting/captured-document-file?id=${DOC2}`, file_name: 'second.pdf' });
    vi.mocked(apiFetch).mockImplementation((u) => (String(u) === URL_ ? Promise.resolve(bytes(PDF)) : new Promise<Response>(() => undefined)));
    render(<AttachmentViewer attachments={[captured(), second]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('fetches each document once while open, stepping back included, and under StrictMode', async () => {
    const DOC2 = '33333333-3333-4333-8333-333333333333';
    const U2 = `/api/accounting/captured-document-file?id=${DOC2}`;
    const second = captured({ id: `captured-${DOC2}`, file_url: U2, file_name: 'second.pdf' });
    vi.mocked(apiFetch).mockImplementation(async () => bytes(PDF));
    render(<StrictMode><AttachmentViewer attachments={[captured(), second]} startIndex={0} onClose={() => undefined} /></StrictMode>);
    await screen.findByTitle('scan.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    await screen.findByTitle('second.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Previous attachment' }));
    await screen.findByTitle('scan.pdf');
    const calls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
    expect(calls.filter((u) => u === URL_)).toHaveLength(1);
    expect(calls.filter((u) => u === U2)).toHaveLength(1);
  });

  it('says a file missing from storage is missing, and offers no download of it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 404 }));
    render(<AttachmentViewer attachments={[captured()]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByText('This file is no longer available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Download / })).toBeNull();
  });

  it('shows no download link while the document is loading', () => {
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(() => undefined));
    render(<AttachmentViewer attachments={[captured()]} startIndex={0} onClose={() => undefined} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Download / })).toBeNull();
  });

  it('offers Try again on a failed fetch, and it fetches again', async () => {
    let first = true;
    vi.mocked(apiFetch).mockImplementation(async () => {
      if (first) { first = false; throw new TypeError('network down'); }
      return bytes(PDF);
    });
    render(<AttachmentViewer attachments={[captured()]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByText('Could not load this file')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u) === URL_)).toHaveLength(2);
  });

  it('tries again on a failed fetch when the document is shown again, and never shows a rejected fetch as loading', async () => {
    const DOC2 = '33333333-3333-4333-8333-333333333333';
    const second = captured({ id: `captured-${DOC2}`, file_url: `/api/accounting/captured-document-file?id=${DOC2}`, file_name: 'second.pdf' });
    let first = true;
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      if (String(u) === URL_ && first) { first = false; throw new TypeError('network down'); }
      return bytes(PDF);
    });
    render(<AttachmentViewer attachments={[captured(), second]} startIndex={0} onClose={() => undefined} />);
    expect(await screen.findByText('Could not load this file')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    await screen.findByTitle('second.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Previous attachment' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u) === URL_)).toHaveLength(2);
  });

  it('names the download for the type its bytes proved, not the type it claimed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(bytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    render(<AttachmentViewer attachments={[captured({ file_name: 'scan.pdf' })]} startIndex={0} onClose={() => undefined} />);
    await screen.findByRole('img', { name: 'scan.pdf' });
    expect(screen.getByRole('link', { name: 'Download scan.pdf' }).getAttribute('download')).toBe('scan.pdf.png');
  });
});

describe('a captured document in the bank line\'s lists', () => {
  const upload = { id: 'a1', bank_transaction_id: 'bt-1', file_name: 'slip.png', file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' };

  it('is listed in the modal as a captured document, viewable and downloadable, and Remove unlinks it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u) === URL_ ? bytes(PDF) : ok([upload, captured()])));
    const onCountChange = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCountChange} onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'View scan.pdf' });
    expect(onCountChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByText(/Captured document/)).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download scan.pdf' });
    expect(download.getAttribute('href')).toBe(URL_);
    expect(download.getAttribute('download')).toBe('scan.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'View scan.pdf' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    vi.mocked(apiFetch).mockImplementation(async (u, init) => (init?.method === 'DELETE' ? ok({ unlinked: DOC }) : ok([upload, captured()])));
    fireEvent.click(screen.getByRole('button', { name: 'Remove scan.pdf' }));
    await vi.waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
    const del = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'DELETE')!;
    expect(String(del[0])).toBe(`/api/accounting/bank-tx-attachments?documentId=${DOC}&bankTransactionId=bt-1`);
  });

  it('opens straight to a captured document when it is the only file', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u) === URL_ ? bytes(PDF) : ok([captured()])));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" openFirst onClose={() => undefined} />);
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeTruthy();
  });

  it('unlinks a copied captured document by its document, not by deleting the copy', async () => {
    const copy = { ...upload, id: 'copy-1', file_name: `${DOC}_scan.png`, document_id: DOC, source: 'captured' as const };
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'DELETE' ? ok({ unlinked: DOC }) : ok([copy])));
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: `Remove ${DOC}_scan.png` }));
    await vi.waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true));
    const del = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'DELETE')!;
    expect(String(del[0])).toContain(`documentId=${DOC}`);
    expect(String(del[0])).not.toContain('?id=');
  });

  it('is listed in the drawer with a View and a link to its route', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      const url = String(u);
      if (url === URL_) return bytes(PDF);
      if (url.includes('bank-tx-attachments')) return ok([captured()]);
      return ok({ id: 'je', entryNumber: 'JE-1', entryDate: '2026-01-01', status: 'posted', lines: [] });
    });
    render(<BankLineDrawerBody tx={{ id: 'bt-1', transactionDate: '2026-06-01', amount: -5, status: 'imported' }} />);
    const link = await screen.findByRole('link', { name: 'scan.pdf' });
    expect(link.getAttribute('href')).toBe(URL_);
    expect(link.getAttribute('download')).toBe('scan.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'View scan.pdf' }));
    expect(await screen.findByTitle('scan.pdf')).toBeTruthy();
  });
});
