import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
const env = fs.readFileSync('/home/hein/Workspace/IsaFlow/.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`
    SELECT status, COUNT(*)::int AS cnt
    FROM bank_transactions
    WHERE bank_account_id = '89c3908e-d2a1-433c-b355-d90f87f8a623'
    GROUP BY status
  ` as Array<{ status: string; cnt: number }>;
  console.log('Blitz txn statuses:', rows);
}
main().catch(e => { console.error(e); process.exit(1); });
