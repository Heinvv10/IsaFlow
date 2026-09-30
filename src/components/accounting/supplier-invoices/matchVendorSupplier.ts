/**
 * OCR vendor name -> supplier id. The bare supplier list is capped at 25 rows
 * (PUR-01), so this searches server-side on the most distinctive tokens of the
 * vendor name, merges the hits, and fuzzy-matches the merged set.
 */

import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';

/** Words and legal suffixes that appear on most suppliers and so identify none. */
const NOISE = new Set([
  'the', 'and', 'of', 'pty', 'ltd', 'limited', 'cc', 'inc', 'co', 'company', 'proprietary',
  'sa', 'za', 'south', 'africa', 'trading', 'group', 'holdings', 'services',
]);
const MAX_SEARCHES = 2;

interface Hit { id: string | number; name: string }

/** Longest distinctive tokens first; two-character tokens such as "3M" are allowed. */
export function vendorSearchTokens(vendorName: string): string[] {
  const tokens = vendorName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !NOISE.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, MAX_SEARCHES);
}

async function search(token: string): Promise<Hit[] | null> {
  try {
    const res = await apiFetch(`/api/accounting/suppliers-list?q=${encodeURIComponent(token)}&limit=200`);
    if (!res.ok) return null;
    const json = await res.json();
    return ((json.data ?? json) as { suppliers?: Hit[] }).suppliers ?? [];
  } catch (err) {
    log.warn('Vendor supplier search failed', { error: err, token }, 'supplier-invoices');
    return null;
  }
}

export async function matchVendorSupplier(vendorName: string): Promise<string | null> {
  const tokens = vendorSearchTokens(vendorName);
  if (tokens.length === 0) return null;
  const results = (await Promise.all(tokens.map(search))).filter((r): r is Hit[] => r !== null);
  if (results.length === 0) return null;

  // Score across searches: a supplier every token found beats one only one token found.
  const seen = new Map<string, { hit: Hit; count: number }>();
  for (const hits of results) {
    for (const hit of hits) {
      const key = String(hit.id);
      seen.set(key, { hit, count: (seen.get(key)?.count ?? 0) + 1 });
    }
  }
  const all = [...seen.values()];
  const best = Math.max(...all.map((e) => e.count), 0);
  const pool = all.filter((e) => e.count === best).map((e) => ({ id: String(e.hit.id), name: e.hit.name }));
  const match = fuzzyMatchSupplier(vendorName, pool) ?? fuzzyMatchSupplier(vendorName, all.map((e) => ({ id: String(e.hit.id), name: e.hit.name })));
  return match ? String(match.id) : null;
}

/**
 * OCR scans resolve asynchronously and may finish out of order. Only the newest
 * scan may apply. A scan may fill an empty supplier or replace one an earlier scan
 * set, but never one the user picked: call `notePick` from the picker's onChange.
 */
export function useVendorSupplierMatch(
  current: string,
  apply: (supplierId: string) => void,
): { scan: (vendorName: string) => void; notePick: () => void } {
  const seq = useRef(0);
  const ocrId = useRef('');
  const currentRef = useRef(current);
  const applyRef = useRef(apply);
  useEffect(() => { currentRef.current = current; applyRef.current = apply; });
  const scan = useCallback((vendorName: string) => {
    const mine = ++seq.current;
    void matchVendorSupplier(vendorName).then((id) => {
      if (!id || mine !== seq.current) return;
      const held = currentRef.current;
      if (held && held !== ocrId.current) return; // the user's own pick
      ocrId.current = id;
      applyRef.current(id);
    });
  }, []);
  const notePick = useCallback(() => { ocrId.current = ''; }, []);
  return { scan, notePick };
}
