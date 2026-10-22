/**
 * D2 round 3 (a1): status-path tests for ScanAndFillButton, AddSubsidiaryModal and the document-capture
 * UploadZone. Written so that removing `assertOk` turns them red: a 4xx whose body says `success: true`
 * (or has no `success`, or only a flat `message`) must still fail with the server's words; an empty 500
 * must show a plain sentence; neither may run the success path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));

import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { AddSubsidiaryModal } from '@/components/accounting/consolidation/AddSubsidiaryModal';
import { UploadZone } from '@/components/accounting/document-capture/UploadZone';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
/** 4xx bodies a route can plausibly send, none of which is the canonical `{ success:false, error }` envelope. */
const ODD: Array<[string, () => Response, RegExp | string]> = [
  ['a 4xx whose body says success:true', () => json({ success: true, data: { document: { id: 'X' }, extracted: { confidence: 0.9, warnings: [] }, items: [{ id: 'X' }] } }, 422), 'FALLBACK'],
  ['a 4xx with only a flat message and no success', () => json({ message: MSG }, 403), MSG],
  ['a 4xx with an error object and no success', () => json({ error: { code: 'NOPE', message: MSG } }, 403), MSG],
  ['an empty 500', empty500, 'FALLBACK'],
  ['a non-JSON 502', () => new Response('<html>Bad gateway</html>', { status: 502 }), 'FALLBACK'],
];
const want = (expected: RegExp | string, fallback: string) => (expected === 'FALLBACK' ? fallback : String(expected));

describe('ScanAndFillButton', () => {
  const FALLBACK = 'Could not scan the document - try again';
  function scan(extract: () => Response) {
    route((url) => (url.includes('vlm-status') ? ok({ available: true }) : extract()));
    const onExtracted = vi.fn();
    const { container } = render(<ScanAndFillButton onExtracted={onExtracted} />);
    return { onExtracted, pick: async () => {
      await screen.findByRole('button', { name: /Scan & Fill/ });
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'inv.pdf', { type: 'application/pdf' })] } });
    } };
  }
  it.each(ODD)('%s shows the right text and never fills the form', async (_n, answer, expected) => {
    const s = scan(answer);
    await s.pick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(want(expected, FALLBACK)));
    expect(s.onExtracted).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(String(toast.error.mock.calls[0]![0])).not.toMatch(/JSON|Unexpected end|HTTP \d|^Failed$/);
  });
  it('an empty-body 500 shows a plain sentence', async () => {
    const s = scan(empty500);
    await s.pick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(FALLBACK));
  });
  it('a 202 job id, then a finished poll, fills the form', async () => {
    const extracted = { confidence: 0.9, warnings: [] };
    route((url, method) => (url.includes('vlm-status') ? ok({ available: true })
      : method === 'POST' ? json({ success: true, data: { jobId: 'job-1' } }, 202) : ok({ state: 'done', extracted })));
    const onExtracted = vi.fn();
    const { container } = render(<ScanAndFillButton onExtracted={onExtracted} />);
    await screen.findByRole('button', { name: /Scan & Fill/ });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'inv.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(onExtracted).toHaveBeenCalledWith(extracted), { timeout: 4000 });
  });
});

describe('AddSubsidiaryModal', () => {
  const FALLBACK = 'Could not add the subsidiary - try again';
  function submit(answer: () => Response) {
    route(answer);
    const onSaved = vi.fn(); const onClose = vi.fn();
    const { container } = render(<AddSubsidiaryModal onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText(/xxxxxxxx/), { target: { value: 'child-1' } });
    fireEvent.submit(container.querySelector('form')!);
    return { onSaved, onClose };
  }
  it.each(ODD)('%s shows the right text, keeps the modal open and saves nothing', async (_n, answer, expected) => {
    const s = submit(answer);
    expect(await screen.findByText(want(expected, FALLBACK))).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(s.onSaved).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
  });
  it('a 200 hands the list back and closes', async () => {
    const s = submit(() => ok({ items: [{ id: 'D2-SUB' }] }));
    await waitFor(() => expect(s.onSaved).toHaveBeenCalledWith([{ id: 'D2-SUB' }]));
    expect(s.onClose).toHaveBeenCalled();
  });
});

describe('UploadZone', () => {
  const FALLBACK = 'Could not upload the document - try again';
  function upload(answer: () => Response) {
    route(answer);
    const props = { isUploading: false, isDragging: false, onDraggingChange: vi.fn(), onUploadComplete: vi.fn(),
      onUploadError: vi.fn(), onUploadStart: vi.fn(), onRefreshList: vi.fn() };
    const { container } = render(<UploadZone {...props} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'inv.pdf', { type: 'application/pdf' })] } });
    return props;
  }
  it.each(ODD)('%s reports the right text and never completes the upload', async (_n, answer, expected) => {
    const p = upload(answer);
    await waitFor(() => expect(p.onUploadError).toHaveBeenCalledWith(want(expected, FALLBACK)));
    expect(toast.error).toHaveBeenCalledWith(want(expected, FALLBACK));
    expect(p.onUploadComplete).not.toHaveBeenCalled();
    expect(p.onRefreshList).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('a 200 completes the upload', async () => {
    const p = upload(() => ok({ document: { id: 'D2-DOC' } }));
    await waitFor(() => expect(p.onUploadComplete).toHaveBeenCalledWith({ document: { id: 'D2-DOC' } }));
  });
});
