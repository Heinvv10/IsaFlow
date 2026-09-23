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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const OWNER = 'oauth-trust-flag-test-user';

/**
 * Run `body` as app_user inside a rolled-back transaction, with the RLS claim
 * set so the owner policy admits the row. Returns the error message, or null
 * when the statement succeeded.
 */
async function asAppUser(body: (q: (text: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: OWNER }),
    ]);
    await client.query('SET LOCAL ROLE app_user');
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
    expect(err).toMatch(/permission denied/i);
  });

  it('refuses an INSERT that names is_first_party', async () => {
    const err = await asAppUser(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id, is_first_party)
         VALUES ('Forged', ARRAY['https://e.example/cb'], 'c_forge_first', $1, TRUE)`,
        [OWNER],
      );
    });
    expect(err).toMatch(/permission denied/i);
  });

  it('refuses an UPDATE of is_verified on a row the role owns', async () => {
    const err = await asAppUser(async (q) => {
      await q(`UPDATE oauth_apps SET is_verified = TRUE WHERE owner_user_id = $1`, [OWNER]);
    });
    expect(err).toMatch(/permission denied/i);
  });

  // The other half of the gate: tightening a privilege breaks things in the
  // other direction too, so prove the writes the app DOES make still work.
  it('still allows registerOauthApp\'s own column list, with both flags false', async () => {
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
    });
    expect(err).toBeNull();
    // The DEFAULT still applies to a column the writer may not name.
    expect(flags).toEqual({ is_verified: false, is_first_party: false });
  });

  it('still allows revokeOauthApp\'s UPDATE of revoked_at', async () => {
    const err = await asAppUser(async (q) => {
      await q(
        `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id,
                                 is_dynamic, token_endpoint_auth_method)
         VALUES ('Legit', ARRAY['https://ok.example/cb'], 'c_revoke_trust', $1, TRUE, 'none')`,
        [OWNER],
      );
      await q(`UPDATE oauth_apps SET revoked_at = NOW() WHERE client_id = 'c_revoke_trust'`);
    });
    expect(err).toBeNull();
  });
});
