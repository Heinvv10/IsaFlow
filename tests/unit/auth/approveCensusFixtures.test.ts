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
export declare function refuseApprovalRequestWithoutApprove(res: unknown, c: string, u: string, t: string, id: string): Promise<boolean>;
export async function finaliseReturn(c: string, form: string, id: string) { return id; }
export async function markReturnFiled(c: string, form: string, id: string) { return id; }
export async function amendReturn(c: string, form: string, id: string) { return id; }
export async function finaliseVatReturn(c: string, id: string) { return id; }
export async function fileIt(id: string) { await client.query("UPDATE tax_return_versions SET status = 'filed' WHERE id = $1", [id]); }
export async function flipBill(id: string) { await client.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [id]); }`,
    '/fx/route.ts': `import { sql, client, refuseWithoutApprove, refuseApprovalRequestWithoutApprove, flipBill, returnApproveModule, fileIt, finaliseReturn, markReturnFiled,
  amendReturn, finaliseVatReturn } from './lib';\ndeclare const res: unknown;
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

  it('#1670 r12 L1 / r13 L2: a filing needs the form gate (returnApproveModule); a VAT lock needs VAT\'s; a literal other module is a finding', () => {
    const filed = "await sql`UPDATE tax_return_versions SET status = 'filed' WHERE id = ${id}`;";
    const lock = "await sql`INSERT INTO vat_period_locks (company_id) VALUES (${id})`;";
    const form = (f: string) => `if (await refuseWithoutApprove(res, 'c', 'u', returnApproveModule('${f}')!, 'x')) return;`;
    const viaConst = "const m = returnApproveModule(id); if (!m) return; if (await refuseWithoutApprove(res, 'c', 'u', m, 'x')) return;";
    const unreadable = "const any = id as 'vat'; if (await refuseWithoutApprove(res, 'c', 'u', any, 'x')) return;";
    for (const body of [filed, 'await fileIt(id);']) { // in the handler's own SQL, and through a helper: the filing's form is unknown
      expect(fixture(handler(`${gate('vat')} ${body}`)), `vat: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${gate('budgets')} ${body}`)), `budgets: ${body}`).toHaveLength(1);
      // follow-up L-a/L-b: a gate for ONE form does not cover a filing whose form the census cannot read
      expect(fixture(handler(`${form('VAT201')} ${body}`)), `VAT201: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${form('EMP501')} ${body}`)), `EMP501: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${viaConst} ${body}`)), `const: ${body}`).toEqual([]);
      expect(fixture(handler(`${unreadable} ${body}`)), `any: ${body}`).toHaveLength(1);
      expect(fixture(handler(`${form('ITR14')} ${body}`)), `unmapped form: ${body}`).toHaveLength(1);
    }
    // r13 L2: the resolver is given its argument: an EMP501 gate (Payroll) before a VAT lock is a finding; VAT201's is not.
    expect(fixture(handler(`${form('EMP501')} ${lock}`))).toHaveLength(1);
    expect(fixture(handler(`${form('VAT201')} ${lock}`))).toEqual([]);
    expect(fixture(handler(`${gate('vat')} ${lock}`))).toEqual([]);
    expect(fixture(handler(`${viaConst} ${lock}`))).toHaveLength(1); // some return's module is not provably VAT
  });

  it('#1670 follow-up L-a/L-b: a finalise / filing / amend of one form needs THAT form\'s gate; another form\'s is a finding', () => {
    const form = (f: string) => `if (await refuseWithoutApprove(res, 'c', 'u', returnApproveModule('${f}')!, 'x')) return;`;
    const viaConst = "const m = returnApproveModule(id); if (!m) return; if (await refuseWithoutApprove(res, 'c', 'u', m, 'x')) return;";
    for (const sink of ['finaliseReturn', 'markReturnFiled', 'amendReturn']) {
      const vat = `await ${sink}('c', 'VAT201', id);`;
      expect(fixture(handler(`${form('EMP501')} ${vat}`)), `EMP501 gate, VAT201 ${sink}`).toHaveLength(1);
      expect(fixture(handler(`${gate('vat')} ${vat}`)), `literal vat gate, VAT201 ${sink}`).toHaveLength(1);
      expect(fixture(handler(`${form('VAT201')} ${vat}`)), `VAT201 gate, VAT201 ${sink}`).toEqual([]);
      expect(fixture(handler(`${form('EMP201')} await ${sink}('c', 'EMP501', id);`)), `EMP201 gate (Payroll), EMP501 ${sink}`).toEqual([]);
      // an unknown form's filing: only a gate whose form is also unknown (the same variable) covers it
      expect(fixture(handler(`${form('EMP501')} await ${sink}('c', id, id);`)), `EMP501 gate, unknown ${sink}`).toHaveLength(1);
      expect(fixture(handler(`${viaConst} await ${sink}('c', id, id);`)), `unknown gate, unknown ${sink}`).toEqual([]);
      expect(fixture(handler(`${viaConst} ${vat}`)), `unknown gate, VAT201 ${sink}`).toEqual([]);
    }
    // #1720 review M1: a gate deciding per document ('*') never covers a filing, of a known form or not
    const perDocument = "if (await refuseApprovalRequestWithoutApprove(res, 'c', 'u', 'x', id)) return;";
    for (const call of ["await finaliseReturn('c', 'VAT201', id);", "await markReturnFiled('c', 'EMP501', id);", 'await amendReturn(\'c\', id, id);']) {
      expect(fixture(handler(`${perDocument} ${call}`)), `'*' gate, ${call}`).toHaveLength(1);
    }
    // #1720 review L2: an unmapped form (ITR14) is refused by every gate, its own resolver included
    for (const g of [form('VAT201'), form('ITR14'), viaConst, perDocument, gate('vat'), gate('payroll')]) {
      expect(fixture(handler(`${g} await finaliseReturn('c', 'ITR14', id);`)), `${g} ITR14`).toHaveLength(1);
    }
    // L-b: the VAT201 finalise (and its period lock) is VAT's wherever a route calls it
    expect(fixture(handler(`${form('EMP501')} await finaliseVatReturn('c', id);`))).toHaveLength(1);
    expect(fixture(handler(`${form('VAT201')} await finaliseVatReturn('c', id);`))).toEqual([]);
  });

  it('#1670 follow-up L-c: an invoice CASE arm to approved counts unless its WHEN names a paid state (the un-payment)', () => {
    for (const table of ['customer_invoices', 'supplier_invoices']) {
      expect(fixture(handler(`await sql\`UPDATE ${table} SET status = CASE WHEN status = 'draft' THEN 'approved' ELSE status END WHERE id = \${id}\`;`)),
        `${table} draft -> approved`).toHaveLength(1);
      expect(fixture(handler(`await sql\`UPDATE ${table} SET status = CASE WHEN amount_paid >= total_amount THEN 'paid' WHEN amount_paid > 0 THEN 'partially_paid' WHEN status IN ('partially_paid', 'paid') THEN 'approved' ELSE status END WHERE id = \${id}\`;`)),
        `${table} recompute`).toEqual([]);
      expect(fixture(handler(`await sql\`UPDATE ${table} SET amount_paid = GREATEST(0, amount_paid - \${id}), status = CASE WHEN GREATEST(0, amount_paid - \${id}) <= 0 THEN 'approved' ELSE 'partially_paid' END WHERE id = \${id}\`;`)),
        `${table} allocation reversal`).toEqual([]);
      expect(fixture(handler(`await sql\`UPDATE ${table} SET status = CASE WHEN status = 'paid' THEN 'approved' ELSE status END WHERE id = \${id}\`;`)),
        `${table} paid -> approved`).toEqual([]);
      // #1720 review L1: naming amount_paid is not an un-payment; a draft with nothing paid flipped to approved is an approval
      expect(fixture(handler(`await sql\`UPDATE ${table} SET status = CASE WHEN amount_paid = 0 AND status = 'draft' THEN 'approved' ELSE status END WHERE id = \${id}\`;`)),
        `${table} draft with nothing paid -> approved`).toHaveLength(1);
    }
  });

  it('#1670 r13 L1: a gate whose module the census cannot read covers nothing, not even a journal (any module)', () => {
    const posted = "await sql`UPDATE gl_journal_entries SET status = 'posted' WHERE id = ${id}`;";
    expect(fixture(handler(`const any = id as 'accounts'; if (await refuseWithoutApprove(res, 'c', 'u', any, 'x')) return; ${posted}`))).toHaveLength(1);
    expect(fixture(handler(`const m = 'accounts'; if (await refuseWithoutApprove(res, 'c', 'u', m, 'x')) return; ${posted}`))).toEqual([]);
    // and nothing module-specific either: a computed module before a bill approval is a finding.
    const bill = "await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${id}`;";
    expect(fixture(handler(`const any = id as 'suppliers'; if (await refuseWithoutApprove(res, 'c', 'u', any, 'x')) return; ${bill}`))).toHaveLength(1);
    expect(fixture(handler(`${gate('accounts')} ${posted}`))).toEqual([]);
  });

  it('#1670 r13 M1 / L3: a finalise INSERT, an amend, a CASE, a tuple SET and an upsert flip are primitives', () => {
    for (const [sqlText, need] of [
      ["INSERT INTO tax_return_versions (company_id, form_type) VALUES (${id}, 'VAT201')", 'returnApproveModule(id)!'],
      ["UPDATE tax_return_versions SET status = 'superseded', amended_at = now() WHERE id = ${id}", 'returnApproveModule(id)!'],
      ["UPDATE supplier_payments SET status = CASE WHEN ${id} = '' THEN 'approved' ELSE status END WHERE id = ${id}", "'suppliers'"],
      ["UPDATE purchase_orders SET (status, approved_by) = ('approved', ${id}) WHERE id = ${id}", "'suppliers'"],
      ["INSERT INTO budget_versions (id, status) VALUES (${id}, 'draft') ON CONFLICT (id) DO UPDATE SET status = 'approved'", "'budgets'"],
    ] as const) {
      const body = `await sql\`${sqlText}\`;`;
      expect(fixture(handler(body)), `ungated: ${sqlText}`).toHaveLength(1);
      expect(fixture(handler(`if (await refuseWithoutApprove(res, 'c', 'u', ${need}, 'x')) return; ${body}`)), `gated: ${sqlText}`).toEqual([]);
    }
    // A CASE that only keeps or resets the status is no flip.
    expect(fixture(handler("await sql`UPDATE supplier_payments SET status = CASE WHEN status = 'draft' THEN 'draft' ELSE status END`;"))).toEqual([]);
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
