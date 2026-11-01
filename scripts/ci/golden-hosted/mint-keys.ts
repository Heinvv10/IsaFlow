/**
 * mint-keys — prints the two Supabase-style API keys the app sends to GoTrue
 * (anon and service_role), signed with the throwaway JWT secret of a hosted
 * Golden Paths run.
 *
 *   JWT_SECRET=<secret> bun scripts/ci/golden-hosted/mint-keys.ts
 *   stdout: SUPABASE_ANON_KEY=<jwt>\nSUPABASE_SERVICE_ROLE_KEY=<jwt>
 *
 * GoTrue itself only checks the service key's signature and role claim
 * (GOTRUE_JWT_ADMIN_ROLES=service_role); on velo Kong sits in front and checks
 * the anon key, here nothing does, but the app still sends both.
 */
import { SignJWT } from 'jose';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  process.stderr.write('mint-keys: JWT_SECRET must be set (32+ chars)\n');
  process.exit(1);
}
const key = new TextEncoder().encode(secret);

async function mint(role: 'anon' | 'service_role'): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('supabase')
    .setIssuedAt()
    .setExpirationTime('1d')
    .sign(key);
}

process.stdout.write(`SUPABASE_ANON_KEY=${await mint('anon')}\nSUPABASE_SERVICE_ROLE_KEY=${await mint('service_role')}\n`);
