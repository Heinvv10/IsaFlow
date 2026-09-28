/**
 * R-147: the approvals list showed "Requested by Unknown" for a request
 * raised by a user with a real name on file. Cause: `listRequests`
 * (approvalService.ts) joined `users` directly to resolve the name, but
 * `users_self_read` (FORCE RLS) lets app_user SELECT only its OWN row —
 * an approver listing anyone else's request always got a blocked join.
 * Fixed by approval_company_member_name() (migration 714), a SECURITY
 * DEFINER lookup bound to the caller's own company and a target who is also
 * a member of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, cleanup, newCompany, plantRule, plantBill, sign,
} from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};

/** A user with a real profile name (as GoTrue signup + profile completion would leave one). */
async function namedUser(email: string, firstName: string | null, lastName: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  tokens[id] = await sign(id);
  users.push(id);
  return id;
}

let requester = '';
let approver = '';
let outsider = '';
let oneNameUser = '';

beforeAll(async () => {
  requester = await namedUser('r147-requester@test.local', 'Nomvula', 'Dlamini');
  approver = await namedUser('r147-approver@test.local', 'Sipho', 'Khumalo');
  outsider = await namedUser('r147-outsider@test.local', 'Someone', 'Else');
  // GoTrue user with an email but no profile row filled in yet: only one
  // name field set. `first_name || ' ' || last_name` (the pre-fix query)
  // returns NULL the instant either half is NULL, not the half that exists.
  oneNameUser = await namedUser('r147-half-name@test.local', 'OnlyFirst', null);
});
afterAll(() => cleanup(pool, companies, users));

async function raiseAndList(as: string, listAs: string, requestedById: string) {
  const company = await newCompany(pool, [[requester, 'owner'], [approver, 'owner'], [oneNameUser, 'owner']], companies);
  await plantRule(pool, company, 'owner');
  const bill = await plantBill(pool, company, requestedById);
  const raised = await callRoute(approvalRequests, tokens[as]!, company, 'POST',
    { action: 'request', documentType: 'supplier_invoice', documentId: bill.id },
    '/api/accounting/approval-requests');
  expect(raised.state.statusCode).toBe(200);

  const listed = await callRoute(approvalRequests, tokens[listAs]!, company, 'GET', undefined,
    '/api/accounting/approval-requests', { status: 'pending' });
  expect(listed.state.statusCode).toBe(200);
  const items = (listed.state.body as {
    data: { items: { requestedBy: string; requestedByName?: string }[] };
  }).data.items;
  return { company, items, mine: items.find((i) => i.requestedBy === requestedById) };
}

describe('approvals list resolves the requester name for a DIFFERENT company member', () => {
  it('shows the real name, not "Unknown", when someone else lists a request A raised', async () => {
    const { mine } = await raiseAndList(requester, approver, requester);
    expect(mine?.requestedByName).toBe('Nomvula Dlamini');
  });

  it('still shows the name to the requester listing their OWN request', async () => {
    const { mine } = await raiseAndList(requester, requester, requester);
    expect(mine?.requestedByName).toBe('Nomvula Dlamini');
  });

  it('shows the half that exists, not NULL, for a member with only one name field set', async () => {
    // `first_name || ' ' || last_name` (the pre-fix query) is NULL the instant
    // either half is NULL — the fixed lookup trims and COALESCEs each half, so
    // a GoTrue user who has completed only part of their profile still shows
    // the name they DO have, rather than falling all the way back to "Unknown".
    const { mine } = await raiseAndList(oneNameUser, approver, oneNameUser);
    expect(mine?.requestedByName).toBe('OnlyFirst');
  });

  it('falls back to email, not "Unknown", when NEITHER name field is set', async () => {
    const noName = await namedUser('r147-no-name@test.local', null, null);
    const company = await newCompany(pool, [[noName, 'owner'], [approver, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, noName);
    await callRoute(approvalRequests, tokens[noName]!, company, 'POST',
      { action: 'request', documentType: 'supplier_invoice', documentId: bill.id },
      '/api/accounting/approval-requests');
    const listed = await callRoute(approvalRequests, tokens[approver]!, company, 'GET', undefined,
      '/api/accounting/approval-requests', { status: 'pending' });
    const items = (listed.state.body as { data: { items: { requestedBy: string; requestedByName?: string }[] } }).data.items;
    expect(items.find((i) => i.requestedBy === noName)?.requestedByName).toBe('r147-no-name@test.local');
  });
});

describe('the name lookup cannot resolve a user outside the caller\'s company', () => {
  it('a company member function-call cannot resolve the name of a user in NO shared company', async () => {
    const company = await newCompany(pool, [[requester, 'owner']], companies);
    // outsider is never added to this company. Ask the SECURITY DEFINER
    // function directly, as the company would (requested_by can never
    // actually be a non-member — this proves the function itself refuses to
    // widen visibility beyond that invariant).
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: requester })]);
      await client.query("SELECT set_config('app.current_company_id', $1, false)", [company]);
      await client.query('SET ROLE app_user');
      const { rows } = await client.query(
        'SELECT public.approval_company_member_name($1, $2) AS name', [company, outsider]);
      expect(rows[0].name).toBeNull();
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});

/** Sets the session GUCs a real withAuth request would (sub + active company), then SET ROLE app_user. */
async function asSession(client: import('pg').PoolClient, userId: string, sessionCompanyId: string): Promise<void> {
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId })]);
  await client.query("SELECT set_config('app.current_company_id', $1, false)", [sessionCompanyId]);
  await client.query('SET ROLE app_user');
}

describe('approval_company_member_name refuses the two 42501 guards, review round 1 M1', () => {
  it('refuses (42501, "own company") when the session company differs from the p_company_id argument', async () => {
    const companyA = await newCompany(pool, [[requester, 'owner']], companies);
    const companyB = await newCompany(pool, [[approver, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, requester, companyA);
      await expect(
        client.query('SELECT public.approval_company_member_name($1, $2) AS name', [companyB, approver]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('answers only for the caller\'s own company'),
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('refuses (42501, "not a member") when the session company matches p_company_id but the caller has no row there', async () => {
    // requester is deliberately NOT added as a member of companyC.
    const companyC = await newCompany(pool, [[approver, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, requester, companyC);
      await expect(
        client.query('SELECT public.approval_company_member_name($1, $2) AS name', [companyC, approver]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('caller is not a member of this company'),
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('still allows the direct call when the session company matches AND the caller is a member (paired positive)', async () => {
    const company = await newCompany(pool, [[requester, 'owner'], [approver, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, requester, company);
      const { rows } = await client.query(
        'SELECT public.approval_company_member_name($1, $2) AS name', [company, approver]);
      expect(rows[0].name).toBe('Sipho Khumalo');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
