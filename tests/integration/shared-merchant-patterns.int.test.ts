/**
 * Migrations 905 / 906 against a real database: the shared merchant pool is deny-all to app_user and
 * platform_admin; shared_pool_publish is its only writer (migration_admin only) and refuses extra fields,
 * sub-threshold rows and non-poolable categories; shared_pool_lookup answers only an eligible caller's
 * active company; the job publishes at k = 5 eligible companies, ignores no-bureau and partially opted-out
 * companies, unmapped accounts and pool-accepted decisions, and drops everything on opt-out; a suggestion
 * names the caller's own account; company_category_mappings is tenant-isolated. The suite runs with the
 * legal-review gate on (MERCHANT_SHARING_ENABLED=true); with it off, the job leaves the pool untouched and
 * the reader serves none of the rows it holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asUser, pool, seedCompany, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import { runSharedPoolAggregation as runJob, type SharedPoolRunResult } from '../../src/modules/accounting/services/sharedPool/sharedPoolJob';
import { getSharedSuggestion } from '../../src/modules/accounting/services/sharedPool/sharedSuggestionService';
import { autoMapCategories } from '../../src/modules/accounting/services/sharedPool/categoryMappingService';
import { bulkCategorize } from '../../src/modules/accounting/services/core/smartCategorizationService';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';

assertDisposable();

let cos: Co[] = []; // c[0..4] eligible; c[5] in an opted-in AND an opted-out bureau; c[6] no bureau
let fresh: Co;
const users: string[] = [];
let member = ''; // member of c[0], c[1], c[5], c[6]
const bureauIn = crypto.randomUUID();
const bureauOut = crypto.randomUUID();

/** A run with the gate on: a skip here means the env was not set, so fail loudly. */
async function runSharedPoolAggregation(): Promise<SharedPoolRunResult> {
  const r = await runJob();
  if ('skipped' in r) throw new Error('the shared pool job skipped: MERCHANT_SHARING_ENABLED is not true');
  return r;
}
const gateBefore = process.env.MERCHANT_SHARING_ENABLED;
function restoreGate() {
  if (gateBefore === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = gateBefore;
}

async function poolRow(merchant: string) {
  return (await pool.query('SELECT * FROM shared_merchant_patterns WHERE normalized_merchant = $1', [merchant])).rows[0];
}

async function decidedLine(co: Co, description: string, source: string, outcome: string): Promise<void> {
  const tx = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1, $2, $3, '2026-10-10', -100, $4, 'allocated')`, [tx, co.id, co.bank, description]);
  await pool.query(
    `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id,
       outcome, final_gl_account_id, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $4, 'u', now())`, [co.id, tx, source, co.other, outcome]);
}

beforeAll(async () => {
  process.env.MERCHANT_SHARING_ENABLED = 'true';
  for (let i = 0; i < 7; i++) cos.push(await seedCompany(`906 pool co ${i}`));
  fresh = await seedCompany('906 auto-map co');
  member = await seedUser([cos[0]!.id, cos[1]!.id, cos[5]!.id, cos[6]!.id, fresh.id]);
  const owner = await seedUser([]);
  users.push(member, owner);
  await pool.query('INSERT INTO bureaus (id, name, owner_user_id, share_merchant_patterns) VALUES ($1, $2, $3, true), ($4, $5, $3, false)',
    [bureauIn, '906 opted in', owner, bureauOut, '906 opted out']);
  for (const c of cos.slice(0, 6)) await pool.query('INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2)', [bureauIn, c.id]);
  await pool.query('INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2)', [bureauOut, cos[5]!.id]);

  for (const c of cos) {
    await pool.query(
      `INSERT INTO company_category_mappings (company_id, category_code, gl_account_id, mapping_source, mapped_by)
       VALUES ($1, 'fuel', $2, 'manual', 'u'), ($1, 'telephone', $3, 'manual', 'u')`, [c.id, c.expense, c.other]);
    // Past coding: a learned pattern, on every company (incl. the two ineligible ones).
    await pool.query(
      `INSERT INTO categorization_patterns (company_id, pattern, match_type, gl_account_id, source) VALUES ($1, 'ENGEN GARAGE', 'contains', $2, 'learned')`,
      [c.id, c.expense]);
    // A rule onto an UNMAPPED account (the bank account): ignored.
    await pool.query(
      `INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern, gl_account_id, is_active)
       VALUES ($1, 'Groceries', 'description', 'contains', 'CHECKERS', $2, true)`, [c.id, c.bank]);
  }
  // SHELL at only four eligible companies: never published.
  for (const c of cos.slice(0, 4)) {
    await pool.query(
      `INSERT INTO categorization_patterns (company_id, pattern, match_type, gl_account_id, source) VALUES ($1, 'SHELL ULTRA CITY', 'contains', $2, 'manual')`,
      [c.id, c.expense]);
  }
  // Future coding (decision log): TELKOM recoded by a person at five eligible companies -> published;
  // VODACOM merely accepted from the pool -> not a vote, nor is the learned pattern that acceptance
  // wrote (learnFromAllocation runs on every account allocation): the pool never votes for itself.
  for (const c of cos.slice(0, 5)) {
    await decidedLine(c, 'TELKOM DEBIT ORDER 0123456789', 'pattern', 'recoded');
    await decidedLine(c, 'VODACOM CONTRACT', 'shared_pool', 'accepted');
    await pool.query(
      `INSERT INTO categorization_patterns (company_id, pattern, match_type, gl_account_id, source) VALUES ($1, 'VODACOM CONTRACT', 'contains', $2, 'learned')`,
      [c.id, c.other]);
  }
});

afterAll(async () => {
  restoreGate();
  try {
    const ids = [...cos, fresh].map((c) => c.id);
    await pool.query("SELECT public.shared_pool_publish('[]'::jsonb, 1)");
    await pool.query('DELETE FROM categorization_patterns WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM company_category_mappings WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM bureaus WHERE id = ANY($1::uuid[])', [[bureauIn, bureauOut]]);
    await teardownCompanies(ids, users);
  } finally {
    await pool.end();
  }
});

describe('the aggregation job', () => {
  it('publishes ENGEN at exactly the five eligible companies (no-bureau and partially opted-out ignored)', async () => {
    const r = await runSharedPoolAggregation();
    expect(r.failedCompanies).toBe(0);
    expect(await poolRow('ENGEN')).toMatchObject({ category_code: 'fuel', distinct_company_count: 5, total_observations: 5 });
  });

  it('publishes from the decision log (TELKOM, recoded by people) with no digits in the key', async () => {
    expect(await poolRow('TELKOM')).toMatchObject({ category_code: 'telephone', distinct_company_count: 5 });
  });

  it('does not publish a merchant at four companies, on an unmapped account, or from pool-accepted decisions (nor their learned patterns)', async () => {
    expect(await poolRow('SHELL')).toBeUndefined();
    expect(await poolRow('CHECKERS')).toBeUndefined();
    expect(await poolRow('VODACOM')).toBeUndefined();
  });

  it('stores no company, bureau, user or transaction reference anywhere in the row', async () => {
    const row = await poolRow('ENGEN');
    const text = JSON.stringify(row);
    for (const c of cos) expect(text).not.toContain(c.id);
    expect(text).not.toContain(bureauIn);
    expect(Object.keys(row).sort()).toEqual(['agreement_pct', 'category_code', 'distinct_company_count', 'filter_version',
      'normalized_merchant', 'total_observations', 'updated_at']);
  });
});

describe('the legal-review gate off (MERCHANT_SHARING_ENABLED unset)', () => {
  it('the job reads and writes nothing: the published rows stay exactly as they were', async () => {
    const before = (await pool.query('SELECT * FROM shared_merchant_patterns ORDER BY normalized_merchant')).rows;
    expect(before.length).toBeGreaterThan(0);
    delete process.env.MERCHANT_SHARING_ENABLED;
    try {
      expect(await runJob()).toEqual({
        skipped: true, reason: 'sharing_pending_legal_review', message: 'skipped: sharing disabled pending legal review',
      });
    } finally {
      process.env.MERCHANT_SHARING_ENABLED = 'true';
    }
    expect((await pool.query('SELECT * FROM shared_merchant_patterns ORDER BY normalized_merchant')).rows).toEqual(before);
  });

  it('an eligible member gets no pool suggestion although the pool holds the merchant', async () => {
    expect(await poolRow('ENGEN')).toBeDefined();
    delete process.env.MERCHANT_SHARING_ENABLED;
    try {
      expect(await asUser(member, cos[1]!.id, () => getSharedSuggestion(cos[1]!.id, 'POS ENGEN ROSEBANK 4411'))).toBeNull();
    } finally {
      process.env.MERCHANT_SHARING_ENABLED = 'true';
    }
  });
});

describe('shared_pool_lookup and getSharedSuggestion', () => {
  it('an eligible member gets the category, mapped to ITS OWN account', async () => {
    const rows = await asUser(member, cos[0]!.id, async (c) =>
      (await c.query("SELECT * FROM public.shared_pool_lookup($1, ARRAY['ENGEN'])", [cos[0]!.id])).rows);
    expect(rows).toEqual([{ merchant: 'ENGEN', category_code: 'fuel', confidence: '0.7500' }]);
    const s = await asUser(member, cos[1]!.id, () => getSharedSuggestion(cos[1]!.id, 'POS ENGEN ROSEBANK 4411'));
    expect(s).toMatchObject({ glAccountId: cos[1]!.expense, matchSource: 'shared_pool', confidence: 0.75 });
    expect([cos[0]!, ...cos.slice(2)].flatMap((c) => [c.expense, c.other, c.bank])).not.toContain(s!.glAccountId);
  });

  it('a no-bureau company and a partially opted-out company get nothing', async () => {
    for (const c of [cos[6]!, cos[5]!]) {
      const rows = await asUser(member, c.id, async (cl) =>
        (await cl.query("SELECT * FROM public.shared_pool_lookup($1, ARRAY['ENGEN'])", [c.id])).rows);
      expect(rows).toEqual([]);
      expect(await asUser(member, c.id, () => getSharedSuggestion(c.id, 'ENGEN'))).toBeNull();
    }
  });

  it('asking for a company other than the active one gets nothing', async () => {
    const rows = await asUser(member, cos[0]!.id, async (c) =>
      (await c.query("SELECT * FROM public.shared_pool_lookup($1, ARRAY['ENGEN'])", [cos[1]!.id])).rows);
    expect(rows).toEqual([]);
  });

  it('a non-member who sets the company GUC gets nothing', async () => {
    const outsider = await seedUser([]);
    users.push(outsider);
    const rows = await asUser(outsider, cos[0]!.id, async (c) =>
      (await c.query("SELECT * FROM public.shared_pool_lookup($1, ARRAY['ENGEN'])", [cos[0]!.id])).rows);
    expect(rows).toEqual([]);
  });

  it('refuses more than 500 keys (no bulk dump)', async () => {
    await expect(asUser(member, cos[0]!.id, (c) =>
      c.query('SELECT * FROM public.shared_pool_lookup($1, $2::text[])', [cos[0]!.id, Array.from({ length: 501 }, (_, i) => `M${i}`)])))
      .rejects.toMatchObject({ code: '22023' });
  });
});

describe('deny-all and the single writer', () => {
  it.each(['SELECT * FROM shared_merchant_patterns', "INSERT INTO shared_merchant_patterns VALUES ('X', 'fuel', 9, 1, 9, 1, now())",
    'DELETE FROM shared_merchant_patterns', "SELECT public.shared_pool_publish('[]'::jsonb, 1)"])('app_user: %s -> 42501', async (q) => {
    await expect(asUser(member, cos[0]!.id, (c) => c.query(q))).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['SELECT * FROM shared_merchant_patterns', "SELECT public.shared_pool_publish('[]'::jsonb, 1)",
    "SELECT * FROM public.shared_pool_lookup(gen_random_uuid(), ARRAY['ENGEN'])"])('platform_admin: %s -> 42501', async (q) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE platform_admin');
      await expect(c.query(q)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the runtime login, without SUPERUSER, can run the job: read its tables, list eligibility and publish', async () => {
    // The suites connect as a superuser, for whom every privilege check passes. Production's runtime login
    // (the role the job runs as) is the same role WITHOUT SUPERUSER, BYPASSRLS, a member of migration_admin.
    // Dropping SUPERUSER inside this transaction makes every check below answer as production would.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const me = (await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      expect(me.rolbypassrls).toBe(true);
      if (me.rolsuper) await c.query('ALTER ROLE CURRENT_USER NOSUPERUSER');
      expect((await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper).toBe(false);
      const p = (await c.query(`SELECT
          has_function_privilege(current_user, 'public.shared_pool_publish(jsonb,int4)', 'EXECUTE') AS publish,
          has_table_privilege(current_user, 'public.company_category_mappings', 'SELECT') AS mappings,
          has_table_privilege(current_user, 'public.categorization_patterns', 'SELECT') AS patterns,
          has_table_privilege(current_user, 'public.bank_categorisation_rules', 'SELECT') AS rules,
          has_table_privilege(current_user, 'public.categorization_decisions', 'SELECT') AS decisions,
          has_table_privilege(current_user, 'public.bank_transactions', 'SELECT') AS lines,
          has_table_privilege(current_user, 'public.bureau_companies', 'SELECT') AS bureau_companies,
          has_table_privilege(current_user, 'public.bureaus', 'SELECT') AS bureaus`)).rows[0];
      expect(p).toEqual({ publish: true, mappings: true, patterns: true, rules: true, decisions: true, lines: true,
        bureau_companies: true, bureaus: true });
      // And the publish itself goes through as this role (rolled back below).
      await c.query("SELECT public.shared_pool_publish('[]'::jsonb, 1)");
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  const publish = (rows: unknown) => pool.query('SELECT public.shared_pool_publish($1::jsonb, 1)', [JSON.stringify(rows)]);
  const row = { merchant: 'ZZTEST', category: 'fuel', companies: 5, agreement: 1, observations: 5 };

  it('refuses a field the pool does not store (a company id)', async () => {
    await expect(publish([{ ...row, company_id: cos[0]!.id }])).rejects.toMatchObject({ code: '22023' });
  });
  it('refuses fewer than five companies and agreement under 0.8 (CHECKs)', async () => {
    await expect(publish([{ ...row, companies: 4, observations: 4 }])).rejects.toMatchObject({ code: '23514' });
    await expect(publish([{ ...row, agreement: 0.79 }])).rejects.toMatchObject({ code: '23514' });
  });
  it('refuses a key that is not the filter shape, and a non-poolable category', async () => {
    await expect(publish([{ ...row, merchant: 'J Smith 0821234567' }])).rejects.toMatchObject({ code: '23514' });
    await expect(publish([{ ...row, category: 'salaries' }])).rejects.toMatchObject({ code: '22023' });
  });
  it('a refused publish leaves the previous pool in place', async () => {
    expect(await poolRow('ENGEN')).toBeDefined();
  });
});

describe('cold start end to end (bulkCategorize, then a sweep with auto-post wide open)', () => {
  it('an unmatched line gets the pool suggestion, logged as shared_pool, and the sweep never posts it', async () => {
    const c0 = cos[0]!;
    await pool.query(
      `INSERT INTO bank_auto_post_settings
         (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
       VALUES ($1, true, 0.01, 0, true, 0.01, 0, NOW())`, [c0.id]);
    await asUser(member, c0.id, async (c) => {
      // Not 'ENGEN GARAGE' (the company's own pattern), no rule, no history: only the pool knows it.
      const tx = (await c.query<{ id: string }>(
        `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
         VALUES ($1, $2, '2026-10-12', -250, 'POS ENGEN MIDRAND 7781', 'imported') RETURNING id`, [c0.id, c0.bank])).rows[0]!.id;
      await bulkCategorize(c0.id, [tx]);
      const line = async () => (await c.query(
        'SELECT suggested_gl_account_id, suggested_strategy, suggested_confidence::TEXT AS conf, status FROM bank_transactions WHERE id = $1', [tx])).rows[0];
      expect(await line()).toEqual({ suggested_gl_account_id: c0.expense, suggested_strategy: 'shared_pool', conf: '0.75', status: 'imported' });

      const r = await sweep(c0.id, [tx], 'categorization', member, member);
      expect(r.posted).toBe(0);
      expect(r.skipped).toEqual([{ txId: tx, reason: 'shared pool suggestions are never auto-posted' }]);
      expect((await line()).status).toBe('imported');
      expect((await c.query(
        'SELECT suggestion_source, outcome, suggested_gl_account_id FROM categorization_decisions WHERE bank_transaction_id = $1', [tx])).rows)
        .toEqual([{ suggestion_source: 'shared_pool', outcome: 'pending', suggested_gl_account_id: c0.expense }]);
    });
  }, 60_000);
});

describe('opt-out propagates on the next run', () => {
  it('the opted-in bureau switching off empties its clients out of the pool', async () => {
    await pool.query('UPDATE bureaus SET share_merchant_patterns = false WHERE id = $1', [bureauIn]);
    const r = await runSharedPoolAggregation();
    expect(r.eligibleCompanies).toBe(0);
    expect(await poolRow('ENGEN')).toBeUndefined();
    expect(await poolRow('TELKOM')).toBeUndefined();
  });
});

describe('company_category_mappings', () => {
  it('is tenant-isolated: another company\'s mappings are invisible and cannot be written', async () => {
    const seen = await asUser(member, cos[0]!.id, async (c) =>
      (await c.query('SELECT company_id FROM company_category_mappings')).rows.map((r) => r.company_id));
    expect(new Set(seen)).toEqual(new Set([cos[0]!.id]));
    await expect(asUser(member, cos[0]!.id, (c) => c.query(
      `INSERT INTO company_category_mappings (company_id, category_code, gl_account_id, mapping_source, mapped_by)
       VALUES ($1, 'rent', $2, 'manual', 'u')`, [cos[1]!.id, cos[1]!.expense]))).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot map a category to another company\'s account (composite FK)', async () => {
    await expect(pool.query(
      `INSERT INTO company_category_mappings (company_id, category_code, gl_account_id, mapping_source, mapped_by)
       VALUES ($1, 'rent', $2, 'manual', 'u')`, [cos[0]!.id, cos[1]!.expense])).rejects.toMatchObject({ code: '23503' });
  });

  it('auto-map fills unmapped categories by account name, as the active company', async () => {
    // asUser always rolls back, so the rows are read inside the same transaction.
    const { r, rows } = await asUser(member, fresh.id, async (c) => ({
      r: await autoMapCategories(fresh.id, member),
      rows: (await c.query('SELECT category_code, gl_account_id, mapping_source FROM company_category_mappings WHERE company_id = $1 ORDER BY 1', [fresh.id])).rows,
    }));
    expect(r).toEqual({ mapped: 2, ambiguous: [] });
    // seedCompany's accounts: 6100 Fuel, 6200 Telephone (and 1100 Bank, an asset no alias names).
    expect(rows).toEqual([
      { category_code: 'fuel', gl_account_id: fresh.expense, mapping_source: 'auto' },
      { category_code: 'telephone', gl_account_id: fresh.other, mapping_source: 'auto' },
    ]);
  });
});
