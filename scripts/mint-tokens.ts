import { SignJWT, createHash } from 'jose';
import { sql } from '../src/lib/neon.ts';
import crypto from 'node:crypto';

const secret = process.env.JWT_SECRET!;
const key = new TextEncoder().encode(secret);
const SUPER_ID = 'f110ef4f-e388-442e-8428-1a265b8d0a6a';
const REG_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';

// Pre-sign to get a token, then hash it for storage
const dummyHash1 = crypto.randomBytes(32).toString('hex');
const dummyHash2 = crypto.randomBytes(32).toString('hex');

const [s1] = await sql`INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (${SUPER_ID}, ${dummyHash1}, NOW() + INTERVAL '2 hours', '127.0.0.1', 'pentest') RETURNING id` as any[];
const [s2] = await sql`INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (${REG_ID}, ${dummyHash2}, NOW() + INTERVAL '2 hours', '127.0.0.1', 'pentest') RETURNING id` as any[];

const adminTok = await new SignJWT({ sub: SUPER_ID, email: 'hein@h10.co.za', role: 'super_admin', sessionId: String(s1.id) }).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('2h').sign(key);
const regTok = await new SignJWT({ sub: REG_ID, email: 'hein@isaflow.co.za', role: 'viewer', sessionId: String(s2.id) }).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('2h').sign(key);

// Update sessions with actual token hashes
const ah = crypto.createHash('sha256').update(adminTok).digest('hex');
const rh = crypto.createHash('sha256').update(regTok).digest('hex');
await sql`UPDATE user_sessions SET token_hash=${ah} WHERE id=${s1.id}`;
await sql`UPDATE user_sessions SET token_hash=${rh} WHERE id=${s2.id}`;

console.log('ADMIN_JWT=' + adminTok);
console.log('REGULAR_JWT=' + regTok);
