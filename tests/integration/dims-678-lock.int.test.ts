/**
 * #678 review M1: every write path to the CC1 / CC2 / BU masters takes the
 * company's dimension-master lock before its first read. While one request
 * holds it, each of them waits; another company's writes do not.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { lockDimensionMasters } from '@/modules/accounting/services/core/dimensionMasterLock';
import { deleteCostCentre } from '@/modules/accounting/services/core/costCentreService';
import {
  deleteBusinessUnit, planCreateBusinessUnit, planDeleteBusinessUnit, planUpdateBusinessUnit,
} from '@/modules/accounting/services/core/businessUnitService';
import { planCreateDimensionCostCentre } from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import { planDeleteDimensionCostCentre, planUpdateDimensionCostCentre } from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { businessUnit, costCentre, dropBase, inCompanyTx, seedBase } from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
let cc = '';
let bu = '';

beforeAll(async () => {
  await seedBase(pool, company, user);
  await seedBase(pool, other, user);
  cc = await costCentre(pool, company, 'LK-CC');
  bu = await businessUnit(pool, company, 'LK-BU');
}, 60000);
afterAll(async () => {
  try { await dropBase(pool, [company, other], [user]); } finally { await pool.end(); }
}, 60000);

const advisoryWaiters = async () => Number((await pool.query(
  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'")).rows[0].n);

const PATHS: [string, () => Promise<unknown>][] = [
  ['planCreateDimensionCostCentre', () => planCreateDimensionCostCentre(company, { code: 'LK-NEW', name: 'n', ccType: 'cc1' })],
  ['planUpdateDimensionCostCentre', () => planUpdateDimensionCostCentre(company, cc, { name: 'n' })],
  ['planDeleteDimensionCostCentre', () => planDeleteDimensionCostCentre(company, cc)],
  ['deleteCostCentre', () => deleteCostCentre(company, crypto.randomUUID()).catch(() => undefined)],
  ['planCreateBusinessUnit', () => planCreateBusinessUnit(company, { code: 'LK-NEW', name: 'n' })],
  ['planUpdateBusinessUnit', () => planUpdateBusinessUnit(company, bu, { name: 'n' })],
  ['planDeleteBusinessUnit', () => planDeleteBusinessUnit(company, bu)],
  ['deleteBusinessUnit', () => deleteBusinessUnit(company, crypto.randomUUID()).catch(() => undefined)],
];

it.each(PATHS)('%s waits while another request holds the company lock', async (_name, path) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const holder = inCompanyTx(pool, company, user, async () => { await lockDimensionMasters(company); await gate; });
  let done = false;
  let waiting = 0;
  let waiter: Promise<void> = Promise.resolve();
  try {
    await new Promise((r) => setTimeout(r, 200));
    waiter = inCompanyTx(pool, company, user, path).then(() => { done = true; });
    for (let i = 0; i < 20 && waiting === 0 && !done; i++) {
      waiting = await advisoryWaiters();
      if (!waiting) await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    release(); // never leave the holder open for the next row
    await holder;
    await waiter;
  }
  expect(waiting).toBe(1);
  expect(done).toBe(true);
});

it('another company\'s lock does not hold this company up', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const holder = inCompanyTx(pool, other, user, async () => { await lockDimensionMasters(other); await gate; });
  await new Promise((r) => setTimeout(r, 200));
  await inCompanyTx(pool, company, user, () => planUpdateDimensionCostCentre(company, cc, { name: 'n' }));
  release();
  await holder;
});

it('refuses outside a request transaction, where the lock would be released at once', async () => {
  await expect(lockDimensionMasters(company)).rejects.toThrow(/requires a request transaction/);
});
