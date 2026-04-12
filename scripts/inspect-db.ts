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
    SELECT u.email, u.first_name, u.is_active, u.password_hash IS NOT NULL has_pw,
           array_agg(cu.role ORDER BY cu.role) roles
    FROM users u
    LEFT JOIN company_users cu ON cu.user_id = u.id
    WHERE u.is_active = true AND u.password_hash IS NOT NULL
    GROUP BY u.id, u.email, u.first_name, u.is_active
    ORDER BY u.created_at LIMIT 15
  ` as any[];
  for (const r of rows) console.log(`${r.email}  ${r.first_name}  roles=${r.roles.join(',')}`);
}
main().catch(e => { console.error(e); process.exit(1); });

async function companies2() {
  const c = await (await import('./inspect-db.ts' as any)).cols('companies');
  const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' ORDER BY ordinal_position`;
  console.log('\n=== companies columns ===');
  for (const r of rows as any[]) console.log(`  ${r.column_name}`);
}
