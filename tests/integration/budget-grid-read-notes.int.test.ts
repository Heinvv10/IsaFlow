/**
 * The grid read model's budget notes (PR-D review M1): each account carries `note`, its
 * `accounting_budgets.notes` for the version's financial year (one header per company, account and
 * year, shared by every version of the year); blank, another year's and another tenant's notes are
 * left out, through the route under RLS and through the service on a superuser connection. Read-only:
 * nothing here writes a note through the app. The world is helpers/budgetGridReadWorld.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { GridCo } from './helpers/budgetGridFixture';
import { budgetGridReadWorld, data } from './helpers/budgetGridReadWorld';

assertDisposable();
const { pool, get, direct, w } = budgetGridReadWorld();
let A: GridCo, B: GridCo;
let primary: string, draftScenario: string;
// Runs after the world's own beforeAll (registered first).
beforeAll(() => { ({ A, B, primary, draftScenario } = w); });

describe('budget-grid read model: notes (accounting_budgets.notes, read-only)', () => {
  const note = (c: GridCo, acct: string, fy: number, text: string) => pool.query(
    `INSERT INTO accounting_budgets (company_id, gl_account_id, fiscal_year, budget_name, notes) VALUES ($1, $2, $3, $4, $5)`,
    [c.id, acct, fy, `FY${fy} Budget`, text]);
  const notes = (m: GridReadModel) => Object.fromEntries(m.accounts.filter((x) => x.note !== null).map((x) => [x.id, x.note]));

  beforeAll(async () => {
    await note(A, A.acct.rent, 2027, 'Lease renewal from March');
    await note(A, A.acct.header, 2027, 'Premises: rates and cleaning together');
    await note(A, A.acct.cos, 2027, '   '); // blank: no note
    await note(A, A.acct.childA, 2026, 'Last year only'); // another year
    await note(B, A.acct.sales, 2027, 'Another company'); // another tenant's row, on A's account id
  });

  it("each account carries its note for the version's year: lines and headers; never a blank, another year's or another tenant's", async () => {
    const want = { [A.acct.rent]: 'Lease renewal from March', [A.acct.header]: 'Premises: rates and cleaning together' };
    expect(notes(data<GridReadModel>(await get(A, { version_id: primary })))).toEqual(want);
    // On a superuser connection only the query's own company_id keeps B's row out.
    expect(notes(await direct(A, { versionId: primary }))).toEqual(want);
  });

  it('every version of the year shows the same note (the header is per account and year)', async () => {
    const m = data<GridReadModel>(await get(A, { version_id: draftScenario }));
    expect(m.accounts.find((x) => x.id === A.acct.rent)?.note).toBe('Lease renewal from March');
    expect(m.accounts.find((x) => x.id === A.acct.childA)?.note).toBeNull();
  });
});
