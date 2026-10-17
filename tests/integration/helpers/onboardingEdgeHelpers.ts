/**
 * Shared assertions for the onboarding complete-setup edge suites (ported from the
 * edge-case tester's file): a refused request writes nothing; an accepted one stores the
 * entity type. Synthetic values.
 */
import { expect } from 'vitest';
import type { Pool } from 'pg';
import { callSetup, doc, newSetupUser, person, setupBody, type SetupUser } from './onboardingSetupFixture';

export function edgeHelpers(pool: Pool, users: SetupUser[]) {
  const user = async () => { const u = await newSetupUser(pool); users.push(u); return u; };
  const count = async (q: string, p: unknown[]) => (await pool.query(q, p)).rows[0].n as number;
  const companiesNamed = (name: string) => count('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [name]);
  const membership = (u: SetupUser) => count('SELECT COUNT(*)::int AS n FROM company_users WHERE user_id = $1', [u.userId]);
  const flag = async (u: SetupUser) => (await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [u.userId])).rows[0].onboarding_completed;

  async function refused(entityType: string, over: Record<string, unknown>, contains?: string) {
    const u = await user();
    const body = setupBody(entityType, over);
    const out = await callSetup(u, body);
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    if (contains) expect(out.body.error?.message).toContain(contains);
    expect(await companiesNamed(body.company.name)).toBe(0);
    expect(await membership(u)).toBe(1);
    expect(await flag(u)).toBe(false);
    expect(out.cookies).toEqual([]);
    return out;
  }
  async function accepted(entityType: string, over: Record<string, unknown>) {
    const u = await user();
    const out = await callSetup(u, setupBody(entityType, over));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const companyId = out.body.data!.companyId!;
    const row = (await pool.query('SELECT entity_type, registration_number, name, vat_period FROM companies WHERE id = $1', [companyId])).rows[0];
    expect(row.entity_type).toBe(entityType);
    return { u, companyId, row, out };
  }
  return { user, count, companiesNamed, membership, flag, refused, accepted };
}

export const PROOF: Record<string, { docs?: unknown[]; people?: unknown[] }> = {
  pty_ltd: { docs: [doc('cipc_certificate')] }, ltd: { docs: [doc('cipc_certificate')] }, npc: { docs: [doc('cipc_certificate')] },
  cc: { docs: [doc('ck_certificate')] }, trust: { docs: [doc('letters_of_authority')] },
  sole_proprietor: { people: [person('Owner A')] }, partnership: { people: [person('Partner A'), person('Partner B')] }, other: {},
};
export const ROLE: Record<string, string> = {
  pty_ltd: 'Director', ltd: 'Director', npc: 'Director', cc: 'Member', trust: 'Trustee',
  sole_proprietor: 'Owner', partnership: 'Partner', other: 'Representative',
};
