// tests/integration/oauth-apps-trust-flags.int.test.ts
//
// The oauth_apps trust flags must be unwritable by the application role.
//
// `is_verified` and `is_first_party` decide whether an app may put its own
// description, logo and homepage on the consent and revoke screens, and
// whether it wears a "Verified" badge. Nothing in the codebase sets either —
// so the question this test answers is not "does our code write them" but
// "would the DATABASE refuse if some future code did". Migration 693 answers
// it; this proves the answer, as app_user, by attempting the forgery.
//
// Outcome-based on purpose: it forges the row and asserts the write is
// refused, rather than asserting a string in relacl. An ACL assertion passes
// on a privilege that exists but is unreachable, and fails on a harmless
// catalog reformat.
//
// Since S-07c (migration 930) app_user may not INSERT or UPDATE oauth_apps at
// all, so the app_user tests below are refused at the table, before 693's
// column model is consulted; 930's every-deploy rule refuses that grant coming
// back. The owner-path tests still exercise 693's trigger.
//
// COLUMN PRIVILEGES ARE NOT ENOUGH, and the app_user tests below do not on
// their own prove the property. A table's OWNER is never checked against
// column privileges, the pool connects as `postgres`, and `postgres` owns
// oauth_apps. Only the routes that issue `SET LOCAL ROLE app_user` run as
// app_user — and pages/api/oauth/register.ts, the PUBLIC unauthenticated DCR
// endpoint, is `withErrorHandler(handler)` with no auth wrapper, so it writes
// as the owner. That is why migration 693 also installs a BEFORE trigger: a
// trigger fires for every role, owner included. The owner-path tests are the
// ones that cover the anonymous writer.
//
// Two traps this encodes, both hit while writing migration 693:
//  1. A column-level REVOKE against mig 348's TABLE-level grant is a no-op —
//     Postgres keeps the table privilege. The revoke must be table-level.
//  2. Applying the migration as `migration_admin` is ALSO a no-op: a role can
//     only revoke grants it issued, and these came from `postgres`, the table
//     owner. The runner uses DATABASE_URL (postgres), which is why it works.
//     Anyone re-applying this by hand as migration_admin will see "REVOKE"
//     printed and nothing change.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

// vitest.integration.config.ts substitutes a `dummy.neon.tech` placeholder
// when the env var is unset, so a bare `!DATABASE_URL` check passes and the
// suite then dies on `ENOTFOUND dummy.neon.tech`. Same explicit throw as
// share-link-lifecycle and statement-grid-foots: this file does NOT skip,
// because a guard that can silently not run is the defect class the repo's
// own text-only CI gates exist to avoid.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.includes('dummy.neon.tech')) {
  throw new Error('oauth-apps-trust-flags requires a real DATABASE_URL; it does not skip');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const OWNER = 'oauth-trust-flag-test-user';

/**
 * Run `body` as app_user inside a rolled-back transaction, with the RLS claim
 * set so the owner policy admits the row. Returns the error message, or null
 * when the statement succeeded.
 */
async function asAppUser(body: (q: (text: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
  role: 'app_user' | 'migration_admin' = 'app_user') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: OWNER }),
    ]);
    await client.query(`SET LOCAL ROLE ${role}`);
    try {
      await body((text, params) => client.query(text, params as never[]));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, email) VALUES ($1, 'oauth-trust-flag@isaflow.test')
       ON CONFLICT (id) DO NOTHING`,
    [OWNER],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM oauth_apps WHERE owner_user_id = $1', [OWNER]);
  await pool.query('DELETE FROM users WHERE id = $1', [OWNER]);
  await pool.end();
});

describe('oauth_apps trust flags (migration 693)', () => {
  it('refuses an INSERT that names is_verified', async () => {
    const err = await asAppUser(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id, is_verified)
         VALUES ('Forged', ARRAY['https://e.example/cb'], 'c_forge_verified', $1, TRUE)`,
        [OWNER],
      );
    });
    // The exact text, not /permission denied/: that looser pattern also matches
    // `permission denied to set role "app_user"`, which is what SET LOCAL ROLE
    // raises if the connecting role ever loses `GRANT app_user TO postgres`
    // (mig 348:21). This test would then pass having never reached the INSERT.
    expect(err).toMatch(/permission denied for table oauth_apps/i);
  });

  it('refuses an INSERT that names is_first_party', async () => {
    const err = await asAppUser(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id, is_first_party)
         VALUES ('Forged', ARRAY['https://e.example/cb'], 'c_forge_first', $1, TRUE)`,
        [OWNER],
      );
    });
    expect(err).toMatch(/permission denied for table oauth_apps/i);
  });

  it('refuses an UPDATE of is_verified on a row the role owns', async () => {
    const err = await asAppUser(async (q) => {
      await q(`UPDATE oauth_apps SET is_verified = TRUE WHERE owner_user_id = $1`, [OWNER]);
    });
    expect(err).toMatch(/permission denied for table oauth_apps/i);
  });

  // The other half of the gate: tightening a privilege breaks things in the
  // other direction too, so prove the writes the app DOES make still work.
  // Since S-07c (930) app_user may not write oauth_apps at all; registerOauthApp
  // and revokeOauthApp run on the migration_admin pool.
  it('refuses registerOauthApp\'s own column list as app_user (930)', async () => {
    const err = await asAppUser(async (q) => {
      await q(`INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id, is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', ARRAY['https://ok.example/cb'], 'c_legit_app_user', $1, TRUE, 'none')`, [OWNER]);
    });
    expect(err).toBe('permission denied for table oauth_apps');
  });

  it('still allows registerOauthApp\'s own column list on migration_admin, with both flags false', async () => {
    let flags: { is_verified: boolean; is_first_party: boolean } | undefined;
    const err = await asAppUser(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, description, logo_url, homepage_url, redirect_uris,
                                 client_id, client_secret_hash, client_secret_prefix,
                                 owner_user_id, is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', NULL, NULL, NULL, ARRAY['https://ok.example/cb'],
                 'c_legit_trust', NULL, NULL, $1, TRUE, 'none')`,
        [OWNER],
      );
      const res = (await q(
        `SELECT is_verified, is_first_party FROM oauth_apps WHERE client_id = 'c_legit_trust'`,
      )) as { rows: { is_verified: boolean; is_first_party: boolean }[] };
      flags = res.rows[0];
    }, 'migration_admin');
    expect(err).toBeNull();
    // The DEFAULT still applies to a column the writer may not name.
    expect(flags).toEqual({ is_verified: false, is_first_party: false });
  });

  // ── The owner path: the public DCR endpoint writes as postgres ───────────
  // These are the anonymous-registration cases. Column privileges do not apply
  // to the owner, so if the trigger were removed these would pass a forged row.
  const asOwner = async (body: (q: (t: string, p?: unknown[]) => Promise<unknown>) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await body((t, p) => client.query(t, p as never[]));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };

  it('refuses a forged INSERT from the OWNER, which is what the DCR route is', async () => {
    const err = await asOwner(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_verified, is_first_party)
         VALUES ('DCR Forged', ARRAY['https://e.example/cb'], 'c_owner_forge', $1, TRUE, TRUE)`,
        [OWNER],
      );
    });
    // The trigger's message, not a privilege error — the owner has the privilege.
    expect(err).toMatch(/may not be set by the application/i);
  });

  it('refuses the OWNER changing is_verified on an existing row', async () => {
    const err = await asOwner(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', ARRAY['https://ok.example/cb'], 'c_owner_flip', $1, TRUE, 'none')`,
        [OWNER],
      );
      await q(`UPDATE oauth_apps SET is_verified = TRUE WHERE client_id = 'c_owner_flip'`);
    });
    expect(err).toMatch(/may not be changed by the application/i);
  });

  it('lets the OWNER register normally — the trigger must not break the DCR route', async () => {
    const err = await asOwner(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, description, logo_url, homepage_url, redirect_uris,
                                 client_id, client_secret_hash, client_secret_prefix,
                                 owner_user_id, is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', NULL, NULL, NULL, ARRAY['https://ok.example/cb'],
                 'c_owner_ok', NULL, NULL, $1, TRUE, 'none')`,
        [OWNER],
      );
      await q(`UPDATE oauth_apps SET revoked_at = NOW() WHERE client_id = 'c_owner_ok'`);
    });
    expect(err).toBeNull();
  });

  // `session_replication_role = 'replica'` skips every ordinary ('O') trigger,
  // and setting it does NOT need superuser — the pool role has rolsuper = f
  // and can set it. That is the role the anonymous DCR endpoint runs as, so
  // this is the bypass sitting on the exact path the guard exists for. The
  // migration answers it with ENABLE ALWAYS; this proves the answer.
  it('is not bypassable by session_replication_role (the trigger is ENABLE ALWAYS)', async () => {
    const err = await asOwner(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_dynamic, token_endpoint_auth_method)
         VALUES ('Replica', ARRAY['https://ok.example/cb'], 'c_replica_test', $1, TRUE, 'none')`,
        [OWNER],
      );
      await q(`SET LOCAL session_replication_role = 'replica'`);
      await q(`UPDATE oauth_apps SET is_first_party = TRUE WHERE client_id = 'c_replica_test'`);
    });
    expect(err).toMatch(/may not be changed by the application/i);
  });

  // A BEFORE trigger alone is a convention, not a guard: BEFORE row triggers
  // fire in NAME order and each one's NEW feeds the next, so a later-sorting
  // trigger can set a flag on a row this guard already approved — the row
  // checked is not the row stored. Reproduced before the fix: a `zz_later`
  // BEFORE INSERT doing `NEW.is_verified := TRUE` stored is_verified = t with
  // no error. The AFTER trigger sees the STORED row and cannot be pre-empted,
  // because AFTER triggers cannot modify NEW.
  it('cannot be pre-empted by a later-sorting BEFORE trigger', async () => {
    const err = await asOwner(async (q) => {
      await q(`CREATE OR REPLACE FUNCTION zz_trust_probe() RETURNS trigger
               LANGUAGE plpgsql AS $f$ BEGIN NEW.is_verified := TRUE; RETURN NEW; END $f$`);
      await q(`CREATE TRIGGER zz_trust_probe_trg BEFORE INSERT ON oauth_apps
               FOR EACH ROW EXECUTE FUNCTION zz_trust_probe()`);
      // Names no flag, so the BEFORE guard passes it; zz_ then sets it.
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_dynamic, token_endpoint_auth_method)
         VALUES ('ordering', ARRAY['https://ok.example/cb'], 'c_zz_order', $1, TRUE, 'none')`,
        [OWNER],
      );
    });
    expect(err).toMatch(/may not be set by the application/i);
  });

  // Asserting the MODE, not just existence: a later `ALTER TABLE ... ENABLE
  // TRIGGER` silently resets ALWAYS back to 'O' and re-opens the bypass, and
  // an existence-only check stays green through that. Verified: the existence
  // query returns true on a downgraded trigger.
  it('keeps BOTH triggers in ALWAYS mode', async () => {
    const res = await pool.query(
      `SELECT tgname, tgenabled::text AS mode FROM pg_trigger
        WHERE tgrelid = 'oauth_apps'::regclass
          AND NOT tgisinternal
          AND tgname IN ('oauth_apps_guard_trust_flags_trg',
                         'oauth_apps_guard_trust_flags_after_trg')
        ORDER BY tgname`,
    );
    expect(res.rows.map((r: { tgname: string; mode: string }) => [r.tgname, r.mode])).toEqual([
      ['oauth_apps_guard_trust_flags_after_trg', 'A'],
      ['oauth_apps_guard_trust_flags_trg', 'A'],
    ]);
  });

  // The escape hatch has to work, or nobody can ever verify an app at all —
  // which was the open question behind this whole change.
  it('allows a deliberate hand-SQL write under the explicit GUC', async () => {
    let verified: boolean | undefined;
    const err = await asOwner(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', ARRAY['https://ok.example/cb'], 'c_guc', $1, TRUE, 'none')`,
        [OWNER],
      );
      await q(`SET LOCAL isaflow.allow_trust_flag_write = 'on'`);
      await q(`UPDATE oauth_apps SET is_verified = TRUE WHERE client_id = 'c_guc'`);
      const res = (await q(
        `SELECT is_verified FROM oauth_apps WHERE client_id = 'c_guc'`,
      )) as { rows: { is_verified: boolean }[] };
      verified = res.rows[0]?.is_verified;
    });
    expect(err).toBeNull();
    expect(verified).toBe(true);
  });

  it('still allows revokeOauthApp\'s UPDATE of revoked_at on migration_admin, and refuses it as app_user (930)', async () => {
    await pool.query(`INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id, is_dynamic, token_endpoint_auth_method)
      VALUES ('Legit', ARRAY['https://ok.example/cb'], 'c_revoke_trust', $1, TRUE, 'none')`, [OWNER]);
    // An UPDATE that can set revoked_at can clear it and revive the app.
    expect(await asAppUser(async (q) => {
      await q(`UPDATE oauth_apps SET revoked_at = NOW() WHERE client_id = 'c_revoke_trust'`);
    })).toBe('permission denied for table oauth_apps');
    expect(await asAppUser(async (q) => {
      await q(`UPDATE oauth_apps SET revoked_at = NOW() WHERE client_id = 'c_revoke_trust'`);
    }, 'migration_admin')).toBeNull();
  });
});
