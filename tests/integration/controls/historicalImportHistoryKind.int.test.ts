import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,pool,historyFixture} from './controlChangeHistoryFixture';
import {storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
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
 const result=await history(source.sourceId);expect(result).toMatchObject({available:true,items:[{action:'historical_import.source_staged',after:{kind:'gl',sourceId:source.sourceId}}]});
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
