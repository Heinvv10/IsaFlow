import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
const env = fs.readFileSync('/home/hein/Workspace/IsaFlow/.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const sql = neon(process.env.DATABASE_URL!);
const BLITZ_PE = 'b5e17198-c23d-4441-a90d-68c9bc4febef';

async function main() {
  // Bank accounts for Blitz PE
  const accounts = await sql`
    SELECT id, account_code, account_name, bank_account_number
    FROM gl_accounts
    WHERE company_id = ${BLITZ_PE} AND account_subtype = 'bank'
    ORDER BY account_code
  ` as Array<{ id: string; account_code: string; account_name: string; bank_account_number: string }>;
  console.log('=== Bank accounts ===');
  for (const a of accounts) console.log(`  ${a.account_code}  ${a.account_name}  accno=${a.bank_account_number}  id=${a.id}`);

  // Transactions by bank_account_id
  const txCounts = await sql`
    SELECT bank_account_id, COUNT(*)::int AS cnt
    FROM bank_transactions
    WHERE company_id = ${BLITZ_PE}
    GROUP BY bank_account_id
  ` as Array<{ bank_account_id: string; cnt: number }>;
  console.log('\n=== Transaction counts by bank_account_id ===');
  for (const t of txCounts) console.log(`  account_id=${t.bank_account_id}  count=${t.cnt}`);

  // Sample transactions
  const sample = await sql`
    SELECT id, transaction_date, description, amount, bank_account_id
    FROM bank_transactions
    WHERE company_id = ${BLITZ_PE}
    LIMIT 3
  ` as Array<{ id: string; transaction_date: string; description: string; amount: string; bank_account_id: string }>;
  console.log('\n=== Sample transactions ===');
  for (const t of sample) console.log(`  ${t.transaction_date}  ${t.description.substring(0, 40)}  ${t.amount}  acct=${t.bank_account_id}`);
}
main().catch(e => { console.error(e); process.exit(1); });
