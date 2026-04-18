import { createSql } from './_pg';
import * as fs from 'node:fs';
const env = fs.readFileSync('/home/hein/Workspace/IsaFlow/.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const sql = createSql();
async function main() {
  const rows = await sql`
    SELECT u.email, u.first_name, u.last_name, cu.role
    FROM company_users cu
    JOIN users u ON u.id = cu.user_id
    WHERE cu.company_id = 'b5e17198-c23d-4441-a90d-68c9bc4febef'
  ` as Array<{ email: string; first_name: string; last_name: string; role: string }>;
  for (const r of rows) console.log(`${r.email}  [${r.role}]  ${r.first_name} ${r.last_name}`);
}
main().catch(e => { console.error(e); process.exit(1); });
