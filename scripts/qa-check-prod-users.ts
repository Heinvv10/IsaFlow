import { createSql } from './_pg';
// Post Neon→Supabase cutover (2026-04-18), "prod" = self-hosted Supabase.
const PROD_URL = 'postgresql://postgres:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow?sslmode=disable';
const sql = createSql(PROD_URL);
async function main() {
  const users = await sql`
    SELECT email, first_name, last_name, is_active, password_hash IS NOT NULL AS has_password
    FROM users WHERE is_active = true ORDER BY created_at LIMIT 20
  ` as Array<{ email: string; first_name: string; last_name: string; is_active: boolean; has_password: boolean }>;
  console.log('=== PROD users ===');
  for (const u of users) console.log(`${u.email}  ${u.first_name} ${u.last_name}  has_pw=${u.has_password}`);

  const blitz = await sql`
    SELECT COUNT(*)::int AS cnt FROM gl_accounts WHERE company_id = 'b5e17198-c23d-4441-a90d-68c9bc4febef'
  ` as Array<{ cnt: number }>;
  console.log('\n=== Blitz PE GL accounts in PROD ===', blitz[0]?.cnt ?? 0);
}
main().catch(e => { console.error(e); process.exit(1); });
