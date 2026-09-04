/**
 * Cross-Module GL Integration Hooks
 * - Asset depreciation → DR Depreciation Expense, CR Accumulated Depreciation
 * - Asset disposal     → DR Acc Dep + Bank, CR Asset Cost ± Disposal P&L
 * - Below-threshold    → DR Expense, CR Bank
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from './systemAccountResolver';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { DbRow } from '@/types/db';

// Asset depreciation lives in its own file — this one was 518 lines against a
// 300-line cap. Re-exported so every existing caller is unchanged.
export {
  postAssetDepreciationToGL,
  postDualDepreciationToLedger,
} from './assetDepreciationPosting';



// ── Asset Disposal → GL ───────────────────────────────────────────────────────

/**
 * Thrown when an asset (and its category) carries no gl_asset_account_id, so
 * the disposal has no credit leg. Typed rather than a bare Error because
 * withErrorHandler masks messages in production — the route matches on
 * `instanceof` to answer 400 with the fix ("set gl_asset_account_id") instead
 * of an opaque 500.
 */
/**
 * @param assetNumber human-facing label (FA-001)
 * @param assetId     UUID — the gl-account endpoint keys on the id, and 404s on
 *                    anything that is not a UUID, so the remediation URL must
 *                    NOT interpolate assetNumber.
 */
export function missingAssetAccountMessage(assetNumber: string, assetId: string): string {
  return `Asset ${assetNumber} has no active fixed-asset account to credit. Set one with PATCH /api/accounting/assets/${assetId}/gl-account, then dispose.`;
}

/**
 * Resolve the account to credit for an asset's cost:
 *   asset.gl_asset_account_id, else its category's.
 *
 * Returns null when neither is set — the caller must then refuse, NOT guess.
 *
 * An earlier revision fell back to "the company's first fixed-asset leaf
 * account" so that disposals were not blocked while the columns were
 * unpopulated. That was wrong: ordered by account code it picked `1210
 * Equipment` for every asset, so disposing a vehicle credited Equipment. The
 * journal balanced and total PPE was right, so nothing surfaced — but the
 * per-class IAS 16 cost reconciliation silently stopped tying, and the only
 * trace was a log line. A wrong number that balances is worse than a refusal,
 * because it is not discoverable.
 *
 * The real remedy was a way to SET the column, which now exists:
 *   PATCH /api/accounting/assets/[assetId]/gl-account
 *
 * There is deliberately NO equivalent writer for the category column.
 * asset_categories has no company_id — it is a global reference table shared by
 * every tenant — yet gl_asset_account_id on it is a per-company GL account id.
 * A writer would therefore let one company set the account every other
 * company's disposals credit. It is NULL on all 35 rows today, so the hazard is
 * latent; the ownership guard below keeps it that way by refusing any resolved
 * account that does not belong to the caller's company. gl_journal_lines has
 * only a plain FK to gl_accounts(id) with no composite company constraint, so
 * the database would not catch this on its own.
 */
export async function resolveAssetAccountId(
  companyId: string,
  assetId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT COALESCE(a.gl_asset_account_id, c.gl_asset_account_id) AS account_id
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE a.id = ${assetId} AND a.company_id = ${companyId}::UUID
  `) as DbRow[];

  const candidate = rows[0]?.account_id ? String(rows[0].account_id) : null;
  if (!candidate) return null;

  const owned = (await sql`
    SELECT 1 FROM gl_accounts
    WHERE id = ${candidate}::UUID AND company_id = ${companyId}::UUID AND is_active = true
  `) as DbRow[];

  if (owned.length === 0) {
    log.error('Asset GL account does not belong to this company — refusing to post', {
      assetId, companyId, accountId: candidate,
    }, 'accounting');
    return null;
  }

  return candidate;
}

export class MissingAssetAccountError extends Error {
  readonly assetNumber: string;
  constructor(assetNumber: string, assetId: string) {
    super(missingAssetAccountMessage(assetNumber, assetId));
    this.name = 'MissingAssetAccountError';
    this.assetNumber = assetNumber;
  }
}

interface DisposalGLInput {
  assetId: string;
  policyAccDep: number;
  cost: number;
  gainLoss: number;
  proceeds: number;
  disposalDate: string;
  notes?: string;
}

/**
 * Posts disposal GL journal:
 *   Dr Accumulated Depreciation
 *   Dr Bank (if proceeds > 0)
 *   Dr/Cr Profit or Loss on Disposal
 *   Cr Fixed Asset at Cost (uses asset category gl_asset_account_id or fallback)
 *
 * Routed through createJournalEntry/postJournalEntry rather than hand-rolled
 * INSERTs. The old shape inserted the header straight into status='posted' and
 * appended each leg behind its own `if`; trg_gl_je_balanced fires only on
 * UPDATE, so nothing checked the result. An asset with no category account
 * dropped the sole credit leg and posted debits against nothing. Building the
 * lines first and handing them to the posting service means validateJournalEntry
 * sees the whole entry before any of it reaches the ledger.
 *
 * Errors propagate. This used to log-and-return-null, which let
 * pages/api/accounting/assets/[assetId]/dispose.ts answer 200 with
 * journalEntryId: null — how production ended up with a disposed asset carrying
 * no journal at all. withAuth rolls the request transaction back on a throw, so
 * the asset_disposals row written earlier in the request goes with it.
 */
export async function postAssetDisposalToGL(
  companyId: string,
  input: DisposalGLInput,
  userId: string
): Promise<string | null> {
  const assetRows = (await sql`
    SELECT a.id, a.asset_number, a.name
    FROM assets a
    WHERE a.id = ${input.assetId} AND a.company_id = ${companyId}::UUID
  `) as DbRow[];

  if (!assetRows[0]) {
    log.warn('Asset not found for disposal GL', { assetId: input.assetId }, 'accounting');
    return null;
  }

  const row = assetRows[0];
  const assetNumber = String(row.asset_number ?? '');
  const assetName = String(row.name ?? '');
  const assetAccountId = await resolveAssetAccountId(companyId, input.assetId);
  const tag = `${assetName} (${assetNumber})`;

  // The Cr leg for the whole entry. Without it there is nothing to balance the
  // acc-dep/bank/loss debits against, so refuse rather than post a half-entry —
  // the asset keeps its cost on the balance sheet and the operator gets told to
  // set gl_asset_account_id on the asset or its category.
  if (!assetAccountId) {
    throw new MissingAssetAccountError(assetNumber, input.assetId);
  }

  const accumDepId = await getSystemAccountId('accumulated_depreciation', companyId);
  const bankId = await getSystemAccountId('bank', companyId);
  const plId = await getSystemAccountId('disposal_profit_loss', companyId);

  const lines: JournalLineInput[] = [];

  if (input.policyAccDep > 0) {
    lines.push({
      glAccountId: accumDepId, debit: input.policyAccDep, credit: 0,
      description: `Disposal acc dep: ${tag}`,
    });
  }

  if (input.proceeds > 0) {
    lines.push({
      glAccountId: bankId, debit: input.proceeds, credit: 0,
      description: `Disposal proceeds: ${tag}`,
    });
  }

  if (input.gainLoss < 0) {
    lines.push({
      glAccountId: plId, debit: Math.abs(input.gainLoss), credit: 0,
      description: `Loss on disposal: ${tag}`,
    });
  } else if (input.gainLoss > 0) {
    lines.push({
      glAccountId: plId, debit: 0, credit: input.gainLoss,
      description: `Gain on disposal: ${tag}`,
    });
  }

  lines.push({
    glAccountId: assetAccountId, debit: 0, credit: input.cost,
    description: `Disposal asset cost: ${tag}`,
  });

  // DIS-<asset>-<month> goes in reference, not entry_number: entry_number is
  // UNIQUE per company and generated by trg_gl_je_entry_number, so two
  // disposals touching one asset in a month used to collide.
  const entry = await createJournalEntry(companyId, {
    entryDate: input.disposalDate,
    description: `Disposal: ${tag}${input.notes ? ` — ${input.notes}` : ''}`,
    source: 'auto_asset_disposal',
    reference: `DIS-${assetNumber}-${input.disposalDate.slice(0, 7)}`,
    lines,
  }, userId, { postingAgent: 'system:asset-disposal:v1' });

  await postJournalEntry(companyId, entry.id, userId);

  await sql`
    UPDATE assets SET
      status = 'disposed',
      disposal_date = ${input.disposalDate}::DATE,
      disposal_amount = ${input.proceeds},
      disposal_gain_loss = ${input.gainLoss},
      updated_at = NOW()
    WHERE id = ${input.assetId} AND company_id = ${companyId}::UUID
  `;

  log.info('Asset disposal GL posted', {
    assetId: input.assetId, entryId: entry.id, gainLoss: input.gainLoss,
  }, 'accounting');
  return entry.id;
}

// ── Below-Threshold Asset → GL (Immediate Expense) ──────────────────────────

/**
 * Posts expense journal for a below-capitalization-threshold asset:
 *   Dr Default Expense
 *   Cr Bank
 *
 * Same treatment as postAssetDisposalToGL: 'asset_expense' was never a value
 * gl_journal_entries_source_check accepted, and the swallow turned the 23514
 * into a null return, so nothing was ever expensed. Posts through the validated
 * service now and lets failures reach the caller.
 */
export async function postCapitalizationExpenseToGL(
  companyId: string,
  assetId: string,
  cost: number,
  userId: string
): Promise<string | null> {
  if (cost <= 0) return null;

  const assetRows = (await sql`
    SELECT id, asset_number, name FROM assets
    WHERE id = ${assetId} AND company_id = ${companyId}::UUID
  `) as DbRow[];

  if (!assetRows[0]) return null;

  const row = assetRows[0];
  const assetNumber = String(row.asset_number ?? '');
  const assetName = String(row.name ?? '');
  const tag = `${assetName} (${assetNumber})`;

  const expenseId = await getSystemAccountId('default_expense', companyId);
  const bankId = await getSystemAccountId('bank', companyId);

  const entry = await createJournalEntry(companyId, {
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Below-threshold expense: ${tag}`,
    source: 'auto_asset_expense',
    reference: `EXP-${assetNumber}-${new Date().toISOString().slice(0, 10)}`,
    lines: [
      { glAccountId: expenseId, debit: cost, credit: 0, description: `Below-threshold expense: ${tag}` },
      { glAccountId: bankId, debit: 0, credit: cost, description: `Below-threshold expense: ${tag}` },
    ],
  }, userId, { postingAgent: 'system:asset-expense:v1' });

  await postJournalEntry(companyId, entry.id, userId);

  await sql`
    UPDATE assets SET below_threshold = true, updated_at = NOW()
    WHERE id = ${assetId} AND company_id = ${companyId}::UUID
  `;

  log.info('Below-threshold expense posted', { assetId, entryId: entry.id, cost }, 'accounting');
  return entry.id;
}
