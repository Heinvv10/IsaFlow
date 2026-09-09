import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,event,supplier,pool,historyFixture} from './controlChangeHistoryFixture';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
it('pages all >100 real events without same-time loss and freezes append population',async()=>{
 const f=historyFixture(),id=await supplier();
 await actor(async ctx=>{for(let v=1;v<=105;v++)await recordCommittedChange(ctx,{entityType:'supplier',entityId:id,previousVersion:v===1?null:v-1,newVersion:v,action:'updated',accountingDate:null,before:null,after:{nested:{version:v}},bindingHash:null,protectedEvidenceRef:null});});
 await pool.query("UPDATE control_change_events SET occurred_at='2026-09-10 00:00:00.123456+00' WHERE company_id=$1 AND entity_id=$2",[f.companyA,id]);
 const first=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,limit:100}));
 expect(first.items).toHaveLength(100);expect(first.coverage.eventCount).toBe(105);
 await event(id,106,{nested:{version:106}});
 const last=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,limit:100,cursor:first.nextCursor!}));
 expect(last.items.map(row=>row.newVersion)).toEqual([101,102,103,104,105]);expect(last.nextCursor).toBeNull();expect(last.coverage.throughVersion).toBe(105);
 expect(first.items[0]?.after).toEqual({nested:{version:1}});
});
it('preserves recorded attribution and exact authorized nested changes with explicit banking redactions',async()=>{
 const f=historyFixture(),id=await supplier();await event(id,1,{classification:{account_subtype:'bank'},bank_account_number:'123456789'},'supplier',true);
 const result=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}));
 expect(result.items[0]).toMatchObject({actor:{personId:f.u1.id,connectionId:f.u1.tokens[0]!.id,provenance:'agent',recorded:true},after:{classification:{account_subtype:'bank'}},redactedPaths:['/after/bank_account_number']});
 expect(JSON.stringify(result)).not.toContain('123456789');
});
it('refuses tenant/entity/tampered cursor and current domain revocation',async()=>{
 const f=historyFixture(),id=await supplier(),other=await supplier();await event(id,1,{status:'one'});await event(id,2,{status:'two'});
 const first=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,limit:1}));
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:other,cursor:first.nextCursor!}))).rejects.toThrow();
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,cursor:first.nextCursor!+'x'}))).rejects.toThrow();
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}),'u3')).rejects.toThrow();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'suppliers',false)",[f.companyA,f.u2.id]);
 try{await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}),'u2')).rejects.toThrow();}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='suppliers'",[f.companyA,f.u2.id]);}
});
it('distinguishes owned legacy, missing versions and rolled-back changes',async()=>{
 const f=historyFixture(),id=await supplier();
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).coverage.historical).toBe('untracked');
 await event(id,1,{status:'one'});await event(id,2,{status:'two'});await event(id,3,{status:'three'});
 await pool.query('DELETE FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND new_version=2',[f.companyA,id]);
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).coverage.versionGaps).toBe(true);
 await expect(actor(async ctx=>{await recordCommittedChange(ctx,{entityType:'supplier',entityId:id,previousVersion:3,newVersion:4,action:'rollback',accountingDate:null,before:null,after:{status:'never'},bindingHash:null,protectedEvidenceRef:null});throw new Error('Rollback');})).rejects.toThrow('Rollback');
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).coverage.throughVersion).toBe(3);
});
it('refuses ciphertext tamper and treats a wrong-parent protected link as missing',async()=>{
 const f=historyFixture(),id=await supplier(),other=await supplier();const one=await event(id,1,{status:'one'}),two=await event(other,1,{status:'two'});
 await pool.query('UPDATE control_change_events SET protected_evidence_id=(SELECT protected_evidence_id FROM control_change_events WHERE company_id=$1 AND id=$3) WHERE company_id=$1 AND id=$2',[f.companyA,one.eventId,two.eventId]);
 const result=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}));expect(result.items[0]?.protectedEvidence.availability).toBe('missing');
 await pool.query("UPDATE control_protected_evidence SET ciphertext='broken' WHERE company_id=$1 AND entity_id=$2",[f.companyA,other]);
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:other}))).rejects.toThrow();
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'not_supported',entityId:randomUUID()}))).rejects.toThrow();
});
