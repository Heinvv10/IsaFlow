/**
 * VAT period locks: recording that a return has been filed, and refusing to let
 * the period move afterwards.
 *
 * WHY. A VAT201 is computed live from posted journals. Nothing stops a journal
 * being posted into a period that has already been filed — Velocity Fibre's
 * ledger accepts a 2022 posting made this morning — so a return submitted last
 * year no longer agrees with the ledger it was computed from, and there is no
 * way for a reader to tell that from an arithmetic error. The lock stores the
 * figures AND the `posted_through` they were computed at, which is what turns
 * "these numbers differ" into "somebody posted into a filed period".
 *
 * THE LOCK IS A RECORD, NOT A DATABASE TRIGGER. A trigger on gl_journal_lines
 * would take the decision away from the application for every write path at
 * once, including bank rule sweeps and the reversal paths, several of which
 * have no way to surface a refusal to a user. The refusal is the application's,
 * made centrally where journals post: gl/journalVatLockGuard (which reads the
 * table itself, not through this module). Only an ACTIVE row
 * (`unlocked_at IS NULL`) locks; an unlocked one is history (migration 695).
 *
 * NOT fiscal_periods. SA VAT periods are two calendar months; fiscal periods
 * here are monthly against an arbitrary year end, and the two do not line up.
 * Filing a return and closing a month are different decisions.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { takeVatLockExclusive } from '../gl/journalVatLockGuard';
import { VatPeriodLockRefusal, assertLockablePeriod } from './vatPeriodLockBounds';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';

export { VatPeriodLockRefusal } from './vatPeriodLockBounds';
export { VatLockTimeoutError } from '../gl/journalVatLockGuard';

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

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '');
}

function dateOnly(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

/** A joined display name, or the id itself when there is no user row (e.g. an
 *  agent lock) or the row's name columns are blank. */
function nameOrId(name: unknown, id: string): string {
  const trimmed = name == null ? '' : String(name).trim();
  return trimmed !== '' ? trimmed : id;
}

function map(r: DbRow): VatPeriodLock {
  const lockedBy = String(r.locked_by ?? '');
  const unlockedBy = r.unlocked_by == null ? null : String(r.unlocked_by);
  return {
    id: String(r.id),
    periodStart: dateOnly(r.period_start),
    periodEnd: dateOnly(r.period_end),
    outputTax: num(r.output_tax),
    inputTax: num(r.input_tax),
    netVat: num(r.net_vat),
    postedThrough: iso(r.posted_through),
    lockedBy,
    lockedByName: nameOrId(r.locked_by_name, lockedBy),
    actorType: (String(r.actor_type ?? 'agent') as VatPeriodLock['actorType']),
    actorTokenJti: r.actor_token_jti == null ? null : String(r.actor_token_jti),
    lockedAt: iso(r.locked_at),
    notes: r.notes == null ? null : String(r.notes),
    active: r.unlocked_at == null,
    unlockedAt: r.unlocked_at == null ? null : iso(r.unlocked_at),
    unlockedBy,
    unlockedByName: unlockedBy == null ? null : nameOrId(r.unlocked_by_name, unlockedBy),
    unlockReason: r.unlock_reason == null ? null : String(r.unlock_reason),
  };
}

const SELECT_COLUMNS = sql`
  id, period_start, period_end, output_tax, input_tax, net_vat,
  posted_through, locked_by, actor_type, actor_token_jti, locked_at, notes,
  unlocked_at, unlocked_by, unlock_reason
`;

/** The ACTIVE lock on exactly this period, or null. An unlocked (history) row is not a lock. */
export async function getVatPeriodLock(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatPeriodLock | null> {
  const rows = (await sql`
    SELECT ${SELECT_COLUMNS} FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID
      AND period_start = ${periodStart}::DATE
      AND period_end = ${periodEnd}::DATE
      AND unlocked_at IS NULL
  `) as DbRow[];
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Every lock INCLUDING history, newest period first; `active` says which
 * still lock.
 *
 * Resolves `locked_by` / `unlocked_by` (TEXT, holding a users.id — VARCHAR)
 * to a display name via approval_company_member_name (mig 714), not a plain
 * join to `users`: app_user can only SELECT its own row there
 * (users_self_read, FORCE RLS), so a join resolved a name only when the
 * viewer was the one who locked/unlocked the period (R-147 review round 1) —
 * same fix as transactionLedgerService/auditTrailLedgerService's
 * `created_by_name` and the credit-note PDF builder's `approved_by_name`.
 */
export async function listVatPeriodLocks(companyId: string, limit = 50): Promise<VatPeriodLock[]> {
  const rows = (await sql`
    SELECT
      vpl.id, vpl.period_start, vpl.period_end, vpl.output_tax, vpl.input_tax, vpl.net_vat,
      vpl.posted_through, vpl.locked_by, vpl.actor_type, vpl.actor_token_jti, vpl.locked_at, vpl.notes,
      vpl.unlocked_at, vpl.unlocked_by, vpl.unlock_reason,
      public.approval_company_member_name(vpl.company_id, vpl.locked_by) AS locked_by_name,
      public.approval_company_member_name(vpl.company_id, vpl.unlocked_by) AS unlocked_by_name
    FROM vat_period_locks vpl
    WHERE vpl.company_id = ${companyId}::UUID
    ORDER BY vpl.period_start DESC, vpl.locked_at DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map(map);
}

/** Is this date inside a filed (ACTIVELY locked) VAT period? Both endpoints are inclusive. */
export async function isVatPeriodLocked(companyId: string, date: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID
      AND unlocked_at IS NULL
      AND period_start <= ${date}::DATE
      AND period_end >= ${date}::DATE
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

/**
 * Lock a VAT period.
 *
 * IDEMPOTENT BY THE NATURAL KEY, not only by an idempotency key. A second lock
 * of the same period returns the first one and does NOT overwrite its figures:
 * a record of what was filed that a later call can rewrite records nothing at
 * all. `created` tells the caller which of the two happened.
 */
export async function lockVatPeriod(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  figures: VatLockFigures,
  actor: VatLockActor,
  notes?: string,
): Promise<LockVatPeriodResult> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  // Exclusive against every post of the company until this transaction ends
  // (journalVatLockGuard). The caller that computed `figures` should already
  // hold it — computeVatLockFigures takes it — and re-taking it is a no-op.
  // Taken BEFORE the bounds check, so two overlapping locks cannot both pass it.
  await takeVatLockExclusive(companyId);
  await assertLockablePeriod(companyId, periodStart, periodEnd);

  const rows = (await sql`
    INSERT INTO vat_period_locks (
      company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by, actor_type, actor_token_jti, notes
    ) VALUES (
      ${companyId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE,
      ${figures.outputTax}, ${figures.inputTax}, ${figures.netVat},
      ${figures.postedThrough}::TIMESTAMPTZ,
      -- users.id is character varying(255): the actor column is TEXT and this
      -- must never be cast ::UUID.
      ${actor.userId}::TEXT, ${actor.actorType}, ${actor.tokenJti ?? null}, ${notes ?? null}
    )
    -- The arbiter is the PARTIAL index uq_vat_period_locks_company_period (696 gave it the 570 index name)
    -- (migration 695): only an active lock conflicts, so a period unlocked
    -- earlier is locked again as a new row and the history row stays.
    ON CONFLICT (company_id, period_start, period_end) WHERE unlocked_at IS NULL DO NOTHING
    RETURNING ${SELECT_COLUMNS}
  `) as DbRow[];

  if (rows[0]) {
    log.info('VAT period locked', { companyId, periodStart, periodEnd }, 'vatPeriodLockService');
    return { lock: map(rows[0]), created: true };
  }

  const existing = await getVatPeriodLock(companyId, periodStart, periodEnd);
  if (!existing) {
    // ON CONFLICT DO NOTHING with nothing to select back means the row was
    // deleted between the two statements. Refusing is right: silently
    // reporting "already locked" would be a lie.
    throw new Error('VAT period lock could not be read back after insert');
  }
  return { lock: existing, created: false };
}

/** An unlock the caller can fix: blank reason, no such lock here, or already unlocked. */
export class VatPeriodUnlockRefusal extends VatPeriodLockRefusal {
  constructor(message: string) {
    super(message);
    this.name = 'VatPeriodUnlockRefusal';
  }
}

/**
 * Unlock a filed VAT period so an amended return can change its figures.
 *
 * Owner/admin only — enforced at the ROUTE (pages/api/accounting/
 * vat-period-locks.ts), not here; there is deliberately no MCP unlock tool.
 * The row is stamped, never deleted: it keeps the figures that were filed and
 * says who unlocked it, when and why, and only an active row locks anything.
 */
export async function unlockVatPeriod(
  companyId: string,
  lockId: string,
  userId: string,
  reason: string,
): Promise<VatPeriodLock> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  const why = reason.trim();
  if (!why) throw new VatPeriodUnlockRefusal('A reason is required to unlock a VAT period.');

  // Same exclusive key as a lock: no post lands mid-unlock.
  await takeVatLockExclusive(companyId);
  const rows = (await sql`
    SELECT id, unlocked_at FROM vat_period_locks
    WHERE id = ${lockId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  // One answer for absent and foreign: no existence oracle across tenants.
  if (!rows[0]) throw new VatPeriodUnlockRefusal('VAT period lock not found.');
  if (rows[0].unlocked_at != null) {
    throw new VatPeriodUnlockRefusal('This VAT period lock is already unlocked.');
  }

  const updated = (await sql`
    UPDATE vat_period_locks
    SET unlocked_at = now(), unlocked_by = ${userId}::TEXT, unlock_reason = ${why}
    WHERE id = ${lockId}::UUID AND company_id = ${companyId}::UUID AND unlocked_at IS NULL
    RETURNING ${SELECT_COLUMNS}
  `) as DbRow[];
  const lock = map(updated[0]!);
  log.info('VAT period unlocked',
    { companyId, lockId, periodStart: lock.periodStart, periodEnd: lock.periodEnd }, 'vatPeriodLockService');
  return lock;
}
