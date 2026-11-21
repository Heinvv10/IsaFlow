/**
 * The posting census's rules (approveCensusConfig POSTING_RULES) on small virtual projects: each #1670 hardening must FIND what it was
 * added for. Split out of approvePostEntryCensus.test.ts (r12): that file builds the real tree's program twice, and with ~100 fixture
 * programs on top a CI worker ran out of heap; here each runs in its own worker.
 */
import { describe, expect, it } from 'vitest';
import { analyse } from '../helpers/approveCensusGraph';
import { PAYROLL_READ_WRAPPERS, POSTING_RULES } from '../helpers/approveCensusConfig';

/** A one-route virtual project under the posting census's own rules (the #1670 fixtures). */
function fixture(route: string) {
  const files: Record<string, string> = {
    '/fx/lib.ts': `export declare function sql(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
export declare const client: { query: (text: string, values?: unknown[]) => Promise<unknown> };
export declare function refuseWithoutApprove(res: unknown, c: string, u: string, m: string, w: string): Promise<boolean>;
export declare function returnApproveModule(form: string): 'vat' | 'payroll' | null;
export async function fileIt(id: string) { await client.query("UPDATE tax_return_versions SET status = 'filed' WHERE id = $1", [id]); }
export async function flipBill(id: string) { await client.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [id]); }`,
    '/fx/route.ts': `import { sql, client, refuseWithoutApprove, flipBill, returnApproveModule, fileIt } from './lib';\ndeclare const res: unknown;
const MODULE_Q = "UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1";\n${route}\nexport default handler;`,
  };
  return analyse({ virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/fx/route.ts'], ...POSTING_RULES }).bad;
}
const gate = (module: string) => `if (await refuseWithoutApprove(res, 'c', 'u', '${module}', 'x')) return;`;
const handler = (body: string) => `async function handler(id: string) { ${body} }`;

describe('posting census fixtures (#1670)', () => {
  it('#1670 Codex: an unguarded route that posts in its own SQL, sql`` or client.query, is a finding; a gate before it passes', () => {
    const tagged = "await sql`UPDATE gl_journal_entries SET status = 'posted' WHERE id = ${id}`;";
    const query = "await client.query(`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = $1`, [id]);";
    expect(fixture(handler(tagged))).toHaveLength(1);
    expect(fixture(handler(query))).toHaveLength(1);
    expect(fixture(handler('await flipBill(id);'))).toHaveLength(1); // a helper's client.query
    expect(fixture(handler(`${gate('accounts')} ${gate('suppliers')} ${tagged} ${query} await flipBill(id);`))).toEqual([]);
  });

  it('#1670 breaker L1a/b: a status bound as a static value, or SQL text held in a const, is read in place', () => {
    for (const body of [
      "await sql`UPDATE gl_journal_entries SET status = ${'posted'} WHERE id = ${id}`;",
      "const POSTED = 'posted'; await sql`UPDATE gl_journal_entries SET status = ${POSTED} WHERE id = ${id}`;",
      "const Q = `UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`; await client.query(Q, [id]);",
      "await client.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [id, 'posted']);",
      'await client.query(MODULE_Q, [id]);', // a module-level const
    ]) expect(fixture(handler(body)), body).toHaveLength(1);
    // A status the census cannot know statically is not read as posted.
    expect(fixture(handler("await sql`UPDATE gl_journal_entries SET status = ${id} WHERE id = ${id}`;"))).toEqual([]);
  });

  it('#1670 breaker L1c: SQL needs ITS module\'s gate: a Budgets gate does not cover a bill flipped to approved, directly or in a helper', () => {
    const bill = "await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${id}`;";
    expect(fixture(handler(`${gate('budgets')} ${bill}`))).toHaveLength(1);
    expect(fixture(handler(`${gate('budgets')} await flipBill(id);`))).toHaveLength(1);
    expect(fixture(handler(`${gate('suppliers')} ${bill} await flipBill(id);`))).toEqual([]);
  });

  it.each([
    ['credit_notes', 'approved', '*'], ['supplier_payments', 'approved', 'suppliers'], ['supplier_payments', 'processed', 'suppliers'],
    ['supplier_payment_batches', 'processed', 'suppliers'], ['supplier_payment_batches', 'reversed', 'suppliers'],
    ['purchase_orders', 'approved', 'suppliers'], ['expense_claims', 'approved', 'suppliers'], ['expense_claims', 'posted', 'suppliers'],
    ['customer_payments', 'confirmed', 'customers'], ['customer_write_offs', 'approved', 'customers'],
    ['payroll_run_headers', 'approved', 'payroll'], ['payroll_batches', 'posted', 'payroll'], ['uif_declarations', 'paid', 'payroll'],
    ['vat_adjustments', 'approved', 'vat'], ['accounting_adjustments', 'approved', 'items'], ['consolidation_adjustments', 'posted', 'group'],
    ['budget_versions', 'approved', 'budgets'], ['fiscal_periods', 'closed', 'accounts'], ['tax_return_versions', 'finalised', 'returns'],
    ['tax_return_versions', 'filed', 'returns'], ['sars_submissions', 'submitted', 'returns'], ['uif_declarations', 'submitted', 'payroll'],
  ])('#1670 breaker L1d: UPDATE %s SET status = %s is a primitive needing %s Approve', (table, status, module) => {
    const flip = `await client.query(\`UPDATE ${table} SET updated_at = NOW(), status = '${status}' WHERE id = $1\`, [id]);`;
    expect(fixture(handler(flip)), 'ungated').toHaveLength(1);
    if (module !== '*') expect(fixture(handler(`${gate(module === 'budgets' ? 'vat' : 'budgets')} ${flip}`)), 'wrong module').toHaveLength(1);
    expect(fixture(handler(`${gate(module === '*' ? 'accounts' : module)} ${flip}`)), 'its module').toEqual([]);
    // A cancel that only names the status in its WHERE is no approval.
    expect(fixture(handler(`await client.query(\`UPDATE ${table} SET status = 'cancelled' WHERE status = '${status}'\`);`)), 'cancel').toEqual([]);
  });

  it('#1670 filing ruling: a marker scoped to the payroll-read census does not exempt the call from the posting census', () => {
    const filed = "await sql`UPDATE tax_return_versions SET status = 'filed' WHERE id = ${id}`;";
    const post = 'await flipBill(id);';
    expect(fixture(handler(`\n// census-exempt(flipBill, payroll-read): a company total\n ${post}`))).toHaveLength(1);
    expect(fixture(handler(`\n// census-exempt(flipBill, posting): the gate is per document, inside\n ${post}`))).toEqual([]);
    // r12 M1: an unscoped marker is no marker at all: the call is judged.
    expect(fixture(handler(`\n// census-exempt(flipBill): either census\n ${post}`))).toHaveLength(1);
    expect(fixture(handler(filed))).toHaveLength(1);
  });

  it('#1670 r12 L1: a filing needs the gate whose module is returnApproveModule(<form>); a literal module gate is a finding', () => {
    const filed = "await sql`UPDATE tax_return_versions SET status = 'filed' WHERE id = ${id}`;";
    const lock = "await sql`INSERT INTO vat_period_locks (company_id) VALUES (${id})`;";
    const viaResolver = "if (await refuseWithoutApprove(res, 'c', 'u', returnApproveModule('VAT201')!, 'x')) return;";
    const viaConst = "const m = returnApproveModule(id); if (!m) return; if (await refuseWithoutApprove(res, 'c', 'u', m, 'x')) return;";
    for (const body of [filed, lock, 'await fileIt(id);']) { // in the handler's own SQL, and through a helper
      expect(fixture(handler(`${gate('vat')} ${body}`)), `vat: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${gate('budgets')} ${body}`)), `budgets: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${viaResolver} ${body}`)), `resolver: ${body}`).toEqual([]);
      expect(fixture(handler(`${viaConst} ${body}`)), `const: ${body}`).toEqual([]);
      // A module the census cannot read (any variable) covers other posting, but never a filing: 'returns' is strict.
      expect(fixture(handler(`const any = id as 'vat'; if (await refuseWithoutApprove(res, 'c', 'u', any, 'x')) return; ${body}`)), `any: ${body}`).toHaveLength(1);
    }
  });

  it('#1670 Codex: withPayrollModule (Payroll read / write) is no proof of Payroll Approve in the posting census; it still is for payroll access', () => {
    const files: Record<string, string> = {
      '/fx/svc.ts': 'export async function approvePayrollRun(c: string, id: string) { return id; }',
      '/fx/route.ts': `import { approvePayrollRun } from './svc';\ndeclare function withPayrollModule<T>(h: T): T;
async function handler(id: string) { await approvePayrollRun('c', id); }\nexport default withPayrollModule(handler);`,
    };
    const bad = analyse({ virtualFiles: files, programFiles: Object.keys(files), routeFiles: ['/fx/route.ts'], ...POSTING_RULES }).bad;
    expect(bad.map((b) => b.sites.join())).toEqual([expect.stringContaining('approvePayrollRun[payroll]')]);
    expect(PAYROLL_READ_WRAPPERS.withPayrollModule).toBe('payroll');
  });
});
