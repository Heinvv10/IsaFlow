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
    SELECT email, is_active, password_hash IS NOT NULL AS has_password
    FROM users
    WHERE email IN ('qa-onboard-05@isaflow.test', 'fabri-admin-01@isaflow.test', 'hein@velocityfibre.co.za', 'hein@isaflow.co.za')
  ` as Array<{ email: string; is_active: boolean; has_password: boolean }>;
  for (const r of rows) console.log(`${r.email}  active=${r.is_active}  has_password=${r.has_password}`);
}
main().catch(e => { console.error(e); process.exit(1); });
