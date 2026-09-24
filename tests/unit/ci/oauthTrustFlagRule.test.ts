/**
 * Mutation counterexamples for oauthTrustFlagRule — proof it fires on what it
 * must and stays quiet on what it must not.
 *
 * WHY THIS GATE EXISTS. Migration 693 makes `oauth_apps.is_verified` and
 * `is_first_party` unwritable by the application: they decide whether an OAuth
 * app may put its own logo, description and homepage on the consent and revoke
 * screens and wear a "Verified" badge. The only guard proving any of that is
 * `tests/integration/oauth-apps-trust-flags.int.test.ts`, and `bun run ci`
 * SKIPS the whole integration step when DATABASE_URL is unset — so nothing in
 * CI would notice if a later change undid 693. That is the same failure shape
 * `check-migration-rls.ts` exists for: a guard that can silently not run.
 *
 * Text-only, no connection, so it runs every time.
 */
import { describe, it, expect } from 'vitest';
import {
  findHatchUsages,
  findGuardRegressions,
  migrationNumber,
  TRUST_FLAG_GUC,
} from '../../../scripts/ci/oauthTrustFlagRule';

describe('findHatchUsages — the escape hatch must stay out of application code', () => {
  // The hatch is `SET LOCAL isaflow.allow_trust_flag_write = 'on'`. It exists
  // for a human at a psql prompt. If application code ever sets it, the guard
  // is void for every request that runs through that code.
  it('fires when application code sets the hatch GUC', () => {
    const v = findHatchUsages([
      {
        file: 'src/lib/auth/oauth.ts',
        text: `await sql\`SELECT set_config('${TRUST_FLAG_GUC}', 'on', true)\`;`,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe('src/lib/auth/oauth.ts');
  });

  it('fires on a bare SET LOCAL spelling too, not just set_config', () => {
    const v = findHatchUsages([
      { file: 'pages/api/oauth/register.ts', text: `SET LOCAL ${TRUST_FLAG_GUC} = 'on'` },
    ]);
    expect(v).toHaveLength(1);
  });

  it('stays quiet on application code that never mentions it', () => {
    expect(
      findHatchUsages([
        { file: 'src/lib/auth/oauth.ts', text: `UPDATE oauth_apps SET revoked_at = NOW()` },
      ]),
    ).toEqual([]);
  });
});

describe('findGuardRegressions — nothing after 693 may undo it', () => {
  const later = (name: string, text: string) => ({
    file: `scripts/migrations/sql/${name}`,
    text,
  });

  it('fires on a later migration re-granting table-level UPDATE to app_user', () => {
    // The exact shape that reopens it: no column list, so it restores the
    // TABLE-level privilege 693 revoked.
    const v = findGuardRegressions([
      later('700_whatever.sql', 'GRANT INSERT, UPDATE ON oauth_apps TO app_user;'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/table-level/i);
  });

  it('fires on a later migration re-running GRANT ON ALL TABLES', () => {
    // Migration 348's statement. Re-running it restores table-level INSERT and
    // UPDATE on EVERY table in public, oauth_apps included.
    const v = findGuardRegressions([
      later('701_regrant.sql', 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/ALL TABLES/i);
  });

  it('fires on a later migration dropping or disabling a guard trigger', () => {
    // The trigger is what actually binds the property — column grants cannot
    // bind the table owner, and the anonymous DCR path writes as the owner.
    expect(
      findGuardRegressions([later('702_drop.sql', 'DROP TRIGGER oauth_apps_guard_trust_flags_after_trg ON oauth_apps;')]),
    ).toHaveLength(1);
    expect(
      findGuardRegressions([later('703_disable.sql', 'ALTER TABLE oauth_apps DISABLE TRIGGER oauth_apps_guard_trust_flags_trg;')]),
    ).toHaveLength(1);
  });

  it('fires on a later migration downgrading a guard trigger out of ALWAYS', () => {
    // `ENABLE TRIGGER` silently resets ALWAYS back to origin mode, which
    // re-opens the session_replication_role bypass with no other symptom.
    const v = findGuardRegressions([
      later('704_enable.sql', 'ALTER TABLE oauth_apps ENABLE TRIGGER oauth_apps_guard_trust_flags_trg;'),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/ALWAYS/i);
  });

  it('stays quiet on ENABLE ALWAYS, which is the correct form', () => {
    expect(
      findGuardRegressions([
        later('705_ok.sql', 'ALTER TABLE oauth_apps ENABLE ALWAYS TRIGGER oauth_apps_guard_trust_flags_trg;'),
      ]),
    ).toEqual([]);
  });

  it('stays quiet on a later COLUMN-level grant, which does not reopen anything', () => {
    expect(
      findGuardRegressions([
        later('706_cols.sql', 'GRANT INSERT (name, description) ON oauth_apps TO app_user;'),
      ]),
    ).toEqual([]);
  });

  it('stays quiet on grants to a DIFFERENT table', () => {
    expect(
      findGuardRegressions([later('707_other.sql', 'GRANT INSERT, UPDATE ON customers TO app_user;')]),
    ).toEqual([]);
  });

  it('does not fire on 693 itself, nor on anything before it', () => {
    // 693 revokes then grants back column-level; 348 predates it and is the
    // grant 693 is written against. Neither is a regression.
    const v = findGuardRegressions([
      {
        file: 'scripts/migrations/sql/348_rls_and_auth_helpers.sql',
        text: 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;',
      },
      {
        file: 'scripts/migrations/sql/693_oauth_apps_trust_flags_not_app_writable.sql',
        text: `REVOKE UPDATE ON oauth_apps FROM app_user;
GRANT UPDATE (revoked_at) ON oauth_apps TO app_user;
DROP TRIGGER IF EXISTS oauth_apps_guard_trust_flags_trg ON oauth_apps;
ALTER TABLE oauth_apps ENABLE ALWAYS TRIGGER oauth_apps_guard_trust_flags_trg;`,
      },
    ]);
    expect(v).toEqual([]);
  });

  // ── Bypasses found by adversarial review of the first version ───────────
  // Every one of these reopened the hole while the gate printed OK. They are
  // all the same defect: matching a name as bare literal text, and trusting a
  // filename to parse.

  it('reads the FULL migration number, not the first three digits', () => {
    // The worst of them. `/^(\d{3})/` read 1001_ as 100, which is <= 693, so
    // the file was skipped entirely and a table-level re-grant was invisible.
    // Nothing else in CI enforces a 3-digit prefix: audit-migration-naming.ts
    // accepts any digit count and always exits 0.
    expect(migrationNumber('scripts/migrations/sql/1001_foo.sql')).toBe(1001);
    expect(migrationNumber('scripts/migrations/sql/694_x.sql')).toBe(694);
    // The repo's documented "insert between existing numbers" form.
    expect(migrationNumber('scripts/migrations/sql/244b_x.sql')).toBe(244);
  });

  it('fires on a 4-digit migration that re-grants', () => {
    expect(
      findGuardRegressions([later('1001_regrant.sql', 'GRANT UPDATE ON oauth_apps TO app_user;')]),
    ).toHaveLength(1);
  });

  it('scans a file whose name has no parseable number, rather than skipping it', () => {
    // Fail closed: an unparseable name must not buy exemption.
    expect(
      findGuardRegressions([
        { file: 'scripts/migrations/sql/hotfix.sql', text: 'GRANT UPDATE ON oauth_apps TO app_user;' },
      ]),
    ).toHaveLength(1);
  });

  it('fires on a schema-qualified table name', () => {
    expect(
      findGuardRegressions([later('900_a.sql', 'GRANT UPDATE ON public.oauth_apps TO app_user;')]),
    ).toHaveLength(1);
  });

  it('fires on quoted identifiers, for the table and the trigger alike', () => {
    expect(
      findGuardRegressions([later('900_b.sql', 'GRANT UPDATE ON "oauth_apps" TO app_user;')]),
    ).toHaveLength(1);
    expect(
      findGuardRegressions([later('900_c.sql', 'DROP TRIGGER "oauth_apps_guard_trust_flags_trg" ON oauth_apps;')]),
    ).toHaveLength(1);
    expect(
      findGuardRegressions([later('900_d.sql', 'GRANT UPDATE ON "public"."oauth_apps" TO app_user;')]),
    ).toHaveLength(1);
  });

  it('fires on DISABLE TRIGGER ALL / USER, which kill the guard without naming it', () => {
    // Stronger than the ALWAYS-downgrade case already covered, and valid SQL.
    expect(
      findGuardRegressions([later('900_e.sql', 'ALTER TABLE oauth_apps DISABLE TRIGGER ALL;')]),
    ).toHaveLength(1);
    expect(
      findGuardRegressions([later('900_f.sql', 'ALTER TABLE public.oauth_apps DISABLE TRIGGER USER;')]),
    ).toHaveLength(1);
  });

  it('stays quiet on DISABLE TRIGGER ALL for a different table', () => {
    expect(
      findGuardRegressions([later('900_g.sql', 'ALTER TABLE customers DISABLE TRIGGER ALL;')]),
    ).toEqual([]);
  });

  it('ignores SQL comments, so prose about the hazard does not fail the build', () => {
    expect(
      findGuardRegressions([
        later('708_comment.sql', `-- Do not GRANT UPDATE ON oauth_apps TO app_user here.\nSELECT 1;`),
      ]),
    ).toEqual([]);
  });
});
