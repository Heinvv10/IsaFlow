/** PRD-05 Phase 5 — Provisional Posting Service */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { allocateProvisionalTransaction } from '../bank/bankAllocationService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';

type Row = DbRow;

const HISTORY_LOOKBACK = 10;
const DICE_THRESHOLD = 0.6;
const STOPWORDS = new Set(['the', 'pos', 'purchase', 'eft', 'debit', 'from', 'for', 'and', 'to']);

export interface CodingPrediction {
  supplierId: string | null;
  supplierName: string | null;
  glAccountId: string | null;
  vatCode: string | null;
  costCentreId: string | null;
  projectId: string | null;
  confidence: number;
  basis: string;
}

// ── Tokeniser ────────────────────────────────────────────────────────────────

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
}

function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) {
    if (b.has(t)) shared++;
  }
  return (2 * shared) / (a.size + b.size);
}

// ── Prediction ───────────────────────────────────────────────────────────────

export async function predictFromHistory(
  companyId: string,
  bankTx: { id: string; description: string | null; amount: number },
): Promise<CodingPrediction> {
  const none: CodingPrediction = {
    supplierId: null,
    supplierName: null,
    glAccountId: null,
    vatCode: null,
    costCentreId: null,
    projectId: null,
    confidence: 0,
    basis: 'none',
  };

  if (!bankTx.description) return none;

  const txTokens = tokenise(bankTx.description);
  if (txTokens.size === 0) return none;

  // Load active suppliers for this company
  const supplierRows = (await sql`
    SELECT id, name FROM suppliers
    WHERE company_id = ${companyId}::UUID AND is_active = true
  `) as Row[];

  // Fuzzy-match against supplier names
  let bestScore = 0;
  let bestSupplierId: string | null = null;
  let bestSupplierName: string | null = null;

  for (const s of supplierRows) {
    const nameTokens = tokenise(String(s.name));
    const score = diceCoefficient(txTokens, nameTokens);
    if (score > bestScore) {
      bestScore = score;
      bestSupplierId = String(s.id);
      bestSupplierName = String(s.name);
    }
  }

  if (bestScore < DICE_THRESHOLD || !bestSupplierId) return none;

  // Look up mode coding from supplier_coding_history (last HISTORY_LOOKBACK rows)
  const historyRows = (await sql`
    SELECT gl_account_id, vat_code, cost_centre_id, project_id
    FROM supplier_coding_history
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${bestSupplierId}::UUID
    ORDER BY posted_at DESC
    LIMIT ${HISTORY_LOOKBACK}
  `) as Row[];

  if (historyRows.length === 0) {
    return {
      supplierId: bestSupplierId,
      supplierName: bestSupplierName,
      glAccountId: null,
      vatCode: null,
      costCentreId: null,
      projectId: null,
      confidence: 0.5,
      basis: `history:0-rows`,
    };
  }

  // Mode of gl_account_id
  const glFreq = new Map<string, number>();
  const vatFreq = new Map<string, number>();
  for (const r of historyRows) {
    const gl = r.gl_account_id ? String(r.gl_account_id) : '';
    const vat = r.vat_code ? String(r.vat_code) : '';
    if (gl) glFreq.set(gl, (glFreq.get(gl) ?? 0) + 1);
    if (vat) vatFreq.set(vat, (vatFreq.get(vat) ?? 0) + 1);
  }

  const topGl = [...glFreq.entries()].sort((a, b) => b[1] - a[1])[0];
  const topVat = [...vatFreq.entries()].sort((a, b) => b[1] - a[1])[0];
  const topCc = historyRows.find((r) => r.cost_centre_id);
  const topProj = historyRows.find((r) => r.project_id);

  const glAccountId = topGl ? topGl[0] : null;
  const glCount = topGl ? topGl[1] : 0;
  const vatCode = topVat ? topVat[0] : null;

  const confidence = glCount >= 3 ? 0.9 : glCount >= 1 ? 0.7 : 0.5;
  const basis = `history:${historyRows.length}-rows`;

  return {
    supplierId: bestSupplierId,
    supplierName: bestSupplierName,
    glAccountId,
    vatCode,
    costCentreId: topCc ? String(topCc.cost_centre_id) : null,
    projectId: topProj ? String(topProj.project_id) : null,
    confidence,
    basis,
  };
}

// ── Post Provisional ─────────────────────────────────────────────────────────

export async function postProvisional(
  companyId: string,
  bankTxId: string,
  userId: string,
  opts: { minConfidence?: number } = {},
): Promise<{ journalEntryId: string | null; prediction: CodingPrediction; skipped?: string }> {
  const minConfidence = opts.minConfidence ?? 0.7;

  // Load bank transaction
  const txRows = (await sql`
    SELECT id, bank_account_id, transaction_date, amount, description, status
    FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;

  if (tx.status !== 'imported') {
    return {
      journalEntryId: null,
      prediction: { supplierId: null, supplierName: null, glAccountId: null, vatCode: null, costCentreId: null, projectId: null, confidence: 0, basis: 'none' },
      skipped: `already ${String(tx.status)}`,
    };
  }

  const amount = Number(tx.amount);

  // Phase 5 only handles supplier payment outflows
  if (amount >= 0) {
    return {
      journalEntryId: null,
      prediction: { supplierId: null, supplierName: null, glAccountId: null, vatCode: null, costCentreId: null, projectId: null, confidence: 0, basis: 'none' },
      skipped: 'incoming not supported in Phase 5',
    };
  }

  const prediction = await predictFromHistory(companyId, {
    id: bankTxId,
    description: tx.description ? String(tx.description) : null,
    amount,
  });

  if (prediction.confidence < minConfidence) {
    return { journalEntryId: null, prediction, skipped: 'low confidence' };
  }

  // The bank account, the amount and the accounting date all come from the bank
  // row the controlled allocation locks and reads for itself, so none of them is
  // recomputed here — including the date, which a toISOString once shifted into
  // the previous day (and, on a month boundary, the previous VAT period).
  const description = String(tx.description ?? 'Provisional bank allocation');

  // Resolve GL account — use predicted or fall back to default_expense
  let expenseAccountId = prediction.glAccountId;
  if (!expenseAccountId) {
    expenseAccountId = await getSystemAccountId('default_expense', companyId);
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

  // THROUGH THE CONTROLLED BANK ALLOCATION — the same operation a person drives
  // on the screen, and the reason this path works at all. The journal it
  // generates carries 'auto_bank_recon', which the kernel refuses as a DIRECT
  // journal operation: posting it here took the whole statement import down with
  // a 500 CONTROL_INTEGRITY_FAILED. The allocation gives it an intent, a receipt
  // (`control_operation_effects`), change events, a parented generated journal
  // and the same refusals as the attended path; the net/VAT split and the bank
  // leg are the controlled path's own, from the vatCode the guard above allowed.
  //
  // The predicted cost centre and project are NOT carried: the plan's dimensions
  // are validated by type (a cc1 slot demands a cc_type='cc1' centre) and a
  // predicted centre of any other type would refuse a line that is otherwise
  // postable. Coding is finalised when evidence is attached.
  // 'standard' or nothing. The predicted code comes from supplier_coding_history, which holds legacy spellings ('S',
  // 'Z', …) as well as the current vocabulary, and the plan accepts only the current one — an unrecognised code would
  // be a ZodError, a fault, rather than the no-VAT posting the old arithmetic gave it (it split only on 'standard').
  const vatCode = guarded.vatCode === 'standard' ? 'standard' : 'none';
  const result = await allocateProvisionalTransaction(
    companyId, bankTxId, expenseAccountId, userId,
    { ...(prediction.supplierId ? { predictedSupplierId: prediction.supplierId } : {}), confidence: prediction.confidence },
    description, vatCode,
  );

  log.info('Posted provisional JE for bank transaction', {
    companyId,
    bankTxId,
    predictedSupplier: prediction.supplierName,
    glAccount: expenseAccountId,
    confidence: prediction.confidence,
    jeId: result.journalEntryId,
  }, 'provisional-posting');

  return { journalEntryId: result.journalEntryId, prediction };
}

