import { describe, it, expect, beforeEach } from 'vitest';

describe('portalJwt', () => {
  beforeEach(() => {
    process.env.PORTAL_JWT_SECRET = 'test-portal-secret-that-is-long-enough-32chars';
  });

  it('signPortalToken + verifyPortalToken round-trips successfully', async () => {
    const { signPortalToken, verifyPortalToken } = await import('@/lib/auth/portalJwt');
    const session = {
      contactId: 'c1',
      companyId: 'comp1',
      role: 'director' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const token = await signPortalToken(session);
    const result = await verifyPortalToken(token);
    expect(result).not.toBeNull();
    expect(result!.contactId).toBe('c1');
    expect(result!.companyId).toBe('comp1');
    expect(result!.role).toBe('director');
  });

  it('verifyPortalToken returns null for an expired token', async () => {
    const { verifyPortalToken } = await import('@/lib/auth/portalJwt');
    // Build a token that is already expired by manually constructing a JWT
    // with exp in the past using jose directly.
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode('test-portal-secret-that-is-long-enough-32chars');
    const expiredToken = await new SignJWT({
      contactId: 'c2',
      companyId: 'comp2',
      role: 'cfo',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('c2')
      .setIssuedAt()
      .setExpirationTime(Math.floor((Date.now() - 60_000) / 1000)) // epoch in the past
      .sign(secret);
    const result = await verifyPortalToken(expiredToken);
    expect(result).toBeNull();
  });

  it('verifyPortalToken returns null for a tampered token', async () => {
    const { signPortalToken, verifyPortalToken } = await import('@/lib/auth/portalJwt');
    const session = {
      contactId: 'c3',
      companyId: 'comp3',
      role: 'external_auditor' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const token = await signPortalToken(session);
    // Tamper with the signature (last segment)
    const parts = token.split('.');
    parts[2] = parts[2]!.split('').reverse().join('');
    const tampered = parts.join('.');
    const result = await verifyPortalToken(tampered);
    expect(result).toBeNull();
  });

  it('verifyPortalToken returns null for a staff JWT (different secret)', async () => {
    const { SignJWT } = await import('jose');
    const { verifyPortalToken } = await import('@/lib/auth/portalJwt');
    const staffSecret = new TextEncoder().encode('completely-different-staff-secret-32chars');
    const staffToken = await new SignJWT({ sub: 'user1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(staffSecret);
    const result = await verifyPortalToken(staffToken);
    expect(result).toBeNull();
  });

  it('signPortalToken throws when PORTAL_JWT_SECRET is not set', async () => {
    delete process.env.PORTAL_JWT_SECRET;
    const { signPortalToken } = await import('@/lib/auth/portalJwt');
    await expect(
      signPortalToken({ contactId: 'c1', companyId: 'comp1', role: 'director', expiresAt: '' }),
    ).rejects.toThrow('PORTAL_JWT_SECRET');
  });
});
