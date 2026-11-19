/**
 * The picked supplier's default CC2 project and BU (migration 890), for the
 * bill screen to show on its lines before saving. The server applies the same
 * defaults to any line that names none (supplierDimensionDefaults.ts), so this
 * pre-fill makes the value visible; it does not make it optional. A pre-filled
 * value can be replaced by another one, but not cleared: a line sent without a
 * CC2 or BU is "open" to the server, which fills it from the default again
 * (null already means "none given" to every other caller, so it cannot also
 * mean "leave it blank"). The screen says so in `note`, and also names a
 * default FNO (CC1) that the server applies to a line with no project, which
 * has no field on this screen to show it in.
 *
 * Only defaults the picker offers (active masters) are pre-filled, because the
 * server skips an inactive default and would refuse a line that named one.
 * When the supplier changes, a line still holding the previous supplier's
 * default (or nothing) takes the new one; a value the user picked stays.
 * A supplier with no rule (404) has no defaults; a failed read is logged and
 * shows none (the server still applies them on save). `status` says whether
 * what the server will apply to a line that names no CC is known yet: it is
 * 'loading' from the render that names a new supplier until its rule (and,
 * for a project default, the pick-lists) arrive, and 'failed' when either
 * read failed, so the table never shows the previous supplier's CC1 or a
 * dash in its place.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { centreOptions, type CodingOption } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

export interface SupplierLineDefaults { cc2Id: string; buId: string }

interface HeldDefaults extends SupplierLineDefaults { cc1Id: string }

/** The active masters the picker offers; defaults are pre-filled once these have loaded. */
export interface OfferedMasters { cc2s: CodingOption[]; bus: CodingOption[]; status: 'loading' | 'ready' | 'failed' }

const NONE: SupplierLineDefaults = { cc2Id: '', buId: '' };
const NO_HELD: HeldDefaults = { cc1Id: '', ...NONE };

/** Whether what the server applies to a line that names no CC is known: see the header. */
export type SupplierDefaultsStatus = 'loading' | 'failed' | 'ready';

/** The rule read for `supplierId` ('' = none picked). */
interface RuleRead { supplierId: string; held: HeldDefaults; failed: boolean }

/** Pure: the status for the supplier now picked, given the last rule read and the pick-lists. */
export function defaultsStatus(read: RuleRead, supplierId: string, offered: OfferedMasters): SupplierDefaultsStatus {
  if (read.supplierId !== supplierId) return 'loading';
  if (read.failed) return 'failed';
  // A project default reaches the lines only through the pick-lists (offeredDefaults); a CC1-only one does not.
  return read.held.cc2Id ? offered.status : 'ready';
}

type DimLine = { cc1Id?: string; cc2Id?: string; buId?: string };

/** Pure: re-stamp the lines that still carry the previous defaults (or none). */
export function restampLines<T extends DimLine>(lines: readonly T[], prev: SupplierLineDefaults, next: SupplierLineDefaults): T[] {
  return lines.map((l) => {
    // A line naming its own CC1 was copied from a PO, whose dimensions are taken whole (`poBillLines.ts`).
    if (l.cc1Id) return l;
    const cc2 = l.cc2Id ?? '';
    const bu = l.buId ?? '';
    return {
      ...l,
      cc2Id: cc2 === '' || cc2 === prev.cc2Id ? next.cc2Id : cc2,
      buId: bu === '' || bu === prev.buId ? next.buId : bu,
    };
  });
}

/** Pure: the held defaults the picker offers (an id not among the active options is not pre-filled). */
export function offeredDefaults(held: HeldDefaults, offered: OfferedMasters): SupplierLineDefaults {
  if (offered.status !== 'ready') return NONE;
  return {
    cc2Id: offered.cc2s.some((o) => o.id === held.cc2Id) ? held.cc2Id : '',
    buId: offered.bus.some((o) => o.id === held.buId) ? held.buId : '',
  };
}

/**
 * Pure: what the server will apply on save, in words ('' when there is nothing to say yet or nothing usable).
 * The project (and FNO) default goes to a line that names neither of its own; the BU default goes to any line
 * with no BU, whatever its project (supplierDimensionDefaults.ts). While the pick-lists fail to load nothing can be
 * named, but the server may still apply what the supplier holds (it skips inactive ones, which cannot be told
 * apart without the lists), so the note says that much and no more.
 */
export function defaultsNote(held: HeldDefaults, applied: SupplierLineDefaults, offered: OfferedMasters, fnoLabel: string): string {
  if (offered.status === 'failed') {
    return held.cc1Id || held.cc2Id || held.buId
      ? "The lists could not be loaded, so this supplier's default dimensions are not shown here. Any that are still active may be applied on save to lines that leave them open."
      : '';
  }
  const label = (options: CodingOption[], id: string) => options.find((o) => o.id === id)?.label ?? '';
  const parts = [
    applied.cc2Id ? `project ${label(offered.cc2s, applied.cc2Id)}` : fnoLabel ? `FNO ${fnoLabel}` : '',
  ].filter(Boolean).map((p) => `${p} on a line that names no project or FNO of its own`);
  if (applied.buId) parts.push(`BU ${label(offered.bus, applied.buId)} on a line that names no BU of its own`);
  if (parts.length === 0) return '';
  return `This supplier's defaults are applied on save: ${parts.join('; ')}. A line left blank takes them; `
    + 'to use something else, pick it under Dimensions on the line.';
}

async function loadHeld(supplierId: string): Promise<RuleRead> {
  const none = (failed: boolean): RuleRead => ({ supplierId, held: NO_HELD, failed });
  if (!supplierId) return none(false);
  try {
    const res = await apiFetch(`/api/accounting/supplier-rules/${supplierId}`);
    if (res.status === 404) return none(false);
    if (!res.ok) {
      log.warn('supplier default dimensions not loaded', { status: res.status }, 'supplier-invoices-new');
      return none(true);
    }
    const json = await res.json() as { data?: { defaultCc1Id?: string | null; defaultCc2Id?: string | null; defaultBuId?: string | null } };
    const d = json.data;
    return { supplierId, failed: false, held: { cc1Id: d?.defaultCc1Id ?? '', cc2Id: d?.defaultCc2Id ?? '', buId: d?.defaultBuId ?? '' } };
  } catch (error) {
    log.warn('supplier default dimensions not loaded', { error }, 'supplier-invoices-new');
    return none(true);
  }
}

/** The label of the supplier's default FNO when it is an active one ('' while loading, or when it is not). */
function useDefaultFnoLabel(cc1Id: string): string {
  const [label, setLabel] = useState<{ id: string; text: string }>({ id: '', text: '' });
  useEffect(() => {
    if (!cc1Id) return undefined;
    let live = true;
    apiJson('/api/accounting/cost-centres?active=true&cc_type=cc1', undefined, 'Could not load the FNOs - try again')
      .then((body) => {
        if (live) setLabel({ id: cc1Id, text: centreOptions(body).find((o) => o.id === cc1Id)?.label ?? '' });
      })
      .catch((error: unknown) => { log.warn('default FNO label not loaded', { error }, 'supplier-invoices-new'); });
    return () => { live = false; };
  }, [cc1Id]);
  return label.id === cc1Id ? label.text : '';
}

export function useSupplierDimensionDefaults<T extends DimLine>(
  supplierId: string,
  setLines: (update: (prev: T[]) => T[]) => void,
  offered: OfferedMasters,
): {
  defaults: SupplierLineDefaults; note: string; status: SupplierDefaultsStatus;
  /** The held default FNO id ('' none): shown, as the CC1 of a line with no project, by the bill table. */ cc1Id: string;
} {
  const [read, setRead] = useState<RuleRead>({ supplierId: '', held: NO_HELD, failed: false });
  const held = read.held;
  const [defaults, setDefaults] = useState<SupplierLineDefaults>(NONE);
  const applied = useRef<SupplierLineDefaults>(NONE);

  useEffect(() => {
    let live = true;
    void loadHeld(supplierId).then((next) => { if (live) setRead(next); });
    return () => { live = false; };
  }, [supplierId]);

  const { cc2s, bus, status } = offered;
  useEffect(() => {
    const next = offeredDefaults(held, { cc2s, bus, status });
    const prev = applied.current;
    if (next.cc2Id === prev.cc2Id && next.buId === prev.buId) return;
    applied.current = next;
    setDefaults(next);
    setLines((lines) => restampLines(lines, prev, next));
  }, [held, cc2s, bus, status, setLines]);

  const fnoLabel = useDefaultFnoLabel(held.cc1Id);
  return {
    defaults, note: defaultsNote(held, defaults, offered, fnoLabel), cc1Id: held.cc1Id,
    status: defaultsStatus(read, supplierId, offered),
  };
}
