import {assertGeneratedJournalMoney} from '../controls/generatedJournalMoney';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { executeControlledOperation } from '../controls/approvalExecutionService';
import { assertGeneratedJournal, type ParentJournalControl } from '../controls/generatedJournalPermit';
import { materializeGlOperation } from '../controls/glOperationMaterializer';
import { initializeOperationObservations } from '../controls/approvalRequestService';
import { recordCommittedChange } from '../controls/changeEventService';
import type { ApMaterial } from '../controls/apOperationMaterializer';
import type { ControlTx, OperationRef } from '../controls/contracts';
export interface JournalControlOptions { approvalId?: string | null; parentControl?: ParentJournalControl }
export async function runJournalControl<T>(companyId: string, userId: string, ref: OperationRef, opts: JournalControlOptions | undefined,
  effect: (ctx: ControlTx, material: ApMaterial, parent: ParentJournalControl) => Promise<T>): Promise<T> {
  try {
    const ctx = requireControlTx();
    if (ctx.principal.companyId !== companyId || ctx.principal.personId !== userId) throw new Error('Journal context does not match authenticated person and tenant');
    const parent = opts?.parentControl;
    if (!parent) return await executeControlledOperation(ctx, ref, opts?.approvalId ?? null, async permit => {
      // The control kernel freezes the target date before its callback, including midnight boundaries.
      const effectiveRef = ref.operation === 'journal.reverse'
        ? { ...ref, reversalDate: permit.accountingDate }
        : ref;
      const material = await materializeGlOperation(ctx, effectiveRef);
      return effect(ctx, material, { permit, parent: effectiveRef });
    });
    assertGeneratedJournal(ctx, parent, ref.entityId, ref.operation as 'journal.post' | 'journal.reverse');
    if (ref.operation === 'journal.reverse' && ref.reversalDate !== undefined && ref.reversalDate !== parent.permit.accountingDate) {
      throw new Error('Journal reversal date does not match the approved parent');
    }
    const effectiveRef = ref.operation === 'journal.reverse' ? { ...ref, reversalDate: parent.permit.accountingDate } : ref;
    return await withSavepoint('controlled_generated_journal', async () => {
      const material = await materializeGlOperation(ctx, effectiveRef);
      assertGeneratedJournalMoney(parent.permit,material.binding);
      await initializeOperationObservations(ctx, material);
      const result = await effect(ctx, material, parent);
      const after = await materializeGlOperation(ctx, { ...ref,
        ...(ref.operation === 'journal.reverse' ? { reversalDate: material.binding.accountingDate! } : {}) });
      const facts = (value: ApMaterial) => value.observedSources.find(s => s.entityType === ref.entityType && s.entityId === ref.entityId)!.facts;
      await recordCommittedChange(ctx, { entityType: ref.entityType, entityId: ref.entityId,
        previousVersion: material.binding.entityVersion, newVersion: material.binding.entityVersion + 1,
        action: ref.operation, accountingDate: material.binding.accountingDate, before: facts(material), after: facts(after),
        bindingHash: null, protectedEvidenceRef: null, operationId: parent.permit.operationId });
      return result;
    });
  } catch (error) {
    const store = als.getStore();
    if (store) store.controlWriteFailed = true;
    throw error;
  }
}
