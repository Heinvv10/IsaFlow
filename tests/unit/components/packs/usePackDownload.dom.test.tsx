/**
 * WHAT THE SAVED FILE IS CALLED.
 *
 * The server composes the name with `packDownloadFilename`, which prefixes the
 * company slug, and puts it in `Content-Disposition`. The hook read that header
 * from nobody and set `a.download` to its own composed string — so a bureau
 * user downloading the board pack for three clients got three files named
 * `report-pack-board-<from>-to-<to>.pdf`, and in most browsers silently kept
 * only the last of them.
 *
 * The assertion is on the name the browser is actually handed, which is the
 * only place the defect was visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const apiFetchMock = vi.fn();
// `assertOk` is real: a stubbed one would let a refusal blob to disk.
vi.mock('@/lib/apiFetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { ...actual, apiFetch: (...a: unknown[]) => apiFetchMock(...a) };
});
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { usePackDownload } from '@/components/accounting/packs/usePackDownload';

const REQUEST = { packType: 'board', from: '2026-01-01', to: '2026-08-31' };

function pdfResponse(headers: Record<string, string>): Response {
  return new Response('%PDF-1.7 fake', { status: 200, headers });
}

/** The name handed to the browser: the `download` attribute of the anchor the
 *  hook clicks. Captured by watching the anchor it creates. */
let savedAs: string | null;

beforeEach(() => {
  savedAs = null;
  apiFetchMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:pack');
  URL.revokeObjectURL = vi.fn();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag);
    if (tag === 'a') {
      el.click = () => { savedAs = (el as HTMLAnchorElement).download; };
    }
    return el;
  });
});

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

async function download(headers: Record<string, string>): Promise<void> {
  apiFetchMock.mockResolvedValue(pdfResponse(headers));
  const { result } = renderHook(() => usePackDownload(REQUEST));
  await act(async () => { await result.current.download('pdf'); });
}

describe('usePackDownload — the name the file is saved under', () => {
  it("uses the server's filename, which carries the company slug", async () => {
    await download({
      'Content-Disposition':
        'attachment; filename="brightsphere-report-pack-board-2026-01-01-to-2026-08-31.pdf"',
    });
    expect(savedAs).toBe('brightsphere-report-pack-board-2026-01-01-to-2026-08-31.pdf');
  });

  it('keeps two companies apart, which one composed name cannot', async () => {
    await download({ 'Content-Disposition': 'attachment; filename="acme-report-pack-board-a.pdf"' });
    const first = savedAs;
    await download({ 'Content-Disposition': 'attachment; filename="brightsphere-report-pack-board-a.pdf"' });
    expect(first).not.toBe(savedAs);
  });

  it('prefers the RFC 5987 filename* when both forms are sent', async () => {
    await download({
      'Content-Disposition':
        "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''brightsphere%2Dpack.pdf",
    });
    expect(savedAs).toBe('brightsphere-pack.pdf');
  });

  it('strips any path the header carries, since a.download must not', async () => {
    await download({ 'Content-Disposition': 'attachment; filename="../../etc/passwd.pdf"' });
    expect(savedAs).toBe('passwd.pdf');
  });

  it('falls back to the composed name when the response names no file', async () => {
    await download({});
    expect(savedAs).toBe('report-pack-board-2026-01-01-to-2026-08-31.pdf');
  });
});
