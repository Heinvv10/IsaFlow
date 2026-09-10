import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({assert:vi.fn(),permission:vi.fn(),request:vi.fn(),inputs:vi.fn(),header:vi.fn(),item:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/auditJobProtection',()=>({openAuditJobRequest:mocks.request}));
vi.mock('@/modules/accounting/services/controls/auditComparisonInputs',()=>({readAuditComparisonInputs:mocks.inputs}));
vi.mock('@/modules/accounting/services/controls/auditComparisonResultProtection',()=>({openComparisonResultHeader:mocks.header,openComparisonResultItem:mocks.item}));
import {readAuditComparisonHeader} from '@/modules/accounting/services/controls/auditComparisonReadHeader';
import {getAuditComparisonPage} from '@/modules/accounting/services/controls/auditComparisonPageService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const companyId='11111111-1111-4111-8111-111111111111',comparisonId='22222222-2222-4222-8222-222222222222';
const first={id:'33333333-3333-4333-8333-333333333333',canonicalHash:'a'.repeat(64),cutoff:'2026-09-09',capturedAt:'2026-09-10T00:00:00.000Z'};
const second={...first,id:'44444444-4444-4444-8444-444444444444',canonicalHash:'b'.repeat(64)};
const zero={first:0,second:0,added:0,removed:0,changed:0,unchanged:0};
const header={companyId,comparisonId,generation:1,leaseId:'55555555-5555-4555-8555-555555555555',comparisonRuleVersion:1,first,second,permissions:['read:reports'],counts:{records:{...zero,second:2,added:2},checks:zero,evidence:zero,evidenceGaps:zero},canonicalHash:'c'.repeat(64),populationChanged:true,coverageChanged:false};
const sql=vi.fn(),ctx={principal:{companyId},sql} as unknown as ControlTx;
function rows(count='2'){sql.mockResolvedValueOnce([{generation:1,lease_id:header.leaseId,protected_header:{}}]).mockResolvedValueOnce([{section:'records',count}]);}
beforeEach(()=>{vi.resetAllMocks();mocks.header.mockReturnValue(header);mocks.request.mockReturnValue({kind:'audit_compare',request:{firstSnapshotId:first.id,secondSnapshotId:second.id,firstCanonicalHash:first.canonicalHash,secondCanonicalHash:second.canonicalHash,comparisonRuleVersion:1,permissions:['read:reports']}});mocks.inputs.mockResolvedValue({first:{...first,snapshotId:first.id,counts:{records:0,checks:0,evidence:0,gaps:0}},second:{...second,snapshotId:second.id,counts:{records:2,checks:0,evidence:0,gaps:0}}});mocks.item.mockImplementation((_e,_h,_s,position)=>({position}));});
it('checks current authority and refuses unavailable or independently incomplete published results',async()=>{
 sql.mockResolvedValueOnce([]);await expect(readAuditComparisonHeader(ctx,comparisonId)).rejects.toThrow(/unavailable/i);
 rows('1');await expect(readAuditComparisonHeader(ctx,comparisonId)).rejects.toThrow(/population/i);
 expect(mocks.permission).toHaveBeenCalledWith(ctx,'read:reports');
});
it('returns bounded contiguous authenticated pages, scopes every query and keeps signed whole-result hash',async()=>{
 rows();sql.mockResolvedValueOnce([{position:0,protected_item:{}}]);
 expect(await getAuditComparisonPage(ctx,{comparisonId,section:'records',limit:1})).toMatchObject({comparisonId,total:2,nextCursor:'1',items:[{position:0}],canonicalHash:header.canonicalHash});
 expect(mocks.item).toHaveBeenCalledTimes(1);
 for(const call of sql.mock.calls){expect(call[0].join(' ')).toContain('company_id');expect(call).toContain(companyId);expect(call).toContain(comparisonId);}
 expect(sql.mock.calls.at(-1)?.[0].join(' ')).toContain('2097152');
});
it('rejects invalid input before SQL and missing or shifted item positions',async()=>{
 for(const input of [{comparisonId,section:'records',limit:101},{comparisonId,section:'records',cursor:'01'},{comparisonId,section:'records',companyId}])await expect(getAuditComparisonPage(ctx,input)).rejects.toThrow();
 expect(sql).not.toHaveBeenCalled();rows();sql.mockResolvedValueOnce([{position:1,protected_item:{}}]);
 await expect(getAuditComparisonPage(ctx,{comparisonId,section:'records',limit:1})).rejects.toThrow(/position|incomplete/i);
 rows();sql.mockResolvedValueOnce([]);await expect(getAuditComparisonPage(ctx,{comparisonId,section:'records'})).rejects.toThrow(/incomplete/i);
});
it('refuses a signed result inconsistent with authenticated original metadata or current permissions',async()=>{
 sql.mockResolvedValueOnce([{generation:1,lease_id:header.leaseId,protected_header:{}}]);mocks.header.mockReturnValueOnce({...header,first:{...first,cutoff:'2026-09-08'}});
 await expect(readAuditComparisonHeader(ctx,comparisonId)).rejects.toThrow(/source|identity/i);
 sql.mockResolvedValueOnce([{generation:1,lease_id:header.leaseId,protected_header:{}}]);mocks.inputs.mockRejectedValueOnce(new Error('Current payroll denied'));
 await expect(readAuditComparisonHeader(ctx,comparisonId)).rejects.toThrow('Current payroll denied');
});
