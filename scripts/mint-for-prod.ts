import { SignJWT } from 'jose';
import { createSql } from './_pg';
import crypto from 'node:crypto';

// Post Neon→Supabase cutover (2026-04-18), "prod" = self-hosted Supabase.
const PROD_DB = 'postgresql://postgres:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow?sslmode=disable';
const sql = createSql(PROD_DB);

const JWT_SECRET = process.env.JWT_SECRET!;
const key = new TextEncoder().encode(JWT_SECRET);

// Use hein@isaflow.co.za — viewer/owner of Demo company, stays on app domain
const USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';
const EMAIL = 'hein@isaflow.co.za';
const ROLE = 'viewer';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const dummyHash = crypto.randomBytes(32).toString('hex');
const [session] = await sql`
  INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
  VALUES (${USER_ID}, ${dummyHash}, NOW() + INTERVAL '4 hours', '127.0.0.1', 'qa-browser-test')
  RETURNING id
` as any[];

const token = await new SignJWT({
  sub: USER_ID,
  email: EMAIL,
  role: ROLE,
  sessionId: String(session.id)
}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('4h').sign(key);

const hash = crypto.createHash('sha256').update(token).digest('hex');
await sql`UPDATE user_sessions SET token_hash=${hash} WHERE id=${session.id}`;

console.log('TOKEN=' + token);
console.log('COMPANY_ID=' + COMPANY_ID);
console.log('SESSION_ID=' + session.id);
