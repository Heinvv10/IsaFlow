/**
 * Migration 904: bureau_audit_log is deny-all to app_user (no policy, no privilege) and append-only for
 * every role, and outlives its bureau (the consent record); bureaus.share_merchant_patterns defaults to off;
 * the owner-only toggle (owner = bureaus.owner_user_id) writes exactly one audit row per change and refuses
 * accountants, viewers and a stale bureau_users 'owner' row; pool eligibility follows decision 3 (no bureau
 * -> out; every linked bureau must opt in). The suites run with MERCHANT_SHARING_ENABLED=true except the
 * last, which pins the gate off (merchantSharingGate.ts): ON refused for the owner, OFF allowed, pool empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asUser, pool, seedCompany, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import { getBureauSharingSetting, setBureauSharingSetting } from '../../src/modules/bureau/services/bureauSettingsService';
import { getBureauRole } from '../../src/modules/bureau/services/bureauService';
import {
  listPoolEligibleCompanyIds, loadCompanyPoolEligibility,
} from '../../src/modules/bureau/services/poolEligibility';

assertDisposable();

let co: Co;
let solo: Co;
let shared: Co;
let owner = '';
let accountant = '';
let viewer = '';
let owner2 = '';
let staleOwner = '';
let rowlessOwner = '';
const bureau1 = crypto.randomUUID();
const bureau2 = crypto.randomUUID();
const bureau3 = crypto.randomUUID(); // its owner has no bureau_users row

async function auditRows(bureauId: string) {
  return (await pool.query<{ actor_user_id: string; old_value: boolean; new_value: boolean }>(
    'SELECT actor_user_id, old_value, new_value FROM bureau_audit_log WHERE bureau_id = $1 ORDER BY created_at, id', [bureauId])).rows;
}

const gateBefore = process.env.MERCHANT_SHARING_ENABLED;

beforeAll(async () => {
  process.env.MERCHANT_SHARING_ENABLED = 'true';
  co = await seedCompany('904 bureau client');
  solo = await seedCompany('904 direct company');
  shared = await seedCompany('904 two-bureau client');
  owner = await seedUser([co.id]);
  accountant = await seedUser([]);
  viewer = await seedUser([]);
  owner2 = await seedUser([]);
  staleOwner = await seedUser([]);
  rowlessOwner = await seedUser([]);
  await pool.query('INSERT INTO bureaus (id, name, owner_user_id) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
    [bureau1, '904 Bureau One', owner, bureau2, '904 Bureau Two', owner2, bureau3, '904 Bureau Three', rowlessOwner]);
  // staleOwner: an 'owner' row in bureau_users that is not bureaus.owner_user_id (a hand-made transfer).
  await pool.query(
    `INSERT INTO bureau_users (bureau_id, user_id, role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'accountant'), ($1, $4, 'viewer'), ($5, $6, 'owner'), ($1, $7, 'owner')`,
    [bureau1, owner, accountant, viewer, bureau2, owner2, staleOwner]);
  await pool.query('INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2), ($1, $3), ($4, $3)',
    [bureau1, co.id, shared.id, bureau2]);
});

afterAll(async () => {
  try {
    // The audit rows stay: append-only for every role and no FK to cascade (the consent record outlives the
    // bureau). This is a disposable fixture database.
    await pool.query('DELETE FROM bureaus WHERE id = ANY($1::uuid[])', [[bureau1, bureau2, bureau3]]);
    await teardownCompanies([co.id, solo.id, shared.id], [owner, accountant, viewer, owner2, staleOwner, rowlessOwner]);
  } finally {
    if (gateBefore === undefined) delete process.env.MERCHANT_SHARING_ENABLED;
    else process.env.MERCHANT_SHARING_ENABLED = gateBefore;
    await pool.end();
  }
});

describe('bureaus.share_merchant_patterns', () => {
  it('defaults to off', async () => {
    const r = await pool.query<{ share_merchant_patterns: boolean }>('SELECT share_merchant_patterns FROM bureaus WHERE id = $1', [bureau1]);
    expect(r.rows[0]!.share_merchant_patterns).toBe(false);
  });
});

describe('setBureauSharingSetting (real owner join)', () => {
  it.each([['accountant', () => accountant], ['viewer', () => viewer]] as const)('a bureau %s is refused and nothing is written', async (_l, who) => {
    expect(await setBureauSharingSetting({ bureauId: bureau1, actorUserId: who(), value: true })).toEqual({ kind: 'forbidden' });
    expect(await auditRows(bureau1)).toEqual([]);
  });

  it('a stale bureau_users "owner" row (not bureaus.owner_user_id) is refused, and reads as accountant', async () => {
    expect(await setBureauSharingSetting({ bureauId: bureau1, actorUserId: staleOwner, value: true })).toEqual({ kind: 'forbidden' });
    expect(await getBureauRole(staleOwner, bureau1)).toBe('accountant');
    expect(await auditRows(bureau1)).toEqual([]);
  });
  it('bureaus.owner_user_id with no bureau_users row is the owner, not locked out', async () => {
    expect(await getBureauRole(rowlessOwner, bureau3)).toBe('owner');
    expect(await setBureauSharingSetting({ bureauId: bureau3, actorUserId: rowlessOwner, value: true }))
      .toMatchObject({ kind: 'ok', changed: true });
    expect(await getBureauRole(owner, bureau3)).toBeNull();
    expect(await getBureauRole(accountant, bureau1)).toBe('accountant');
    expect(await getBureauRole(owner, bureau1)).toBe('owner');
  });
  it('the owner of another bureau is refused here', async () => {
    expect(await setBureauSharingSetting({ bureauId: bureau1, actorUserId: owner2, value: true })).toEqual({ kind: 'forbidden' });
  });

  it('the owner switches it on: one audit row, who and old -> new; repeating it writes nothing', async () => {
    expect(await setBureauSharingSetting({ bureauId: bureau1, actorUserId: owner, value: true }))
      .toEqual({ kind: 'ok', changed: true, oldValue: false, newValue: true });
    expect(await setBureauSharingSetting({ bureauId: bureau1, actorUserId: owner, value: true }))
      .toMatchObject({ kind: 'ok', changed: false });
    expect(await auditRows(bureau1)).toEqual([{ actor_user_id: owner, old_value: false, new_value: true }]);
  });
  it('the history names each change by its row id and its actor', async () => {
    const setting = await getBureauSharingSetting(bureau1);
    expect(setting!.history).toHaveLength(1);
    expect(setting!.history[0]).toMatchObject({ actorUserId: owner, actorName: `${owner}@test.local`, newValue: true });
    expect(setting!.history[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('bureau_audit_log: deny-all to app_user', () => {
  it('app_user cannot read it', async () => {
    await expect(asUser(owner, co.id, (c) => c.query('SELECT 1 FROM bureau_audit_log LIMIT 1'))).rejects.toMatchObject({ code: '42501' });
  });
  it('app_user cannot write it', async () => {
    await expect(asUser(owner, co.id, (c) => c.query(
      `INSERT INTO bureau_audit_log (bureau_id, actor_user_id, action, setting, new_value)
       VALUES ($1, $2, 'setting_changed', 'share_merchant_patterns', 'true')`, [bureau1, owner]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('bureau_audit_log: append-only for every role', () => {
  it('UPDATE, DELETE and TRUNCATE are refused, even for the owner role', async () => {
    await expect(pool.query("UPDATE bureau_audit_log SET new_value = 'false' WHERE bureau_id = $1", [bureau1])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM bureau_audit_log WHERE bureau_id = $1', [bureau1])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('TRUNCATE bureau_audit_log')).rejects.toMatchObject({ code: '42501' });
    expect(await auditRows(bureau1)).toHaveLength(1);
  });

  it('the consent record outlives a deleted bureau, and still cannot be deleted', async () => {
    const temp = crypto.randomUUID();
    await pool.query('INSERT INTO bureaus (id, name, owner_user_id) VALUES ($1, $2, $3)', [temp, '904 temp', owner]);
    await pool.query("INSERT INTO bureau_users (bureau_id, user_id, role) VALUES ($1, $2, 'owner')", [temp, owner]);
    await setBureauSharingSetting({ bureauId: temp, actorUserId: owner, value: true });
    await pool.query('DELETE FROM bureaus WHERE id = $1', [temp]);
    expect(await auditRows(temp)).toEqual([{ actor_user_id: owner, old_value: false, new_value: true }]);
    await expect(pool.query('DELETE FROM bureau_audit_log WHERE bureau_id = $1', [temp])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('pool eligibility (decision 3)', () => {
  it('a company with no bureau is never eligible', async () => {
    expect(await loadCompanyPoolEligibility(solo.id)).toBe(false);
    expect(await listPoolEligibleCompanyIds()).not.toContain(solo.id);
  });

  it('two bureaus, one opted out: not eligible; both opted in: eligible', async () => {
    // bureau1 is on (above), bureau2 still off.
    expect(await loadCompanyPoolEligibility(shared.id)).toBe(false);
    expect(await listPoolEligibleCompanyIds()).not.toContain(shared.id);
    expect(await loadCompanyPoolEligibility(co.id)).toBe(true); // only in bureau1
    expect(await listPoolEligibleCompanyIds()).toContain(co.id);

    await setBureauSharingSetting({ bureauId: bureau2, actorUserId: owner2, value: true });
    expect(await loadCompanyPoolEligibility(shared.id)).toBe(true);
    expect(await listPoolEligibleCompanyIds()).toContain(shared.id);
  });
});

describe('the legal-review gate off (MERCHANT_SHARING_ENABLED unset)', () => {
  it('the owner cannot switch it on; nothing is written', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    const fresh = crypto.randomUUID();
    await pool.query('INSERT INTO bureaus (id, name, owner_user_id) VALUES ($1, $2, $3)', [fresh, '904 gated', owner]);
    try {
      expect(await setBureauSharingSetting({ bureauId: fresh, actorUserId: owner, value: true })).toEqual({ kind: 'pending_legal_review' });
      expect(await auditRows(fresh)).toEqual([]);
      const r = await pool.query<{ share_merchant_patterns: boolean }>('SELECT share_merchant_patterns FROM bureaus WHERE id = $1', [fresh]);
      expect(r.rows[0]!.share_merchant_patterns).toBe(false);
    } finally {
      await pool.query('DELETE FROM bureaus WHERE id = $1', [fresh]);
    }
  });

  it('bureaus stored as on pool nothing, and the owner can still switch off', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    // bureau1 and bureau2 are on (above).
    expect(await loadCompanyPoolEligibility(co.id)).toBe(false);
    expect(await loadCompanyPoolEligibility(shared.id)).toBe(false);
    expect(await listPoolEligibleCompanyIds()).toEqual([]);
    expect(await setBureauSharingSetting({ bureauId: bureau2, actorUserId: owner2, value: false }))
      .toEqual({ kind: 'ok', changed: true, oldValue: true, newValue: false });
  });
});
