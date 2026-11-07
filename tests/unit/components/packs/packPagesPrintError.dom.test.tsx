/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * A pages fetch that fails must tell the renderer, or a refusing tenant holds
 * a render slot for the whole print-ready timeout. The status goes in the
 * attribute; the response body does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { usePackPagesData } from '@/components/accounting/packs/usePackPagesData';
import { renderHook } from '@testing-library/react';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { serialisePackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import { demoInput } from '../../services/packs/fixtures/boardPackInputs';
import { storedBeforeStampedFits } from '../../services/packs/fixtures/storedBeforeStampedFits';
import { PackPagesPrintPage } from '@/components/accounting/packs/PackPagesPrintPage';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import type { StampedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packFigureFitCss';

const attr = () => document.documentElement.getAttribute('data-print-error-pages');
const fontsAttr = () => document.documentElement.getAttribute('data-print-error-fonts');

// `reportError` is real under happy-dom and vitest fails the run on every
// error it reports; the page raises one by design, so it is stubbed here.
beforeEach(() => { vi.stubGlobal('reportError', vi.fn()); });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-print-error-pages');
  document.documentElement.removeAttribute('data-print-error-fonts');
  document.documentElement.className = '';
  window.localStorage.clear();
});

describe('PackPagesPrintPage when the pages fetch fails', () => {
  it('marks a 422 refusal with its status and not its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Acme (Pty) Ltd has a balance that does not foot' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toBe('pages: HTTP 422'));
    expect(attr()).not.toContain('Acme');
  });

  it('marks a pack stored before figure fits were stamped: it is refused, never printed unchecked', async () => {
    const body = JSON.stringify({ data: storedBeforeStampedFits() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toMatch(/^pages: .*without a printable figure size the server decided/));
  });

  it.each([
    ['a fit that does not fit', { px: 10, fits: false }],
    ['a size below the floor', { px: 9, fits: true }],
    ['the ordinary size stated as a size', { px: 12, fits: true }],
    ['a fractional size', { px: 10.5, fits: true }],
  ])('marks a pack whose table carries %s: it is refused, never printed', async (what, figureFit) => {
    const wire = JSON.parse(JSON.stringify(serialisePackPagesDocument(buildBoardPackPages(demoInput)))) as { pages: Array<{ blocks: Array<{ kind: string; table?: { figureFit?: unknown } }> }> };
    const block = wire.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'table')!;
    block.table!.figureFit = figureFit;
    const body = JSON.stringify({ data: wire });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toMatch(/^pages: .*refusing a statement table without a printable figure size/));
  });

  it('a document that reaches the view without its fits (by any road but the adopter) renders no pages and says why', async () => {
    const doc = buildBoardPackPages(demoInput);
    const kpi = doc.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'kpiTiles')!;
    if (kpi.kind === 'kpiTiles') delete (kpi as { fit?: unknown }).fit;
    const { container } = render(<PackPagesView document={doc as StampedPackPagesDocument} />);
    await waitFor(() => expect(attr()).toMatch(/^pages: page \d+: a KPI row without a printable figure size \(null\)/));
    expect(container.querySelectorAll('.pack-page').length).toBe(0);
    expect(container.querySelector('[data-print-ready="false"]')).not.toBeNull();
  });

  it('marks a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    render(<PackPagesPrintPage packType="board" from="2026-01-01" to="2026-08-31" />);
    await waitFor(() => expect(attr()).toBe('pages: socket hang up'));
  });

  it('clears the marker when a later fetch succeeds, but not another producer\'s', async () => {
    const good = JSON.stringify({ data: serialisePackPagesDocument(buildBoardPackPages(demoInput)) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 422, headers: { 'content-type': 'application/json' } }))
      .mockImplementation(async () => new Response(good, { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ to }) => usePackPagesData('board', '2026-01-01', to), {
      initialProps: { to: '2026-08-31' },
    });
    await waitFor(() => expect(attr()).toBe('pages: HTTP 422'));
    rerender({ to: '2026-09-30' });
    await waitFor(() => expect(result.current.document).not.toBeNull());
    expect(attr()).toBeNull();

    document.documentElement.setAttribute('data-print-error-fonts', 'fonts: x');
    rerender({ to: '2026-10-31' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(fontsAttr()).toBe('fonts: x');
  });
});
