import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const je = (await sql`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE fiscal_period_id IS NULL)::int AS null_fp FROM gl_journal_entries`) as Array<{c:number; null_fp:number}>;
  const inv = (await sql`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE gl_journal_entry_id IS NULL AND status IN ('approved','sent','paid','partially_paid','overdue'))::int AS unposted FROM customer_invoices`) as Array<{c:number; unposted:number}>;
  const bills = (await sql`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE gl_journal_entry_id IS NULL AND status IN ('approved','partially_paid','paid'))::int AS unposted FROM supplier_invoices`) as Array<{c:number; unposted:number}>;
  const runs = (await sql`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE journal_entry_id IS NULL AND status='completed')::int AS unposted FROM payroll_runs`) as Array<{c:number; unposted:number}>;
  const ctrl = (await sql`SELECT account_code, COUNT(*)::int AS n FROM gl_accounts WHERE account_code IN ('2140','2150','2160','2170') GROUP BY account_code ORDER BY account_code`) as Array<{account_code:string; n:number}>;
  console.log('PROD snapshot:');
  console.log('  JEs:', je[0].c, ' NULL fiscal_period_id:', je[0].null_fp);
  console.log('  Invoices:', inv[0].c, ' unposted:', inv[0].unposted);
  console.log('  Bills:', bills[0].c, ' unposted:', bills[0].unposted);
  console.log('  Payroll runs:', runs[0].c, ' unposted:', runs[0].unposted);
  console.log('  Control accts present:', ctrl);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
