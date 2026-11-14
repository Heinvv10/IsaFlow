import { createHmac } from 'crypto';
import { decodeJwt, jwtVerify, SignJWT, type JWTPayload } from 'jose';

const ISSUER = 'isaflow';
const AUDIENCE = 'isaflow-impersonation';
const PURPOSE = 'isaflow:impersonation-assurance:v1';

function key(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHmac('sha256', secret).update(PURPOSE).digest();
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

interface DelegationInput {
  actorUserId: string;
  targetUserId: string;
  targetSessionId: string;
  /** Unix seconds, from the verified actor JWT and persisted stash respectively. */
  actorExpiresAt: number;
  stashExpiresAt: number;
}

/** Call only after platform-admin authorization and successful stash/audit writes. */
export async function mintImpersonationProof(input: DelegationInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (![input.actorUserId, input.targetUserId, input.targetSessionId].every(identifier)
    || ![input.actorExpiresAt, input.stashExpiresAt].every(Number.isSafeInteger)) {
    throw new Error('Invalid impersonation identity or expiration');
  }
  const expiresAt = Math.min(input.actorExpiresAt, input.stashExpiresAt, now + 3600);
  if (expiresAt <= now) throw new Error('Impersonation authorization expired');
  // No sub claim and a separate key: this envelope cannot act as a GoTrue JWT.
  return new SignJWT({ version: 1, actorUserId: input.actorUserId,
    targetUserId: input.targetUserId, targetSessionId: input.targetSessionId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setIssuedAt(now).setExpirationTime(expiresAt).sign(key());
}

/** Seconds until a proof validateImpersonationProof has accepted runs out, at least 1. */
export function proofSecondsLeft(proof: string): number {
  return Math.max(1, (decodeJwt(proof).exp ?? 0) - Math.floor(Date.now() / 1000));
}

/** The target JWT must already have passed its own signature/expiry verification. */
export async function validateImpersonationProof(proof: string, target: JWTPayload): Promise<boolean> {
  if (!identifier(target.sub) || !identifier(target.session_id)) return false;
  try {
    const { payload } = await jwtVerify(proof, key(), {
      algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE,
      requiredClaims: ['exp', 'iat'], maxTokenAge: '1h',
    });
    return payload.version === 1 && identifier(payload.actorUserId)
      && payload.targetUserId === target.sub && payload.targetSessionId === target.session_id
      && Number.isSafeInteger(payload.exp) && Number.isSafeInteger(payload.iat)
      && payload.exp! > payload.iat! && payload.exp! - payload.iat! <= 3600;
  } catch {
    // Invalid delegation never authorizes: the caller retains ordinary MFA checks.
    return false;
  }
}

/**
 * Whether `proof` is a Login-as proof THIS app minted for exactly this target session (signature, issuer, audience,
 * target and session binding), at any age. Not an authorisation (validateImpersonationProof adds the age limit and
 * the actor): a local, no-DB filter for the refused Return whose stash is already gone, so that only a browser holding
 * its own session's proof may spend a slot of the capped Login-as look-up. Junk cannot produce one (#1371 review).
 */
export async function proofNamesSession(proof: string, target: JWTPayload): Promise<boolean> {
  if (!identifier(target.sub) || !identifier(target.session_id)) return false;
  try {
    const { iat } = decodeJwt(proof);
    if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) return false;
    const { payload } = await jwtVerify(proof, key(), {
      algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, currentDate: new Date(iat * 1000),
    });
    return payload.version === 1 && payload.targetUserId === target.sub && payload.targetSessionId === target.session_id;
  } catch {
    return false; // not ours, or not this session's: it proves nothing
  }
}
