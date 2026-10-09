/**
 * Auto-Post Settings — the per-company (min_confidence, amount_cap) pairs the
 * gate reads before it posts anything.
 *
 * Split out of `autoPostGateService` so that file stays under the 300-line
 * ceiling; the gate re-exports everything here, so no call site moved.
 *
 * Forensic-controls step 2 (Hein, 2026-10-09, decision 5): every change is
 * audited field by field (before and after), and a WEAKENING change — one that
 * lets the sweep post more without anyone approving — is refused, before any
 * write, under manual-journal or supplier-payment enforcement unless a person in
 * their own session holds the authority to weaken the bank-control role.
 * Under `bank_rule` enforcement too (breaker #684 REPRO 4): with auto-post on,
 * every active rule posts money (877's bank_rule_posts_money), so enabling or
 * loosening it is judged against at least the bank-rule approver role.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { ownCompanyRole } from '../ap/supplierBankBaseline';
import { bankControlRole } from '../gl/approvalEnforcement';
import { mayWeakenAtLevel } from '../gl/approvalRuleGuards';
import type { DocumentType } from '../gl/approvalService';
import { assertHumanSession, BankControlError } from './bankControlRefusal';
import { assertNoUnreviewedRuleChanges, lockForAutoPostSettings } from './bankRuleAutoPostLock';

type Row = DbRow;

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number; // 0 = uncapped
}

/**
 * What the gate applies to a company with no settings row — migrations 492/493's
 * column defaults. A missing row is judged and audited against THESE (what the
 * sweep actually did), and a first write inserts every column explicitly, so
 * the column defaults never decide anything on their own.
 */
const DEFAULTS: AutoPostSettings = {
  enabled: false, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000,
};

function mapSettings(row: Row): AutoPostSettings {
  return {
    enabled: Boolean(row.enabled),
    minConfidence: Number(row.min_confidence),
    amountCap: Number(row.amount_cap),
    llmEnabled: Boolean(row.llm_enabled),
    llmMinConfidence: Number(row.llm_min_confidence),
    llmAmountCap: Number(row.llm_amount_cap),
  };
}

export async function getAutoPostSettings(companyId: string): Promise<AutoPostSettings> {
  const rows = (await sql`
    SELECT enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
    FROM bank_auto_post_settings
    WHERE company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  return rows.length === 0 ? { ...DEFAULTS } : mapSettings(rows[0]!);
}

export interface AutoPostSettingsPatch {
  enabled?: boolean;
  minConfidence?: number;
  amountCap?: number;
  llmEnabled?: boolean;
  llmMinConfidence?: number;
  llmAmountCap?: number;
}

/** A patch the columns cannot hold (the route answers it 400 with this message). */
export class AutoPostSettingsInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoPostSettingsInvalidError';
  }
}

/** numeric(14,2) */
const MAX_CAP = 999_999_999_999.99;
const inHundredths = (n: number) => Math.round(n * 100) / 100 === n;

function validatePatch(patch: AutoPostSettingsPatch): void {
  const confidence = (value: number | undefined, column: string) => {
    if (value == null) return;
    // numeric(3,2): a finer figure would be stored rounded — compared unrounded, a no-op could read as a change.
    if (!Number.isFinite(value) || value <= 0 || value > 1 || !inHundredths(value)) {
      throw new AutoPostSettingsInvalidError(`${column} must be within (0, 1], to two decimals`);
    }
  };
  const cap = (value: number | undefined, column: string) => {
    if (value == null) return;
    if (!Number.isFinite(value) || value < 0 || value > MAX_CAP || !inHundredths(value)) {
      throw new AutoPostSettingsInvalidError(`${column} must be >= 0, in rand and cents`);
    }
  };
  confidence(patch.minConfidence, 'min_confidence');
  cap(patch.amountCap, 'amount_cap');
  confidence(patch.llmMinConfidence, 'llm_min_confidence');
  cap(patch.llmAmountCap, 'llm_amount_cap');
}

/**
 * A cap lets more through when raised, or when set to 0: autoPostGateService's
 * `evaluate` skips a line over the cap only when the cap is > 0, so 0 means NO
 * cap (the loosest value) and any positive cap after 0 is a tightening.
 */
const capLoosened = (before: number, after: number) => (after === 0 ? before !== 0 : before !== 0 && after > before);

type Key = keyof AutoPostSettings;
const FIELDS: { key: Key; label: string; weakens: (b: AutoPostSettings, a: AutoPostSettings) => boolean }[] = [
  { key: 'enabled', label: 'Auto-post enabled', weakens: (b, a) => !b.enabled && a.enabled },
  { key: 'minConfidence', label: 'Minimum confidence', weakens: (b, a) => a.minConfidence < b.minConfidence },
  { key: 'amountCap', label: 'Amount cap', weakens: (b, a) => capLoosened(b.amountCap, a.amountCap) },
  { key: 'llmEnabled', label: 'LLM tier enabled', weakens: (b, a) => !b.llmEnabled && a.llmEnabled },
  { key: 'llmMinConfidence', label: 'LLM minimum confidence', weakens: (b, a) => a.llmMinConfidence < b.llmMinConfidence },
  { key: 'llmAmountCap', label: 'LLM amount cap', weakens: (b, a) => capLoosened(b.llmAmountCap, a.llmAmountCap) },
];

/**
 * The enforced types whose approval the sweep's postings go around: a manual
 * journal (an allocation to an account) and a supplier payment (supplier_payment
 * and payment_batch are one coupled switch, D1 — either row means both).
 * Only ENFORCED types count, and only their rules can raise the role: a rule of
 * a type nobody enforces gates no document today, so it governs nothing the
 * settings could undercut — and counting it would let a dormant rule, never
 * switched on, decide who may change auto-post.
 */
async function enforcedControlTypes(companyId: string): Promise<{ types: DocumentType[]; bankRule: boolean }> {
  const rows = (await sql`
    SELECT document_type FROM approval_enforcement
    WHERE company_id = ${companyId}::UUID AND document_type IN ('manual_journal', 'supplier_payment', 'payment_batch', 'bank_rule')
  `) as Row[];
  const on = new Set(rows.map((r) => String(r.document_type)));
  const types: DocumentType[] = on.has('manual_journal') ? ['manual_journal'] : [];
  if (on.has('supplier_payment') || on.has('payment_batch')) types.push('supplier_payment', 'payment_batch');
  return { types, bankRule: on.has('bank_rule') };
}

/**
 * Refuses (BankControlError, 403) a weakening the caller may not make: a
 * person in their own session (never Login-as, an agent or a job) whose own
 * role, read from the DB, may weaken the bank-control role of the enforced
 * types — `mayWeakenAtLevel`, so above admin, or owner at owner level.
 * No audit_log action fits a refusal and withAuth commits a 4xx, so the attempt
 * is recorded as a warning.
 */
async function assertMayWeaken(companyId: string, userId: string, weakened: string[], types: DocumentType[], bankRule: boolean)
  : Promise<void> {
  const refused = (err: unknown, level: string | null): never => {
    log.warn('Auto-post settings weakening refused', {
      companyId, userId, fields: weakened, enforcedTypes: types, bankRule, level, reason: (err as BankControlError).code,
    }, 'auto-post-gate');
    throw err;
  };
  await assertHumanSession('weaken the auto-post settings').catch((err: unknown) => refused(err, null));
  // bank_rule: at least the bank-rule approver role (bankRuleApproverRole — the manual-journal rules').
  const level = await bankControlRole(companyId, bankRule && !types.includes('manual_journal') ? [...types, 'manual_journal'] : types);
  const own = await ownCompanyRole(companyId, userId);
  if (own !== null && mayWeakenAtLevel(own, level)) return;
  const need = level === 'owner' ? 'the owner role' : `a role above ${level}`;
  const what = [types.includes('manual_journal') && 'Manual-journal', types.includes('supplier_payment') && 'supplier-payment',
    bankRule && 'bank-rule'].filter(Boolean).join(' and ').replace(/^./, (c) => c.toUpperCase());
  refused(new BankControlError('WEAKENING_REQUIRES_AUTHORITY', `${what} approval is enforced, and auto-post posts without `
    + `anyone approving, so loosening it (${weakened.join(', ')}) needs ${need}. Ask someone who holds it to make this `
    + 'change; tightening a setting needs no approval.'), level);
}

/**
 * One pass: lock the row, judge the change, write, audit. Null when a peer
 * created the company's first row between this read and its insert — the
 * caller judges again against that row.
 */
async function applyOnce(companyId: string, patch: AutoPostSettingsPatch, userId: string): Promise<AutoPostSettings | null> {
  // Before the row lock, always: serialises with bank-rule writers (bankRuleAutoPostLock).
  await lockForAutoPostSettings(companyId);
  const rows = (await sql`
    SELECT enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
    FROM bank_auto_post_settings WHERE company_id = ${companyId}::UUID
    FOR UPDATE
  `) as Row[];
  const exists = rows.length > 0;
  const before = exists ? mapSettings(rows[0]!) : { ...DEFAULTS };
  const after: AutoPostSettings = { ...before };
  for (const { key } of FIELDS) {
    if (patch[key] !== undefined) (after as unknown as Record<Key, unknown>)[key] = patch[key];
  }
  const changed = FIELDS.filter((f) => before[f.key] !== after[f.key]);
  if (changed.length === 0) return before;

  const weakened = changed.filter((f) => f.weakens(before, after));
  const { types, bankRule } = await enforcedControlTypes(companyId);
  if (weakened.length > 0 && (types.length > 0 || bankRule)) {
    await assertMayWeaken(companyId, userId, weakened.map((f) => f.label), types, bankRule);
  }
  // Switching auto-post on makes every active rule post money (877): not while one carries a change nobody approved.
  if (bankRule && !before.enabled && after.enabled) await assertNoUnreviewedRuleChanges(companyId, userId);

  const written = exists
    ? (await sql`
        UPDATE bank_auto_post_settings SET
          enabled = ${after.enabled}, min_confidence = ${after.minConfidence}::NUMERIC, amount_cap = ${after.amountCap}::NUMERIC,
          llm_enabled = ${after.llmEnabled}, llm_min_confidence = ${after.llmMinConfidence}::NUMERIC,
          llm_amount_cap = ${after.llmAmountCap}::NUMERIC, updated_by = ${userId}::UUID, updated_at = NOW()
        WHERE company_id = ${companyId}::UUID
        RETURNING enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
      `) as Row[]
    : (await sql`
        INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap, llm_enabled,
          llm_min_confidence, llm_amount_cap, updated_by, updated_at)
        VALUES (${companyId}::UUID, ${after.enabled}, ${after.minConfidence}::NUMERIC, ${after.amountCap}::NUMERIC,
          ${after.llmEnabled}, ${after.llmMinConfidence}::NUMERIC, ${after.llmAmountCap}::NUMERIC, ${userId}::UUID, NOW())
        ON CONFLICT (company_id) DO NOTHING
        RETURNING enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
      `) as Row[];
  if (!written[0]) return null;

  // logAuditOrThrow: an unrecorded loosening of the sweep is what this exists to prevent, so a failed record fails the write.
  await logAuditOrThrow({
    companyId,
    userId,
    action: exists ? 'update' : 'create',
    entityType: 'bank_auto_post_settings',
    entityId: companyId,
    changes: {
      fields: changed.map((f) => ({ field: f.key, old: String(before[f.key]), new: String(after[f.key]), label: f.label })),
      metadata: { weakening: String(weakened.length > 0), enforcedTypes: [...types, ...(bankRule ? ['bank_rule'] : [])].join(',') },
    },
  });
  log.info('Updated auto-post settings', { companyId, fields: changed.map((f) => f.key) }, 'auto-post-gate');
  return mapSettings(written[0]);
}

export async function updateAutoPostSettings(
  companyId: string,
  patch: AutoPostSettingsPatch,
  userId: string,
): Promise<AutoPostSettings> {
  validatePatch(patch);
  const settings = await applyOnce(companyId, patch, userId) ?? await applyOnce(companyId, patch, userId);
  // The second pass found the row the first one's insert lost to, so it never inserts: unreachable short of a delete.
  if (!settings) throw new Error(`Auto-post settings row for ${companyId} vanished while saving`);
  return settings;
}

/**
 * The (min_confidence, amount_cap) pair to record on a bank_auto_post_runs row,
 * chosen by the posting strategy. An 'llm' post is gated by the LLM pair; every
 * other strategy (and the provisional import path) uses the standard pair.
 * NOTE: a run row is created lazily on the first post, so for a (rare) mixed-
 * strategy sweep the snapshot reflects the FIRST posted row's tier.
 */
export function autoPostRunSnapshot(
  strategy: string | null,
  settings: AutoPostSettings,
): { minConfidence: number; amountCap: number } {
  return strategy === 'llm'
    ? { minConfidence: settings.llmMinConfidence, amountCap: settings.llmAmountCap }
    : { minConfidence: settings.minConfidence, amountCap: settings.amountCap };
}
