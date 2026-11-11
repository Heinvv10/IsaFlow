/** VAT period lock types, moved out of vatPeriodLockService.ts (a pure move; the service re-exports them). */

export interface VatPeriodLock {
  id: string;
  periodStart: string;
  periodEnd: string;
  outputTax: number;
  inputTax: number;
  netVat: number;
  /** MAX(created_at) of the journals the figures came from, ISO-8601. */
  postedThrough: string;
  lockedBy: string;
  /** users.first_name + last_name for lockedBy, falling back to the raw id
   *  (an agent lock, or a human whose user row is gone). */
  lockedByName: string;
  actorType: 'human' | 'agent' | 'system';
  actorTokenJti: string | null;
  lockedAt: string;
  notes: string | null;
  /** False once unlocked: the row is kept as history and locks nothing (migration 695). */
  active: boolean;
  unlockedAt: string | null;
  unlockedBy: string | null;
  /** Same fallback as lockedByName; null exactly when unlockedBy is null. */
  unlockedByName: string | null;
  unlockReason: string | null;
}

export interface VatLockFigures {
  outputTax: number;
  inputTax: number;
  netVat: number;
  postedThrough: string;
}

export interface VatLockActor {
  userId: string;
  actorType: 'human' | 'agent' | 'system';
  tokenJti?: string | null;
}

export interface LockVatPeriodResult {
  lock: VatPeriodLock;
  /** False when the period was already locked — the existing lock is returned. */
  created: boolean;
}

