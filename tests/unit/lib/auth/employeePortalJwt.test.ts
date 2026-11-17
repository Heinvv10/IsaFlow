/** Wave 6 SS: the employee portal's token verifies only under its own derived key and audience. */
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { signEmployeePortalToken, verifyEmployeePortalToken } from '@/lib/auth/employeePortalJwt';

const claims = { accessId: '11111111-1111-4111-8111-111111111111', companyId: '22222222-2222-4222-8222-222222222222', employeeId: '33333333-3333-4333-8333-333333333333', sessionVersion: 3 };

beforeAll(() => { process.env.PORTAL_JWT_SECRET = 'u'.repeat(48); });

describe('employee portal token', () => {
  it('round-trips its own claims', async () => {
    expect(await verifyEmployeePortalToken(await signEmployeePortalToken(claims))).toEqual(claims);
  });
  it('refuses the same claims signed with PORTAL_JWT_SECRET itself (the AR/AFS portals\' key)', async () => {
    const forged = await new SignJWT({ cid: claims.companyId, eid: claims.employeeId, sv: 3 }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.accessId).setAudience('isaflow-employee-portal').setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.PORTAL_JWT_SECRET));
    expect(await verifyEmployeePortalToken(forged)).toBeNull();
  });
  it('refuses a token with no session version', async () => {
    const token = await signEmployeePortalToken({ ...claims, sessionVersion: 1.5 });
    expect(await verifyEmployeePortalToken(token)).toBeNull();
  });
});
