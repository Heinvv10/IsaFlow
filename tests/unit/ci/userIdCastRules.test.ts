// tests/unit/ci/userIdCastRules.test.ts
//
// The CI guard that blocks the `text = uuid` defect class needs its own tests:
// a guard whose regexes are unverified is theatre. The first version of these
// rules shipped with three holes a blind reviewer found by construction, and
// every one of those counterexamples is now a case below.
//
// Rules under test (scripts/ci/userIdCastRules.ts):
//   1. user_id compared to a ${param}::UUID cast on a string-id table
//   2. users.id compared to a ${param}::UUID cast
//   3. a join onto users.id from a uuid column with no ::TEXT

import { describe, it, expect } from 'vitest';
import { findViolations } from '../../../scripts/ci/userIdCastRules';

const wrap = (sqlBody: string) => `const rows = await sql\`${sqlBody}\`;`;

describe('userIdCastRules — must fire', () => {
  it('rule 1: user_id ::UUID against company_users', () => {
    const v = findViolations(wrap(`
      SELECT 1 FROM company_users
      WHERE company_id = \${companyId}::UUID AND user_id = \${userId}::UUID
      LIMIT 1
    `));
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toContain('company_users');
  });

  it('rule 1: aliased cu.user_id ::UUID via a join', () => {
    const v = findViolations(wrap(`
      SELECT 1 FROM company_group_members cgm
      JOIN company_users cu ON cu.company_id = cgm.company_id
      WHERE cgm.group_id = \${gId}::UUID AND cu.user_id = \${userId}::UUID
    `));
    expect(v).toHaveLength(1);
  });

  // Reviewer counterexample 2: a space before the cast defeated the old regex.
  it('rule 1: fires even with whitespace before the cast', () => {
    const v = findViolations(wrap(`
      SELECT 1 FROM company_users WHERE user_id = \${userId} ::UUID
    `));
    expect(v).toHaveLength(1);
  });

  it('rule 2: users.id ::UUID unaliased', () => {
    const v = findViolations(wrap(`
      SELECT id, email FROM users WHERE id = \${userId}::UUID
    `));
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toContain('users.id');
  });

  // Reviewer counterexample 3: only the literal alias `u` was recognised.
  it('rule 2: users.id ::UUID under a non-u alias', () => {
    const v = findViolations(wrap(`
      SELECT 1 FROM users usr WHERE usr.id = \${userId}::UUID
    `));
    expect(v).toHaveLength(1);
  });

  it('rule 3: join onto users.id from a uuid column with no cast', () => {
    const v = findViolations(wrap(`
      SELECT cn.* FROM credit_notes cn
      LEFT JOIN users u ON u.id = cn.approved_by
    `));
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toContain('without ::TEXT');
  });

  // Reviewer counterexample 4: reversed operand order was not matched.
  it('rule 3: fires on the reversed operand order', () => {
    const v = findViolations(wrap(`
      SELECT cn.* FROM credit_notes cn
      LEFT JOIN users u ON cn.approved_by = u.id
    `));
    expect(v).toHaveLength(1);
  });
});

describe('userIdCastRules — must NOT fire', () => {
  it('correct: user_id with no cast, company_id cast', () => {
    expect(findViolations(wrap(`
      SELECT 1 FROM company_users
      WHERE company_id = \${companyId}::UUID AND user_id = \${userId}
      LIMIT 1
    `))).toEqual([]);
  });

  it('correct: join onto users.id with an explicit ::TEXT', () => {
    expect(findViolations(wrap(`
      SELECT * FROM credit_notes cn
      LEFT JOIN users u ON u.id = cn.approved_by::TEXT
    `))).toEqual([]);
  });

  it('correct: join onto users.id from a string column needs no cast', () => {
    expect(findViolations(wrap(`
      SELECT * FROM customer_activities ca
      JOIN users u ON u.id = ca.created_by
    `))).toEqual([]);
  });

  it('correct: company_users.user_id joined to users.id, both strings', () => {
    expect(findViolations(wrap(`
      SELECT cu.role FROM company_users cu
      JOIN users u ON u.id = cu.user_id
      WHERE cu.company_id = \${companyId}::UUID
    `))).toEqual([]);
  });

  // Reviewer counterexample 1: the old rule matched the literal string
  // "company_users" anywhere in the block, so an unrelated table's genuinely
  // uuid user_id was flagged. Alias resolution is what fixes this.
  it('correct: a uuid user_id on a DIFFERENT table is not flagged just because company_users is joined', () => {
    expect(findViolations(wrap(`
      SELECT 1 FROM time_entries t
      JOIN company_users cu ON cu.company_id = t.company_id
      WHERE t.user_id = \${userId}::UUID AND t.company_id = \${companyId}::UUID
    `))).toEqual([]);
  });

  it('correct: a genuinely uuid id column keeps its ::UUID cast', () => {
    expect(findViolations(wrap(`
      SELECT * FROM credit_notes cn
      WHERE cn.id = \${creditNoteId}::UUID AND cn.company_id = \${companyId}::UUID
    `))).toEqual([]);
  });

  it('correct: practice tables have a uuid user_id and keep the cast', () => {
    expect(findViolations(wrap(`
      SELECT 1 FROM practice_staff_rates
      WHERE company_id = \${companyId}::UUID AND user_id = \${userId}::UUID
    `))).toEqual([]);
  });
});
