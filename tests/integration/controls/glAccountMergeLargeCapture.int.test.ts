import {expect,it} from 'vitest';
import {evidence,glFixture,journalRows,merge,mergeFixture,pool} from './glAccountMergeCaptureFixture';
it('retains every line of a legal 10002-line draft journal beyond posting-material limits',async()=>{
 const f=glFixture(),m=await mergeFixture('draft');
 await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.companyA,m.journal]);
 await pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description) SELECT $1,$2,CASE WHEN n%2=1 THEN $3::uuid ELSE $4::uuid END,CASE WHEN n%2=1 THEN 0.01 ELSE 0 END,CASE WHEN n%2=0 THEN 0.01 ELSE 0 END,'Synthetic complete line '||n FROM generate_series(1,10002) n",[f.companyA,m.journal,m.source,m.contra]);
 const before=await journalRows(m.journal);expect(before).toHaveLength(10002);
 const result=await merge(m.source,m.target);expect(result.linesRepointed).toBe(5001);
 const events=await evidence('journal_entry',m.journal);expect(events).toHaveLength(1);
 const original=events[0].values.before?.lines as Array<{id:string;debit:string;credit:string}>;
 const final=events[0].values.after?.lines as Array<{id:string;debit:string;credit:string;gl_account_id:string}>;
 expect(original).toHaveLength(10002);expect(final).toHaveLength(10002);
 expect(original.map(row=>row.id)).toEqual(before.map(row=>row.id));expect(final.map(row=>row.id)).toEqual(before.map(row=>row.id));
 expect(final.filter(row=>row.gl_account_id===m.target)).toHaveLength(5001);
 expect(final.map(row=>({id:row.id,debit:row.debit,credit:row.credit}))).toEqual(before.map(row=>({id:row.id,debit:row.debit,credit:row.credit})));
},60000);

it('captures journals beyond the 200-entry preview sample without dropping recovery IDs',async()=>{
 const f=glFixture(),m=await mergeFixture('draft');
 const extra=(await pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,fiscal_period_id,description,source,status,created_by) SELECT $1,'2026-09-10',$2,'Synthetic complete merge population','manual','draft',$3 FROM generate_series(1,200) RETURNING id",[f.companyA,m.period,f.u1.id])).rows.map(row=>String(row.id));
 await pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,j,CASE WHEN n=1 THEN $3::uuid ELSE $4::uuid END,CASE WHEN n=1 THEN 1 ELSE 0 END,CASE WHEN n=2 THEN 1 ELSE 0 END FROM unnest($2::uuid[]) j CROSS JOIN generate_series(1,2) n",[f.companyA,extra,m.source,m.contra]);
 const ids=[m.journal,...extra].sort(),result=await merge(m.source,m.target);expect(result.entriesAffected).toBe(201);expect(result.linesRepointed).toBe(201);
 const events=(await pool.query("SELECT entity_id FROM control_change_events WHERE company_id=$1 AND entity_type='journal_entry' AND action=$2 ORDER BY entity_id",[f.companyA,`accounts_merged:${result.mergeRecordId}`])).rows.map(row=>String(row.entity_id));expect(events).toEqual(ids);
 for(const id of ids){const event=(await evidence('journal_entry',id))[0]!;expect(event.values.before?.lines).toHaveLength(id===m.journal?3:2);expect(event.values.after?.lines).toHaveLength(id===m.journal?3:2);}
 const record=(await pool.query('SELECT moved_line_ids FROM gl_account_merges WHERE company_id=$1 AND id=$2',[f.companyA,result.mergeRecordId])).rows[0];expect(record.moved_line_ids).toHaveLength(201);
},120000);
