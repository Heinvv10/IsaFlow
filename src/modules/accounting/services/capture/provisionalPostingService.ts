/** PRD-05 Phase 5 — Provisional Posting Service */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';

type Row = DbRow;

const HISTORY_LOOKBACK = 10;
const DICE_THRESHOLD = 0.6;
const STOPWORDS = new Set(['the', 'pos', 'purchase', 'eft', 'debit', 'from', 'for', 'and', 'to']);
const VAT_RATE = 15;

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

  const totalAmount = Math.abs(amount);
  const bankAccountId = String(tx.bank_account_id);
  const txDate = tx.transaction_date instanceof Date
    ? (tx.transaction_date.toISOString().split('T')[0] ?? '')
    : (String(tx.transaction_date).split('T')[0] ?? '');
  const description = String(tx.description ?? 'Provisional bank allocation');

  const hasVat = prediction.vatCode === 'standard';
  const netAmount = hasVat ? Math.round((totalAmount * 100 / (100 + VAT_RATE)) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;

  // Resolve GL account — use predicted or fall back to default_expense
  let expenseAccountId = prediction.glAccountId;
  if (!expenseAccountId) {
    expenseAccountId = await getSystemAccountId('default_expense', companyId);
  }

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

  const je = await createJournalEntry(
    companyId,
    { entryDate: txDate, description, source: 'auto_bank_recon', lines },
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

  return { journalEntryId: je.id, prediction };
}

