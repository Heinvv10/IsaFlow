import { SignJWT } from 'jose';
import { createSql } from './_pg';
import * as crypto from 'crypto';

// Post Neon→Supabase cutover (2026-04-18), "prod" = self-hosted Supabase
// on velo-server (tailnet). Legacy Neon data still exists but is frozen.
const PROD_DB = 'postgresql://postgres:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow?sslmode=disable';
const JWT_SECRET = 'accounting-app-jwt-secret-change-in-production';
const sql = createSql(PROD_DB);

async function main() {
  // Use hein@isaflow.co.za — viewer in ISAFlow Demo — not super_admin, won't redirect to admin
  const userId = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';
  const email = 'hein@isaflow.co.za';
  const role = 'viewer';

  // Check user is active
  const users = await sql`SELECT id, email, role, is_active, onboarding_completed FROM users WHERE id = ${userId}`;
  console.log('User:', JSON.stringify(users[0]));

  // Ensure onboarding_completed = true
  await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId}`;

  // Create session
  const sessions = await sql`
    INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
    VALUES (${userId}, ${'temp'}, ${'qa-playwright'}, ${'playwright-qa-browser'}, NOW() + INTERVAL '8 hours')
    RETURNING id
  `;
  const sessionId = String((sessions[0] as { id: number }).id);
  console.log('Session ID:', sessionId);

  const secret = new TextEncoder().encode(JWT_SECRET);
  const token = await new SignJWT({ email, role, sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await sql`UPDATE user_sessions SET token_hash = ${hash} WHERE id = ${Number(sessionId)}`;
  console.log('TOKEN:', token);
}

main().catch(console.error);
