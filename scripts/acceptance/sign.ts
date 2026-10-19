// Signs a GoTrue-shaped HS256 session JWT for the entity-onboarding acceptance run.
// Usage: JWT_SECRET=... bun scripts/acceptance/sign.ts <user-id> <email> <aal1|aal2>
// withAuth -> verifyToken (src/lib/auth/gotrue.ts) needs only a valid HS256 signature, a string `sub`
// and `aal: 'aal2'` (any other aal triggers a GoTrue /user call). Prints the token with no newline.
import { SignJWT } from 'jose';

const [id, email, aal] = process.argv.slice(2);
const secret = process.env.JWT_SECRET;
if (!id || !email || !aal || !secret) {
  process.stderr.write('usage: JWT_SECRET=... bun sign.ts <id> <email> <aal>\n');
  process.exit(1);
}

const token = await new SignJWT({ sub: id, email, aal, role: 'authenticated', aud: 'authenticated' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuedAt()
  .setExpirationTime('4h')
  .sign(new TextEncoder().encode(secret));
process.stdout.write(token);
