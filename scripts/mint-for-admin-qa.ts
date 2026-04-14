// Mints a fresh 2-hour JWT for admin@isaflow.co.za for QA / audit purposes.
// Run with: `bun run scripts/mint-for-admin-qa.ts` OR `bunx tsx scripts/mint-for-admin-qa.ts`
// Requires DATABASE_URL and JWT_SECRET in the environment.
import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { sql } from '../src/lib/neon';

const USER_ID = '00000000-0000-0000-0000-000000000099'; // admin@isaflow.co.za

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  const key = new TextEncoder().encode(secret);

  const dummyHash = crypto.randomBytes(32).toString('hex');
  const [session] = await sql`
    INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (${USER_ID}, ${dummyHash}, NOW() + INTERVAL '2 hours', '127.0.0.1', 'qa-browser-test')
    RETURNING id
  ` as any[];

  const token = await new SignJWT({
    sub: USER_ID,
    email: 'admin@isaflow.co.za',
    role: 'super_admin',
    sessionId: String(session.id),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(key);

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await sql`UPDATE user_sessions SET token_hash=${hash} WHERE id=${session.id}`;

  // Print key=value lines only so `export $(cat output | xargs)` works cleanly.
  process.stdout.write(`TOKEN=${token}\n`);
  process.stdout.write(`SESSION_ID=${session.id}\n`);
}

main().catch((err) => {
  process.stderr.write(`mint-for-admin-qa failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
