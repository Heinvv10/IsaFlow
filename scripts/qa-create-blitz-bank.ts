import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';

const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const BLITZ_PE = 'b5e17198-c23d-4441-a90d-68c9bc4febef';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const existing = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${BLITZ_PE} AND account_subtype = 'bank' AND bank_account_number = '4096451384'
    LIMIT 1
  `) as Array<{ id: string }>;
  if (existing.length) { console.log('exists:', existing[0]!.id); return; }
  const rows = (await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, description, is_active, bank_account_number, bank_name
    ) VALUES (
      ${BLITZ_PE}, 'BL001', 'Blitz Fibre (Pty) Ltd',
      'asset', 'bank', 'debit',
      'Blitz Fibre ABSA operating account - QA test seed',
      true, '4096451384', 'ABSA'
    ) RETURNING id, account_name, bank_account_number
  `) as Array<{ id: string; account_name: string; bank_account_number: string }>;
  console.log('created:', rows[0]);
}
main().catch(e => { console.error(e); process.exit(1); });
