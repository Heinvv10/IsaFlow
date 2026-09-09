import { expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({permit:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({assertControlledEffectPermit:mocks.permit}));
import { readPostingIntentJournalRelationship } from '@/modules/accounting/services/controls/postingIntentJournalRelationship';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ParentJournalControl } from '@/modules/accounting/services/controls/generatedJournalPermit';
const ctx={principal:{companyId:'company'},sql:vi.fn(async()=>[{id:'journal',entry_date:'2026-12-31'}])} as unknown as ControlTx;
const control={permit:{accountingDate:'2026-12-31'},parent:{entityType:'fiscal_year',entityId:'2026',operation:'year.close'}} as ParentJournalControl;
it('requires the live purpose-bound parent permit before reading a relationship',async()=>{
 mocks.permit.mockImplementationOnce(()=>{throw new Error('expired');});
 await expect(readPostingIntentJournalRelationship(ctx,control,'journal','journal.post')).rejects.toThrow('expired');
 expect(ctx.sql).not.toHaveBeenCalled();
});
it('does not grant reversal authority to posting-only business intents',async()=>{
 expect(await readPostingIntentJournalRelationship(ctx,control,'journal','journal.reverse')).toEqual([]);
});
