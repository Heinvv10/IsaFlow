/**
 * Shared shape for the VAT period locks UI — mirrors
 * `VatPeriodLock` from `vatPeriodLockService.ts` (the API's `map()` already
 * turns every DB row into this exact JSON shape).
 */
export interface VatPeriodLock {
  id: string;
  periodStart: string;
  periodEnd: string;
  outputTax: number;
  inputTax: number;
  netVat: number;
  postedThrough: string;
  lockedBy: string;
  lockedByName: string;
  actorType: 'human' | 'agent' | 'system';
  actorTokenJti: string | null;
  lockedAt: string;
  notes: string | null;
  active: boolean;
  unlockedAt: string | null;
  unlockedBy: string | null;
  unlockedByName: string | null;
  unlockReason: string | null;
}
