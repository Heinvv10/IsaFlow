import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {buildSnapshotIndex} from '@/modules/accounting/services/controls/auditSnapshotIndexMaterial';
import {getAuditSnapshotPage,readAuditSnapshotChunk} from '@/modules/accounting/services/controls/auditSnapshotPageService';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn(async()=>undefined)}));
vi.mock('@/modules/accounting/services/controls/auditSnapshotPublication',()=>({readRetainedAuditSnapshot:()=>{throw new Error('Foreground full retained load forbidden');}}));
const companyId='11111111-1111-4111-8111-111111111111',snapshotId='22222222-2222-4222-8222-222222222222';
const query=vi.fn(),ctx={principal:{companyId},sql:query} as unknown as ControlTx;
beforeEach(()=>{query.mockReset();vi.mocked(assertEffectivePermission).mockReset().mockResolvedValue(undefined);vi.stubEnv('ENCRYPTION_KEY','synthetic-index-read-key-outside-database');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-index-sign-key-outside-database');});
afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
 const record={source:'journal_entry',id:'one',version:1,data:{amount:'115.00'}};
 const sealed=sealAuditSnapshot({version:1,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-09T00:00:00.000Z',records:[record],
  populations:['journal_entry','journal_line','payroll_run','payroll_run_line'].map(source=>({source,count:source==='journal_entry'?1:0,excludedCount:0,exclusions:[]})),checks:[],evidence:[],coverage:[],missingSources:[]});
 const material=await buildSnapshotIndex(sealed,[],['read:reports','read:payroll']);
 query.mockImplementation(async(strings:TemplateStringsArray)=>{
  const text=strings.join('?');
  if(text.includes('protected_header'))return[{protected_header:material.protectedHeader,canonical_hash:sealed.canonicalHash}];
  if(text.includes('protected_chunk'))return[{protected_chunk:material.items[0]!.chunks[0]}];
  if(text.includes('protected_item'))return[{ordinal:0,protected_item:material.items[0]!.protectedItem}];
  throw new Error('Unexpected foreground SQL');
 });
 return{record,material};
}
it('returns authenticated bounded descriptors and exact item chunks without loading full retained material',async()=>{
 const value=await fixture();
 const page=await getAuditSnapshotPage(ctx,{snapshotId,section:'records',limit:1});
 expect(page).toMatchObject({snapshotId,section:'records',total:1,nextCursor:null});expect(page.items).toHaveLength(1);
 const chunk=await readAuditSnapshotChunk(ctx,{snapshotId,section:'records',ordinal:0,chunkOrdinal:0});
 expect(JSON.parse(Buffer.from(chunk.bytes).toString())).toEqual(value.record);
 expect(vi.mocked(assertEffectivePermission).mock.calls.map(call=>call[1])).toContain('read:payroll');
});
it('checks current sensitive permissions before fetching any item or chunk',async()=>{
 await fixture();vi.mocked(assertEffectivePermission).mockImplementation(async(_ctx,permission)=>{if(permission==='read:payroll')throw new Error('Revoked payroll permission');});
 await expect(getAuditSnapshotPage(ctx,{snapshotId,section:'records'})).rejects.toThrow('Revoked payroll permission');
 expect(query.mock.calls.some(([strings])=>strings.join('').includes('protected_item'))).toBe(false);
});
it('refuses excess limits and caller authority fields before SQL',async()=>{
 await expect(getAuditSnapshotPage(ctx,{snapshotId,section:'records',limit:101})).rejects.toThrow();
 await expect(getAuditSnapshotPage(ctx,{snapshotId,section:'records',companyId})).rejects.toThrow();
 expect(query).not.toHaveBeenCalled();
});
it('refuses a missing item rather than returning a misleading complete page',async()=>{
 await fixture();const original=query.getMockImplementation()!;
 query.mockImplementation(async(strings,...args)=>strings.join('').includes('protected_item')?[]:original(strings,...args));
 await expect(getAuditSnapshotPage(ctx,{snapshotId,section:'records'})).rejects.toThrow(/incomplete|unavailable/i);
});
