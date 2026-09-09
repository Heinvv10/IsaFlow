import { UUID_RE } from '@/lib/validation';
import type { ControlTx, OperationRef } from './contracts';
import { assertControlledEffectPermit, type ControlledEffectPermit } from './approvalExecutionService';

export interface ParentJournalControl { permit: ControlledEffectPermit; parent: OperationRef }
type JournalOperation = 'journal.post' | 'journal.reverse';
const registrations = new WeakMap<ControlledEffectPermit, {
  principal: ControlTx['principal']; journals: Map<string, Set<JournalOperation>>;
}>();
/** Internal server callback only: explicitly register the journal created/selected by the parent workflow. */
export function registerGeneratedJournal(ctx: ControlTx, control: ParentJournalControl, journalId: string, operation: JournalOperation): void {
  assertControlledEffectPermit(ctx, control.permit, control.parent);
  if (!UUID_RE.test(journalId) || !['journal.post', 'journal.reverse'].includes(operation)) throw new Error('Invalid generated journal');
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
