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
 * have no way to surface a refusal to a user. `isVatPeriodLocked` is what a
 * posting path asks; the refusal is the application's.
 *
 * NOT fiscal_periods. SA VAT periods are two calendar months; fiscal periods
 * here are monthly against an arbitrary year end, and the two do not line up.
 * Filing a return and closing a month are different decisions.
 */
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { requirePeriodControl, runPeriodControl, type PeriodControlOptions } from '../controls/periodControl';
import { materializePeriodOperation, parseVatPeriodId } from '../controls/periodOperationMaterializer';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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
  actorType: 'human' | 'agent' | 'system';
  actorTokenJti: string | null;
  lockedAt: string;
  notes: string | null;
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

function map(r: DbRow): VatPeriodLock {
  return {
    id: String(r.id),
    periodStart: dateOnly(r.period_start),
    periodEnd: dateOnly(r.period_end),
    outputTax: num(r.output_tax),
    inputTax: num(r.input_tax),
    netVat: num(r.net_vat),
    postedThrough: iso(r.posted_through),
    lockedBy: String(r.locked_by ?? ''),
    actorType: (String(r.actor_type ?? 'agent') as VatPeriodLock['actorType']),
    actorTokenJti: r.actor_token_jti == null ? null : String(r.actor_token_jti),
    lockedAt: iso(r.locked_at),
    notes: r.notes == null ? null : String(r.notes),
  };
}

const SELECT_COLUMNS = sql`
  id, period_start, period_end, output_tax, input_tax, net_vat,
  posted_through, locked_by, actor_type, actor_token_jti, locked_at, notes
`;

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
  `) as DbRow[];
  return rows[0] ? map(rows[0]) : null;
}

export async function listVatPeriodLocks(companyId: string, limit = 50): Promise<VatPeriodLock[]> {
  const rows = (await sql`
    SELECT ${SELECT_COLUMNS} FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID
    ORDER BY period_start DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map(map);
}

/** Is this date inside a filed VAT period? Both endpoints are inclusive. */
export async function isVatPeriodLocked(companyId: string, date: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID
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
async function insertVatPeriodLock(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  figures: VatLockFigures,
  actor: VatLockActor,
  notes?: string,
): Promise<LockVatPeriodResult> {
  if (periodEnd < periodStart) {
    throw new Error('period_end must not be before period_start');
  }

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
    ON CONFLICT (company_id, period_start, period_end) DO NOTHING
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

/** The legacy figures argument is retained for caller compatibility; the ledger owns stored figures. */
/**
 * The authority and period-shape guards the live lock runs, callable on their
 * own: a preview that skips them tells a caller a lock will be taken that the
 * live call then refuses.
 */
export async function assertVatPeriodLockAuthority(companyId: string, userId: string,
  periodStart: string, periodEnd: string): Promise<void> {
  const ctx = requirePeriodControl(companyId, userId);
  await assertEffectivePermission(ctx, 'write:locks');
  await assertEffectivePermission(ctx, 'read:vat');
  parseVatPeriodId(`${periodStart}/${periodEnd}`);
}

export async function lockVatPeriod(companyId: string, periodStart: string, periodEnd: string,
  _figures: VatLockFigures, actor: VatLockActor, notes?: string, options?: PeriodControlOptions): Promise<LockVatPeriodResult> {
  const ctx = requirePeriodControl(companyId, actor.userId);
  await assertVatPeriodLockAuthority(companyId, actor.userId, periodStart, periodEnd);
  const entityId = `${periodStart}/${periodEnd}`;
  const existing = await getVatPeriodLock(companyId, periodStart, periodEnd);
  if (existing) return { lock: existing, created: false };
  const ref = { entityType: 'vat_period', entityId, operation: 'vat_period.lock' as const };
  return runPeriodControl(companyId, ref, options, async () => {
    const material = await materializePeriodOperation(ctx, ref);
    const facts = material.observedSources.find(row => row.entityType === ref.entityType && row.entityId === entityId)!.facts;
    const figures = (facts.vat as { figures: VatLockFigures }).figures;
    return insertVatPeriodLock(companyId, periodStart, periodEnd, figures,
      { userId: ctx.principal.personId, actorType: ctx.principal.provenance === 'human' ? 'human' : 'agent', tokenJti: ctx.principal.grantId }, notes);
  });
}
