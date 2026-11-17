/**
 * Browser fixture for the WP5 account switcher: 80 bank accounts (18 primaries + a "Paycards" umbrella with 60
 * sub-accounts) in the QA company "Bank Audit QA 2026-11-15" on isaflow_dev, so the switcher can be driven by hand.
 *
 *   DATABASE_URL=<isaflow_dev url> bun scripts/dev/seed-bank-switcher-qa.ts
 *
 * Refuses anything but that company on a database named isaflow_dev; never touches Demo or any other tenant.
 * Idempotent: an account code that exists is left alone.
 */
import { Pool } from 'pg';

const QA_COMPANY = '33fd2683-d163-449b-8b34-60d1a99d30a1';
const QA_NAME = 'Bank Audit QA 2026-11-15';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/isaflow_dev') throw new Error('DATABASE_URL must point at isaflow_dev');
  const pool = new Pool({ connectionString: url });
  try {
    const co = await pool.query('SELECT name FROM companies WHERE id = $1', [QA_COMPANY]);
    if (co.rows[0]?.name !== QA_NAME) throw new Error(`company ${QA_COMPANY} is not "${QA_NAME}"`);
    const ensure = async (code: string, name: string, parent: string | null): Promise<string> => {
      const have = await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2', [QA_COMPANY, code]);
      if (have.rows[0]) return have.rows[0].id as string;
      return (await pool.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype,parent_account_id,bank_account_number)
         VALUES($1,$2,$3,'asset','debit',true,'bank',$4,$5) RETURNING id`, [QA_COMPANY, code, name, parent, `62${code}`])).rows[0].id as string;
    };
    const umbrella = await ensure('SW3000', 'Paycards', null);
    const ids: string[] = [];
    for (let i = 1; i <= 18; i++) ids.push(await ensure(`SW${3100 + i}`, `Branch account ${i} - First National Bank Business Current Account`, null));
    for (let i = 1; i <= 60; i++) ids.push(await ensure(`SW${4000 + i}`, `Employee ${i} Paycard`, umbrella));
    // A line still to code on every fifth account, so "N to code" varies.
    for (const [i, id] of ids.entries()) {
      if (i % 5 !== 0) continue;
      const exists = await pool.query("SELECT 1 FROM bank_transactions WHERE company_id = $1 AND bank_account_id = $2 AND description = 'WP5 switcher fixture'", [QA_COMPANY, id]);
      if (exists.rows[0]) continue;
      await pool.query(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status)
        VALUES($1,$2,DATE '2026-11-10',$3,'WP5 switcher fixture','imported')`, [QA_COMPANY, id, -(100 + i)]);
    }
    process.stdout.write(`seeded ${ids.length} bank accounts under ${QA_NAME}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
