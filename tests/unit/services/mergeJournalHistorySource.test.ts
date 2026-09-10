import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({permission:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mock.permission}));
import {assertJournalMergeHistorySources,JOURNAL_MERGE_SOURCE_PERMISSIONS} from '@/modules/accounting/services/controls/controlChangeHistoryJournalSources';
import {GL_ENTRY_SOURCES} from '@/modules/accounting/types/gl.types';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const company='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const event={entityType:'journal_entry',entityId:id,action:`accounts_merged:${id}`};
const ctx:ControlTx={sql:vi.fn(async()=>[]),principal:{companyId:company,personId:'person',authMethod:'cookie',provenance:'human',connectionId:null,grantId:null,actingFirmId:null,grantedScopes:null,requestId:id,operationId:id,delegatedByPersonId:null}};
const image=(source:string)=>({header:{id,company_id:company,source},lines:[],accounts:[]});
beforeEach(()=>{vi.clearAllMocks();mock.permission.mockResolvedValue(undefined);});
it('covers every persisted journal source with a closed mapping',()=>{expect(Object.keys(JOURNAL_MERGE_SOURCE_PERMISSIONS).sort()).toEqual([...GL_ENTRY_SOURCES].sort());});
for(const [before,after] of [['auto_payroll','manual'],['manual','auto_payroll']])it(`retains sensitive authority for ${before} to ${after}`,async()=>{
 await assertJournalMergeHistorySources(ctx,event,{before:image(before!),after:image(after!)});
 expect(mock.permission).toHaveBeenCalledWith(ctx,'read:payroll-sensitive');
});
it('requires the union of bank and invoice retained sources',async()=>{
 await assertJournalMergeHistorySources(ctx,event,{before:image('auto_bank_transfer'),after:image('auto_invoice')});
 expect(mock.permission).toHaveBeenCalledWith(ctx,'read:bank-tx');expect(mock.permission).toHaveBeenCalledWith(ctx,'read:invoices');
});
for(const source of [null,'unknown'])it(`refuses absent or unsupported retained source ${source}`,async()=>{
 await expect(assertJournalMergeHistorySources(ctx,event,{before:source===null?null:image(source),after:image('manual')})).rejects.toThrow();
});
it('refuses foreign retained image identity',async()=>{const before=image('manual');before.header.company_id=id;await expect(assertJournalMergeHistorySources(ctx,event,{before,after:image('manual')})).rejects.toThrow();});
