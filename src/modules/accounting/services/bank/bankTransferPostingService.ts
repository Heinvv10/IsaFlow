import { randomUUID } from 'node:crypto';
import { replayKnownOperationEffect } from '../controls/operationReceiptReplay';
import { canonicalIntentId, loadIntentReceipt, sameIntentId } from '../controls/intentIdentity';
import Decimal from 'decimal.js';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { withSavepoint } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { canonicalMoney } from '../controls/canonical';
import { BankTransferRefusalError, assertTransferAccountsActive, assertTransferPostable, materializeBankTransferOperation, readTransferAccounts } from '../controls/bankTransferOperationMaterializer';
import { loadOperationMaterial } from '../controls/operationMaterializer';
import { executeControlledOperation } from '../controls/approvalExecutionService';
import { initializeOperationObservations } from '../controls/approvalRequestService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import { postJournalEntry } from '../gl/journalEntryPostingService';
import type { ControlTx } from '../controls/contracts';
type Row = Record<string, unknown>;
export interface BankTransferInput { fromAccountId: string; toAccountId: string; amount: string | number; transferDate: string; reference?: string }
export interface BankTransferResult { intentId: string; journalEntryId: string; status: 'posted'; amount: string; currency: string; accountingDate: string }
function actor(companyId: string, userId: string): ControlTx {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId || ctx.principal.personId !== userId) throw new Error('Transfer actor does not match authenticated context');
  return ctx;
}
const ref = (id: string) => ({ entityType: 'bank_transfer_intent', entityId: id, operation: 'bank_transfer.post' as const });
/** The person's own input, refused with a 400 that says what to change — before any source is read. */
function validated(input: BankTransferInput) {
  const refuse = (message: string) => new BankTransferRefusalError(message, 400);
  if (!input || !UUID_RE.test(input.fromAccountId) || !UUID_RE.test(input.toAccountId)) throw refuse('Choose a from and a to bank account');
  // Canonical once, here: the route accepts either case, and every comparison downstream is against pg's lowercase text.
  const fromAccountId = input.fromAccountId.toLowerCase(), toAccountId = input.toAccountId.toLowerCase();
  if (fromAccountId === toAccountId) throw refuse('The from and to accounts must be different bank accounts');
  if (!isRealCalendarDate(input.transferDate)) throw refuse(`The transfer date ${String(input.transferDate)} is not a real calendar date`);
  if (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 500)) {
    throw refuse('The reference must be text of at most 500 characters');
  }
  if (typeof input.amount !== 'string' && (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || Math.abs(input.amount) > Number.MAX_SAFE_INTEGER)) {
    throw refuse('Transfer amount must be exact decimal text');
  }
  let amount: string;
  try { amount = canonicalMoney(String(input.amount)); } catch { throw refuse('Transfer amount must be a decimal number'); }
  const decimal = new Decimal(amount);
  if (!decimal.gt(0) || decimal.decimalPlaces() > 2) throw refuse('Transfer amount must be positive and expressed in cents');
  return { ...input, fromAccountId, toAccountId, amount };
}
/** Preparation persists reviewable intent, without a journal or bank movement. */
export async function prepareBankTransfer(companyId: string, userId: string, input: BankTransferInput) {
  const ctx = actor(companyId, userId);
  await assertEffectivePermission(ctx, 'write:bank-tx');
  const value = validated(input), intentId = randomUUID();
  return withSavepoint('prepare_bank_transfer', async () => {
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${companyId}`},0))`;
  await readTransferAccounts(ctx, companyId, value.fromAccountId, value.toAccountId, { lock: false });
  await ctx.sql`INSERT INTO control_bank_transfer_intents(company_id,id,requester_person_id,from_gl_account_id,to_gl_account_id,amount,accounting_date,reference)
    VALUES(${companyId}::uuid,${intentId}::uuid,${userId},${value.fromAccountId}::uuid,${value.toAccountId}::uuid,
      ${value.amount},${value.transferDate}::date,${value.reference ?? ''})`;
  const material = await loadOperationMaterial(ctx, ref(intentId));
  await initializeOperationObservations(ctx, material);
  return { intentId, status: material.binding.policies.length ? 'approval_required' as const : 'prepared' as const,
    requiresApproval: material.binding.policies.length > 0, amount: material.binding.amount!, currency: material.binding.currency!,
    accountingDate: material.binding.accountingDate!, operation: ref(intentId) };
  });
}
async function receipt(ctx: ControlTx, intentId: string): Promise<BankTransferResult | null> {
  const effect = await loadIntentReceipt<BankTransferResult>(ctx, { entityType:'bank_transfer_intent', entityId:intentId, operation:'bank_transfer.post' });
  if (!effect) return null;
  if (!sameIntentId(effect.result.intentId, intentId) || !UUID_RE.test(effect.result.journalEntryId)) throw new Error('Invalid transfer receipt');
  const [journal] = await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid
    AND id=${effect.result.journalEntryId}::uuid AND source_record_id=${intentId}::uuid
    AND source='auto_bank_transfer' AND status='posted' AND reversed_at IS NULL FOR SHARE`;
  if (!journal) throw new Error('Transfer receipt journal has changed; prepare a new intent');
  return replayKnownOperationEffect<BankTransferResult>(ctx,{entityType:'bank_transfer_intent',entityId:intentId,operation:'bank_transfer.post'},effect.id);
}
export async function executeBankTransfer(companyId: string, userId: string, inputIntentId: string, options?: { approvalId?: string }): Promise<BankTransferResult> {
  const ctx = actor(companyId, userId);
  await assertEffectivePermission(ctx, 'write:bank-tx');
  await assertEffectivePermission(ctx, 'write:post');
  if (!UUID_RE.test(inputIntentId)) throw new Error('Invalid transfer intent');
  const intentId = canonicalIntentId(inputIntentId);
  const [intent] = await ctx.sql`SELECT requester_person_id FROM control_bank_transfer_intents
    WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid` as Row[];
  // Absent, another person's and another tenant's intent are one answer.
  if (!intent || intent.requester_person_id !== ctx.principal.personId) throw new BankTransferRefusalError('Transfer intent not found', 404);
  if (!options?.approvalId) { const existing = await receipt(ctx, intentId); if (existing) return existing; }
  const parent = ref(intentId);
  return executeControlledOperation(ctx, parent, options?.approvalId ?? null, async permit => {
    if (await receipt(ctx, intentId)) throw new Error('Transfer intent already executed');
    const material = await materializeBankTransferOperation(ctx, parent);
    const facts = material.observedSources[0]!.facts as { company: Row; intent: Row; accounts: Row[]; banks: Row[]; period: Row;
      plan: { glAccountId: string; debit: string; credit: string }[] };
    assertTransferAccountsActive(facts.accounts, facts.banks);
    assertTransferPostable(facts.company, facts.period, permit.accountingDate);
    const journalEntryId = randomUUID();
    await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,posting_agent)
      VALUES(${journalEntryId}::uuid,${companyId}::uuid,${permit.accountingDate}::date,${facts.period.id}::uuid,
        ${String(facts.intent.reference || 'Bank transfer')},'auto_bank_transfer',${intentId}::uuid,'draft',${userId}::uuid,${`human:${userId}`})`;
    for (const line of facts.plan) await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
      VALUES(${companyId}::uuid,${journalEntryId}::uuid,${line.glAccountId}::uuid,${line.debit},${line.credit},'Bank transfer')`;
    const parentControl = { permit, parent };
    await registerGeneratedJournal(ctx, parentControl, journalEntryId, 'journal.post');
    await postJournalEntry(companyId, journalEntryId, userId, { parentControl });
    return { intentId, journalEntryId, status: 'posted', amount: material.binding.amount!, currency: material.binding.currency!, accountingDate: permit.accountingDate };
  });
}
