/**
 * R-035 PR3 review B4 / A4: rule matching and the rank ladder exist in three
 * places that must agree —
 *   - TypeScript: strictestMatchingRule (approvalMatching.ts) and requiredRank
 *     (approvalAuthority.ts), which the 409 gate uses;
 *   - SQL, generic (862): approval_rule_strictest_rank / approval_rule_matches
 *     and approval_required_rank, which the credit-note backstop uses;
 *   - SQL, supplier invoices (712): approval_supplier_invoice_rule_matches,
 *     which the live supplier-invoice backstop uses and this PR does not touch.
 * Each is driven over every operator (an unknown one included), a NULL
 * threshold, an inactive rule, another company's rule and another type's rule,
 * at amounts either side of the threshold, and over every role on the ladder
 * plus unknown and NULL ones. Where they disagree, a document one layer
 * refuses would pass the other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { isConditionOperator, strictestMatchingRule } from '../../src/modules/accounting/services/gl/approvalMatching';
import { APPROVER_ROLES, requiredRank } from '../../src/modules/accounting/services/gl/approvalAuthority';
import type { DocumentType } from '../../src/modules/accounting/services/gl/approvalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, createUser, newCompany } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let c = '';
let other = '';

beforeAll(async () => {
  user = await createUser(pool, tokens);
  c = await newCompany(pool, [[user, 'owner']], companies);
  other = await newCompany(pool, [[user, 'owner']], companies);
});
afterAll(() => cleanup(pool, companies, [user]));

interface Rule { operator: string; value: number | null; role: string; active?: boolean; company?: 'other'; type?: 'other' }

const CASES: [string, Rule[]][] = [
  ['any', [{ operator: 'any', value: 0, role: 'owner' }]],
  ['greater_than', [{ operator: 'greater_than', value: 1000, role: 'manager' }]],
  ['greater_equal', [{ operator: 'greater_equal', value: 1000, role: 'admin' }]],
  ['an operator nobody can evaluate (fails closed)', [{ operator: 'less_than', value: 1000, role: 'accountant' }]],
  ['a NULL threshold', [{ operator: 'greater_than', value: null, role: 'viewer' }]],
  ['an inactive rule', [{ operator: 'any', value: 0, role: 'owner', active: false }]],
  ["another company's rule", [{ operator: 'any', value: 0, role: 'owner', company: 'other' }]],
  ["another type's rule", [{ operator: 'any', value: 0, role: 'owner', type: 'other' }]],
  ['an unknown role', [{ operator: 'any', value: 0, role: 'wizard' }]],
  ['the strictest of several', [
    { operator: 'any', value: 0, role: 'bookkeeper' },
    { operator: 'greater_equal', value: 1000, role: 'owner' },
    { operator: 'greater_than', value: 5000, role: 'manager' },
  ]],
];
const AMOUNTS = [0, 999.99, 1000, 1000.01, 5000, 5000.01];
const TYPES: DocumentType[] = ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
  'supplier_payment', 'payment_batch', 'manual_journal'];

/**
 * Runs inside one transaction that is rolled back. Only the case that needs an
 * ACTIVE rule with an operator outside the allowlist takes DDL: the 647 CHECK
 * refuses one (rows written before it exist — it is NOT VALID — but no INSERT
 * or UPDATE can make one now), so that case drops the constraint for the
 * duration. Dropping it takes ACCESS EXCLUSIVE on approval_rules, so the wait
 * for it is bounded: a busy table fails this case fast rather than queueing
 * every other session's rule read behind it.
 */
async function inRolledBackTx(fn: (client: PoolClient) => Promise<void>, legacyOperator: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (legacyOperator) {
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query('ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS approval_rules_condition_operator_check');
    }
    await als.run({ client, userId: user, companyId: c, claims: {} } as never, () => fn(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe.each(TYPES)('rule matching agrees for %s', (type) => {
  it.each(CASES)('%s', async (_name, rules) => {
    await inRolledBackTx(async (client) => {
      for (const rule of rules) {
        await client.query(
          `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
           VALUES($1,'parity',$2,'amount',$3,$4,$5,$6)`,
          [rule.company === 'other' ? other : c, rule.type === 'other' ? 'payment' : type,
            rule.operator, rule.value, rule.role, rule.active ?? true]);
      }
      for (const amount of AMOUNTS) {
        const ts = await strictestMatchingRule(c, type, amount);
        const { rows: [sql] } = await client.query(
          `SELECT approval_rule_strictest_rank($1,$2,$3) AS rank, approval_rule_matches($1,$2,$3) AS matches,
                  approval_supplier_invoice_rule_matches($1,$3) AS si_matches`, [c, type, amount]);
        const at = `${type} @ ${amount}`;
        expect(sql.matches, at).toBe(ts !== null);
        expect(sql.rank, at).toBe(ts === null ? null : requiredRank(ts.approverRole));
        if (type === 'supplier_invoice') expect(sql.si_matches, at).toBe(ts !== null);
      }
    }, rules.some((rule) => (rule.active ?? true) && !isConditionOperator(rule.operator)));
  });
});

describe('the rank ladder agrees', () => {
  it.each([...APPROVER_ROLES, 'wizard', '', 'toString', 'constructor', 'OWNER'])('%s', async (role) => {
    const { rows: [r] } = await pool.query('SELECT approval_required_rank($1) AS rank', [role]);
    expect(r.rank).toBe(requiredRank(role));
  });

  it('a NULL role ranks as the floor requiredRank gives a role it does not know', async () => {
    const { rows: [r] } = await pool.query('SELECT approval_required_rank(NULL) AS rank');
    expect(r.rank).toBe(requiredRank(String(null)));
  });
});
