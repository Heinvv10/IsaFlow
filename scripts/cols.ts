import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
const env = fs.readFileSync('/home/hein/Workspace/IsaFlow/.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  for (const t of ['supplier_payments','customer_invoices']) {
    const r = await sql`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=${t} AND column_name='company_id'` as any[];
    console.log(`${t}.company_id: nullable=${r[0]?.is_nullable} default=${r[0]?.column_default ?? 'none'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
