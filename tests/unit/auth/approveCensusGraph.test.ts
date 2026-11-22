/**
 * The approve / post census's analyser (tests/unit/helpers/approveCensusGraph.ts) on synthetic projects: it must flag what a
 * per-file regex let through (a helper chain, one gated action of several, a gate after the call), what a looser analyser let
 * through (a CONDITIONAL refusal, a dropped gate result, a gate for the wrong module), and stay quiet on a gated route.
 * The census over the real tree is approvePostEntryCensus.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { analyse } from '../helpers/approveCensusGraph';
import type { GateSpec } from '../helpers/approveCensusGraph';

const SERVICE = `export async function postJournalEntry(c: string, id: string) { return id; }
export async function reverseJournalEntry(c: string, id: string, o?: { dryRun?: boolean; allowReversal?: boolean }) { return id; }
export async function postPayrollRun(c: string, id: string) { return id; }
export async function refuseWithoutApprove(res: unknown, c: string, u: string, m: string, w: string) { return false; }
export async function mayApprove(c: string, u: string, m: string) { return true; }
export async function assertMayApprove(c: string, u: string, m: string, w: string) { return; }
export async function postVia(c: string, id: string) { return postJournalEntry(c, id); }
export async function postViaGated(res: unknown, c: string, id: string) {
  if (await refuseWithoutApprove(res, c, 'u', 'accounts', 'x')) return null;
  return postJournalEntry(c, id);
}
export async function postsSql(c: string) { return sql\`UPDATE gl_journal_entries SET status = 'posted' WHERE company_id = \${c}\`; }
declare function sql(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
`;
const GATES: Record<string, GateSpec> = {
  refuseWithoutApprove: { kind: 'refuse', moduleArg: 3 },
  mayApprove: { kind: 'allow', moduleArg: 2 },
  assertMayApprove: { kind: 'assert', moduleArg: 2 },
};

function runFull(route: string, extra: Record<string, string> = {}) {
  const files = { '/v/svc.ts': SERVICE, '/v/barrel.ts': "export { postVia as renamedPost } from './svc';", '/v/route.ts': route, ...extra };
  return analyse({
    virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/v/route.ts'],
    sinks: { postJournalEntry: 'accounts', reverseJournalEntry: 'accounts', postPayrollRun: 'payroll' }, gates: GATES,
    routeWrappers: { withPayrollModule: 'payroll' }, sqlPrimitives: [/UPDATE\s+gl_journal_entries[^;]*status\s*=\s*'posted'/i],
  });
}
const run = (route: string, extra: Record<string, string> = {}) => runFull(route, extra).bad;
const HEAD = "import { postJournalEntry, reverseJournalEntry, postPayrollRun, refuseWithoutApprove, mayApprove, assertMayApprove, postVia, postViaGated, postsSql } from './svc';\nimport { renamedPost } from './barrel';\ndeclare function withPayrollModule<T>(h: T): T;\ndeclare const res: unknown;\n";
const GATE = "if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) return;";
const h = (body: string, exp = 'export default handler;') => `${HEAD}async function handler(x: boolean, action: string) { ${body} }\n${exp}`;

describe('approve census analyser: dominance', () => {
  it('flags an ungated direct call, and passes it once a refusing gate precedes it', () => {
    expect(run(h("await postJournalEntry('c', 'i');"))).toHaveLength(1);
    expect(run(h(`${GATE} await postJournalEntry('c', 'i');`))).toEqual([]);
  });

  it('flags a gate that only follows the call, or sits in an unrelated if body', () => {
    expect(run(h("await postJournalEntry('c', 'i'); await assertMayApprove('c', 'u', 'accounts', 'x');"))).toHaveLength(1);
    expect(run(h(`if (x) { ${GATE} } await postJournalEntry('c', 'i');`))).toHaveLength(1);
  });

  it('judges each action branch: a gate on one case does not cover a sibling', () => {
    const route = (gateReverse: boolean) => h(`switch (action) {
      case 'post': { ${GATE} await postJournalEntry('c', 'i'); break; }
      case 'reverse': { ${gateReverse ? GATE : ''} await reverseJournalEntry('c', 'i'); break; }
    }`);
    const bad = run(route(false));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.sites.join()).toContain('reverseJournalEntry');
    expect(run(route(true))).toEqual([]);
  });

  it('follows a helper chain, through an aliased barrel re-export, and a unit that runs posting SQL', () => {
    expect(run(h("await postVia('c', 'i');"))).toHaveLength(1);
    expect(run(h("await renamedPost('c', 'i');"))).toHaveLength(1);
    expect(run(`${HEAD}async function helper() { await postVia('c', 'i'); }\nasync function handler() { await helper(); }\nexport default handler;`)).toHaveLength(1);
    expect(run(h("await postsSql('c');"))).toHaveLength(1); // not named anywhere: found by its SQL
  });

  it('a helper that asks the Approve itself, or a gate before the helper call, passes', () => {
    expect(run(h("await postViaGated(res, 'c', 'i');"))).toEqual([]);
    expect(run(`${HEAD}async function helper() { await postVia('c', 'i'); }\nasync function handler() { ${GATE} await helper(); }\nexport default handler;`)).toEqual([]);
  });

  it('a route wrapped by withPayrollModule is gated for Payroll for the whole file; a dry run and a non-literal allowReversal are not writes', () => {
    expect(run(h("await postPayrollRun('c', 'i');", 'export default withPayrollModule(handler);'))).toEqual([]);
    expect(run(h("await postJournalEntry('c', 'i');", 'export default withPayrollModule(handler);'))).toHaveLength(1); // the wrapper is Payroll, the sink is accounts
    expect(run(h("await reverseJournalEntry('c', 'i', { dryRun: true });"))).toEqual([]);
    expect(run(h("const allowReversal = await mayApprove('c', 'u', 'accounts'); await reverseJournalEntry('c', 'i', { allowReversal });"))).toEqual([]);
    expect(run(h("await reverseJournalEntry('c', 'i', { allowReversal: true });"))).toHaveLength(1); // the literal true is no decision
  });
});

describe('approve census analyser: round 4 (B-M2 / F-M1)', () => {
  it('FALSE NEGATIVE 1: `if (x && await gate()) return;` is a conditional refusal and does not dominate a call reachable when x is false', () => {
    expect(run(h("if (x && await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) return; await postJournalEntry('c', 'i');"))).toHaveLength(1);
    expect(run(h("if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x') || x) return; await postJournalEntry('c', 'i');"))).toEqual([]); // || short-circuits only after the gate
  });

  it('FALSE NEGATIVE 2: a bare `await mayApprove()` whose result is dropped is no gate; an assert, and a used result, are', () => {
    expect(run(h("await mayApprove('c', 'u', 'accounts'); await postJournalEntry('c', 'i');"))).toHaveLength(1);
    expect(run(h("await assertMayApprove('c', 'u', 'accounts', 'x'); await postJournalEntry('c', 'i');"))).toEqual([]);
    expect(run(h("if (!(await mayApprove('c', 'u', 'accounts'))) return; await postJournalEntry('c', 'i');"))).toEqual([]);
    expect(run(h("const ok = await mayApprove('c', 'u', 'accounts'); if (!ok) throw new Error('no'); await postJournalEntry('c', 'i');"))).toEqual([]);
  });

  it('a gate whose refusal does NOT exit does not dominate', () => {
    expect(run(h("if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) { console.warn('refused'); } await postJournalEntry('c', 'i');"))).toHaveLength(1);
  });

  it('the call inside the gate\'s own positive branch is covered (`if (a && await mayApprove()) { call }`)', () => {
    expect(run(h("if (x && await mayApprove('c', 'u', 'accounts')) { await postJournalEntry('c', 'i'); }"))).toEqual([]);
    expect(run(h("const posted = x && await mayApprove('c', 'u', 'accounts'); if (posted) { await postJournalEntry('c', 'i'); }"))).toEqual([]);
    expect(run(h("if (x || await mayApprove('c', 'u', 'accounts')) { await postJournalEntry('c', 'i'); }"))).toHaveLength(1);
  });

  it('FALSE NEGATIVE 3: a gate for the WRONG module does not cover the sink', () => {
    expect(run(h("if (await refuseWithoutApprove(res, 'c', 'u', 'banking', 'x')) return; await postJournalEntry('c', 'i');"))).toHaveLength(1);
    expect(run(h("if (await refuseWithoutApprove(res, 'c', 'u', 'payroll', 'x')) return; await postPayrollRun('c', 'i');"))).toEqual([]);
    expect(run(h("if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) return; await postPayrollRun('c', 'i');"))).toHaveLength(1);
  });

  it('a call with two modules needs both gates', () => {
    const body = (g1: boolean, g2: boolean) => `${g1 ? "if (await refuseWithoutApprove(res, 'c', 'u', 'accounts', 'x')) return;" : ''} ${g2 ? "if (await refuseWithoutApprove(res, 'c', 'u', 'payroll', 'x')) return;" : ''} await postJournalEntry('c', 'i'); await postPayrollRun('c', 'i');`;
    expect(run(h(body(true, false)))).toHaveLength(1);
    expect(run(h(body(false, true)))).toHaveLength(1);
    expect(run(h(body(true, true)))).toEqual([]);
  });
});

describe('approve census analyser: round 6', () => {
  it('allowReversal counts only when its value is a GATE RESULT (a gate call, or a variable set from one, shorthand included)', () => {
    expect(run(h("const allowReversal = await mayApprove('c', 'u', 'accounts'); await reverseJournalEntry('c', 'i', { allowReversal });"))).toEqual([]);
    expect(run(h("await reverseJournalEntry('c', 'i', { allowReversal: await mayApprove('c', 'u', 'accounts') });"))).toEqual([]);
    expect(run(h("const allowReversal = x; await reverseJournalEntry('c', 'i', { allowReversal });"))).toHaveLength(1);
    expect(run(h("await reverseJournalEntry('c', 'i', { allowReversal: x });"))).toHaveLength(1);
    expect(run(h("await reverseJournalEntry('c', 'i', { allowReversal: false });"))).toHaveLength(1);
  });

  it('a census-exempt marker exempts ONE call site, not every call of the callee; a second ungated call fails', () => {
    const marked = "\n    // census-exempt(postJournalEntry, posting): approve asks first elsewhere\n    await postJournalEntry('c', 'i');";
    expect(run(h(marked))).toEqual([]);
    const bad = run(h(`${marked}\n    if (x) { await postJournalEntry('c', 'j'); }`));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.sites).toHaveLength(1);
  });

  it('a marker on the wrong callee exempts nothing', () => {
    expect(run(h("\n    // census-exempt(reverseJournalEntry, posting): wrong one\n    await postJournalEntry('c', 'i');"))).toHaveLength(1);
  });

  it('a marker is USED only while its call would otherwise be uncovered: once the call is gated, the marker is stale', () => {
    const used = runFull(h("\n    // census-exempt(postJournalEntry, posting): why\n    await postJournalEntry('c', 'i');"));
    expect(used.markersUsed).toHaveLength(1);
    expect(used.staleMarkers).toEqual([]);
    const stale = runFull(h(`\n    // census-exempt(postJournalEntry, posting): why\n    ${GATE} await postJournalEntry('c', 'i');`));
    expect(stale.markersUsed).toEqual([]);
    expect(stale.staleMarkers).toHaveLength(1);
  });
});

describe('approve census analyser: the payroll-read mode', () => {
  const SVC = `declare function sql(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
export async function readPay(c: string) { return sql\`SELECT gross FROM payslips WHERE company_id = \${c}\`; }
export async function viaReadPay(c: string) { return readPay(c); }
export async function refuseWithoutPayrollRead(res: unknown, c: string, u: string) { return false; }
`;
  const payrollFull = (route: string) => {
    const files = { '/v/svc.ts': SVC, '/v/route.ts': route };
    return analyse({
      virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/v/route.ts'], sinks: {},
      gates: { refuseWithoutPayrollRead: { kind: 'refuse', module: 'payroll' } }, routeWrappers: { withPayrollDetailAccess: 'payroll' },
      sqlPrimitives: [/FROM\s+payslips/i], flagPrimitiveRoots: true,
    });
  };
  const payroll = (route: string) => payrollFull(route).bad;
  const H = "import { readPay, viaReadPay, refuseWithoutPayrollRead } from './svc';\ndeclare function sql(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;\ndeclare function withPayrollDetailAccess<T>(h: T): T;\ndeclare const res: unknown;\ndeclare const x: boolean;\n";
  const READ = "if (await refuseWithoutPayrollRead(res, 'c', 'u')) return;";

  it('a call to a function that reads the payroll table needs Payroll read, through any number of helpers (round 7: multi-hop)', () => {
    expect(payroll(`${H}async function handler() { await readPay('c'); }\nexport default handler;`)).toHaveLength(1);
    expect(payroll(`${H}async function handler() { ${READ} await readPay('c'); }\nexport default handler;`)).toEqual([]);
    expect(payroll(`${H}async function handler() { await viaReadPay('c'); }\nexport default handler;`)).toHaveLength(1);
    expect(payroll(`${H}async function handler() { ${READ} await viaReadPay('c'); }\nexport default handler;`)).toEqual([]);
    expect(payroll(`${H}async function handler() { await readPay('c'); }\nexport default withPayrollDetailAccess(handler);`)).toEqual([]);
  });

  it('a handler that runs the SQL itself is flagged unless wrapped, gated BEFORE it, or marked census-exempt(sql)', () => {
    const sqlRoute = (extra: string, exp = 'export default handler;') => `${H}async function handler() { ${extra} await sql\`SELECT gross FROM payslips\`; }\n${exp}`;
    expect(payroll(sqlRoute(''))).toHaveLength(1);
    expect(payroll(sqlRoute(READ))).toEqual([]);
    expect(payroll(sqlRoute('', 'export default withPayrollDetailAccess(handler);'))).toEqual([]);
    expect(payroll(sqlRoute("\n// census-exempt(sql, payroll-read): a monthly total, no one person's pay\n"))).toEqual([]);
    // above the function, not the statement: binds to nothing
    expect(payroll(`// census-exempt(sql, payroll-read): a monthly total, no one person's pay\n${sqlRoute('')}`)).toHaveLength(1);
  });

  // Breaker mutation 1 (round 7 M3b): the old check passed a handler that called a gate ANYWHERE, so a read the gate did not dominate went through.
  it('a gate that does not DOMINATE the read does not cover it: one after it, in a sibling if body, or on another branch', () => {
    const route = (body: string) => `${H}async function handler() { ${body} }\nexport default handler;`;
    expect(payroll(route(`await sql\`SELECT gross FROM payslips\`; ${READ}`))).toHaveLength(1);
    expect(payroll(route(`if (x) { ${READ} } await sql\`SELECT gross FROM payslips\`;`))).toHaveLength(1);
    expect(payroll(route(`${READ} await sql\`SELECT gross FROM payslips\`;`))).toEqual([]);
    expect(payroll(route(`if (x) { ${READ} await sql\`SELECT gross FROM payslips\`; } else { await sql\`SELECT gross FROM payslips\`; }`))).toHaveLength(1);
  });

  // Breaker mutation 2 (round 7 M3a): a census-exempt(sql) marker anywhere in the file exempted every primitive SQL statement in it.
  it('census-exempt(sql) exempts the statement directly below it only; a second read in the file is still flagged', () => {
    const marker = '// census-exempt(sql, payroll-read): a monthly total, no one person\'s pay';
    const route = (body: string) => `${H}async function handler() { ${body} }\nexport default handler;`;
    const one = payrollFull(route(`\n${marker}\nawait sql\`SELECT SUM(gross) FROM payslips\`;\nawait sql\`SELECT gross FROM payslips WHERE id = 1\`;`));
    expect(one.bad).toHaveLength(1);
    expect(one.bad[0]!.sites).toHaveLength(1);
    expect(one.markersUsed).toHaveLength(1);
    const both = payrollFull(route(`\n${marker}\nawait sql\`SELECT SUM(gross) FROM payslips\`;\n${marker}\nawait sql\`SELECT COUNT(*) FROM payslips\`;`));
    expect(both.bad).toEqual([]);
    expect(both.markersUsed).toHaveLength(2);
    // a marker above something that is not a payroll read is stale
    expect(payrollFull(route(`\n${marker}\nawait sql\`SELECT 1\`;`)).staleMarkers).toHaveLength(1);
  });

  it('a gated read does not use a marker above it: the marker is stale', () => {
    const marked = payrollFull(`${H}async function handler() { ${READ}\n// census-exempt(sql, payroll-read): why\nawait sql\`SELECT gross FROM payslips\`; }\nexport default handler;`);
    expect(marked.bad).toEqual([]);
    expect(marked.staleMarkers).toHaveLength(1);
  });
});

describe('approve census analyser: a marker binds to the outermost call of its statement', () => {
  it('census-exempt(<callee>) exempts the outer call, not a same-named call nested inside it', () => {
    const marker = "\n    // census-exempt(postJournalEntry, posting): approve asks first elsewhere\n";
    expect(run(h(`${marker}    await postJournalEntry('c', String(await postJournalEntry('c', 'j')));`))).toHaveLength(1);
    expect(run(h(`${marker}    await postJournalEntry('c', 'i');`))).toEqual([]);
  });
});

describe('approve census analyser: pg client calls and quoted identifiers (round 8)', () => {
  const run = (route: string, queryCalls: boolean) => analyse({
    virtualFiles: { '/v/route.ts': route }, programFiles: ['/v/route.ts'], routeFiles: ['/v/route.ts'], sinks: {}, gates: {}, routeWrappers: {},
    sqlPrimitives: [/FROM\s+"?payslips"?/i], flagPrimitiveRoots: true, queryCalls,
  }).bad;
  const route = (body: string) => `declare const client: { query(t: string, v?: unknown[]): Promise<unknown> };\nasync function handler() { ${body} }\nexport default handler;`;

  it('a client.query(\'...\') with a static string or template is a primitive read when asked (queryCalls); not otherwise', () => {
    expect(run(route("await client.query('SELECT gross FROM payslips WHERE id = $1', ['1']);"), true)).toHaveLength(1);
    expect(run(route('await client.query(`SELECT gross FROM payslips`);'), true)).toHaveLength(1);
    expect(run(route("await client.query('SELECT gross FROM payslips');"), false)).toEqual([]);
    expect(run(route("await client.query('SELECT 1 FROM customers');"), true)).toEqual([]);
  });

  it('a census-exempt(sql) marker binds to the one query call, like a tagged template', () => {
    const marker = "\n// census-exempt(sql, payroll-read): a total\n";
    expect(run(route(`${marker}await client.query('SELECT sum(gross) FROM payslips');`), true)).toEqual([]);
    expect(run(route(`${marker}await client.query('SELECT sum(gross) FROM payslips');\nawait client.query('SELECT gross FROM payslips');`), true)).toHaveLength(1);
  });

  it('a quoted table name is read as the table', () => {
    expect(run(route("await client.query('SELECT gross FROM \"payslips\"');"), true)).toHaveLength(1);
  });
});
