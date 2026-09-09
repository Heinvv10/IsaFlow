import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {exportReadFixture} from '../../../fixtures/auditExportReadFixture';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({permission:vi.fn(),sql:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>undefined}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/auditSnapshotPublication',()=>({readRetainedAuditSnapshot:()=>{throw Error('Whole blob forbidden');}}));
vi.mock('@/modules/accounting/services/controls/auditJobRunner',()=>({runAuditSnapshotJob:()=>{throw Error('Worker forbidden');}}));
let fixture:Awaited<ReturnType<typeof exportReadFixture>>,ctx:ControlTx;
beforeEach(async()=>{
 vi.stubEnv('ENCRYPTION_KEY','synthetic-read-encryption-key-0000000000000001');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-read-signing-key-000000000000000001');
 fixture=await exportReadFixture();mocks.permission.mockReset();mocks.sql.mockReset();
 ctx={principal:{companyId:fixture.identity.companyId},sql:mocks.sql} as unknown as ControlTx;
});
afterEach(()=>vi.unstubAllEnvs());
function header(){mocks.sql.mockResolvedValueOnce([fixture.intentRow]).mockResolvedValueOnce([{protected_header:fixture.indexHeader,canonical_hash:fixture.identity.canonicalSnapshotHash}]);}
it('reads bounded authenticated descriptors without full snapshot or worker dependency',async()=>{
 header();mocks.sql.mockResolvedValueOnce(fixture.rows.filter(r=>r.kind==='file').slice(0,100).map(r=>({file_ordinal:r.file.ordinal,protected_file:r.envelope})));
 const page=await getAuditExportFiles(ctx,{jobId:fixture.identity.jobId});expect(page.files).toHaveLength(100);expect(page.fileCount).toBe(111);expect(page.nextCursor).toBe('100');
 expect(mocks.permission).toHaveBeenCalledWith(ctx,'read:payroll');
});
it('authenticates one chunk against its file descriptor',async()=>{
 const f=fixture.rows.find(r=>r.kind==='file')!,c=fixture.rows.find(r=>r.kind==='chunk')!;header();
 mocks.sql.mockResolvedValueOnce([{protected_file:f.envelope}]).mockResolvedValueOnce([{protected_chunk:c.envelope}]);
 const result=await readAuditExportChunk(ctx,{jobId:fixture.identity.jobId,fileOrdinal:0,chunkOrdinal:0});
 expect(Buffer.from(result.bytes)).toEqual(Buffer.from(fixture.bundle.files[0]!.bytes));
});
it('rejects invalid inputs and getters before any query',async()=>{
 let calls=0;
 for(const input of [{jobId:fixture.identity.jobId,limit:101},{jobId:fixture.identity.jobId,cursor:'01'},{jobId:fixture.identity.jobId,companyId:fixture.identity.companyId},
  {get jobId(){calls++;return fixture.identity.jobId;}}])await expect(getAuditExportFiles(ctx,input)).rejects.toThrow();
 expect(calls).toBe(0);expect(mocks.sql).not.toHaveBeenCalled();
});
it('refuses missing descriptors and current source permission denial',async()=>{
 header();mocks.sql.mockResolvedValueOnce([]);await expect(getAuditExportFiles(ctx,{jobId:fixture.identity.jobId})).rejects.toThrow(/incomplete/);
 mocks.sql.mockReset();mocks.permission.mockImplementation(async(_ctx,permission)=>{if(permission==='read:payroll')throw Error('Permission refused');});
 mocks.sql.mockResolvedValueOnce([fixture.intentRow]);await expect(getAuditExportFiles(ctx,{jobId:fixture.identity.jobId})).rejects.toThrow(/Permission/);
 expect(mocks.sql).toHaveBeenCalledTimes(1);
});
