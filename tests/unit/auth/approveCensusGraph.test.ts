/**
 * The approve / post census's analyser (tests/unit/helpers/approveCensusGraph.ts) on synthetic projects: it must flag
 * what the old per-file regex let through (a helper chain, one gated action of several, a gate after the call) and stay
 * quiet on a gated route. The census over the real tree is approvePostEntryCensus.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { analyse } from '../helpers/approveCensusGraph';

const SERVICE = `export async function postJournalEntry(c: string, id: string) { return id; }
export async function reverseJournalEntry(c: string, id: string, o?: { dryRun?: boolean }) { return id; }
export async function refuseWithoutApprove(res: unknown, c: string, u: string, m: string, w: string) { return false; }
export async function postVia(c: string, id: string) { return postJournalEntry(c, id); }
export async function postViaGated(res: unknown, c: string, id: string) {
  if (await refuseWithoutApprove(res, c, 'u', 'accounts', 'x')) return null;
  return postJournalEntry(c, id);
}
`;

function run(route: string, extra: Record<string, string> = {}) {
  const files = { '/v/svc.ts': SERVICE, '/v/barrel.ts': "export { postVia as renamedPost } from './svc';", '/v/route.ts': route, ...extra };
  return analyse({
    virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/v/route.ts'],
    sinks: ['postJournalEntry', 'reverseJournalEntry'], gates: new Set(['refuseWithoutApprove']), routeWrappers: ['withPayrollModule'],
  }).bad;
}
const HEAD = "import { postJournalEntry, reverseJournalEntry, refuseWithoutApprove, postVia, postViaGated } from './svc';\nimport { renamedPost } from './barrel';\ndeclare function withPayrollModule<T>(h: T): T;\ndeclare const res: unknown;\n";

describe('approve census analyser', () => {
  it('flags an ungated direct call, and passes it once a gate precedes it', () => {
    expect(run(`${HEAD}async function handler() { await postJournalEntry('c', 'i'); }\nexport default handler;`)).toHaveLength(1);
    expect(run(`${HEAD}async function handler() { if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) return; await postJournalEntry('c', 'i'); }\nexport default handler;`)).toEqual([]);
  });

  it('flags a gate that only follows the call, or sits in an unrelated if body', () => {
    expect(run(`${HEAD}async function handler() { await postJournalEntry('c', 'i'); await refuseWithoutApprove(res, 'c', 'u', 'a', 'x'); }\nexport default handler;`)).toHaveLength(1);
    expect(run(`${HEAD}async function handler(x: boolean) { if (x) { await refuseWithoutApprove(res, 'c', 'u', 'a', 'x'); } await postJournalEntry('c', 'i'); }\nexport default handler;`)).toHaveLength(1);
  });

  it('judges each action branch: a gate on one case does not cover a sibling', () => {
    const route = (gateReverse: boolean) => `${HEAD}async function handler(action: string) {
  switch (action) {
    case 'post': { if (await refuseWithoutApprove(res, 'c', 'u', 'a', 'x')) return; await postJournalEntry('c', 'i'); break; }
    case 'reverse': { ${gateReverse ? "if (await refuseWithoutApprove(res, 'c', 'u', 'a', 'x')) return;" : ''} await reverseJournalEntry('c', 'i'); break; }
  }
}
export default handler;`;
    const bad = run(route(false));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.sites.join()).toContain('reverseJournalEntry');
    expect(run(route(true))).toEqual([]);
  });

  it('follows a helper chain, through an aliased barrel re-export', () => {
    expect(run(`${HEAD}async function handler() { await postVia('c', 'i'); }\nexport default handler;`)).toHaveLength(1);
    expect(run(`${HEAD}async function handler() { await renamedPost('c', 'i'); }\nexport default handler;`)).toHaveLength(1);
    expect(run(`${HEAD}async function helper() { await postVia('c', 'i'); }\nasync function handler() { await helper(); }\nexport default handler;`)).toHaveLength(1);
  });

  it('a helper that asks the Approve itself, or a gate before the helper call, passes', () => {
    expect(run(`${HEAD}async function handler() { await postViaGated(res, 'c', 'i'); }\nexport default handler;`)).toEqual([]);
    expect(run(`${HEAD}async function helper() { await postVia('c', 'i'); }\nasync function handler() { if (await refuseWithoutApprove(res, 'c', 'u', 'a', 'x')) return; await helper(); }\nexport default handler;`)).toEqual([]);
  });

  it('a route wrapped by withPayrollModule is gated for the whole file; a dry run is not a write', () => {
    expect(run(`${HEAD}async function handler() { await postJournalEntry('c', 'i'); }\nexport default withPayrollModule(handler);`)).toEqual([]);
    expect(run(`${HEAD}async function handler() { await reverseJournalEntry('c', 'i', { dryRun: true }); }\nexport default handler;`)).toEqual([]);
  });

  it('a gate in a condition covers the call in its branch, and in the right side of &&', () => {
    expect(run(`${HEAD}async function handler(x: boolean) { if (x && await refuseWithoutApprove(res, 'c', 'u', 'a', 'x')) return; await postJournalEntry('c', 'i'); }\nexport default handler;`)).toEqual([]);
    expect(run(`${HEAD}async function handler(x: boolean) { x && await refuseWithoutApprove(res, 'c', 'u', 'a', 'x') && await postJournalEntry('c', 'i'); }\nexport default handler;`)).toEqual([]);
  });
});
