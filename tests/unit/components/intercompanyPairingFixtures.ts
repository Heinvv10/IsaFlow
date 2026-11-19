/** Wire shapes of the pairing route, for the component tests. */
import type { PairingCandidate, PairingDoc, PairingView } from '@/modules/accounting/services/intercompany/pairingTypes';

export const doc = (id: string, number: string, total: number, over: Partial<PairingDoc> = {}): PairingDoc => ({ id, number, date: '2026-08-15', total, open: total, currency: 'ZAR', ...over });
export const pair = (n: number, over: Partial<PairingCandidate> = {}): PairingCandidate => ({
  mine: doc(`m${n}`, `INV-${n}`, 1000 + n), theirs: doc(`t${n}`, `INV-${n}`, 1000 + n), ambiguous: false, openDiffers: false, ...over,
});
export const EMPTY = { suggestions: [], mismatches: [], unmatchedMine: [], unmatchedTheirs: [], unsupported: [] };
export const VIEW = (over: Partial<PairingView> = {}): PairingView => ({
  connectionId: 'conn-1', partnerName: 'Velocity Fibre', direction: 'ar', cutoverDate: '2026-10-01', blocked: null, confirmsBoth: false,
  matches: EMPTY, truncated: false, links: [], loan: null, ...over,
});

