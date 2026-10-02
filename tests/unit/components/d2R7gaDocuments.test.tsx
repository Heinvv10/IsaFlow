import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, configure } from '@testing-library/react';
import { useAccountingDocuments } from '@/modules/accounting/documents/useAccountingDocuments';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const fetchMock = vi.fn();
const refused = (message: string, status = 400) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const empty500 = () => new Response('', { status: 500 });
const okDocs = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const DOC = { id: 'd1', file_name: 'a.pdf' };
const BAD = /JSON|Unexpected end|HTTP \d|Failed to/;
const file = () => new File(['x'], 'a.pdf', { type: 'application/pdf' });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('useAccountingDocuments', () => {
  it('load: 200 fills the list', async () => {
    fetchMock.mockResolvedValue(okDocs([DOC]));
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.documents).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it('load: a 4xx shows the server message and clears stale documents', async () => {
    fetchMock.mockResolvedValueOnce(okDocs([DOC])).mockResolvedValueOnce(refused('No access to documents', 403));
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.documents).toHaveLength(1));
    await act(async () => { await result.current.refreshDocuments(); });
    expect(result.current.error).toBe('No access to documents');
    expect(result.current.documents).toEqual([]);
  });

  it('load: an empty 500 gives a plain sentence', async () => {
    fetchMock.mockResolvedValue(empty500());
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.error).toBe('Could not load the documents - try again'));
    expect(result.current.error).not.toMatch(BAD);
  });

  it('upload: 4xx shows the server message and rejects, no document added', async () => {
    fetchMock.mockResolvedValueOnce(okDocs([])).mockResolvedValueOnce(refused('File type not allowed'));
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.uploadDocument(file(), 'invoice' as never)).rejects.toBeTruthy(); });
    expect(result.current.error).toBe('File type not allowed');
    expect(result.current.documents).toEqual([]);
    expect(result.current.uploading).toBe(false);
  });

  it('upload: an empty 500 gives a plain sentence; 200 adds the document', async () => {
    fetchMock.mockResolvedValueOnce(okDocs([])).mockResolvedValueOnce(empty500()).mockResolvedValueOnce(okDocs(DOC));
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.uploadDocument(file(), 'invoice' as never)).rejects.toBeTruthy(); });
    expect(result.current.error).toBe('Could not upload the document - try again');
    expect(result.current.error).not.toMatch(BAD);
    await act(async () => { await result.current.uploadDocument(file(), 'invoice' as never); });
    expect(result.current.documents).toEqual([DOC]);
    expect(result.current.error).toBeNull();
  });

  it('delete: refused keeps the row and shows the message; empty 500 plain; 200 removes', async () => {
    fetchMock.mockResolvedValueOnce(okDocs([DOC]))
      .mockResolvedValueOnce(refused('Document is locked', 409))
      .mockResolvedValueOnce(empty500())
      .mockResolvedValueOnce(okDocs({}));
    const { result } = renderHook(() => useAccountingDocuments('supplier_invoice', 'inv1'));
    await waitFor(() => expect(result.current.documents).toHaveLength(1));
    await act(async () => { await result.current.deleteDocument('d1'); });
    expect(result.current.error).toBe('Document is locked');
    expect(result.current.documents).toHaveLength(1);
    await act(async () => { await result.current.deleteDocument('d1'); });
    expect(result.current.error).toBe('Could not delete the document - try again');
    expect(result.current.error).not.toMatch(BAD);
    expect(result.current.documents).toHaveLength(1);
    await act(async () => { await result.current.deleteDocument('d1'); });
    expect(result.current.documents).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
