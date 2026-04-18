import { createSql } from './_pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath,'utf-8').split('\n')) { const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]!])process.env[m[1]!]=m[2]!.replace(/^["']|["']$/g,''); }
(async () => {
  const sql = createSql();
  const cid = '00000000-0000-0000-0000-000000000001';

  // Trial balance totals for 2024
  const tb = await sql`
    SELECT SUM(jl.debit)::numeric AS dr, SUM(jl.credit)::numeric AS cr,
           COUNT(DISTINCT jl.gl_account_id)::int AS accts
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${cid}::UUID AND je.status='posted'
      AND je.entry_date BETWEEN '2024-01-01' AND '2024-12-31'` as any[];
  console.log('2024 FY: DR=R', tb[0].dr, '  CR=R', tb[0].cr, '  accounts used=', tb[0].accts);

  // By source
  const src = await sql`
    SELECT source, COUNT(*)::int AS entries
    FROM gl_journal_entries
    WHERE company_id = ${cid}::UUID AND status='posted'
      AND entry_date BETWEEN '2024-01-01' AND '2024-12-31'
    GROUP BY source ORDER BY source` as any[];
  console.log('\nBy source:');
  src.forEach((r:any) => console.log('  ', r.source.padEnd(30), r.entries));

  // IS proxy
  const rev = await sql`
    SELECT SUM(credit - debit)::numeric AS total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${cid}::UUID AND je.status='posted' AND ga.account_type='revenue'
      AND je.entry_date BETWEEN '2024-01-01' AND '2024-12-31'` as any[];
  const exp = await sql`
    SELECT SUM(debit - credit)::numeric AS total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${cid}::UUID AND je.status='posted' AND ga.account_type='expense'
      AND je.entry_date BETWEEN '2024-01-01' AND '2024-12-31'` as any[];
  console.log('\n2024 Income Statement:');
  console.log('  Revenue: R', Number(rev[0].total).toLocaleString('en-ZA', {minimumFractionDigits: 2}));
  console.log('  Expenses: R', Number(exp[0].total).toLocaleString('en-ZA', {minimumFractionDigits: 2}));
  console.log('  Net:     R', (Number(rev[0].total) - Number(exp[0].total)).toLocaleString('en-ZA', {minimumFractionDigits: 2}));

  // VAT
  const vatOut = await sql`
    SELECT SUM(credit - debit)::numeric AS total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${cid}::UUID AND je.status='posted' AND ga.account_code='2120'
      AND je.entry_date BETWEEN '2024-01-01' AND '2024-12-31'` as any[];
  const vatIn = await sql`
    SELECT SUM(debit - credit)::numeric AS total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${cid}::UUID AND je.status='posted' AND ga.account_code='1140'
      AND je.entry_date BETWEEN '2024-01-01' AND '2024-12-31'` as any[];
  console.log('\n2024 VAT:');
  console.log('  Output (2120): R', Number(vatOut[0].total||0).toLocaleString('en-ZA', {minimumFractionDigits: 2}));
  console.log('  Input  (1140): R', Number(vatIn[0].total||0).toLocaleString('en-ZA', {minimumFractionDigits: 2}));
  console.log('  Net payable:   R', (Number(vatOut[0].total||0) - Number(vatIn[0].total||0)).toLocaleString('en-ZA', {minimumFractionDigits: 2}));
})().catch(e=>console.error(e.message));
