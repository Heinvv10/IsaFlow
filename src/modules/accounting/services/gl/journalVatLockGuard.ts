/**
 * The central refusal behind a VAT period lock: a journal that would MOVE a
 * VAT-return figure may not post on a date inside an ACTIVE lock
 * (`vat_period_locks.unlocked_at IS NULL`). A lock means "this VAT201 is filed;
 * nothing may change its figures" — so it is enforced where journals post, not
 * by each document path remembering to ask.
 *
 * "Moves a VAT figure" is per line, and DELIBERATELY WIDER than the tax
 * figures the lock records (output tax, input tax, net VAT):
 *
 *   - a line on an account whose canonical subtype is one of `VAT_TAX_SUBTYPES`
 *     (vat_input, vat_output — imported from reports/vatBoxBasis, not copied):
 *     a tax leg, which moves a recorded tax figure;
 *   - ANY line with a `vat_type` set and not 'no_vat', on any account: a base
 *     leg with a VAT code moves a VAT201 SUPPLY box (standard, zero-rated,
 *     exempt, capital goods…) even when it moves no tax figure at all — a
 *     zero-rated sale changes the filed return without touching output tax.
 *
 * A journal with neither posts into a locked period freely: it is in no box of
 * the filed return.
 *
 * WHY NOT `reportingClassFor(...) === 'vat'`. That class still includes the
 * generic 'tax' subtype, because the merge/reclassification guards mirror the
 * legacy line filter in vatReturnService. The lock does not record that filter:
 * the VAT201 snapshot drops an untagged 'tax' line from every box (vatBoxBasis
 * — Brightsphere's PAYE and Income Tax are expense accounts carrying 'tax').
 * Refusing those would block, for instance, every year-end close of a company
 * with a PAYE account behind its filed VAT period, over figures no filed return
 * contains. A 'tax' line WITH a VAT code is still refused — by its vat_type.
 *
 * WHERE IT RUNS. In createJournalEntry (so a journal that can never post is
 * refused before its draft exists — routes answer the refusal with a 4xx and
 * withAuth COMMITs a 4xx) and again, authoritatively, where it posts. Both take
 * the shared key, so no lock can commit between a draft's creation and its
 * post in the same transaction.
 *
 * Deliberately NOT importing `reports/vatPeriodLockService` (or
 * `reclassification/planGuards`, which imports it): that module builds a sql
 * fragment at load time, and dragging it into every posting path's import
 * graph shifts every positional `sql` mock in the unit suite. This module reads
 * `vat_period_locks` itself.
 *
 * CONCURRENCY. Every post takes `pg_advisory_xact_lock_shared` on a per-company
 * key before reading the locks; `lockVatPeriod`, `unlockVatPeriod` and the lock
 * figure snapshot take the EXCLUSIVE lock on the same key. So a post can never
 * land between a lock's figure snapshot and its INSERT, and posts do not block
 * each other. Transaction-scoped: outside a transaction (a bare pooled
 * statement) the lock is released at once and serialises nothing — every
 * request, MCP call and `withAlsTransaction` caller has one.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { canonicalSubtype } from './accountSubtypes';
import { VAT_TAX_SUBTYPES } from '../reports/vatBoxBasis';

/** A line as the guard needs it. `vatType` absent means untagged. */
export interface VatLineRef {
  glAccountId: string;
  vatType?: string | null;
}

export interface ActiveVatLock {
  id: string;
  periodStart: string;
  periodEnd: string;
}

/** `sql`, or a transaction-bound tag with the same call shape. */
export type SqlExec = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

type Row = Record<string, unknown>;

/**
 * Thrown when a journal that moves a VAT-return figure would post inside a
 * locked (filed) VAT period. A refusal the caller can act on — an owner/admin
 * unlocks the period, or the journal is dated elsewhere — and matched by
 * `instanceof` (and by `code` at the MCP boundary), never by wording.
 */
export class VatPeriodLockedError extends Error {
  readonly code = 'VAT_PERIOD_LOCKED';
  readonly date: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** `message` replaces the standard wording entirely, for a caller with a more specific story. */
  constructor(date: string, lock: ActiveVatLock, lead?: string, message?: string) {
    super(message ??
      `${lead ?? `Cannot post on ${date}`}: it falls inside the VAT period ${lock.periodStart} to `
      + `${lock.periodEnd}, which is locked because its VAT201 has been filed, and this journal changes `
      + 'VAT-return figures. Date it outside the locked period, or an owner or admin can unlock the '
      + 'period (with a reason) if the return is being amended.',
    );
    this.name = 'VatPeriodLockedError';
    this.date = date;
    this.periodStart = lock.periodStart;
    this.periodEnd = lock.periodEnd;
  }
}

/** Does a line with this VAT tag, on an account with this RAW subtype, move a VAT201 figure? */
export function lineMovesVatFigure(vatType: string | null | undefined, subtype: string | null | undefined): boolean {
  if (vatType && vatType !== 'no_vat') return true;
  const canon = canonicalSubtype(subtype);
  return canon !== null && (VAT_TAX_SUBTYPES as readonly string[]).includes(canon);
}

/** Does any line of this journal move a VAT201 figure? One account read, and only when no tag already decides it. */
export async function journalMovesVatFigure(
  companyId: string, lines: readonly VatLineRef[], q: SqlExec = sql,
): Promise<boolean> {
  if (lines.some((l) => lineMovesVatFigure(l.vatType, null))) return true;
  const ids = [...new Set(lines.map((l) => l.glAccountId))];
  if (ids.length === 0) return false;
  const rows = (await q`
    SELECT id, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`) as Row[];
  return rows.some((r) => lineMovesVatFigure(null, r.account_subtype == null ? null : String(r.account_subtype)));
}

/*
 * The key is `hashtextextended(company_id, 570)`. 570 is the migration that
 * created `vat_period_locks`; the module's other advisory keys use their own
 * feature numbers (617, 619, 620, 621) so that a collision in a shared int
 * space cannot serialise two unrelated operations.
 */

/** Posting side: shared, so posts never wait on each other — only on a lock/unlock/snapshot. */
export async function takeVatLockShared(companyId: string, q: SqlExec = sql): Promise<void> {
  await q`SELECT pg_advisory_xact_lock_shared(hashtextextended(${companyId}::text, 570))`;
}

/**
 * Thrown when the exclusive key could not be had within 5s — a post (or a
 * preview) is holding the shared side. Nothing has been written; retry.
 * Caller-facing and retryable, like the other `_LOCK_TIMEOUT` codes.
 */
export class VatLockTimeoutError extends Error {
  readonly code = 'VAT_LOCK_TIMEOUT';
  constructor() {
    super('Journals are being posted for this company right now, so the VAT period lock cannot be '
      + 'changed at this instant. Nothing was changed — retry in a moment.');
    this.name = 'VatLockTimeoutError';
  }
}

/**
 * Lock/unlock/snapshot side: exclusive against every post of the company.
 *
 * Bounded: `lock_timeout` is set to 5s for THIS acquisition only and the
 * caller's own value restored after, so a lock behind a long post refuses
 * (typed, retryable) instead of pinning the request connection indefinitely,
 * and nothing later in the request inherits the 5s. `set_config(..., true)` is
 * transaction-local, the same scope `SET LOCAL` has.
 */
export async function takeVatLockExclusive(companyId: string, q: SqlExec = sql): Promise<void> {
  const prev = (await q`SELECT current_setting('lock_timeout') AS v`) as Row[];
  await q`SELECT set_config('lock_timeout', '5s', true)`;
  try {
    await q`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 570))`;
  } catch (err) {
    // 55P03 lock_not_available. The transaction is aborted now, so there is
    // no setting to restore; the caller's savepoint/rollback does that.
    if ((err as { code?: unknown } | null)?.code === '55P03') throw new VatLockTimeoutError();
    throw err;
  }
  await q`SELECT set_config('lock_timeout', ${String(prev[0]?.v ?? '0')}, true)`;
}

function dateOnly(v: unknown): string {
  return fmtDate(v as string | Date);
}

/** The ACTIVE lock covering `date` (both ends inclusive), or null. History rows never lock. */
export async function findActiveVatLock(
  companyId: string, date: string, q: SqlExec = sql,
): Promise<ActiveVatLock | null> {
  const rows = (await q`
    SELECT id, period_start, period_end FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID
      AND unlocked_at IS NULL
      AND period_start <= ${date}::DATE
      AND period_end >= ${date}::DATE
    ORDER BY period_start
    LIMIT 1`) as Row[];
  const r = rows[0];
  return r ? { id: String(r.id), periodStart: dateOnly(r.period_start), periodEnd: dateOnly(r.period_end) } : null;
}

/**
 * Refuse a journal dated inside an active VAT lock when it moves a VAT figure.
 *
 * Call it BEFORE the write that makes the journal posted (the status UPDATE, or
 * a raw INSERT at status='posted'), in the same transaction, so a refusal
 * leaves nothing behind. `q` lets a caller holding a `withTransaction` tag run
 * it on that connection — the advisory lock must be taken on the connection
 * that posts.
 */
export async function assertJournalVatPeriodOpen(
  companyId: string,
  entryDate: string | Date,
  lines: readonly VatLineRef[],
  q: SqlExec = sql,
): Promise<void> {
  await takeVatLockShared(companyId, q);
  const date = fmtDate(entryDate);
  const lock = await findActiveVatLock(companyId, date, q);
  if (!lock) return;
  if (await journalMovesVatFigure(companyId, lines, q)) {
    throw new VatPeriodLockedError(date, lock);
  }
}

/**
 * A posted journal's lines as the guard reads them — for the pre-write checks
 * that predict a reversal's date from the entry id alone (bank allocation
 * reversal, payment void) and must roll it exactly as reverseJournalEntry will.
 */
export async function loadJournalVatLines(
  companyId: string, journalEntryId: string, q: SqlExec = sql,
): Promise<VatLineRef[]> {
  const rows = (await q`
    SELECT gl_account_id, vat_type FROM gl_journal_lines
    WHERE journal_entry_id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id),
    vatType: r.vat_type == null ? null : String(r.vat_type),
  }));
}
