/**
 * The bill screen's pre-fill of a supplier's default CC2 / BU (migration 890).
 *
 *  - only a default the picker offers (an active master) is pre-filled, because the server skips an inactive
 *    default and would refuse a line that names one;
 *  - the screen says what the server applies, including a default FNO (CC1-only) that no field shows, and that a
 *    blank line still takes the default (the server cannot tell "blank" from "open").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, renderHook, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import {
  defaultsNote, offeredDefaults, useSupplierDimensionDefaults, type OfferedMasters,
} from '@/components/accounting/suppliers/useSupplierDimensionDefaults';
import { BillLineItemsTable, type BillLineItem } from '@/components/accounting/suppliers/BillLineItemsTable';
import type { InvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const OFFERED: OfferedMasters = {
  status: 'ready',
  cc2s: [{ id: 'p-active', label: 'PF Project' }],
  bus: [{ id: 'bu-active', label: 'B1 Maintenance' }],
};
const rule = (over: Record<string, string | null>) => ok({ defaultCc1Id: null, defaultCc2Id: null, defaultBuId: null, ...over });

describe('offeredDefaults', () => {
  const held = { cc1Id: 'f1', cc2Id: 'p-gone', buId: 'bu-active' };

  it('pre-fills only the defaults among the active options', () => {
    expect(offeredDefaults(held, OFFERED)).toEqual({ cc2Id: '', buId: 'bu-active' });
  });

  it('pre-fills nothing until the options have loaded', () => {
    expect(offeredDefaults(held, { ...OFFERED, status: 'loading' })).toEqual({ cc2Id: '', buId: '' });
    expect(offeredDefaults(held, { ...OFFERED, status: 'failed' })).toEqual({ cc2Id: '', buId: '' });
  });
});

describe('defaultsNote', () => {
  const HELD = { cc1Id: '', cc2Id: 'p-active', buId: 'bu-active' };
  const NOTHING = { cc2Id: '', buId: '' };

  it('names the project and the BU, each with the lines it goes to', () => {
    const note = defaultsNote(HELD, { cc2Id: 'p-active', buId: 'bu-active' }, OFFERED, '');
    expect(note).toContain('project PF Project on a line that names no project or FNO of its own');
    expect(note).toContain('BU B1 Maintenance on a line that names no BU of its own');
    expect(note).toContain('A line left blank takes them');
  });

  it('does not say the BU waits for a line with no project: a line with its own project still takes the default BU', () => {
    const note = defaultsNote(HELD, { cc2Id: '', buId: 'bu-active' }, OFFERED, '');
    expect(note).toContain('BU B1 Maintenance on a line that names no BU of its own');
    expect(note).not.toMatch(/names none of its own/);
  });

  it('names a default FNO that has no field, and only when no project default is shown', () => {
    const held = { cc1Id: 'f1', cc2Id: '', buId: '' };
    expect(defaultsNote(held, NOTHING, OFFERED, 'FT Fibertime')).toContain('FNO FT Fibertime');
    expect(defaultsNote(HELD, { cc2Id: 'p-active', buId: '' }, OFFERED, 'FT Fibertime')).not.toContain('FNO FT');
  });

  it('says nothing for a supplier with no usable default, or while the lists load', () => {
    expect(defaultsNote(HELD, NOTHING, OFFERED, '')).toBe('');
    expect(defaultsNote(HELD, NOTHING, { ...OFFERED, status: 'loading' }, '')).toBe('');
  });

  it('when the lists failed to load, still says the server may apply what the supplier holds', () => {
    const failed = { ...OFFERED, status: 'failed' as const };
    expect(defaultsNote(HELD, NOTHING, failed, '')).toContain('may be applied on save');
    expect(defaultsNote({ cc1Id: '', cc2Id: '', buId: '' }, NOTHING, failed, '')).toBe('');
  });
});

describe('useSupplierDimensionDefaults', () => {
  const blank = (): BillLineItem[] => [{ key: 'k', description: '', quantity: 1, unitPrice: 0, taxRate: 15, glAccountId: '' }];

  /** Hook plus the lines state it writes to, the way the page holds them. */
  function mount(supplierId: string, offered: OfferedMasters) {
    let lines = blank();
    const setLines = vi.fn((update: (prev: BillLineItem[]) => BillLineItem[]) => { lines = update(lines); });
    const view = renderHook((p: { id: string; offered: OfferedMasters }) =>
      useSupplierDimensionDefaults<BillLineItem>(p.id, setLines, p.offered), { initialProps: { id: supplierId, offered } });
    return { view, lines: () => lines };
  }

  it('stamps the lines with the held defaults the picker offers, and leaves an inactive one off', async () => {
    serve(on('GET', '/supplier-rules/s1', () => rule({ defaultCc2Id: 'p-gone', defaultBuId: 'bu-active' })));
    const { view, lines } = mount('s1', OFFERED);
    await waitFor(() => expect(lines()[0]).toMatchObject({ cc2Id: '', buId: 'bu-active' }));
    expect(view.result.current.defaults).toEqual({ cc2Id: '', buId: 'bu-active' });
  });

  it('waits for the options: nothing is stamped while they load, then the default arrives', async () => {
    serve(on('GET', '/supplier-rules/s1', () => rule({ defaultCc2Id: 'p-active' })));
    const { view, lines } = mount('s1', { ...OFFERED, status: 'loading' });
    await act(async () => { await Promise.resolve(); });
    expect(lines()[0]!.cc2Id ?? '').toBe('');
    view.rerender({ id: 's1', offered: OFFERED });
    await waitFor(() => expect(lines()[0]).toMatchObject({ cc2Id: 'p-active' }));
  });

  it('says a CC1-only default is applied, naming the active FNO', async () => {
    serve(
      on('GET', '/supplier-rules/s1', () => rule({ defaultCc1Id: 'f1' })),
      on('GET', 'cc_type=cc1', () => ok({ items: [{ id: 'f1', code: 'FT', name: 'Fibertime' }] })),
    );
    const { view } = mount('s1', OFFERED);
    await waitFor(() => expect(view.result.current.note).toContain('FNO FT Fibertime'));
    expect(view.result.current.defaults).toEqual({ cc2Id: '', buId: '' });
  });

  it('with the lists failed, nothing is pre-filled but the note says the server may apply the defaults', async () => {
    serve(on('GET', '/supplier-rules/s1', () => rule({ defaultCc2Id: 'p-active', defaultBuId: 'bu-active' })));
    const { view, lines } = mount('s1', { cc2s: [], bus: [], status: 'failed' });
    await waitFor(() => expect(view.result.current.note).toContain('may be applied on save'));
    expect(lines()[0]!.cc2Id ?? '').toBe('');
  });

  it('has no defaults for a supplier with no rule', async () => {
    serve(on('GET', '/supplier-rules/s1', () => new Response('', { status: 404 })));
    const { view, lines } = mount('s1', OFFERED);
    await act(async () => { await Promise.resolve(); });
    expect(lines()[0]!.cc2Id ?? '').toBe('');
    expect(view.result.current.note).toBe('');
  });
});

describe('BillLineItemsTable with supplier defaults', () => {
  const options = { accounts: [], projects: [], cc2s: OFFERED.cc2s, bus: OFFERED.bus, known: {}, status: 'ready',
    lookupFailed: false, error: '', retry: vi.fn() } as InvoiceLineCodingOptions;
  const line: BillLineItem = { key: 'k', description: 'x', quantity: 1, unitPrice: 1, taxRate: 15, glAccountId: '', cc2Id: 'p-active', buId: '' };
  const table = (note: string) => render(
    <BillLineItemsTable lines={[line]} glAccounts={[]} onAdd={vi.fn()} onUpdate={vi.fn()} onRemove={vi.fn()}
      codingOptions={options} supplierDefaults={{ cc2Id: 'p-active', buId: '', note }} />,
  );

  it('shows the note, and labels the blank choice of a defaulted column as the supplier default', () => {
    table('NOTE: the defaults apply on save');
    expect(screen.getByText('NOTE: the defaults apply on save')).toBeDefined();
    // The panel opens by default on a pre-filled line: the blank choice of the CC2 picker says what a blank does.
    expect(screen.getAllByText('Supplier default').length).toBeGreaterThan(0);
    expect(screen.queryByText('No CC2 project')).toBeNull();
  });
});
