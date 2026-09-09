import { randomUUID } from 'node:crypto';
import { replayKnownOperationEffect } from '../controls/operationReceiptReplay';
import Decimal from 'decimal.js';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { withSavepoint } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { canonicalMoney } from '../controls/canonical';
import { materializeBankTransferOperation } from '../controls/bankTransferOperationMaterializer';
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
function validated(input: BankTransferInput) {
  if (!input || !UUID_RE.test(input.fromAccountId) || !UUID_RE.test(input.toAccountId) || input.fromAccountId === input.toAccountId
    || !isRealCalendarDate(input.transferDate) || (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 500))) {
    throw new Error('Invalid bank transfer input');
  }
  if (typeof input.amount !== 'string' && (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || Math.abs(input.amount) > Number.MAX_SAFE_INTEGER)) {
    throw new Error('Transfer amount must be exact decimal text');
  }
  const amount = canonicalMoney(String(input.amount)), decimal = new Decimal(amount);
  if (!decimal.gt(0) || decimal.decimalPlaces() > 2) throw new Error('Transfer amount must be positive and expressed in cents');
  return { ...input, amount };
}
/** Preparation persists reviewable intent, without a journal or bank movement. */
export async function prepareBankTransfer(companyId: string, userId: string, input: BankTransferInput) {
  const ctx = actor(companyId, userId);
  await assertEffectivePermission(ctx, 'write:bank-tx');
  const value = validated(input), intentId = randomUUID();
  return withSavepoint('prepare_bank_transfer', async () => {
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${companyId}`},0))`;
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
  const [effect] = await ctx.sql`SELECT e.id,e.result FROM control_operation_effects e
    WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.entity_type='bank_transfer_intent'
      AND e.entity_id=${intentId} AND e.operation='bank_transfer.post' ORDER BY e.committed_at DESC LIMIT 1` as { id:string; result: BankTransferResult }[];
  if (!effect) return null;
  if (effect.result.intentId !== intentId || !UUID_RE.test(effect.result.journalEntryId)) throw new Error('Invalid transfer receipt');
  const [journal] = await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid
    AND id=${effect.result.journalEntryId}::uuid AND source_record_id=${intentId}::uuid
    AND source='auto_bank_transfer' AND status='posted' AND reversed_at IS NULL FOR SHARE`;
  if (!journal) throw new Error('Transfer receipt journal has changed; prepare a new intent');
  return replayKnownOperationEffect<BankTransferResult>(ctx,{entityType:'bank_transfer_intent',entityId:intentId,operation:'bank_transfer.post'},effect.id);
}
export async function executeBankTransfer(companyId: string, userId: string, intentId: string, options?: { approvalId?: string }): Promise<BankTransferResult> {
  const ctx = actor(companyId, userId);
  await assertEffectivePermission(ctx, 'write:bank-tx');
  await assertEffectivePermission(ctx, 'write:post');
  if (!UUID_RE.test(intentId)) throw new Error('Invalid transfer intent');
  const [intent] = await ctx.sql`SELECT requester_person_id FROM control_bank_transfer_intents
    WHERE company_id=${companyId}::uuid AND id=${intentId}::uuid` as Row[];
  if (!intent || intent.requester_person_id !== ctx.principal.personId) throw new Error('Transfer intent does not belong to authenticated requester');
  if (!options?.approvalId) { const existing = await receipt(ctx, intentId); if (existing) return existing; }
  const parent = ref(intentId);
  return executeControlledOperation(ctx, parent, options?.approvalId ?? null, async permit => {
    if (await receipt(ctx, intentId)) throw new Error('Transfer intent already executed');
    const material = await materializeBankTransferOperation(ctx, parent);
    const facts = material.observedSources[0]!.facts as { intent: Row; accounts: Row[]; banks: Row[]; period: Row;
      plan: { glAccountId: string; debit: string; credit: string }[] };
    if (facts.accounts.some(a => a.is_active !== true) || facts.banks.some(b => b.is_active !== true)) throw new Error('Transfer bank account is inactive');
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
