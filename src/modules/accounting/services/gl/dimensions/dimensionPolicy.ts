/**
 * The mandatory-dimension matrix (brief §5.3) as two rules the ledger enforces.
 *
 * 1. A SETTLEMENT carries no dimensions. A receipt, a supplier payment, a batch
 *    payment, an internal transfer and a VAT payment move cash against a
 *    control account; the cost or revenue they settle already carries its
 *    dimensions on the bill or invoice, so tagging the payment counts it twice
 *    ("a batch payment is not a cost", brief §2). Explicit input is REFUSED;
 *    defaults are simply not applied (see bankAllocationDimensions.ts).
 *
 * 2. A COS line wants a project (CC2). Missing, it is a WARNING the caller
 *    reports; with companies.require_project_on_cos it is a BLOCK. An explicit
 *    (unallocated) CC2 member satisfies it — blank is never a code (§5.5).
 */
import { sql } from '@/lib/neon';
import { canonicalSubtype, rawSubtypesFor, type CanonicalSubtype } from '../accountSubtypes';
import type { GLEntrySource, JournalLineInput } from '../../../types/gl.types';
import { DimensionRefusal, PreWriteDimensionRefusal, hasDimensions, isDimensionRefusal, type DimensionIds } from './dimensionTypes';
import { deriveLineDimensions } from './dimensionDerivation';
import { assertJournalAnalysisDimensions } from '../journalCostCentreValidation';
import { assertCostCentresPlaced } from './costCentrePick';

/** Journal sources that settle or move cash between control accounts. */
export const NO_DIMENSION_SOURCES: ReadonlySet<GLEntrySource> = new Set<GLEntrySource>([
  'auto_payment',
  'auto_supplier_payment',
  'auto_batch_payment',
  'auto_bank_transfer',
  'auto_vat_submission',
]);

/** Pure: refuse dimensions on a settlement / receipt / transfer / VAT-payment journal. */
export function assertNoSettlementDimensions(
  source: GLEntrySource | undefined,
  lines: readonly DimensionIds[],
): void {
  if (!source || !NO_DIMENSION_SOURCES.has(source)) return;
  if (lines.some(hasDimensions)) {
    throw new DimensionRefusal(
      'A settlement, receipt, transfer or VAT payment carries no CC1/CC2/BU: the bill or invoice it settles '
      + 'already carries them, and tagging the payment would count the cost twice. Remove the dimensions.',
    );
  }
}

/**
 * The write-boundary policy for a NEW journal (createJournalEntry,
 * 'new-assignment' mode only — reversals and reclassifications copy history):
 * settlements refused, then CC1 derived from CC2 with conflicts blocked.
 */
export async function applyJournalDimensionPolicy(
  companyId: string,
  source: GLEntrySource | undefined,
  lines: JournalLineInput[],
): Promise<JournalLineInput[]> {
  assertNoSettlementDimensions(source, lines);
  return deriveLineDimensions(companyId, lines);
}

/**
 * The dimension checks createJournalEntry will run on a NEW journal, for a
 * caller that must refuse BEFORE its first write (a recurring run claims its
 * schedule first; a route may only answer 4xx for a request that wrote
 * nothing). Every refusal — a settlement carrying dimensions, a project under
 * another FNO, an inactive or foreign CC1 / CC2 / BU, an inactive FNO derived
 * from an active project — is a PreWriteDimensionRefusal. createJournalEntry
 * raises the last kind as a plain Error, which no route can tell from a fault.
 * The refusal carries the line it is about (`lineIndex`), so a caller can name
 * that line; the settlement refusal is about the whole journal and carries none.
 */
export async function assertNewJournalDimensions(
  companyId: string,
  source: GLEntrySource | undefined,
  lines: JournalLineInput[],
): Promise<void> {
  let at: number | undefined;
  assertCostCentresPlaced(lines); // createJournalEntry's own refusal, raised here before the caller's first write
  try {
    assertNoSettlementDimensions(source, lines);
    // The same two steps as applyJournalDimensionPolicy; the label is how derivation says which line it refused.
    const derived = await deriveLineDimensions(companyId, lines, (i) => { at = i; return `Line ${i + 1}`; });
    try {
      await assertDocumentDimensions(companyId, derived);
    } catch (err) {
      if (isDimensionRefusal(err)) at = await firstRefusedLine(companyId, derived);
      throw err;
    }
  } catch (err) {
    if (isDimensionRefusal(err)) throw new PreWriteDimensionRefusal(err.message, at);
    throw err;
  }
}

/** The first line the slot / active / tenant check refuses on its own — asked only once the whole journal was refused. */
async function firstRefusedLine(companyId: string, lines: readonly DimensionIds[]): Promise<number | undefined> {
  for (const [i, line] of lines.entries()) {
    if (!hasDimensions(line)) continue;
    try {
      await assertDocumentDimensions(companyId, [line]);
    } catch (err) {
      if (isDimensionRefusal(err)) return i;
      throw err;
    }
  }
  return undefined;
}

/**
 * A document line's dimensions must name this company's active masters in the
 * right slot — the same check every journal line gets, run when the document is
 * SAVED so a bad id never sits on a draft. Its plain-Error refusals come back
 * as DimensionRefusal, so callers can show them; no query when none is named.
 */
export async function assertDocumentDimensions(companyId: string, lines: readonly DimensionIds[]): Promise<void> {
  try {
    await assertJournalAnalysisDimensions(companyId, lines);
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === undefined) throw new DimensionRefusal(err.message);
    throw err;
  }
}

/** Canonical subtypes of control accounts: cash, subledger controls, VAT, payroll clearing. */
const CONTROL_SUBTYPES: ReadonlySet<CanonicalSubtype> = new Set<CanonicalSubtype>([
  'bank', 'cash', 'credit_card', 'receivable', 'payable',
  'vat_input', 'vat_output', 'vat_input_late_claim', 'payroll_liability',
]);

/**
 * Every raw `account_subtype` spelling of a control account, for SQL that must say what `isControlSubtype` says
 * (the bank row's journal-dimension rule, journalDimensionSetSql.ts).
 */
export const CONTROL_RAW_SUBTYPES: readonly string[] = rawSubtypesFor(...CONTROL_SUBTYPES);

/** True when an account of this raw subtype is a control account, which carries no dimensions. */
export function isControlSubtype(rawSubtype: string | null | undefined): boolean {
  const canonical = canonicalSubtype(rawSubtype ?? null);
  return canonical !== null && CONTROL_SUBTYPES.has(canonical);
}

export const COS_SUBTYPES: readonly string[] = rawSubtypesFor('cost_of_sales');

export interface CosProjectCheck {
  /** Indexes of lines on a COS account with no CC2. */
  missing: number[];
  /** companies.require_project_on_cos. */
  enforced: boolean;
}

/** One query: which lines sit on a COS account without a CC2, and does the company block it. */
export async function checkCosProjects(
  companyId: string,
  lines: readonly { glAccountId?: string | null; cc2Id?: string | null }[],
): Promise<CosProjectCheck> {
  const candidates = [...new Set(lines.filter((l) => l.glAccountId && !l.cc2Id).map((l) => String(l.glAccountId)))];
  if (candidates.length === 0) return { missing: [], enforced: false };
  const rows = (await sql`
    SELECT COALESCE(c.require_project_on_cos, false) AS enforced,
      COALESCE((SELECT array_agg(a.id::TEXT) FROM gl_accounts a
        WHERE a.company_id = c.id AND a.id = ANY(${candidates}::UUID[])
          AND a.account_subtype = ANY(${[...COS_SUBTYPES]}::TEXT[])), '{}') AS cos_ids
    FROM companies c WHERE c.id = ${companyId}::UUID
  `) as { enforced: boolean | null; cos_ids: string[] | null }[] | undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const cos = new Set((row?.cos_ids ?? []).map((id) => String(id).toLowerCase()));
  const missing = lines.flatMap((l, i) =>
    l.glAccountId && !l.cc2Id && cos.has(String(l.glAccountId).toLowerCase()) ? [i] : []);
  return { missing, enforced: row?.enforced === true };
}

/**
 * Warn, or block when the company requires it. Returns the warnings to report
 * (empty when every COS line has a project). `label(i)` names the line.
 */
export async function cosProjectWarnings(
  companyId: string,
  lines: readonly { glAccountId?: string | null; cc2Id?: string | null }[],
  label: (index: number) => string = (i) => `lines[${i}]`,
): Promise<string[]> {
  const { missing, enforced } = await checkCosProjects(companyId, lines);
  if (missing.length === 0) return [];
  const named = missing.map(label).join(', ');
  if (enforced) {
    throw new DimensionRefusal(
      `${named}: a cost-of-sales line must name a project (CC2) in this company. `
      + 'Name the project, or the (unallocated) project with a reason.',
    );
  }
  return [`${named}: cost-of-sales line with no project (CC2) — it will report outside every project margin.`];
}
