/**
 * The company VAT/tax profile change behind MCP `update_company_profile`.
 *
 * The write is companyService.updateCompany with only the fields that change, the call the settings page's
 * PUT /api/accounting/companies makes (the company is the caller's, never an id from input). Around it:
 * the company row is locked, the change is checked against the VAT filing history, and the VAT periods it would move
 * are reported. Every refusal comes BEFORE the write and is returned, not thrown; anything thrown after the write
 * starts propagates (the registry's savepoint then rolls it back).
 *
 * A category/alignment change moves VAT period boundaries; a VAT return or a VAT period lock (active or since
 * unlocked; a VAT201 version always has one) on file was cut on the old boundaries, so the change needs an explicit
 * acknowledgement and is reported with the periods on file.
 */
import { sql } from '@/lib/neon';
import { getCompany, updateCompany } from './companyService';
import { inRolledBackSavepoint } from './rolledBackSavepoint';
import { isDeadlockDetected } from './lockContention';
import { logAuditOrThrow } from './auditTrailService';
import { VatLockTimeoutError, takeVatLockExclusive } from '@/modules/accounting/services/gl/journalVatLockGuard';
import {
  categoryOf, compactNumber, isValidSaVatNumber, periodImpact, resolveDesired, stateFromColumns,
  type PeriodImpact, type VatCategory, type VatProfileRequest, type VatProfileState,
} from './companyVatProfile';
import { isValidSarsTaxNumber } from '@/modules/accounting/services/payroll/employeeFieldRules';

/** The profile as the tool reports it: the four arguments' own vocabulary. */
export interface ProfileView {
  vat_number: string | null;
  income_tax_number: string | null;
  vat_category: VatCategory | 'none';
  /** odd/even for a bi-monthly company; null for monthly or a non-vendor (alignment has no meaning there). */
  vat_alignment: 'odd' | 'even' | null;
}

export interface FilingRecord {
  source: 'vat_return' | 'vat_period_lock' | 'sars_vat201_submission';
  period_start: string;
  period_end: string;
  /** A lock that has since been unlocked for an amendment: still history cut on the old boundaries. */
  unlocked?: boolean;
}

export interface FilingFootprint { total: number; records: FilingRecord[]; truncated: boolean }

export type ProfileChange =
  | { refused: string }
  | {
    before: ProfileView; after: ProfileView; changed: string[]; nothingChanged: boolean;
    periodImpact: PeriodImpact | null; footprint: FilingFootprint;
    /** Arguments that put the company back: the before value of every field that changed. */
    undoArguments: Record<string, string>;
    /** What the undo cannot do (a field that was empty before cannot be emptied again). */
    undoLimitations: string[];
  };

export interface ChangeOptions {
  dryRun: boolean; acknowledgePeriodChange: boolean; asOf: Date;
  /** The acting user, recorded in the audit_log row of a real change. */
  userId: string;
  /** The MCP token that made the call, recorded with it. */
  tokenJti?: string | null;
}

const FOOTPRINT_LIST_CAP = 24;

export function profileView(s: VatProfileState): ProfileView {
  const category = categoryOf(s.setting, s.alignment);
  return {
    vat_number: s.vatNumber, income_tax_number: s.incomeTaxNumber, vat_category: category,
    vat_alignment: s.setting === 'bi-monthly' ? s.alignment : null,
  };
}

/**
 * Every VAT return, VAT period lock (any state) and legacy VAT201 submission (sars_submissions, any status but draft:
 * the VAT201 page's mark-submitted writes only that row, no lock and no vat_returns) the company has, newest period
 * first. A VAT201 version (tax_return_versions) always references its period's lock row, which is never deleted, so a
 * version adds nothing.
 */
export async function vatFilingFootprint(companyId: string): Promise<FilingFootprint> {
  const rows = (await sql`
    SELECT source, period_start::text AS period_start, period_end::text AS period_end, unlocked
      FROM (
        SELECT 'vat_return' AS source, period_start, period_end, false AS unlocked
          FROM vat_returns WHERE company_id = ${companyId}::UUID
        UNION ALL
        SELECT 'vat_period_lock', period_start, period_end, unlocked_at IS NOT NULL
          FROM vat_period_locks WHERE company_id = ${companyId}::UUID
        UNION ALL
        SELECT 'sars_vat201_submission', period_start, period_end, false
          FROM sars_submissions WHERE company_id = ${companyId}::UUID AND form_type = 'VAT201' AND status <> 'draft'
      ) f
     ORDER BY period_end DESC, source
  `) as { source: FilingRecord['source']; period_start: string; period_end: string; unlocked: boolean }[];
  const records = rows.slice(0, FOOTPRINT_LIST_CAP).map((r) => ({
    source: r.source, period_start: r.period_start, period_end: r.period_end, ...(r.unlocked ? { unlocked: true } : {}),
  }));
  return { total: rows.length, records, truncated: rows.length > records.length };
}

/**
 * FOR NO KEY UPDATE, not FOR UPDATE: a journal insert takes FOR KEY SHARE on its company (the FK) while holding the
 * shared VAT key, and FOR UPDATE would conflict with it. This lock still excludes another profile change and any
 * UPDATE of the row, which is all it is for.
 */
async function lockCompanyRow(companyId: string): Promise<boolean> {
  const rows = (await sql`SELECT id FROM companies WHERE id = ${companyId}::UUID FOR NO KEY UPDATE`) as unknown[];
  return rows.length > 0;
}

/**
 * The locks, in the repo's order: the VAT advisory key FIRST (posting and lock_vat_period take it before anything
 * on the company, companyService.updateCompany documents "advisory first, company row after"), then the company row.
 * The key is taken whenever the request names a category or alignment, before the row is read, so it is held
 * whether or not the periods turn out to move. A deadlock victim answers the retryable VAT-lock refusal, not a fault.
 * Returns false when the company does not exist.
 */
async function lockForChange(companyId: string, req: VatProfileRequest): Promise<boolean> {
  try {
    if (req.category !== undefined || req.alignment !== undefined) await takeVatLockExclusive(companyId);
    return await lockCompanyRow(companyId);
  } catch (err) {
    if (isDeadlockDetected(err)) throw new VatLockTimeoutError();
    throw err;
  }
}

function validateNumbers(req: VatProfileRequest, current: VatProfileState): string | null {
  if (req.vatNumber !== undefined) {
    if (!isValidSaVatNumber(req.vatNumber)) return 'vat_number must be a South African VAT number: 10 digits starting with 4.';
    if (current.setting === 'none') return 'The company is not registered for VAT, so it takes no VAT number. Register it in Settings > VAT first.';
  }
  if (req.incomeTaxNumber !== undefined && !isValidSarsTaxNumber(req.incomeTaxNumber)) {
    return 'income_tax_number must be a SARS income tax reference: 10 digits starting with 0, 1, 2, 3 or 9.';
  }
  return null;
}

/**
 * Changes the company's VAT/tax profile (or, with `dryRun`, runs the identical path and rolls the write back).
 * `companyId` is the token's company.
 */
export async function changeCompanyVatProfile(
  companyId: string, req: VatProfileRequest, opts: ChangeOptions,
): Promise<ProfileChange> {
  if (!(await lockForChange(companyId, req))) return { refused: 'Not found' };
  const company = await getCompany(companyId);
  if (!company) return { refused: 'Not found' };
  const current = stateFromColumns(company);

  const numberRefusal = validateNumbers(req, current);
  if (numberRefusal) return { refused: numberRefusal };
  const desired = resolveDesired(current, req);
  if ('error' in desired) return { refused: desired.error };

  const wantsCycle = req.category !== undefined || req.alignment !== undefined;
  const impact = wantsCycle ? periodImpact(current, desired, opts.asOf) : null;
  // The exclusive VAT key (lockForChange) is already held, so a VAT lock or return being written right now has
  // finished or is waiting for this change: the footprint below is complete.
  const footprint = await vatFilingFootprint(companyId);

  const patch: Record<string, string> = {};
  const undo: Record<string, string> = {};
  const changed: string[] = [];
  if (req.vatNumber !== undefined && compactNumber(current.vatNumber ?? '') !== req.vatNumber) {
    patch.vatNumber = req.vatNumber; changed.push('vat_number');
    if (current.vatNumber) undo.vat_number = current.vatNumber;
  }
  if (req.incomeTaxNumber !== undefined && compactNumber(current.incomeTaxNumber ?? '') !== req.incomeTaxNumber) {
    patch.taxNumber = req.incomeTaxNumber; changed.push('income_tax_number');
    if (current.incomeTaxNumber) undo.income_tax_number = current.incomeTaxNumber;
  }
  if (impact?.changes_periods) {
    patch.vatPeriod = desired.cadence;
    if (desired.cadence === 'bi-monthly') patch.vatPeriodAlignment = desired.alignment;
    changed.push('vat_category');
    undo.vat_category = categoryOf(current.setting, current.alignment);
    if (undo.vat_category === 'none') delete undo.vat_category;
  }

  const before = profileView(current);
  if (changed.length === 0) {
    return { before, after: before, changed, nothingChanged: true, periodImpact: impact, footprint, undoArguments: {}, undoLimitations: [] };
  }
  if (impact?.changes_periods && footprint.total > 0 && !opts.acknowledgePeriodChange) {
    return { refused: periodChangeRefusal(footprint, impact) };
  }

  const written: { state: VatProfileState | null } = { state: null };
  const write = async (): Promise<void> => {
    written.state = stateFromColumns(await updateCompany(companyId, patch));
  };
  if (opts.dryRun) await inRolledBackSavepoint('mcp_company_profile_dry_run', write);
  else await write();
  if (written.state === null) throw new Error('update_company_profile: the company update returned no row');
  const after = profileView(written.state);
  if (!opts.dryRun) await auditChange(companyId, opts, before, after, changed, impact?.changes_periods === true);
  return {
    before, after, changed, nothingChanged: false, periodImpact: impact, footprint,
    undoArguments: undo, undoLimitations: undoLimitations(before, changed),
  };
}

function periodChangeRefusal(footprint: FilingFootprint, impact: PeriodImpact): string {
  const on = footprint.records.slice(0, 6).map((r) => `${r.source} ${r.period_start}..${r.period_end}${r.unlocked ? ' (unlocked)' : ''}`);
  const move = (label: string, p: { old: { from: string; to: string } | null; new: { from: string; to: string } | null }): string =>
    `${label}: ${p.old ? `${p.old.from}..${p.old.to}` : 'none'} -> ${p.new ? `${p.new.from}..${p.new.to}` : 'none'}`;
  return 'Refused: this changes the VAT period boundaries, and the company already has VAT returns, period locks or VAT201 versions '
    + `cut on the old boundaries (${footprint.total}: ${on.join('; ')}${footprint.total > on.length ? '; ...' : ''}). `
    + `Periods that would move at ${impact.as_of} - ${move('current', impact.current)}; ${move('next', impact.next)}. `
    + 'Filed periods are NOT re-cut and the change cannot be undone for them. Confirm SARS has moved the vendor to the new category, '
    + 'then repeat the call (dry_run first) with acknowledge_period_change: true.';
}

const AUDIT_LABELS: Record<string, string> = {
  vat_number: 'VAT number', income_tax_number: 'Income tax number', vat_category: 'VAT category',
};

/** One audit_log row (same transaction, so it commits or rolls back with the change) with each field's old and new value. */
async function auditChange(
  companyId: string, opts: ChangeOptions, before: ProfileView, after: ProfileView, changed: string[], periodsMoved: boolean,
): Promise<void> {
  const view = before as unknown as Record<string, string | null>;
  const next = after as unknown as Record<string, string | null>;
  await logAuditOrThrow({
    companyId, userId: opts.userId, action: 'update', entityType: 'company', entityId: companyId,
    entityRef: 'VAT and tax registration',
    changes: {
      fields: changed.map((field) => ({ field, label: AUDIT_LABELS[field] ?? field, old: view[field] ?? null, new: next[field] ?? null })),
      metadata: {
        area: 'company_vat_profile', source: 'mcp:update_company_profile:v1',
        ...(opts.tokenJti ? { tokenJti: opts.tokenJti } : {}),
        periodsMoved: String(periodsMoved), acknowledgedPeriodChange: String(opts.acknowledgePeriodChange),
      },
    },
  });
}

/** The fields the undo arguments cannot restore: updateCompany keeps the stored value when given an empty one. */
function undoLimitations(before: ProfileView, changed: string[]): string[] {
  return changed
    .filter((f) => (f === 'vat_number' || f === 'income_tax_number') && before[f] === null)
    .map((f) => `${f} was empty before this change and cannot be emptied again through this tool; undo_arguments has no entry for it.`);
}
