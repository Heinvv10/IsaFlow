import { SignJWT } from 'jose';
import { sql } from '/home/hein/Workspace/IsaFlow/src/lib/neon.ts';
import crypto from 'node:crypto';

const secret = process.env.JWT_SECRET!;
const key = new TextEncoder().encode(secret);

const USER_ID = '00000000-0000-0000-0000-000000000099'; // admin@isaflow.co.za

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
  sessionId: String(session.id) 
}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('2h').sign(key);

const hash = crypto.createHash('sha256').update(token).digest('hex');
await sql`UPDATE user_sessions SET token_hash=${hash} WHERE id=${session.id}`;

console.log('TOKEN=' + token);
console.log('SESSION_ID=' + session.id);
