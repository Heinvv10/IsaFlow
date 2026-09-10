import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
const boundary=vi.hoisted(()=>({assert:vi.fn(),permission:vi.fn(),target:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:boundary.assert}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:boundary.permission}));
vi.mock('@/lib/auth/platformImportAuthority',()=>({readPlatformImportTarget:boundary.target}));
import {readHistoricalImportSourceKind} from '@/modules/accounting/services/controls/historicalImportSourceKind';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const companyId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const sql=vi.fn(),ctx={sql,principal:{companyId}} as unknown as ControlTx;
beforeEach(()=>{vi.resetAllMocks();process.env.ENCRYPTION_KEY='synthetic-import-kind-test-key-long-enough';});
function row(changes:Record<string,unknown>={}){
 const source=protectChangeValues('historical_import_source',null,{companyId,sourceId:id,normalized:{kind:'gl'}}).protectedPayload;
 const digest=createHash('sha256').update(source.ciphertext).digest('hex');
 const metadata=protectChangeValues('historical_import_source',null,{sourceId:id,contentHash:'a'.repeat(64),normalizedHash:'b'.repeat(64),kind:'gl',
  sourceCompanyId:companyId,sourceEnvelopeHash:digest,sourceEnvelopeKeyId:source.keyId,sourceEnvelopeVersion:source.version,...changes}).protectedPayload;
 return{id,content_hash:'a'.repeat(64),normalized_hash:'b'.repeat(64),source_digest:digest,source_key:source.keyId,source_version:source.version,
 event_id:id,evidence_id:id,metadata:metadata.ciphertext,key_id:metadata.keyId,envelope_version:metadata.version};
}
it('authenticates the actual protected proof without loading a second source payload',async()=>{
 sql.mockResolvedValueOnce([row()]);expect(await readHistoricalImportSourceKind(ctx,id)).toBe('gl');expect(sql).toHaveBeenCalledTimes(1);
});
it('rejects valid encryption whose signed proof does not match original identity, hash or envelope',async()=>{
 for(const change of [{sourceId:companyId},{contentHash:'0'.repeat(64)},{normalizedHash:'0'.repeat(64)},{sourceCompanyId:id},
  {sourceEnvelopeHash:'0'.repeat(64)},{sourceEnvelopeKeyId:'different'},{sourceEnvelopeVersion:2},{kind:'payroll'}]){
  sql.mockResolvedValueOnce([row(change)]);await expect(readHistoricalImportSourceKind(ctx,id)).rejects.toThrow('History kind metadata changed');
 }
});
it('refuses oversized or missing protected metadata and preserves authority failures',async()=>{
 for(const change of [{metadata:null},{evidence_id:null},{envelope_version:2}]){sql.mockResolvedValueOnce([{...row(),...change}]);await expect(readHistoricalImportSourceKind(ctx,id)).rejects.toThrow('History kind metadata unavailable');}
 boundary.permission.mockRejectedValueOnce(new Error('Revoked'));await expect(readHistoricalImportSourceKind(ctx,id)).rejects.toThrow('Revoked');
 expect(sql).toHaveBeenCalledTimes(3);
});
const other='33333333-3333-4333-8333-333333333333',importId='44444444-4444-4444-8444-444444444444';
const platform={sql,principal:{companyId,personId:'maker',authMethod:'platform_import'}} as unknown as ControlTx;
it('refuses a platform maker kind metadata for a source other than the selected one before querying it',async()=>{
 sql.mockResolvedValue([row()]);boundary.target.mockReturnValue({action:'prepare',companyId,sourceId:other});
 await expect(readHistoricalImportSourceKind(platform,id)).rejects.toThrow('Platform import source identity differs');expect(sql).not.toHaveBeenCalled();
 boundary.target.mockReturnValue({action:'execute',companyId,importId});
 sql.mockResolvedValueOnce([{source_id:other,requester_person_id:'maker',requester_auth_method:'platform_import'}]);
 await expect(readHistoricalImportSourceKind(platform,id)).rejects.toThrow('Platform import source identity differs');expect(sql).toHaveBeenCalledTimes(1);
});
it('still reads kind metadata for the selected platform source',async()=>{
 boundary.target.mockReturnValue({action:'prepare',companyId,sourceId:id});sql.mockResolvedValueOnce([row()]);
 expect(await readHistoricalImportSourceKind(platform,id.toUpperCase())).toBe('gl');expect(sql).toHaveBeenCalledTimes(1);
});
it('reads kind metadata for an ordinary member without consulting platform target authority',async()=>{
 const member={sql,principal:{companyId,personId:'member',authMethod:'cookie'}} as unknown as ControlTx;
 sql.mockResolvedValueOnce([row()]);expect(await readHistoricalImportSourceKind(member,id)).toBe('gl');
 expect(boundary.target).not.toHaveBeenCalled();expect(sql).toHaveBeenCalledTimes(1);
});
