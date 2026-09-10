import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,pool,historyFixture} from './controlChangeHistoryFixture';
import {storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
async function staged(large=false){
 const records=Array.from({length:large?400:2},(_,i)=>({recordId:String(i),accountCode:'HISTORY',debit:i%2?'0':'1',credit:i%2?'1':'0',description:'x'.repeat(large?400:10)}));
 return actor(ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify({version:1,sourceSystem:'csv',sourceKey:randomUUID(),kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records})),mimeType:'application/json'}));
}
const history=(id:string,person:'u1'|'u3'='u1')=>actor(ctx=>readControlEntityHistory(ctx,{entityType:'historical_import_source',entityId:id}),person);
async function row(id:string){return(await pool.query('SELECT * FROM control_historical_import_sources WHERE company_id=$1 AND id=$2',[historyFixture().companyA,id])).rows[0];}
async function evidence(id:string){return(await pool.query("SELECT p.* FROM control_protected_evidence p JOIN control_change_events e ON e.company_id=p.company_id AND e.protected_evidence_id=p.id WHERE e.company_id=$1 AND e.entity_type='historical_import_source' AND e.entity_id=$2",[historyFixture().companyA,id])).rows[0];}
for(const large of [false,true])it(`reads genuine staged-unprepared import history with bounded source-kind metadata (large=${large})`,async()=>{
 const source=await staged(large),before=await row(source.sourceId);
 expect((await pool.query('SELECT id FROM control_historical_imports WHERE company_id=$1 AND source_id=$2',[historyFixture().companyA,source.sourceId])).rows).toEqual([]);
 if(large)expect(Buffer.byteLength(JSON.stringify(before.payload_envelope))).toBeGreaterThan(65536);
 const statements:string[]=[];
 const result=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'historical_import_source',entityId:source.sourceId}),'u1',false,statement=>statements.push(statement));
 expect(statements.join(' ')).toContain('octet_length(p.ciphertext)<=65536');expect(statements.join(' ')).not.toContain('AS payload_envelope');expect(result).toMatchObject({available:true,items:[{action:'historical_import.source_staged',after:{kind:'gl',sourceId:source.sourceId}}]});
 expect(await row(source.sourceId)).toEqual(before);
});
it('rechecks reports domain permission and refuses foreign source history',async()=>{
 const source=await staged(),f=historyFixture();
 await expect(history(source.sourceId,'u3')).rejects.toThrow();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.companyA,f.u1.id]);
 try{await expect(history(source.sourceId)).rejects.toThrow();}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.companyA,f.u1.id]);}
});
it('refuses changed original envelope even when its replacement is valid authenticated encryption',async()=>{
 const source=await staged(),original=await row(source.sourceId),body=openProtectedChange(original.payload_envelope);
 const changed=protectChangeValues('historical_import_source',body.before,{...body.after,normalized:{...(body.after!.normalized as Record<string,unknown>),kind:'customer_invoice'}}).protectedPayload;
 await pool.query('UPDATE control_historical_import_sources SET payload_envelope=$3::jsonb WHERE company_id=$1 AND id=$2',[historyFixture().companyA,source.sourceId,JSON.stringify(changed)]);
 await expect(history(source.sourceId)).rejects.toThrow();
});
it('refuses corrupt kind metadata without trusting an unrelated event or unbounded original',async()=>{
 const source=await staged(true),retained=await evidence(source.sourceId);
 await pool.query("UPDATE control_protected_evidence SET ciphertext='invalid' WHERE company_id=$1 AND id=$2",[historyFixture().companyA,retained.id]);
 await expect(history(source.sourceId)).rejects.toThrow();
});

async function legacyMetadata(id:string){
 const retained=await evidence(id),body=openProtectedChange({version:1,keyId:retained.key_id,ciphertext:retained.ciphertext});
 for(const key of ['kind','sourceCompanyId','sourceEnvelopeHash','sourceEnvelopeKeyId','sourceEnvelopeVersion'])delete body.after![key];
 const old=protectChangeValues('historical_import_source',body.before,body.after).protectedPayload;
 await pool.query('UPDATE control_protected_evidence SET ciphertext=$3 WHERE company_id=$1 AND id=$2',[historyFixture().companyA,retained.id,old.ciphertext]);
}
it('authenticates a bounded legacy original when its old staged event had no kind',async()=>{
 const source=await staged();await legacyMetadata(source.sourceId);const retained=await evidence(source.sourceId);
 expect(await history(source.sourceId)).toMatchObject({available:true,items:[{after:{sourceId:source.sourceId}}]});
 expect(await evidence(source.sourceId)).toEqual(retained);
});
it('refuses oversized legacy staged sources without kind evidence rather than guessing a domain',async()=>{
 const source=await staged(true);await legacyMetadata(source.sourceId);
 await expect(history(source.sourceId)).rejects.toThrow('History domain metadata unavailable');
});
it('preserves prepared source history and records kind on the new preparation event',async()=>{
 const source=await staged(true),f=historyFixture(),original=await row(source.sourceId);
 const normalized=openProtectedChange(original.payload_envelope).after!.normalized as {sourceKey:string;records:Array<{recordId:string}>};
 await pool.query("INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,level) VALUES($1,'HISTORY','History fixture','asset','debit',true,3)",[f.companyA]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'History fixture',2,2023,'2023-02-01','2023-02-28','closed')",[f.companyA]);
 const prepared=await actor(ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:normalized.sourceKey,kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',evidenceId:source.sourceId,sourceRecordIds:normalized.records.map(r=>r.recordId)}));
 expect(await actor(ctx=>readControlEntityHistory(ctx,{entityType:'historical_import',entityId:prepared.importId}))).toMatchObject({available:true,items:[{after:{kind:'gl'}}]});
 await legacyMetadata(source.sourceId);
 expect(await history(source.sourceId)).toMatchObject({available:true});expect(await row(source.sourceId)).toEqual(original);
});
it('refuses a correctly encrypted kind proof claiming another tenant',async()=>{
 const source=await staged(),retained=await evidence(source.sourceId),body=openProtectedChange({version:1,keyId:retained.key_id,ciphertext:retained.ciphertext});
 const changed=protectChangeValues('historical_import_source',body.before,{...body.after,sourceCompanyId:historyFixture().companyB}).protectedPayload;
 await pool.query('UPDATE control_protected_evidence SET ciphertext=$3 WHERE company_id=$1 AND id=$2',[historyFixture().companyA,retained.id,changed.ciphertext]);
 await expect(history(source.sourceId)).rejects.toThrow('History kind metadata changed');
});
