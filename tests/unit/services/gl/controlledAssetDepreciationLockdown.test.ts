/** Depreciation execution's lockdown refusal is the shared lockdownBlock rule (unmocked), checked inside the effect before any write. */
import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const m=vi.hoisted(()=>({sql:vi.fn(),permission:vi.fn(),execute:vi.fn(),material:vi.fn(),receipt:vi.fn()}));
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',INTENT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:m.execute}));
vi.mock('@/modules/accounting/services/controls/assetDepreciationOperationMaterializer',()=>({materializeAssetDepreciationOperation:m.material}));
vi.mock('@/modules/accounting/services/controls/intentIdentity',async(importOriginal)=>({...await importOriginal<object>(),loadIntentReceipt:m.receipt}));
import {executeAssetDepreciation} from '@/modules/accounting/services/gl/controlledAssetDepreciation';
const ctx={principal:{companyId:COMPANY,personId:USER},sql:m.sql} as unknown as ControlTx;
let company:Record<string,unknown>;
beforeEach(()=>{
 vi.resetAllMocks();company={id:COMPANY,default_currency:'ZAR',lockdown_enabled:true,lockdown_date:'2026-02-28'};
 m.sql.mockImplementation(async(parts:TemplateStringsArray)=>parts.join('?').includes('control_asset_depreciation_intents')?[{requester_person_id:USER}]:[]);
 m.receipt.mockResolvedValue(undefined);
 m.material.mockImplementation(async()=>({observedSources:[{facts:{company,asset:{id:'asset',asset_number:'A1'},period:{id:'period',status:'open'},accounts:[],ledgers:[],
  input:{cost:'0',openingAccDep:'0',taxOpeningAccDep:'0'},calculation:{policyDep:'0',taxDep:'0',policyClosing:'0',policyCarrying:'0',policyRate:'0',taxClosing:'0',taxCarrying:'0',deferredTax:'0'},plan:[]}}]}));
});
const executeOn=(accountingDate:string)=>{
 m.execute.mockImplementation(async(_ctx:unknown,_ref:unknown,_approval:unknown,callback:(p:unknown)=>unknown)=>callback({accountingDate,operationId:'operation'}));
 return executeAssetDepreciation(COMPANY,USER,INTENT,{approvalId:'approval'});
};
const writes=()=>m.sql.mock.calls.map(([parts])=>(parts as string[]).join('?')).filter(text=>/INSERT|UPDATE|DELETE/.test(text));
it('refuses a permit date on or before a dated lockdown before writing the subledger',async()=>{
 await expect(executeOn('2026-02-28')).rejects.toThrow('Depreciation date is within company lockdown');
 await expect(executeOn('2026-02-27')).rejects.toThrow('Depreciation date is within company lockdown');
 expect(writes()).toEqual([]);
});
it('proceeds past the lockdown check the day after the lockdown date',async()=>{
 // No journal (empty plan): the next write is the subledger row, which proves the lockdown check let it through.
 await executeOn('2026-03-01').catch(()=>undefined);
 expect(writes().some(text=>text.includes('INSERT INTO asset_period_ledger'))).toBe(true);
});
it('refuses every permit date when lockdown is enabled with no date',async()=>{
 company.lockdown_date=null;
 await expect(executeOn('2099-12-31')).rejects.toThrow('Depreciation date is within company lockdown');
 expect(writes()).toEqual([]);
});
