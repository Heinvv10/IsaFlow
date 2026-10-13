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
 * shows none (the server still applies them on save).
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

type DimLine = { cc2Id?: string; buId?: string };

/** Pure: re-stamp the lines that still carry the previous defaults (or none). */
export function restampLines<T extends DimLine>(lines: readonly T[], prev: SupplierLineDefaults, next: SupplierLineDefaults): T[] {
  return lines.map((l) => {
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

async function loadHeld(supplierId: string): Promise<HeldDefaults> {
  if (!supplierId) return NO_HELD;
  try {
    const res = await apiFetch(`/api/accounting/supplier-rules/${supplierId}`);
    if (res.status === 404) return NO_HELD;
    if (!res.ok) {
      log.warn('supplier default dimensions not loaded', { status: res.status }, 'supplier-invoices-new');
      return NO_HELD;
    }
    const json = await res.json() as { data?: { defaultCc1Id?: string | null; defaultCc2Id?: string | null; defaultBuId?: string | null } };
    return { cc1Id: json.data?.defaultCc1Id ?? '', cc2Id: json.data?.defaultCc2Id ?? '', buId: json.data?.defaultBuId ?? '' };
  } catch (error) {
    log.warn('supplier default dimensions not loaded', { error }, 'supplier-invoices-new');
    return NO_HELD;
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
): { defaults: SupplierLineDefaults; note: string } {
  const [held, setHeld] = useState<HeldDefaults>(NO_HELD);
  const [defaults, setDefaults] = useState<SupplierLineDefaults>(NONE);
  const applied = useRef<SupplierLineDefaults>(NONE);

  useEffect(() => {
    let live = true;
    void loadHeld(supplierId).then((next) => { if (live) setHeld(next); });
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
  return { defaults, note: defaultsNote(held, defaults, offered, fnoLabel) };
}
