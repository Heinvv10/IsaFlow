/**
 * Split allocation of one bank line across GL accounts and supplier / customer lines. Moved verbatim
 * out of bankAllocationService.ts (its line cap), which re-exports it for every existing import site.
 */

import { refuseLineOfCompletedReconciliation } from './reconciledCash';
import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { LateClaimInfo } from '../gl/vatLateClaimPlan';
import type { JournalEntryMeta, PostingActorOpts } from '../gl/journalEntryMeta';
import { mapTxRow } from './bankTransactionQueryService';
import type { BankTransaction } from '../../types/bank.types';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { assertPostedForAllocation } from './bankFeedStateGuard';
import { assertBankLineMayPostToAccounts } from './bankLineJournalGate';
import { assertImporterMayAllocate } from './bankLineImporterGate';
import { assertAllocationInputUsable } from './bankAllocationInputGuard';
import { planSplitDimensions } from './bankSplitDimensions';
import { planSplitContacts, recordSplitContactDocuments, type SplitContactDocument } from './bankSplitContacts';
import { buildSplitJournalLines, splitParts } from './bankSplitJournal';
import { SPLIT_ALLOCATION_NAME } from './splitJournalDocuments';
import { recordAllocationDecision } from './codingDecisionLog';
import type { SplitLine } from './bankAllocationTypes';

type Row = DbRow;

// ── Split Allocate ────────────────────────────────────────────────────────────

export async function splitAllocateTransaction(
  companyId: string, bankTxId: string, lines: SplitLine[], userId: string,
  // allowLateInputClaim: a USER's split only — see allocateTransaction. The actor fields stamp an MCP split.
  opts?: PostingActorOpts & { allowLateInputClaim?: boolean },
): Promise<{
  journalEntryId: string; bankTransaction: BankTransaction; lateClaim?: LateClaimInfo;
  /** COS split lines with no project (CC2), when the company does not block them. */
  dimensionWarnings?: string[];
  /** The payment / receipt / refund each supplier or customer line became (bankSplitContacts.ts). */
  contactDocuments?: SplitContactDocument[];
}> {
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  // Same two pre-write refusals as `allocateTransaction`, and the same class:
  // both are decided from the locked row before anything is written, so a
  // caller that can show that ordering may answer them with a 4xx. Left as bare
  // Errors here they would have to be told apart by message text — which is
  // exactly what `BankAllocationRefusal` exists to stop.
  if (!tx) throw new BankAllocationRefusal(`Bank transaction ${bankTxId} not found`);
  // Same reasoning as allocateTransaction: refused from the locked row, before
  // any write, because status alone would let a pending/removed row through.
  assertPostedForAllocation(tx, bankTxId, 'split allocate');
  await refuseLineOfCompletedReconciliation(companyId, tx); // D12: the shared 409, before the status refusal
  if (tx.status !== 'imported') {
    throw new BankAllocationRefusal(`Transaction already ${tx.status} — cannot split allocate`);
  }
  if (!lines || lines.length === 0) throw new BankAllocationRefusal('At least one split line is required'); // 400, pre-write

  const totalAmount = Math.abs(Number(tx.amount));
  const linesTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  if (Math.abs(linesTotal - totalAmount) > 0.01) {
    throw new BankAllocationRefusal(`Split lines total R${linesTotal.toFixed(2)} does not equal transaction amount R${totalAmount.toFixed(2)}`);
  }
  // Supplier / customer lines: every refusal for them, from reads, before any write (bankSplitContacts.ts).
  const contactPlan = await planSplitContacts(companyId, tx, lines, userId);
  const parts = splitParts(lines, contactPlan);
  const accountLines = parts.flatMap((p) => (p.kind === 'account' ? [p] : []));
  if (accountLines.length > 0) {
    // R-035 PR6 H2, judged at the WHOLE line's amount as it was before split lines
    // could name contacts: a R10k hand-keyed line split R5k account / R5k supplier is
    // not two R5k decisions. The supplier part is judged again as a payment
    // (planSplitContacts, per supplier).
    await assertBankLineMayPostToAccounts(companyId, tx, totalAmount);
    await assertImporterMayAllocate(companyId, tx, userId, 'manual_journal'); // step 2: not the statement's own importer
  }

  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, NOT toISOString(): pg hands the DATE back as a Date at LOCAL
  // midnight, and toISOString() re-reads it in UTC — on the UTC+2 box that
  // rolls 2026-03-01T00:30+02:00 back to "2026-02-28", dating the journal into
  // the previous month (and, at a boundary, into a closed period).
  const txDate = fmtDate(tx.transaction_date);
  const isSpent = Number(tx.amount) < 0;
  const entryDesc = String(tx.description || 'Split bank allocation');
  // Reads only: refusals (dimensions on a control account, COS with no project where required) precede every write.
  // GL-account lines only: a contact line is a settlement and carries no dimensions.
  const dimensionPlan = await planSplitDimensions(companyId, bankAccountId, accountLines.map(({ line }) => line));
  // Foreign / unknown accounts and unusable cost centres: refused here, typed, not by createJournalEntry's plain Errors.
  await assertAllocationInputUsable(companyId, accountLines.map(({ line }) => line.contraAccountId), dimensionPlan.dims);
  const journalLines = await buildSplitJournalLines({
    companyId, parts, isSpent, entryDesc, bankAccountId, totalAmount,
    dimsByIndex: new Map(accountLines.map(({ index }, k) => [index, dimensionPlan.dims[k]])),
  });

  const splitMeta: JournalEntryMeta = {
    postingAgent: opts?.postingAgent ?? 'system:bank-allocation:v1',
    ...(opts?.actorType === undefined ? {} : { actorType: opts.actorType }),
    ...(opts?.actorTokenJti === undefined ? {} : { actorTokenJti: opts.actorTokenJti }),
  };
  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source: 'auto_bank_recon', lines: journalLines,
  }, userId, splitMeta, { allowLateInputClaim: opts?.allowLateInputClaim });
  const { lateClaim } = await postJournalEntry(companyId, je.id, userId, { allowLateInputClaim: opts?.allowLateInputClaim });

  const jeLines = (await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankAccountId}::UUID
      AND jl.company_id = ${companyId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  // Wrap the final bank_transactions write atomically
  if (journalLineId) {
    await withTransaction(async (wTx) => {
      await wTx`
        UPDATE bank_transactions
        SET status = 'allocated', matched_journal_line_id = ${journalLineId}::UUID,
            allocation_type = 'account', allocated_entity_name = ${SPLIT_ALLOCATION_NAME}, updated_at = NOW(),
            allocation_rule_id = NULL, allocation_rule_name = NULL,
            allocation_batch_id = NULL
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    });
  }

  // The supplier / customer documents, on the journal just posted — so a reversal
  // of this split unwinds them with it. Not caught: see recordSplitContactDocuments.
  const contactDocuments = contactPlan.length > 0
    ? await recordSplitContactDocuments({
      companyId, bankTxId, bankAccountId, journalEntryId: je.id, isSpent, txDate, planned: contactPlan, userId,
      bankReference: (tx.reference || tx.bank_reference || tx.description || null) as string | null,
    })
    : [];

  log.info('Split-allocated bank transaction', {
    bankTxId, journalEntryId: je.id, lineCount: lines.length, contactLines: contactPlan.length,
  }, 'accounting');
  // A split is never the one suggested target: recoded (non-fatal).
  await recordAllocationDecision(companyId, bankTxId, userId, { glAccountId: null, contactId: null });
  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return {
    journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!), ...(lateClaim ? { lateClaim } : {}),
    ...(dimensionPlan.warnings.length > 0 ? { dimensionWarnings: dimensionPlan.warnings } : {}),
    ...(contactDocuments.length > 0 ? { contactDocuments } : {}),
  };
}
