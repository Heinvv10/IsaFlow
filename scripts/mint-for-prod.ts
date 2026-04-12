import { SignJWT } from 'jose';
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const PROD_DB = 'postgresql://neondb_owner:npg_TDuKN9ao1sZB@ep-shiny-flower-aldyej0o-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const sql = neon(PROD_DB);

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
