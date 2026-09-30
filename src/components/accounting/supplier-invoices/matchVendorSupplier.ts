/**
 * OCR vendor name -> supplier id. Searches server-side (the bare list is capped
 * at 25 rows, PUR-01) on the first meaningful word, then fuzzy-matches the hits.
 */

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';

export async function matchVendorSupplier(vendorName: string): Promise<string | null> {
  const word = vendorName.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 3);
  if (!word) return null;
  try {
    const res = await apiFetch(`/api/accounting/suppliers-list?q=${encodeURIComponent(word)}&limit=200`);
    const json = await res.json();
    const data = (json.data ?? json) as { suppliers?: { id: string | number; name: string }[] };
    const match = fuzzyMatchSupplier(vendorName, (data.suppliers ?? []).map((s) => ({ id: String(s.id), name: s.name })));
    return match ? String(match.id) : null;
  } catch (err) {
    log.warn('Vendor supplier match failed', { error: err }, 'supplier-invoices');
    return null;
  }
}
