/**
 * Per-line CC1 / CC2 / BU pickers for purchase-order lines (budgets P5-3; po_items dimensions from migration 954),
 * shared by the new-PO page and the detail page's line editor. The pickers are the bill and customer-invoice lines'
 * `CodingPicker`, offering the company's ACTIVE masters of each kind; the server applies the bill lines' rules (a CC2
 * brings its FNO as CC1, a contradicting CC1 is refused). The lists load only once the pickers are shown
 * (`enabled`), so a page whose Dimensions stay closed reads nothing. A stored id the lists do not offer keeps its
 * label (`storedLabels`), so a save never silently recodes it.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { CodingPicker } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import {
  centreOptions, type CodingOption, type InvoiceLineCodingOptions,
} from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

export interface PoLineDims { cc1: string; cc2: string; bu: string }
export type PoDimSlot = keyof PoLineDims;

export interface PoDimensionOptions {
  cc1s: CodingOption[];
  cc2s: CodingOption[];
  bus: CodingOption[];
  /** The picker's shared state (labels of every id, load status). */
  all: InvoiceLineCodingOptions;
  error: string;
  retry: () => void;
}

type Lists = { cc1s: CodingOption[]; cc2s: CodingOption[]; bus: CodingOption[]; status: 'loading' | 'ready' | 'failed'; error: string };
const LOADING: Lists = { cc1s: [], cc2s: [], bus: [], status: 'loading', error: '' };
const FAILED = 'Could not load the cost centres and business units - try again';

export function usePoDimensionOptions(enabled: boolean, storedLabels: Readonly<Record<string, string>> = {}): PoDimensionOptions {
  const [lists, setLists] = useState<Lists>(LOADING);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setLists(LOADING);
    Promise.all([
      apiJson('/api/accounting/cost-centres?active=true&cc_type=cc1', undefined, FAILED),
      apiJson('/api/accounting/cost-centres?active=true&cc_type=cc2', undefined, FAILED),
      apiJson('/api/accounting/business-units?active=true', undefined, FAILED),
    ]).then(([cc1, cc2, bu]) => {
      if (live) setLists({ cc1s: centreOptions(cc1), cc2s: centreOptions(cc2), bus: centreOptions(bu), status: 'ready', error: '' });
    }).catch((err: unknown) => {
      if (live) setLists({ ...LOADING, status: 'failed', error: apiErrorMessage(err, FAILED) });
    });
    return () => { live = false; };
  }, [enabled, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  const known = { ...storedLabels, ...Object.fromEntries([...lists.cc1s, ...lists.cc2s, ...lists.bus].map((o) => [o.id, o.label])) };
  const all: InvoiceLineCodingOptions = {
    accounts: [], projects: [], cc2s: lists.cc2s, bus: lists.bus, known, status: lists.status, lookupFailed: false, error: lists.error, retry,
  };
  return { cc1s: lists.cc1s, cc2s: lists.cc2s, bus: lists.bus, all, error: lists.error, retry };
}

/** The three header cells, in picker order. */
export function PoDimensionHeaders({ className }: { className: string }) {
  return (
    <>
      <th className={className}>CC1</th>
      <th className={className}>CC2 project</th>
      <th className={className}>BU</th>
    </>
  );
}

/** One line's three picker cells. */
export function PoDimensionCells({ index, value, options, onChange, cellClassName }: {
  index: number; value: PoLineDims; options: PoDimensionOptions; onChange: (slot: PoDimSlot, v: string) => void; cellClassName: string;
}) {
  return (
    <>
      <td className={cellClassName}>
        <CodingPicker label={`Line ${index + 1} CC1`} value={value.cc1} options={options.cc1s} all={options.all} empty="No CC1"
          onChange={(v) => onChange('cc1', v)} />
      </td>
      <td className={cellClassName}>
        <CodingPicker label={`Line ${index + 1} CC2 project`} value={value.cc2} options={options.cc2s} all={options.all} empty="No CC2 project"
          onChange={(v) => onChange('cc2', v)} />
      </td>
      <td className={cellClassName}>
        <CodingPicker label={`Line ${index + 1} BU`} value={value.bu} options={options.bus} all={options.all} empty="No BU"
          onChange={(v) => onChange('bu', v)} />
      </td>
    </>
  );
}
