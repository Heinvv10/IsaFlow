import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({original:vi.fn(),openHeader:vi.fn(),openItem:vi.fn(),assert:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditSnapshotIndexRead',()=>({readAuditSnapshotIndexHeader:mocks.original}));
vi.mock('@/modules/accounting/services/controls/auditComparisonSourceProtection',()=>({openComparisonSourceHeader:mocks.openHeader,openComparisonSourceItem:mocks.openItem}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
import {readComparisonSourceHeader,iterateComparisonSourceItems} from '@/modules/accounting/services/controls/auditComparisonSourceRead';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const companyId='11111111-1111-4111-8111-111111111111',snapshotId='22222222-2222-4222-8222-222222222222',canonicalHash='a'.repeat(64);
const header={version:1 as const,companyId,snapshotId,canonicalHash,cutoff:'2026-09-09',capturedAt:'2026-09-10T00:00:00.000Z',populationsHash:'b'.repeat(64),coverageHash:'c'.repeat(64),permissions:['read:reports' as const],counts:{records:2,checks:0,evidence:0,evidenceGaps:0}};
const sql=vi.fn(),ctx={principal:{companyId},sql} as unknown as ControlTx;
beforeEach(()=>{vi.resetAllMocks();mocks.original.mockResolvedValue({...header,counts:{records:2,checks:0,findings:0,evidence:0,gaps:0}});mocks.openHeader.mockReturnValue(header);mocks.openItem.mockImplementation((_envelope,_header,_section,position)=>({identity:{source:'journal_entry',id:String(position)},materialHash:canonicalHash,ordinal:position}));});
it('refuses missing projection and mismatched independent population after original authorization',async()=>{
 sql.mockResolvedValueOnce([]);await expect(readComparisonSourceHeader(ctx,snapshotId,canonicalHash)).rejects.toThrow(/projection.*unavailable/i);
 sql.mockResolvedValueOnce([{protected_header:{}}]).mockResolvedValueOnce([{section:'records',count:'1'}]);
 await expect(readComparisonSourceHeader(ctx,snapshotId,canonicalHash)).rejects.toThrow(/count|population/i);
});
it('scopes all queries, reads contiguous bounded batches and opens every item',async()=>{
 sql.mockResolvedValueOnce([{protected_header:{}}]).mockResolvedValueOnce([{section:'records',count:'2'}]);
 const verified=await readComparisonSourceHeader(ctx,snapshotId,canonicalHash);
 sql.mockResolvedValueOnce([{position:0,protected_item:{}},{position:1,protected_item:{}}]);
 const result=[];for await(const row of iterateComparisonSourceItems(ctx,verified,'records'))result.push(row);
 expect(result).toHaveLength(2);expect(mocks.openItem).toHaveBeenCalledTimes(2);
 for(const call of sql.mock.calls){expect(call[0].join(' ')).toContain('company_id');expect(call).toContain(companyId);expect(call).toContain(snapshotId);}
 expect(sql.mock.calls.at(-1)?.[0].join(' ')).toMatch(/LIMIT 256/);
});
it('rejects forged headers, incorrect positions and changed current permissions',async()=>{
 sql.mockResolvedValueOnce([{protected_header:{}}]).mockResolvedValueOnce([{section:'records',count:'2'}]);
 const verified=await readComparisonSourceHeader(ctx,snapshotId,canonicalHash);
 await expect(iterateComparisonSourceItems(ctx,{...verified},'records').next()).rejects.toThrow();
 sql.mockResolvedValueOnce([{position:1,protected_item:{}}]);await expect(iterateComparisonSourceItems(ctx,verified,'records').next()).rejects.toThrow(/position/i);
 mocks.original.mockRejectedValueOnce(new Error('Current permissions denied'));
 await expect(iterateComparisonSourceItems(ctx,verified,'records').next()).rejects.toThrow('Current permissions denied');
});
