import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {ParentJournalControl} from '@/modules/accounting/services/controls/generatedJournalPermit';
const mocks=vi.hoisted(()=>({permit:vi.fn(),sql:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({assertControlledEffectPermit:mocks.permit}));
import {readArJournalRelationship} from '@/modules/accounting/services/controls/arGeneratedRelationship';
const ctx={principal:{companyId:'company'},sql:mocks.sql} as unknown as ControlTx;
const control={parent:{entityType:'customer_invoice',entityId:'invoice',operation:'customer_invoice.post'},permit:{accountingDate:'2026-09-09'}} as ParentJournalControl;
beforeEach(()=>{vi.clearAllMocks();mocks.sql.mockResolvedValue([{id:'journal',entry_date:'2026-09-09'}]);});
it('requires a live issued parent capability before any relationship read',async()=>{
 mocks.permit.mockImplementationOnce(()=>{throw new Error('expired');});
 await expect(readArJournalRelationship(ctx,control,'journal','journal.post')).rejects.toThrow('expired');expect(mocks.sql).not.toHaveBeenCalled();
});
it('returns only a persisted tenant relationship and binds posting/reversal identities in SQL',async()=>{
 expect(await readArJournalRelationship(ctx,control,'journal','journal.post')).toHaveLength(1);
 const [strings,...values]=mocks.sql.mock.calls[0]!;
 const query=(strings as TemplateStringsArray).join('');
 expect(values).toContain('company');expect(values).toContain('invoice');expect(values).toContain('customer_invoice');
 expect(query).toContain('je.source_record_id=p.source_id');expect(query).toContain('je.reversal_of_id=p.original_id');
 expect(query).toContain('original.status=');expect(query).toContain('control_recurring_invoice_runs');
 mocks.sql.mockResolvedValue([]);expect(await readArJournalRelationship(ctx,control,'foreign','journal.post')).toEqual([]);
});
it('does not turn nonposting application intents into journal authority',async()=>{
 expect(await readArJournalRelationship(ctx,{...control,parent:{entityType:'credit_note_application',entityId:'intent',operation:'credit_note_application.apply'}},'journal','journal.post')).toEqual([]);
 expect(mocks.sql).not.toHaveBeenCalled();
});
