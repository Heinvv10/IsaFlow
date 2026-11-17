/** PRD-05 Phase 5 — Provisional Posting Service */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { feedStateOf } from '../bank/bankFeedStateGuard';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { handKeyedLineJournalRefusal } from '../bank/bankLineJournalGate';
import { importerAllocationRefusal, importerArmOf } from '../bank/bankLineImporterGate';
import { isAllocationVatCode } from '../bank/bankVatCodes';
import { allocationPeriodFor, isLineSkipRefusal } from '../bank/bankAllocationPeriod';
import { predictFromHistory, type CodingPrediction } from './provisionalPrediction';
import { isBankContra } from '../bank/bankContraTransfer';
import { placeCostCentres } from '../gl/dimensions/costCentrePick'; // the predicted centre, in its slot

type Row = DbRow;

const VAT_RATE = 15;

// The predictor lives in provisionalPrediction.ts; re-exported for its existing importers.
export { predictFromHistory, type CodingPrediction } from './provisionalPrediction';

// ── Post Provisional ─────────────────────────────────────────────────────────

const NO_PREDICTION: CodingPrediction = { // what a row skipped before any prediction reports
  supplierId: null, supplierName: null, glAccountId: null, vatCode: null, costCentreId: null, projectId: null, confidence: 0, basis: 'none',
};

export async function postProvisional(
  companyId: string,
  bankTxId: string,
  userId: string,
  opts: { minConfidence?: number; triggeredBy?: string } = {}, // triggeredBy: who ran the sweep (default userId)
): Promise<{ journalEntryId: string | null; prediction: CodingPrediction; skipped?: string; warnings?: string[] }> {
  const minConfidence = opts.minConfidence ?? 0.7;

  // Load bank transaction
  const txRows = (await sql`
    SELECT id, bank_account_id, transaction_date, amount, description, status, feed_state, bank_feed_connection_id, import_batch_id
    FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;

  if (tx.status !== 'imported') {
    return { journalEntryId: null, prediction: NO_PREDICTION, skipped: `already ${String(tx.status)}` };
  }

  if (feedStateOf(tx) !== 'posted') {
    return { journalEntryId: null, prediction: NO_PREDICTION, skipped: `feed_state ${feedStateOf(tx)}` };
  }

  const amount = Number(tx.amount);

  // Phase 5 only handles supplier payment outflows
  if (amount >= 0) {
    return { journalEntryId: null, prediction: NO_PREDICTION, skipped: 'incoming not supported in Phase 5' };
  }

  // R-035 PR6 (H2, round 5): DR <predicted account> / CR bank from a HAND-KEYED outflow is a manual journal nobody
  // decides — skipped before any write under an enforced rule; the route and the auto-post gate report the reason.
  if (!isBankEvidenced(tx) && await handKeyedLineJournalRefusal(companyId, Math.abs(amount))) {
    return { journalEntryId: null, prediction: NO_PREDICTION, skipped: 'approval_required' };
  }
  // Step 2: so is one run for the person who imported the line (unlocked: a line's provenance never changes, 877).
  if (await importerAllocationRefusal(companyId, tx, opts.triggeredBy ?? userId, importerArmOf('account', null, amount)!)) {
    return { journalEntryId: null, prediction: NO_PREDICTION, skipped: 'approval_required' };
  }

  const prediction = await predictFromHistory(companyId, {
    id: bankTxId,
    description: tx.description ? String(tx.description) : null,
    amount,
  });

  if (prediction.confidence < minConfidence) {
    return { journalEntryId: null, prediction, skipped: 'low confidence' };
  }
  // WP2 row 13, the unattended twin: a predicted code outside none / standard / zero_rated / exempt (the history holds
  // whatever its writers recorded) posted the gross with nobody watching. Skipped and reported, before any write.
  if (prediction.vatCode !== null && !isAllocationVatCode(prediction.vatCode)) {
    return { journalEntryId: null, prediction, skipped: `unknown VAT code "${prediction.vatCode}"` };
  }

  if (prediction.vatHistoryAllInvalid) {
    return { journalEntryId: null, prediction, skipped: "no valid VAT code in this supplier's history" };
  }

  const totalAmount = Math.abs(amount);
  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, never toISOString — this date becomes the provisional journal's
  // entry_date, and on a UTC+2 host toISOString shifted it into the previous
  // day (and, on a month boundary, the previous VAT period).
  const txDate = fmtDate(tx.transaction_date);
  const description = String(tx.description ?? 'Provisional bank allocation');

  // WP2 row 12: the open period this journal posts on, resolved before anything is written. Without it a date no
  // period covers or can cover (the statement's, 2001 or 2040) posted with fiscal_period_id NULL, past the closed-period
  // check, and a closed period left a draft journal behind. A skip with the reason, like every other here.
  let fiscalPeriodId: string;
  try {
    // Its own savepoint: a period lock timeout is a failed statement, and without one the whole transaction stays
    // aborted ("current transaction is aborted") for the next row of a batch or sweep.
    fiscalPeriodId = await withSavepoint('provisional_period', () => allocationPeriodFor(companyId, txDate));
  } catch (err) {
    if (isLineSkipRefusal(err)) {
      return { journalEntryId: null, prediction, skipped: err.message };
    }
    throw err;
  }

  // Resolve GL account — use predicted or fall back to default_expense
  let expenseAccountId = prediction.glAccountId;
  if (!expenseAccountId) {
    expenseAccountId = await getSystemAccountId('default_expense', companyId);
  }
  // WP2 row 5: a BANK account is a transfer — the duplicate guard, the pair lock and the leg pairing live in the
  // transfer arm, and a provisional journal is not one. Left for a person (or the rule sweep's transfer line).
  if (await isBankContra(companyId, expenseAccountId)) {
    return { journalEntryId: null, prediction, skipped: 'bank account: a transfer is allocated, not posted provisionally' };
  }

  // THE THIRD UNATTENDED POSTER. This one predicts its own vat code, from the
  // most frequent code on that supplier's history — so a ledger already
  // carrying a wrong claim teaches this path to repeat it, which is exactly
  // Velocity's salary account: 34 historical lines at 'standard'. It posts
  // with nobody watching, so it guards like the other two rather than
  // trusting the prediction. Resolved AFTER the account falls back to
  // default_expense, because the fallback is what actually gets posted to.
  const guarded = await resolveRuleVatCode({
    allocType: 'account',
    companyId,
    requestedVatCode: prediction.vatCode ?? 'none',
    glAccountId: expenseAccountId,
    denialContext: { bankTxId, source: 'provisional_posting' },
    guardContext: { bankTxId, ruleName: 'provisional posting' },
  });

  const hasVat = guarded.vatCode === 'standard';
  const netAmount = hasVat ? Math.round((totalAmount * 100 / (100 + VAT_RATE)) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;

  type JournalLine = { glAccountId: string; debit: number; credit: number; description: string; vatType?: 'standard' | 'zero_rated' | 'exempt'; projectId?: string; costCenterId?: string };
  const lines: JournalLine[] = [
    {
      glAccountId: expenseAccountId,
      debit: netAmount,
      credit: 0,
      description,
      vatType: hasVat ? 'standard' : undefined,
      projectId: prediction.projectId ?? undefined,
      costCenterId: prediction.costCentreId ?? undefined,
    },
  ];

  // A missing vat_input system account is a config error; refuse to post a
  // provisional journal with the VAT line silently dropped.
  if (hasVat) {
    const vatAccountId = await getSystemAccountId('vat_input', companyId);
    lines.push({ glAccountId: vatAccountId, debit: vatAmount, credit: 0, description: `VAT @ ${VAT_RATE}%`, vatType: 'standard' });
  }

  lines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description });

  const placed = await placeCostCentres(companyId, lines);
  const je = await createJournalEntry(
    companyId,
    { entryDate: txDate, description, source: 'auto_bank_recon', lines: placed.lines, fiscalPeriodId },
    userId,
    { postingAgent: 'ai-provisional:v1', extractionConfidence: prediction.confidence, sourceDocumentId: undefined },
  );

  await postJournalEntry(companyId, je.id, userId);

  // Mark JE as needing evidence
  await sql`
    UPDATE gl_journal_entries
    SET needs_evidence = true
    WHERE id = ${je.id}::UUID AND company_id = ${companyId}::UUID
  `;

  // Update bank transaction
  await sql`
    UPDATE bank_transactions
    SET status = 'provisional',
        provisional_je_id = ${je.id}::UUID,
        predicted_supplier_id = ${prediction.supplierId}::UUID,
        prediction_confidence = ${prediction.confidence}
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Posted provisional JE for bank transaction', {
    companyId,
    bankTxId,
    predictedSupplier: prediction.supplierName,
    glAccount: expenseAccountId,
    confidence: prediction.confidence,
    jeId: je.id,
  }, 'provisional-posting');

  return { journalEntryId: je.id, prediction, ...(placed.warnings.length > 0 ? { warnings: placed.warnings } : {}) };
}

