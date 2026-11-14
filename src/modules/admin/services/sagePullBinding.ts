/**
 * Binds a Sage commit to the pull it came from (admin audit 3.4, #1370 review M1).
 *
 * sage-pull-server issues a token: base64url claims {companyId, issuedAt, a
 * SHA-256 of each pulled section} and an HMAC over them. sage-commit refuses a
 * commit whose token is missing, forged, for another company, older than
 * PULL_TOKEN_MAX_AGE_MS, or over a section that is not exactly what was pulled.
 * A commit may send a subset of the sections (names + COA only); every section
 * it does send must match. The key is derived from the server's existing
 * JWT_SECRET for this purpose only (the budgetTemplateSignature pattern); no new
 * secret.
 *
 * Named limit: the token is not single-use and not bound to an admin or a
 * session. Any super admin holding it can replay the same commit, into the
 * same company, with the same data, for two hours. That is acceptable because
 * the commit is idempotent on what matters (invoice numbers and existing
 * account codes are skipped, contacts matched by name), every admin is
 * already allowed to commit into any company, and what the token prevents is
 * the dangerous case: a payload or company that the pull did not produce.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'isaflow:sage-pull-binding:v1';
export const PULL_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
export const PULL_SECTIONS = ['company', 'accounts', 'customers', 'suppliers', 'arInvoices', 'apInvoices'] as const;

interface Claims { v: 1; companyId: string; issuedAt: number; sections: Record<string, string> }

/** A commit that does not match its pull; the route answers 409 with the message. */
export class PullBindingError extends Error {}

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

const sign = (body: string) => createHmac('sha256', key()).update(body).digest('hex');
/** The section as the client sends it back: JSON round-trips keep key order and values. */
const digest = (section: unknown) => createHash('sha256').update(JSON.stringify(section)).digest('hex');

export function issuePullToken(companyId: string, pulled: Record<string, unknown>, now = Date.now()): string {
  const sections = Object.fromEntries(PULL_SECTIONS.filter((s) => pulled[s] !== undefined).map((s) => [s, digest(pulled[s])]));
  const claims: Claims = { v: 1, companyId: companyId.toLowerCase(), issuedAt: now, sections };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readClaims(token: unknown): Claims {
  const refuse = () => new PullBindingError('This commit does not carry a valid pull token. Pull from Sage again, then commit.');
  if (typeof token !== 'string') throw refuse();
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined || !/^[0-9a-f]{64}$/.test(mac)) throw refuse();
  const expected = Buffer.from(sign(body), 'hex');
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), expected)) throw refuse();
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
}

/** Throws PullBindingError unless `pulled` is (a subset of) what was pulled for `companyId`, recently. */
export function verifyPullToken(token: unknown, companyId: string, pulled: Record<string, unknown>, now = Date.now()): void {
  const claims = readClaims(token);
  if (claims.companyId !== companyId.toLowerCase()) {
    throw new PullBindingError('This data was pulled for a different company. Pull from Sage again for this company.');
  }
  if (claims.issuedAt > now + CLOCK_SKEW_MS) {
    throw new PullBindingError('This pull token was issued in the future (server clocks disagree). Pull from Sage again, then commit.');
  }
  if (now - claims.issuedAt > PULL_TOKEN_MAX_AGE_MS) {
    throw new PullBindingError('This pull is more than two hours old. Pull from Sage again, then commit.');
  }
  const changed = Object.keys(pulled).filter((s) => pulled[s] !== undefined
    && (!claims.sections[s] || claims.sections[s] !== digest(pulled[s])));
  if (changed.length > 0) {
    throw new PullBindingError(`The data to commit is not what was pulled (${changed.join(', ')}). Pull from Sage again, then commit.`);
  }
}
