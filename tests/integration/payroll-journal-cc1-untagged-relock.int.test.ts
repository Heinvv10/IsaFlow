/**
 * The mirror of d416d6de6's fail-closed rule (review of #1065, on #1079): a
 * company with NO cost centres posts untagged labour, and its plan is untagged
 * too — so a reopened run, recalculated with nothing changed, still re-locks
 * onto its journal through the gate; nothing about CC1 can have moved. Only a
 * plan that now TAGS labour fails closed against an untagged journal.
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => {
  r = await rig('cc1untagged'); await r.setup();
  await r.employee(20000);
  await r.employee(15000); // two employees, no centres, no mappings
});
afterAll(async () => { await r.teardown(); });

describe('an untagged journal and an untagged plan', () => {
  it('a recalculated, unchanged run re-locks onto its journal', async () => {
    const id = await r.calculatedRun(4);
    const approved = await r.api.approve(id);
    expect(approved.statusCode).toBe(200);
    const journal = String(approved.body.data!.journalEntryId);
    expect((await r.pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE journal_entry_id = $1 AND cc1_id IS NOT NULL', [journal])).rows[0]!.n).toBe(0);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toBeNull();
    expect((p.body.data!.plan.lines as Array<{ cc1Id: string | null }>).every((l) => l.cc1Id === null)).toBe(true);
    const again = await r.api.approve(id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ journalEntryId: journal });
  });
});
