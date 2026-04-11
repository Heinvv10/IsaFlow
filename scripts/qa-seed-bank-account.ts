/**
 * Seed a test bank account on the demo DB for bank-import QA.
 * Creates a minimal gl_accounts row with account_subtype='bank' and a
 * distinctive bank_account_number so the security gate test has something
 * clearly-wrong to reject.
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
const ACCOUNT_NUMBER = '9999000001'; // Fake — distinct from any real Brighttech statement

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Try to find an existing "Current Assets" parent — if none exists we'll
  // create this as a root bank account (no parent).
  const parent = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${BLITZ_PE} AND account_code = '1100' AND account_subtype IS NULL
    LIMIT 1
  `) as Array<{ id: string }>;
  const parentId = parent[0]?.id ?? null;

  // Check if our QA bank account already exists
  const existing = (await sql`
    SELECT id, bank_account_number FROM gl_accounts
    WHERE company_id = ${BLITZ_PE} AND account_subtype = 'bank' AND account_code = '1115'
    LIMIT 1
  `) as Array<{ id: string; bank_account_number: string | null }>;

  if (existing.length > 0) {
    console.log(`Bank account already exists: id=${existing[0]!.id} number=${existing[0]!.bank_account_number}`);
    return;
  }

  const result = (await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name,
      account_type, account_subtype, normal_balance,
      parent_account_id, description, is_active,
      bank_account_number, bank_name
    ) VALUES (
      ${BLITZ_PE}, '1115', 'Bank - QA Test Account',
      'asset', 'bank', 'debit',
      ${parentId}, 'Seeded by qa-seed-bank-account.ts', true,
      ${ACCOUNT_NUMBER}, 'QA Test Bank'
    )
    RETURNING id, account_code, account_name, bank_account_number
  `) as Array<{ id: string; account_code: string; account_name: string; bank_account_number: string }>;

  console.log('Created bank account:');
  console.log(`  id:             ${result[0]!.id}`);
  console.log(`  code:           ${result[0]!.account_code}`);
  console.log(`  name:           ${result[0]!.account_name}`);
  console.log(`  account_number: ${result[0]!.bank_account_number}`);
}

main().catch(e => { console.error(e); process.exit(1); });
