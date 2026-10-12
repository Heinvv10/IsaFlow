/**
 * The picked supplier's default CC2 project and BU (migration 890), for the
 * bill screen to show on its lines before saving. The server applies the same
 * defaults to any line left open (supplierDimensionDefaults.ts), so this is a
 * visible, editable pre-fill — never a value the user did not see.
 *
 * When the supplier changes, a line still holding the previous supplier's
 * default (or nothing) takes the new one; a value the user picked stays.
 * A supplier with no rule (404) has no defaults; a failed read is logged and
 * shows none (the server still applies them on save).
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export interface SupplierLineDefaults { cc2Id: string; buId: string }

const NONE: SupplierLineDefaults = { cc2Id: '', buId: '' };

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

async function loadDefaults(supplierId: string): Promise<SupplierLineDefaults> {
  if (!supplierId) return NONE;
  try {
    const res = await apiFetch(`/api/accounting/supplier-rules/${supplierId}`);
    if (res.status === 404) return NONE;
    if (!res.ok) {
      log.warn('supplier default dimensions not loaded', { status: res.status }, 'supplier-invoices-new');
      return NONE;
    }
    const json = await res.json() as { data?: { defaultCc2Id?: string | null; defaultBuId?: string | null } };
    return { cc2Id: json.data?.defaultCc2Id ?? '', buId: json.data?.defaultBuId ?? '' };
  } catch (error) {
    log.warn('supplier default dimensions not loaded', { error }, 'supplier-invoices-new');
    return NONE;
  }
}

export function useSupplierDimensionDefaults<T extends DimLine>(
  supplierId: string,
  setLines: (update: (prev: T[]) => T[]) => void,
): SupplierLineDefaults {
  const [defaults, setDefaults] = useState<SupplierLineDefaults>(NONE);
  const applied = useRef<SupplierLineDefaults>(NONE);
  useEffect(() => {
    let live = true;
    void loadDefaults(supplierId).then((next) => {
      if (!live) return;
      const prev = applied.current;
      applied.current = next;
      setDefaults(next);
      setLines((lines) => restampLines(lines, prev, next));
    });
    return () => { live = false; };
  }, [supplierId, setLines]);
  return defaults;
}
