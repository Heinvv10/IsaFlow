// applyPlan, paginate and the legacy scan against a stateful fake of isaflow_dev and GoTrue: what is written, in what order, what is refused.
import { describe, expect, it } from 'vitest';
import { fakes, newWorld } from '../../helpers/slotEmailWorld';
import { applyPlan, findUnknownLegacy, paginate, readAccountState } from '../../../scripts/ci/golden/slotEmailApply';
import { knownAccounts, planAccount } from '../../../scripts/ci/golden/slotEmailPlan';

describe('applyPlan', () => {
  it('updates users and companies, then GoTrue, then commits; the id never changes', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    await applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)));
    expect(w.log).toEqual(['BEGIN', 'UPDATE users', 'UPDATE companies', 'GOTRUE', 'COMMIT']);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    expect(w.users.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    // Only the slot company moved: a company outside the slot id pattern that carries the address is not ours to rewrite.
    expect(w.companies.map((c) => c.email)).toEqual(['golden-slot-1@isaflow.co.za', 'golden-slot-2@isaflow.dev', 'golden-slot-1@isaflow.dev', 'golden-slot-3@isaflow.dev']);
  });

  it('rolls the database back when GoTrue fails, and a re-run then migrates', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    w.failGoTrue = true;
    await expect(applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)))).rejects.toThrow(/gotrue down/);
    expect(w.log).toContain('ROLLBACK');
    expect(w.users.get('g1')).toBe('golden-slot-1@isaflow.dev');
    expect(w.companies[0]!.email).toBe('golden-slot-1@isaflow.dev');
    w.failGoTrue = false;
    await applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)));
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
  });

  it('heals a COMMIT that failed after GoTrue changed: only the database steps remain', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    w.failCommit = true;
    await expect(applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)))).rejects.toThrow(/commit failed/);
    w.failCommit = false;
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    const again = planAccount(a, await readAccountState(db, gt, a));
    expect(again.steps).toEqual(['users-email', 'companies-email']);
    await applyPlan(db, gt, again);
    expect(planAccount(a, await readAccountState(db, gt, a)).action).toBe('noop');
  });

  it('writes nothing for a no-op or a conflict plan', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    await applyPlan(db, gt, planAccount(a, { gotrueOld: null, gotrueNew: 'g1', usersOld: [], usersNew: ['g1'], companiesOld: 0 }));
    await applyPlan(db, gt, planAccount(a, { gotrueOld: 'g1', gotrueNew: 'g9', usersOld: [], usersNew: [], companiesOld: 0 }));
    expect(w.log).toEqual([]);
  });
});

describe('applyPlan: the users row', () => {
  it.each([0, 2])('rolls back and refuses when UPDATE users touches %i rows (exactly one is expected)', async (rowCount) => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    const plan = planAccount(a, await readAccountState(db, gt, a));
    w.usersUpdateRows = rowCount;
    await expect(applyPlan(db, gt, plan)).rejects.toThrow(/exactly one|1 row/);
    expect(w.log).toContain('ROLLBACK');
    expect(w.log).not.toContain('GOTRUE');
    expect(w.users.get('g1')).toBe('golden-slot-1@isaflow.dev');
  });
});

describe('paginate', () => {
  it('reads to the first empty page, so a server that caps per_page below the ask loses nothing', async () => {
    const pages = [[1, 2], [3, 4], [5], []];
    const asked: number[] = [];
    expect(await paginate(async (n) => { asked.push(n); return pages[n - 1] ?? []; }, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([1, 2, 3, 4]);
  });

  it('throws at the page cap instead of returning a truncated list', async () => {
    await expect(paginate(async () => [1], 3)).rejects.toThrow(/more than 3 pages/);
  });
});

describe('findUnknownLegacy', () => {
  it('lists old-domain addresses no code knows, in GoTrue and in users, and leaves known ones out', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    expect(await findUnknownLegacy(db, gt, knownAccounts())).toEqual({ gotrue: ['stranger@isaflow.dev'], users: ['orphan@isaflow.dev'] });
  });
});

