import { neon } from '@neondatabase/serverless';
const PROD_URL = 'postgresql://neondb_owner:npg_TDuKN9ao1sZB@ep-shiny-flower-aldyej0o-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const sql = neon(PROD_URL);
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
