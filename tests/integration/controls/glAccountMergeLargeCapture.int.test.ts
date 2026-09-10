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
