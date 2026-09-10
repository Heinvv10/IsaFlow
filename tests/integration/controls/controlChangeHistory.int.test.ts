import {expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {actor,event,supplier,pool,historyFixture} from './controlChangeHistoryFixture';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
it('pages all >100 real events without same-time loss and freezes append population',async()=>{
 const f=historyFixture(),id=await supplier();
 await actor(async ctx=>{for(let v=1;v<=105;v++)await recordCommittedChange(ctx,{entityType:'supplier',entityId:id,previousVersion:v===1?null:v-1,newVersion:v,action:'updated',accountingDate:null,before:null,after:{nested:{version:v}},bindingHash:null,protectedEvidenceRef:null});});
 await pool.query("UPDATE control_change_events SET occurred_at='2026-09-10 00:00:00.123456+00' WHERE company_id=$1 AND entity_id=$2",[f.companyA,id]);
 const started=performance.now(),rssBefore=process.memoryUsage().rss;
 const first=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,limit:100}));
 if(process.env.FORENSIC_HISTORY_METRICS)writeFileSync(process.env.FORENSIC_HISTORY_METRICS,JSON.stringify({eventCount:105,pageCount:first.items.length,elapsedMs:performance.now()-started,rssBefore,rssAfter:process.memoryUsage().rss}));
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
it('returns full authorized payroll components and refuses missing payroll rights before opening tampered evidence',async()=>{
 const f=historyFixture(),id=randomUUID();await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','History','2020-01-01','active')",[id,f.companyA,id.slice(0,12)]);
 await event(id,1,{components:[{name:'Salary',amount:'9876.54'}],accountNumber:'123456789'},'employee');
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'employee',entityId:id}))).items[0]?.after).toEqual({accountNumber:'[REDACTED]',components:[{name:'Salary',amount:'9876.54'}]});
 await pool.query("UPDATE control_protected_evidence SET ciphertext='broken' WHERE company_id=$1 AND entity_id=$2",[f.companyA,id]);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.companyA,f.u2.id]);
 try{await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'employee',entityId:id}),'u2')).rejects.toThrow(/permission/i);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.companyA,f.u2.id]);}
});
it('preflights ciphertext bytes and paginates whole events without omission',async()=>{
 const id=await supplier();for(let v=1;v<=3;v++)await event(id,v,{payload:'x'.repeat(400000)});
 const first=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,limit:100}));
 expect(first.available).toBe(true);expect(first.items).toHaveLength(2);expect(first.coverage.eventCount).toBe(3);
 const next=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id,cursor:first.nextCursor!}));
 expect(next.items.map(row=>row.newVersion)).toEqual([3]);expect(next.nextCursor).toBeNull();
});
it('returns explicit unavailable RESOURCE_LIMIT for a single oversized event before ciphertext retrieval',async()=>{
 const f=historyFixture(),id=await supplier();await event(id,1,{status:'before'});
 await pool.query("UPDATE control_protected_evidence SET ciphertext=repeat('x',2097153) WHERE company_id=$1 AND entity_id=$2",[f.companyA,id]);
 const statements:string[]=[];const result=await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}),'u1',false,statement=>statements.push(statement));
 expect(statements.some(sql=>sql.includes('octet_length(p.ciphertext)'))).toBe(true);expect(statements.some(sql=>sql.includes('SELECT e.id,p.ciphertext'))).toBe(false);
 expect(result).toMatchObject({available:false,code:'RESOURCE_LIMIT',requiredDelivery:'async',byteLength:2097153,items:[]});
});
it('keeps categorisation rules, legacy bank rules and GL parents distinct and preserves exact recorded rules',async()=>{
 const f=historyFixture(),categorisation=randomUUID(),legacy=randomUUID(),account=randomUUID();
 await pool.query("INSERT INTO bank_categorisation_rules(id,company_id,rule_name,match_pattern) VALUES($1,$2,'Synthetic categorisation','test')",[categorisation,f.companyA]);
 await pool.query("INSERT INTO bank_rules(id,company_id,name,match_value) VALUES($1,$2,'Synthetic legacy','test')",[legacy,f.companyA]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$2,left($1::uuid::text,12),'Synthetic history GL','asset','debit',3)",[account,f.companyA]);
 for(const [entityType,entityId] of [['bank_categorisation_rule',categorisation],['bank_rule',legacy],['gl_account',account]])expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:entityType!,entityId:entityId!}))).coverage.historical).toBe('untracked');
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'bank_rule',entityId:categorisation}))).rejects.toThrow();
 const rule={match_pattern:'Rent',priority:0,auto_create_entry:false,gl_account_id:account};await event(categorisation,1,rule,'bank_categorisation_rule');
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'bank_categorisation_rule',entityId:categorisation}))).items[0]?.after).toEqual(rule);
 await event(account,1,{account_type:'asset',account_subtype:'bank',parent_account_id:null},'gl_account');
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'gl_account',entityId:account}))).items[0]?.after).toEqual({account_type:'asset',account_subtype:'bank',parent_account_id:null});
});
it('requires mixed-operation payroll authority before decrypting a contacts event',async()=>{
 const f=historyFixture(),id=await supplier();
 // Actual writer and retained operation metadata; no claim this synthetic effect is a payroll producer test.
 await actor(async ctx=>{
  await recordCommittedChange(ctx,{entityType:'supplier',entityId:id,previousVersion:null,newVersion:1,action:'baseline_observed',accountingDate:null,before:null,after:{nested:{payrollAmount:'12345.67'}},bindingHash:null,protectedEvidenceRef:null});
  await ctx.sql`INSERT INTO control_operation_effects(company_id,operation_id,operation,entity_type,entity_id,binding_hash,result)
   VALUES(${f.companyA}::uuid,${ctx.principal.operationId}::uuid,'payroll_run.post','payroll_run',${randomUUID()},${'a'.repeat(64)},'{}'::jsonb)`;
 });
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).items[0]?.after).toEqual({nested:{payrollAmount:'12345.67'}});
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.companyA,f.u2.id]);
 try{await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}),'u2')).rejects.toThrow(/permission/i);
  await pool.query("UPDATE control_protected_evidence SET ciphertext=repeat('x',2097153) WHERE company_id=$1 AND entity_id=$2",[f.companyA,id]);
  await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}),'u2')).rejects.toThrow(/permission/i);
 }
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.companyA,f.u2.id]);}
});
it('does not reject legal large source-reference metadata when its distinct authority families are bounded',async()=>{
 const f=historyFixture(),id=await supplier();
 const accounts=(await pool.query("INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,level) SELECT $1,'H-'||left($2::text,8)||'-'||n,'Synthetic authority source','asset','debit',3 FROM generate_series(1,1001) n RETURNING id",[f.companyA,id])).rows as {id:string}[];
 const sources=accounts.map(row=>({entityType:'gl_account',entityId:row.id,version:1,fingerprint:'a'.repeat(64)}));
 await actor(async ctx=>{
  await recordCommittedChange(ctx,{entityType:'supplier',entityId:id,previousVersion:null,newVersion:1,action:'baseline_observed',accountingDate:null,before:null,after:{status:'recorded'},bindingHash:null,protectedEvidenceRef:null});
  await ctx.sql`INSERT INTO control_operation_approvals(company_id,operation_id,operation,entity_type,entity_id,requester_person_id,requester_auth_method,binding,binding_hash,status,expires_at)
   VALUES(${f.companyA}::uuid,${ctx.principal.operationId}::uuid,'journal.post','journal_entry',${randomUUID()},${f.u1.id},'cookie',${JSON.stringify({sourceVersions:sources,beneficiaries:[]})}::jsonb,${'a'.repeat(64)},'pending',clock_timestamp()+interval '1 day')`;
 });
 expect((await actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).items[0]?.after).toEqual({status:'recorded'});
 await pool.query("UPDATE control_operation_approvals SET binding=jsonb_build_object('sourceVersions',$3::jsonb,'beneficiaries','[]'::jsonb) WHERE company_id=$1 AND operation_id=(SELECT operation_id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 LIMIT 1)",[f.companyA,id,JSON.stringify([{entityType:'historical_import',entityId:randomUUID(),version:1,fingerprint:'a'.repeat(64)}])]);
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:'supplier',entityId:id}))).rejects.toThrow();
});
