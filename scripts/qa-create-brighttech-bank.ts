/**
 * Create the real Brighttech ABSA bank account on the demo DB so the
 * bank statement import flow can be tested end-to-end with matching
 * statements (4069625895).
 */
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
const ACCOUNT_CODE = 'BT001';
const ACCOUNT_NAME = 'Brightsphere Technologies';
const BANK_NAME = 'ABSA';
const BANK_ACCOUNT_NUMBER = '4069625895';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Idempotent check
  const existing = (await sql`
    SELECT id, account_name, bank_account_number
    FROM gl_accounts
    WHERE company_id = ${BLITZ_PE}
      AND account_subtype = 'bank'
      AND bank_account_number = ${BANK_ACCOUNT_NUMBER}
    LIMIT 1
  `) as Array<{ id: string; account_name: string; bank_account_number: string }>;

  if (existing.length > 0) {
    console.log(`Already exists: id=${existing[0]!.id} name="${existing[0]!.account_name}" number=${existing[0]!.bank_account_number}`);
    return;
  }

  const rows = (await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name,
      account_type, account_subtype, normal_balance,
      description, is_active,
      bank_account_number, bank_name
    ) VALUES (
      ${BLITZ_PE}, ${ACCOUNT_CODE}, ${ACCOUNT_NAME},
      'asset', 'bank', 'debit',
      'Brighttech operating account (ABSA) — seeded via scripts/qa-create-brighttech-bank.ts',
      true,
      ${BANK_ACCOUNT_NUMBER}, ${BANK_NAME}
    )
    RETURNING id, account_code, account_name, bank_name, bank_account_number
  `) as Array<{ id: string; account_code: string; account_name: string; bank_name: string; bank_account_number: string }>;

  const row = rows[0]!;
  console.log('✅ Created bank account:');
  console.log(`   id:       ${row.id}`);
  console.log(`   code:     ${row.account_code}`);
  console.log(`   name:     ${row.account_name}`);
  console.log(`   bank:     ${row.bank_name}`);
  console.log(`   number:   ${row.bank_account_number}`);
  console.log(`   company:  Blitz PE (${BLITZ_PE})`);
}

main().catch(e => { console.error(e); process.exit(1); });
