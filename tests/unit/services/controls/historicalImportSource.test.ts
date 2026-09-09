import {expect,it,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {decodeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {parseHistoricalImportArtifact} from '@/modules/accounting/services/controls/historicalImportExactPlan';
import {createHash} from 'node:crypto';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const ctx={principal:{companyId:'company'}} as ControlTx;
function row(){
 const bytes=Buffer.from(JSON.stringify({version:1,sourceSystem:'csv',sourceKey:'source',kind:'gl',mode:'post_journal',currency:'ZAR',accountingDate:'2023-02-28',records:[{recordId:'1',accountCode:'1000',debit:'1',credit:'0',description:'a'},{recordId:'2',accountCode:'4000',debit:'0',credit:'1',description:'b'}]}));
 const normalized=parseHistoricalImportArtifact(bytes,'application/json'),contentHash=hash(bytes),normalizedHash=hash(canonicalJson(normalized));
 return{id:'source',company_id:'company',content_hash:contentHash,normalized_hash:normalizedHash,mime_type:'application/json',byte_length:bytes.length,record_count:2,
  payload_envelope:protectChangeValues('historical_import_source',null,{companyId:'company',sourceId:'source',bodyBase64:bytes.toString('base64'),contentHash,normalizedHash,mimeType:'application/json',normalized}).protectedPayload};
}
it('decrypts actual bytes and independently reproduces normalization and both hashes',()=>{
 expect(decodeHistoricalImportSource(ctx,row()).normalized.amount).toBe('1');
});
it.each(['company_id','id','content_hash','normalized_hash','mime_type','byte_length','record_count'])('refuses changed bound metadata %s',key=>{
 const changed={...row(),[key]:'changed'};expect(()=>decodeHistoricalImportSource(ctx,changed)).toThrow('unavailable or changed');
});
it('refuses ciphertext alteration',()=>{
 const changed=row();changed.payload_envelope.ciphertext+='a';expect(()=>decodeHistoricalImportSource(ctx,changed)).toThrow('unavailable or changed');
});
