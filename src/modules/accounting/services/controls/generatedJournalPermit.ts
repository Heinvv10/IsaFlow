import { UUID_RE } from '@/lib/validation';
import type { ControlTx, OperationRef } from './contracts';
import { assertControlledEffectPermit, type ControlledEffectPermit } from './approvalExecutionService';

export interface ParentJournalControl { permit: ControlledEffectPermit; parent: OperationRef }
type JournalOperation = 'journal.post' | 'journal.reverse';
const registrations = new WeakMap<ControlledEffectPermit, {
  principal: ControlTx['principal']; journals: Map<string, Set<JournalOperation>>;
}>();
/** Internal server callback only: explicitly register the journal created/selected by the parent workflow. */
export async function registerGeneratedJournal(ctx: ControlTx, control: ParentJournalControl, journalId: string, operation: JournalOperation): Promise<void> {
  assertControlledEffectPermit(ctx, control.permit, control.parent);
  if (!UUID_RE.test(journalId) || !['journal.post', 'journal.reverse'].includes(operation)) throw new Error('Invalid generated journal');
  const { parent } = control, company = ctx.principal.companyId;
  let related: unknown[] = [];
  if (parent.entityType === 'supplier_invoice' && ['supplier_invoice.post', 'supplier_invoice.approve', 'supplier_invoice.cancel'].includes(parent.operation)) {
    related = await ctx.sql`SELECT je.id FROM gl_journal_entries je JOIN supplier_invoices p
      ON p.company_id=je.company_id AND p.id=${parent.entityId}::uuid
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid
        AND ((${operation}='journal.post' AND je.status='draft' AND je.source='auto_supplier_invoice' AND je.source_record_id=p.id)
          OR (${operation}='journal.reverse' AND ${parent.operation}='supplier_invoice.cancel' AND p.gl_journal_entry_id=je.id AND je.status='posted'))
      FOR SHARE OF p,je`;
  } else if (parent.entityType === 'supplier_payment' && ['supplier_payment.process', 'supplier_payment.void'].includes(parent.operation)) {
    related = await ctx.sql`SELECT je.id FROM gl_journal_entries je JOIN supplier_payments p
      ON p.company_id=je.company_id AND p.id=${parent.entityId}::uuid
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid
        AND ((${operation}='journal.post' AND je.status='draft' AND je.source='auto_supplier_payment' AND je.source_record_id=p.id)
          OR (${operation}='journal.reverse' AND ${parent.operation}='supplier_payment.void' AND p.gl_journal_entry_id=je.id AND je.status='posted'))
      FOR SHARE OF p,je`;
  } else if (parent.entityType === 'journal_entry' && parent.operation === 'journal.reverse' && operation === 'journal.post') {
    related = await ctx.sql`SELECT je.id FROM gl_journal_entries je JOIN gl_journal_entries p
      ON p.company_id=je.company_id AND p.id=je.reversal_of_id
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid AND p.id=${parent.entityId}::uuid
        AND je.status='draft' AND p.status='posted' FOR SHARE OF p,je`;
  }
  if (related.length !== 1) throw new Error('Generated journal has no authorized parent relationship');
  // A lazy query may have yielded beyond the callback lifetime.
  assertControlledEffectPermit(ctx, control.permit, control.parent);
  let registration = registrations.get(control.permit);
  if (registration && registration.principal !== ctx.principal) throw new Error('Generated journal context mismatch');
  if (!registration) {
    registration = { principal: ctx.principal, journals: new Map() };
    registrations.set(control.permit, registration);
  }
  const operations = registration.journals.get(journalId) ?? new Set<JournalOperation>();
  operations.add(operation); registration.journals.set(journalId, operations);
}
export function assertGeneratedJournal(ctx: ControlTx, control: ParentJournalControl, journalId: string, operation: JournalOperation): void {
  assertControlledEffectPermit(ctx, control.permit, control.parent);
  const registration = registrations.get(control.permit);
  if (registration?.principal !== ctx.principal || !registration.journals.get(journalId)?.has(operation)) {
    throw new Error('Journal is not authorized by this parent operation');
  }
}
