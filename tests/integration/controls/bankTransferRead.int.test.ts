import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferReadFixture} from './bankTransferReadFixture';
let f:Awaited<ReturnType<typeof transferReadFixture>>;
beforeAll(async()=>{f=await transferReadFixture();});afterAll(async()=>{if(f)await f.close();});
it('actual GET resolves original and saved opposite to one canonical post intent',async()=>{
 const p=await f.posted();
 for(const id of [p.bank,p.opposite!]){const response=await f.read(id);expect(response.status).toBe(200);expect(response.body.data).toMatchObject({currentOriginalIntentId:p.prepared.intentId,legacyProvenanceUnavailable:false});}
 expect((await f.read(p.bank,'u1',p.approval)).body.data.selected.approval.id).toBe(p.approval);
});
it('actual GET resolves a separately approved late link without ambiguous receipts',async()=>{
 const p=await f.posted(false),late=await f.bank(f.to,'115.23'),link=await f.prepare(late,f.from);await f.execute(link.intentId,await f.approve(link.operation));
 for(const id of [p.bank,late])expect((await f.read(id)).body.data.currentOriginalIntentId).toBe(p.prepared.intentId);
 await expect(f.withoutEvidence(late,link.intentId,'event')).rejects.toThrow();
 await expect(f.withoutEvidence(p.bank,link.intentId,'receipt')).rejects.toThrow();
});
it('read-only reviewer succeeds while foreign tenant and revoked current read refuse',async()=>{
 const p=await f.posted();await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',true,false),($1,$2,'accounts',true,false)",[f.f.companyA,f.f.u2.id]);
 expect((await f.read(p.opposite!,'u2')).status).toBe(200);expect((await f.read(p.bank,'u3')).status).toBeGreaterThanOrEqual(400);
 await f.pool.query("UPDATE company_user_permissions SET can_read=false WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.f.companyA,f.f.u2.id]);
 try{expect((await f.read(p.bank,'u2')).status).toBeGreaterThanOrEqual(400);}finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2',[f.f.companyA,f.f.u2.id]);}
});
it('missing original event or receipt cannot become legacy unknown',async()=>{
 const p=await f.posted();await expect(f.withoutEvidence(p.bank,p.prepared.intentId,'event')).rejects.toThrow();await expect(f.withoutEvidence(p.opposite!,p.prepared.intentId,'receipt')).rejects.toThrow();
});
it('unapproved occupation is refused for both source and fabricated opposite',async()=>{
 const p=await f.posted(false),raw=await f.bank(f.to,'115.23');
 const line=(await f.pool.query('SELECT id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.f.companyA,p.effect.journalEntryId,f.to])).rows[0].id;
 await f.pool.query("UPDATE bank_transactions SET status='allocated',allocation_type='transfer',matched_journal_line_id=$3,transfer_journal_entry_id=$4,counterparty_account_id=$5 WHERE company_id=$1 AND id=$2",[f.f.companyA,raw,line,p.effect.journalEntryId,f.from]);
 for(const id of [p.bank,raw])expect((await f.read(id)).status).toBeGreaterThanOrEqual(400);
});
it('changed opposite amount or pointer refuses',async()=>{
 const p=await f.posted();await f.pool.query('UPDATE bank_transactions SET amount=116 WHERE company_id=$1 AND id=$2',[f.f.companyA,p.opposite]);
 expect((await f.read(p.bank)).status).toBeGreaterThanOrEqual(400);
 await f.pool.query('UPDATE bank_transactions SET amount=115.23,transfer_journal_entry_id=NULL WHERE company_id=$1 AND id=$2',[f.f.companyA,p.opposite]);
 expect((await f.read(p.opposite!)).status).toBeGreaterThanOrEqual(400);
});
it('genuine legacy transfer remains explicit unknown',async()=>{
 const bank=await f.bank(),journal=randomUUID(),line=randomUUID();
 await f.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by,source_record_id) VALUES($1,$2,'2026-09-09','Synthetic legacy transfer','auto_bank_transfer','posted',$3,$4)",[journal,f.f.companyA,f.f.u1.id,bank]);
 await f.pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,0,115.23)',[line,f.f.companyA,journal,f.from]);
 await f.pool.query("UPDATE bank_transactions SET status='matched',matched_journal_line_id=$3 WHERE company_id=$1 AND id=$2",[f.f.companyA,bank,line]);
 expect((await f.read(bank)).body.data).toMatchObject({currentOriginalIntentId:null,legacyProvenanceUnavailable:true});
});
