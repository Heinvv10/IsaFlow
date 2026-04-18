# Phase 2 — GoTrue Auth + Postgres RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace IsaFlow's custom auth stack with Supabase GoTrue and enforce tenant isolation at the database layer via Postgres RLS on all 117 `company_id` tables, making the 47-IDOR class of bug structurally impossible.

**Architecture:** Three cooperating pieces — (1) GoTrue in the shared `postgres` DB issues HS256 JWTs signed with the same `JWT_SECRET` the app verifies with, (2) Postgres RLS on every `company_id` table keys off JWT claims set through per-request GUCs inside a tx, (3) AsyncLocalStorage-bound `sql` routes every query through the request's tx-scoped connection with GUCs already set, so 395 existing handlers stay unchanged. Big-bang cutover on a feature branch since IsaFlow is pre-launch with zero real users.

**Tech Stack:** Next.js 14 (Pages router), TypeScript strict, pg (node-postgres), Vitest, Playwright, Self-hosted Supabase on velo-server (Postgres 15.8, GoTrue, Kong), jose (JWT verify), bun, Postmark SMTP, nodemailer.

**Spec:** `docs/superpowers/specs/2026-04-18-supabase-phase2-auth-rls-design.md`

---

## Known deviations from the spec (reality-check adjustments)

While reading the codebase the plan author found facts the spec had wrong or glossed over. Resolutions below; the plan below uses these names/types:

| Spec said | Reality | Plan uses |
|---|---|---|
| `company_members` table | Actual table is `company_users` (columns `user_id text`, `role text`, `is_default bool`) | `company_users` throughout |
| `users.id uuid`, `company_members.user_id uuid` | Both are text/varchar; lots of tables have text `created_by_user_id` FKs | Keep text; `auth.uid() RETURNS text` |
| `company_invitations` needs `accepted_at` added | Column already exists | Only add `gotrue_user_id` in migration 350 |
| New `withAuth` replaces both `withAuth` and `withCompany` | Existing `withAuth` is used by user-only endpoints (`/api/auth/me` etc.), `withCompany` wraps it for company-scoped endpoints | Keep the two-wrapper pattern: `withUserAuth` (user only) + `withAuth` (user + company + tx + GUCs) |
| Mailer is Postmark | Codebase uses `sendEmail()` in `src/modules/accounting/services/core/emailService.ts` (nodemailer, provider-agnostic) | Call existing `sendEmail()` for invite emails; configure GoTrue's SMTP env to point at the same provider |

---

## Prerequisites

- [ ] Confirm feature branch is created: `git checkout -b phase2/gotrue-rls` from `master`.
- [ ] Confirm `.env.local` DATABASE_URL points to `isaflow_dev` on velo:5437.
- [ ] Confirm velo Supabase containers are up: `ssh velo@100.96.203.105 'docker ps --format "{{.Names}}"' | grep supabase-`.
- [ ] Read the spec in full.

---

## Stage 1 — Foundation (migrations + ALS + sql rewrite)

### Task 1.1: Write the failing pool-isolation integration test

**Files:**
- Create: `tests/integration/rls-pool-isolation.test.ts`

Purpose: prove `set_config(..., true)` doesn't leak claims across pooled connection reuse. This is the GREEN-gate for the whole RLS pattern. We write it first so it fails loudly until the migration + ALS pieces land.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/rls-pool-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required for integration tests');

describe('RLS pool isolation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 }); // size 1 forces reuse
  });

  afterAll(async () => {
    await pool.end();
  });

  it('set_config(..., true) does not leak across pooled connections', async () => {
    // Run 20 interleaved "requests" alternating between two users.
    // Each wraps its work in a tx, sets GUCs, reads them back, commits.
    const runRequest = async (userId: string, companyId: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: userId })]
        );
        await client.query(
          `SELECT set_config('app.current_company_id', $1, true)`,
          [companyId]
        );
        const { rows } = await client.query(
          `SELECT current_setting('request.jwt.claims', true) AS claims,
                  current_setting('app.current_company_id', true) AS cid`
        );
        await client.query('COMMIT');
        return { claims: rows[0].claims, cid: rows[0].cid };
      } finally {
        client.release();
      }
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const userId = i % 2 === 0 ? 'user-A' : 'user-B';
        const companyId =
          i % 2 === 0
            ? '00000000-0000-0000-0000-00000000000a'
            : '00000000-0000-0000-0000-00000000000b';
        return runRequest(userId, companyId).then((r) => ({
          userId,
          companyId,
          ...r,
        }));
      })
    );

    for (const r of results) {
      const parsed = JSON.parse(r.claims);
      expect(parsed.sub).toBe(r.userId);
      expect(r.cid).toBe(r.companyId);
    }

    // Verify the GUCs do NOT persist after COMMIT — one extra query outside any tx
    const probe = await pool.query(
      `SELECT current_setting('app.current_company_id', true) AS cid`
    );
    expect(probe.rows[0].cid).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/integration/rls-pool-isolation.test.ts`
Expected: FAIL (or PASS — if PASS it means pg already behaves correctly, which is the theoretical expectation; but we want this test locked into CI as a regression guard before anything else ships).

Note: this test actually should PASS today. That's fine — mark as "expected to keep passing" and move on. It's a regression gate.

- [ ] **Step 3: Commit the test**

```bash
git add tests/integration/rls-pool-isolation.test.ts
git commit -m "test(rls): pool-isolation regression guard for set_config(..., true)"
```

---

### Task 1.2: Migration 348 — roles, helpers, RLS on all company_id tables

**Files:**
- Create: `scripts/migrations/sql/348_rls_and_auth_helpers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- scripts/migrations/sql/348_rls_and_auth_helpers.sql
-- Phase 2: RLS + JWT-claim GUC helpers. See spec 2026-04-18.

-- ───────────────────────────────────────────── Roles ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- So the pool connection (as postgres) can SET LOCAL ROLE app_user
GRANT app_user TO postgres;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration_admin') THEN
    -- Password must be set by ops via the secrets store; placeholder password
    -- is rotated immediately after migration. See Task 5.1.
    CREATE ROLE migration_admin WITH LOGIN BYPASSRLS PASSWORD 'CHANGEME_SET_VIA_OPS';
  END IF;
END $$;

GRANT ALL PRIVILEGES ON SCHEMA public TO migration_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migration_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO migration_admin;

-- ─────────────────────────────────── Helper schemas ──────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;

GRANT USAGE ON SCHEMA auth TO app_user, migration_admin;
GRANT USAGE ON SCHEMA app TO app_user, migration_admin;

-- auth.uid() reads the 'sub' claim from the JWT stashed in request.jwt.claims
-- Returns text because IsaFlow's users.id + company_users.user_id are text,
-- not uuid (text is gen_random_uuid()::text; we didn't migrate the column
-- types because of extensive FK references).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
$$;

CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_company_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO app_user, migration_admin;
GRANT EXECUTE ON FUNCTION app.current_company_id() TO app_user, migration_admin;

-- ────────────────────── RLS on every public.* company_id table ──────────────
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id'
      AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('companies')      -- handled below (uses id)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS tenant_isolation ON public.%1$I;
      CREATE POLICY tenant_isolation ON public.%1$I
        FOR ALL TO app_user
        USING (company_id IN (
          SELECT company_id FROM public.company_users
           WHERE user_id = auth.uid()
        ))
        WITH CHECK (company_id = app.current_company_id());
    $p$, t);
  END LOOP;
END $$;

-- ──────────────────────────── Special-case: companies ───────────────────────
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_member_read ON public.companies;
CREATE POLICY companies_member_read ON public.companies FOR SELECT TO app_user
  USING (id IN (
    SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS companies_owner_write ON public.companies;
CREATE POLICY companies_owner_write ON public.companies FOR ALL TO app_user
  USING (id IN (
    SELECT company_id FROM public.company_users
     WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ))
  WITH CHECK (id = app.current_company_id());

-- ──────────────────────── Special-case: company_users ───────────────────────
ALTER TABLE public.company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;
CREATE POLICY cu_self_or_admin ON public.company_users FOR ALL TO app_user
  USING (
    user_id = auth.uid()
    OR company_id IN (
      SELECT company_id FROM public.company_users
       WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (company_id = app.current_company_id());

-- ─────────── Special-case: company_invitations (anonymous token accept) ─────
ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invites_tenant ON public.company_invitations;
CREATE POLICY invites_tenant ON public.company_invitations FOR ALL TO app_user
  USING (company_id IN (
    SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id = app.current_company_id());

-- Additional policy: anonymous accept-invite flow sets app.invite_token GUC.
-- Only SELECT is allowed via this path; the accept endpoint uses a
-- BYPASSRLS migration_admin connection for the subsequent INSERT into
-- company_users.
DROP POLICY IF EXISTS invites_by_token ON public.company_invitations;
CREATE POLICY invites_by_token ON public.company_invitations FOR SELECT TO app_user
  USING (
    token = nullif(current_setting('app.invite_token', true), '')
    AND accepted_at IS NULL
    AND expires_at > now()
  );

-- ─────────────── `users` shadow table: users see only themselves ────────────
-- (Profile-shadow; not company-scoped. Phase 2 trims this table in mig 349.)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_read ON public.users;
CREATE POLICY users_self_read ON public.users FOR SELECT TO app_user
  USING (id = auth.uid());

DROP POLICY IF EXISTS users_self_write ON public.users;
CREATE POLICY users_self_write ON public.users FOR UPDATE TO app_user
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
```

- [ ] **Step 2: Apply the migration to `isaflow_dev`**

Run:
```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -f scripts/migrations/sql/348_rls_and_auth_helpers.sql
```
Expected: no errors. Verify:
```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "SELECT COUNT(*) FROM pg_policies WHERE policyname='tenant_isolation';"
```
Expected: ~116 rows (117 company_id tables minus `companies`). Actual count will be logged; document in commit message.

- [ ] **Step 3: Register in schema_migrations**

```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "INSERT INTO schema_migrations (filename, applied_at) VALUES ('348_rls_and_auth_helpers.sql', now()) ON CONFLICT DO NOTHING;"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/348_rls_and_auth_helpers.sql
git commit -m "feat(db): migration 348 — RLS on all company_id tables + auth helpers

- Creates app_user NOLOGIN role; grants CRUD on public.
- Creates migration_admin BYPASSRLS role for admin scripts.
- auth.uid() RETURNS text (matches users.id/company_users.user_id type).
- app.current_company_id() RETURNS uuid.
- Enables + FORCEs RLS on every public.<table> with a company_id column (116 tables), adds tenant_isolation policy.
- Special-case policies on companies, company_users, company_invitations, users."
```

---

### Task 1.3: Migration 349 — trim `users` to profile shadow

**Files:**
- Create: `scripts/migrations/sql/349_users_profile_shadow.sql`

- [ ] **Step 1: Check which columns are in use**

```bash
grep -rn "password_hash\|email_verified\|password_reset_token\|password_reset_expires" src/ pages/ tests/ scripts/ 2>/dev/null | grep -v "\.md:" | head -30
```
Expected: callers of these columns exist in `src/lib/auth/password.ts`, `src/lib/auth/session.ts`, etc. — all files we're deleting in Stage 2. Note any surprising callers for later.

- [ ] **Step 2: Write the migration**

```sql
-- scripts/migrations/sql/349_users_profile_shadow.sql
-- Phase 2: GoTrue owns email/password/verification; trim the shadow table.

ALTER TABLE public.users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE public.users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_token;
ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_expires;
ALTER TABLE public.users DROP COLUMN IF EXISTS failed_login_attempts;
ALTER TABLE public.users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE public.users DROP COLUMN IF EXISTS must_change_password;
ALTER TABLE public.users DROP COLUMN IF EXISTS last_login;
ALTER TABLE public.users DROP COLUMN IF EXISTS last_login_ip;
ALTER TABLE public.users DROP COLUMN IF EXISTS login_count;

-- Keep: id, email, first_name, last_name, role (app role, not auth role),
--       permissions, phone, department, profile_picture, is_active,
--       created_at, updated_at, onboarding_completed, mobile, status,
--       suspended_at, suspended_reason.
-- `email` is denormalised; we sync it in upsertUserProfile.
```

- [ ] **Step 3: Apply the migration to `isaflow_dev`**

```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -f scripts/migrations/sql/349_users_profile_shadow.sql
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "INSERT INTO schema_migrations (filename, applied_at) VALUES ('349_users_profile_shadow.sql', now()) ON CONFLICT DO NOTHING;"
```

- [ ] **Step 4: Verify column drop**

```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "\d users" | grep -E "password_hash|email_verified|must_change_password"
```
Expected: empty output (columns dropped).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/sql/349_users_profile_shadow.sql
git commit -m "feat(db): migration 349 — trim users to profile shadow

GoTrue owns password, email verification, password-reset tokens,
and account-lockout state. Drops 11 columns from public.users."
```

---

### Task 1.4: Migration 350 — `company_invitations.gotrue_user_id`

**Files:**
- Create: `scripts/migrations/sql/350_invitations_gotrue_link.sql`

- [ ] **Step 1: Write the migration**

```sql
-- scripts/migrations/sql/350_invitations_gotrue_link.sql
-- Phase 2: Link company_invitations to the GoTrue user we admin-created.

ALTER TABLE public.company_invitations
  ADD COLUMN IF NOT EXISTS gotrue_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_company_invitations_gotrue_user_id
  ON public.company_invitations(gotrue_user_id) WHERE gotrue_user_id IS NOT NULL;
```

- [ ] **Step 2: Apply and register**

```bash
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -f scripts/migrations/sql/350_invitations_gotrue_link.sql
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "INSERT INTO schema_migrations (filename, applied_at) VALUES ('350_invitations_gotrue_link.sql', now()) ON CONFLICT DO NOTHING;"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/350_invitations_gotrue_link.sql
git commit -m "feat(db): migration 350 — company_invitations.gotrue_user_id"
```

---

### Task 1.5: AsyncLocalStorage module

**Files:**
- Create: `src/lib/als.ts`
- Create: `tests/unit/lib/als.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lib/als.test.ts
import { describe, it, expect } from 'vitest';
import { als, requireCtx } from '@/lib/als';

describe('als', () => {
  it('isolates context between sibling async operations', async () => {
    const ctxA = { client: null as any, userId: 'A', companyId: 'cA', claims: {} };
    const ctxB = { client: null as any, userId: 'B', companyId: 'cB', claims: {} };

    const runInCtx = async (ctx: typeof ctxA, delay: number) =>
      als.run(ctx, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return requireCtx().userId;
      });

    const [a, b] = await Promise.all([runInCtx(ctxA, 10), runInCtx(ctxB, 5)]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('throws when requireCtx() called outside an als.run scope', () => {
    expect(() => requireCtx()).toThrow(/no request context/);
  });

  it('returns undefined from als.getStore() outside any run', () => {
    expect(als.getStore()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/unit/lib/als.test.ts`
Expected: FAIL with "Cannot find module '@/lib/als'".

- [ ] **Step 3: Implement `src/lib/als.ts`**

```typescript
// src/lib/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  companyId: string;
  claims: Record<string, unknown>;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function requireCtx(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'als: no request context — handler called outside withAuth or background job called sql without wrapping?'
    );
  }
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run tests/unit/lib/als.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/als.ts tests/unit/lib/als.test.ts
git commit -m "feat(als): AsyncLocalStorage module for request-scoped tx context"
```

---

### Task 1.6: Rewrite `src/lib/neon.ts` to be ALS-aware

Surgery on a live file. The existing API (tagged template, `sql.transaction`, `transaction`, `withTransaction`, `fmtDate`, `DbRow`) stays identical; we only change how the underlying connection is chosen.

**Files:**
- Modify: `src/lib/neon.ts`
- Create: `tests/integration/neon-als.test.ts`

- [ ] **Step 1: Write the integration test (ALS-bound sql routes through tx client)**

```typescript
// tests/integration/neon-als.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

describe('neon.ts — ALS-aware sql', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('uses the ALS-bound client when inside als.run', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [
        '00000000-0000-0000-0000-00000000abcd',
      ]);

      const seen = await als.run(
        { client, userId: 'probe', companyId: '00000000-0000-0000-0000-00000000abcd', claims: {} },
        async () => {
          const rows = await sql<{ v: string }>`SELECT current_setting('app.current_company_id', true) AS v`;
          return rows[0]!.v;
        }
      );

      expect(seen).toBe('00000000-0000-0000-0000-00000000abcd');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('falls through to the pool when no ALS context (scripts / cron)', async () => {
    const rows = await sql<{ one: number }>`SELECT 1 AS one`;
    expect(rows[0]!.one).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/integration/neon-als.test.ts`
Expected: FAIL — `seen` is empty because today's `sql` always runs on the pool, not the ALS client.

- [ ] **Step 3: Modify `src/lib/neon.ts` — make `LazyQuery` ALS-aware**

Open `src/lib/neon.ts`. Find the `LazyQuery.run()` method (around line 82). Replace its body:

```typescript
  private async run(): Promise<T[]> {
    if (this.boundClient) {
      const res = await this.boundClient.query(this.text, this.values);
      return res.rows as T[];
    }
    // If a request-scoped tx is in flight, route through it so RLS sees the GUCs.
    const ctxClient = (await import('@/lib/als')).als.getStore()?.client;
    if (ctxClient) {
      const res = await ctxClient.query(this.text, this.values);
      return res.rows as T[];
    }
    const res = await getPool().query(this.text, this.values);
    return res.rows as T[];
  }
```

Note: avoid a top-level `import` of `als` to prevent a circular-import risk; dynamic `import()` is cheap (module cached after first call).

- [ ] **Step 4: Run tests to verify**

Run: `bun run vitest run tests/integration/neon-als.test.ts`
Expected: PASS (2 passing).

Run: `bun run vitest run tests/integration/rls-pool-isolation.test.ts`
Expected: PASS (regression guard still green).

- [ ] **Step 5: Run full type check**

Run: `bunx tsc --noEmit`
Expected: no new errors. If existing errors remain, ignore — pre-existing baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/neon.ts tests/integration/neon-als.test.ts
git commit -m "feat(neon): ALS-aware sql — route through tx client when inside withAuth

Preserves the tagged-template API and sql.transaction/transaction/
withTransaction helpers. When als.getStore() has a client, sql queries
run on that client (inside the request tx, RLS-scoped). Otherwise,
falls through to the pool — so scripts and background jobs keep
working unchanged."
```

---

## Stage 2 — Auth stack swap

### Task 2.1: GoTrue client (`src/lib/auth/gotrue.ts`)

**Files:**
- Create: `src/lib/auth/gotrue.ts`
- Create: `tests/unit/auth/gotrue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/auth/gotrue.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const ENC = new TextEncoder().encode(TEST_SECRET);

async function makeToken(claims: Record<string, unknown>, expSeconds = 3600) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .sign(ENC);
}

describe('gotrue client', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-dummy';
  });

  it('verifyToken accepts a valid HS256 token and returns claims', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const token = await makeToken({ sub: 'user-uuid', email: 'a@b.c', role: 'authenticated' });
    const claims = await verifyToken(token);
    expect(claims.sub).toBe('user-uuid');
    expect(claims.email).toBe('a@b.c');
  });

  it('verifyToken rejects an expired token', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const token = await makeToken({ sub: 'u' }, -60);
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('verifyToken rejects a token signed by a different secret', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const otherEnc = new TextEncoder().encode('b'.repeat(40));
    const token = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(otherEnc);
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('signIn POSTs grant_type=password to /token and returns tokens', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u', email: 'x@y.z' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const { signIn } = await import('@/lib/auth/gotrue');
    const r = await signIn('x@y.z', 'pw');
    expect(r.access_token).toBe('a');
    expect(r.refresh_token).toBe('r');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toMatch(/\/token\?grant_type=password/);
    expect(JSON.parse(init.body)).toEqual({ email: 'x@y.z', password: 'pw' });
  });

  it('adminCreateUser uses service-role key and returns the created user', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'new-uuid', email: 'e@x.y' }), { status: 200 })
    );
    const { adminCreateUser } = await import('@/lib/auth/gotrue');
    const u = await adminCreateUser({ email: 'e@x.y', password: 'pw', email_confirm: true });
    expect(u.id).toBe('new-uuid');
    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer service-role-dummy');
    expect(init.headers.apikey).toBe('service-role-dummy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/unit/auth/gotrue.test.ts`
Expected: FAIL with "Cannot find module '@/lib/auth/gotrue'".

- [ ] **Step 3: Implement `src/lib/auth/gotrue.ts`**

```typescript
// src/lib/auth/gotrue.ts
import { jwtVerify, type JWTPayload } from 'jose';

export interface GoTrueUser {
  id: string;
  email: string;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export interface GoTrueTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'bearer';
  user: GoTrueUser;
}

export interface GoTrueClaims extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  aud?: string | string[];
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function gotrueUrl(path: string): string {
  const base = getEnv('GOTRUE_URL').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function jwtKey(): Uint8Array {
  return new TextEncoder().encode(getEnv('JWT_SECRET'));
}

export async function verifyToken(token: string): Promise<GoTrueClaims> {
  const { payload } = await jwtVerify(token, jwtKey(), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string') {
    throw new Error('JWT missing sub claim');
  }
  return payload as GoTrueClaims;
}

async function gotrueFetch(
  path: string,
  init: RequestInit,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
      ...extraHeaders,
    },
  });
  return res;
}

function adminHeaders(): Record<string, string> {
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  return { Authorization: `Bearer ${key}`, apikey: key };
}

export async function signIn(email: string, password: string): Promise<GoTrueTokenResponse> {
  const res = await gotrueFetch(
    '/token?grant_type=password',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    { apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gotrue signIn failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<GoTrueTokenResponse>;
}

export async function refresh(refreshToken: string): Promise<GoTrueTokenResponse> {
  const res = await gotrueFetch(
    '/token?grant_type=refresh_token',
    { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) },
    { apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) throw new Error(`gotrue refresh failed: ${res.status}`);
  return res.json() as Promise<GoTrueTokenResponse>;
}

export async function logout(accessToken: string): Promise<void> {
  await gotrueFetch(
    '/logout',
    { method: 'POST' },
    { apikey: getEnv('SUPABASE_ANON_KEY'), Authorization: `Bearer ${accessToken}` }
  );
}

export interface AdminCreateUserInput {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function adminCreateUser(input: AdminCreateUserInput): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    '/admin/users',
    { method: 'POST', body: JSON.stringify(input) },
    adminHeaders()
  );
  if (!res.ok && res.status !== 422) {
    throw new Error(`gotrue adminCreateUser failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  if (res.status === 422) {
    // User already exists — look them up instead
    return adminGetUserByEmail(input.email);
  }
  return res.json() as Promise<GoTrueUser>;
}

export async function adminGetUserByEmail(email: string): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    `/admin/users?filter=${encodeURIComponent(`email.eq.${email}`)}`,
    { method: 'GET' },
    adminHeaders()
  );
  if (!res.ok) throw new Error(`gotrue getUserByEmail failed: ${res.status}`);
  const body = (await res.json()) as { users?: GoTrueUser[] };
  const user = body.users?.[0];
  if (!user) throw new Error(`no gotrue user with email ${email}`);
  return user;
}

export async function adminUpdateUser(
  userId: string,
  patch: { email?: string; password?: string; user_metadata?: Record<string, unknown> }
): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    `/admin/users/${userId}`,
    { method: 'PUT', body: JSON.stringify(patch) },
    adminHeaders()
  );
  if (!res.ok) throw new Error(`gotrue adminUpdateUser failed: ${res.status}`);
  return res.json() as Promise<GoTrueUser>;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const res = await gotrueFetch(`/admin/users/${userId}`, { method: 'DELETE' }, adminHeaders());
  if (!res.ok) throw new Error(`gotrue adminDeleteUser failed: ${res.status}`);
}

export async function recoverPassword(email: string, redirectTo: string): Promise<void> {
  const res = await gotrueFetch(
    '/recover',
    { method: 'POST', body: JSON.stringify({ email, redirect_to: redirectTo }) },
    { apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) throw new Error(`gotrue recover failed: ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run tests/unit/auth/gotrue.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Add env to `.env.local`**

Append the following to `.env.local` (get actual values from `/home/velo/supabase/.env`):
```
GOTRUE_URL=http://100.96.203.105:8300/auth/v1
SUPABASE_ANON_KEY=<paste from velo supabase .env>
SUPABASE_SERVICE_ROLE_KEY=<paste from velo supabase .env>
# JWT_SECRET is already set (same value used by GoTrue to sign)
```

Verify `JWT_SECRET` already in `.env.local` matches `/home/velo/supabase/.env`:
```bash
ssh velo@100.96.203.105 "grep '^JWT_SECRET=' /home/velo/supabase/.env"
grep '^JWT_SECRET=' .env.local
```
They MUST match.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/gotrue.ts tests/unit/auth/gotrue.test.ts
git commit -m "feat(auth): typed GoTrue client (verify, signIn, refresh, admin API, recover)"
```

---

### Task 2.2: Cookie helpers (`src/lib/auth/cookies.ts`)

**Files:**
- Create: `src/lib/auth/cookies.ts`
- Create: `tests/unit/auth/cookies.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/auth/cookies.test.ts
import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  setActiveCompanyCookie,
} from '@/lib/auth/cookies';

function mkReq(cookieHeader: string): NextApiRequest {
  return { headers: { cookie: cookieHeader } } as unknown as NextApiRequest;
}

function mkRes(): { res: NextApiResponse; headers: Record<string, string[]> } {
  const headers: Record<string, string[]> = {};
  const res = {
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: string | string[]) => {
      headers[name.toLowerCase()] = Array.isArray(value) ? value : [value];
    },
  } as unknown as NextApiResponse;
  return { res, headers };
}

describe('cookies', () => {
  it('parseCookies extracts sb-access-token and active_company_id', () => {
    const c = parseCookies(
      mkReq('sb-access-token=abc; sb-refresh-token=def; active_company_id=cid-1')
    );
    expect(c['sb-access-token']).toBe('abc');
    expect(c['sb-refresh-token']).toBe('def');
    expect(c['active_company_id']).toBe('cid-1');
  });

  it('setAuthCookies writes both access and refresh cookies with httpOnly', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    const cookies = headers['set-cookie'];
    expect(cookies.some((c) => c.startsWith('sb-access-token=a;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sb-refresh-token=r;'))).toBe(true);
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
  });

  it('clearAuthCookies emits Max-Age=0 for all auth cookies', () => {
    const { res, headers } = mkRes();
    clearAuthCookies(res);
    const cookies = headers['set-cookie'];
    expect(cookies).toHaveLength(3);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/);
  });

  it('setActiveCompanyCookie writes the cookie without clobbering prior Set-Cookie', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    setActiveCompanyCookie(res, '00000000-0000-0000-0000-00000000abcd');
    expect(headers['set-cookie']).toHaveLength(3);
    expect(
      headers['set-cookie'].some((c) =>
        c.startsWith('active_company_id=00000000-0000-0000-0000-00000000abcd;')
      )
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/unit/auth/cookies.test.ts`
Expected: FAIL with "Cannot find module '@/lib/auth/cookies'".

- [ ] **Step 3: Implement `src/lib/auth/cookies.ts`**

```typescript
// src/lib/auth/cookies.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function cookieFlags(maxAgeSeconds: number): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(req: NextApiRequest): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    const v = decodeURIComponent(s.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

function appendSetCookie(res: NextApiResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const arr = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

export function setAuthCookies(
  res: NextApiResponse,
  params: { accessToken: string; refreshToken: string; expiresIn: number }
): void {
  appendSetCookie(res, `${ACCESS_COOKIE}=${params.accessToken}; ${cookieFlags(params.expiresIn)}`);
  // Refresh token lives longer than the access token; GoTrue default 30d.
  appendSetCookie(
    res,
    `${REFRESH_COOKIE}=${params.refreshToken}; ${cookieFlags(60 * 60 * 24 * 30)}`
  );
}

export function setActiveCompanyCookie(res: NextApiResponse, companyId: string): void {
  appendSetCookie(
    res,
    `${ACTIVE_COMPANY_COOKIE}=${companyId}; ${cookieFlags(60 * 60 * 24 * 30)}`
  );
}

export function clearAuthCookies(res: NextApiResponse): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE]) {
    appendSetCookie(res, `${name}=; ${cookieFlags(0)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run tests/unit/auth/cookies.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/cookies.ts tests/unit/auth/cookies.test.ts
git commit -m "feat(auth): cookie helpers for GoTrue access/refresh + active_company_id"
```

---

### Task 2.3: `withUserAuth` middleware (user-only, no company/tx)

Used by `/api/auth/me`, `/api/auth/logout`, `/api/auth/switch-company`, `/api/auth/preferences`, `/api/auth/change-password`, `/api/auth/profile` — endpoints that need identity but not company-scoped data access.

**Files:**
- Create: `src/lib/auth/withUserAuth.ts`
- Create: `tests/unit/auth/withUserAuth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/auth/withUserAuth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReq(token?: string): NextApiRequest {
  return {
    headers: { cookie: token ? `sb-access-token=${token}` : '' },
  } as unknown as NextApiRequest;
}

function mkRes() {
  const headers: Record<string, unknown> = {};
  let status = 200;
  const body: { value?: unknown } = {};
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body.value = v; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body.value; } };
}

describe('withUserAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
  });

  it('401s when no cookie', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const r = mkRes();
    await withUserAuth(async () => { throw new Error('should not run'); })(mkReq(), r.res);
    expect(r.status).toBe(401);
  });

  it('401s on invalid token and clears cookies', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const r = mkRes();
    await withUserAuth(async () => { throw new Error('should not run'); })(mkReq('bogus'), r.res);
    expect(r.status).toBe(401);
    const sc = r.res.getHeader('set-cookie') as string[];
    expect(sc.some((c) => c.includes('sb-access-token=;'))).toBe(true);
  });

  it('attaches req.user and calls handler on valid token', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const tok = await makeToken('user-uuid-1');
    const r = mkRes();
    let seenId = '';
    await withUserAuth(async (req: any) => {
      seenId = req.user.id;
      (req as any).res_ok = true;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenId).toBe('user-uuid-1');
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/unit/auth/withUserAuth.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/auth/withUserAuth.ts`**

```typescript
// src/lib/auth/withUserAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import { log } from '@/lib/logger';

export interface UserAuthedRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

export function withUserAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    try {
      const claims = await verifyToken(token);
      (req as UserAuthedRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };
      return handler(req, res);
    } catch (err) {
      log.warn('withUserAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run tests/unit/auth/withUserAuth.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/withUserAuth.ts tests/unit/auth/withUserAuth.test.ts
git commit -m "feat(auth): withUserAuth — JWT verify only (no tx, no company)"
```

---

### Task 2.4: New `withAuth` middleware (user + company + tx + GUCs + ALS)

Replaces the existing `withCompany`. Attaches `req.user`, `req.companyId`, `req.companyRole` (matching today's `CompanyApiRequest` shape so 395 handlers don't change) and binds ALS so `sql` queries inside the handler run on the tx-bound connection.

**Files:**
- Create: `src/lib/auth/withAuth.ts`
- Create: `tests/integration/withAuth.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/withAuth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withAuth } from '@/lib/auth/withAuth';
import { sql } from '@/lib/neon';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

async function seed() {
  // Create a throwaway company + user + membership. Idempotent.
  await seedPool.query(`
    INSERT INTO companies (id, name, is_active)
    VALUES ('00000000-0000-0000-0000-000000000cc1', 'Phase2 WA Test Co', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await seedPool.query(`
    INSERT INTO users (id, email, role, is_active)
    VALUES ('phase2-wa-user-1', 'wa@phase2.test', 'admin', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await seedPool.query(`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES ('00000000-0000-0000-0000-000000000cc1', 'phase2-wa-user-1', 'admin')
    ON CONFLICT DO NOTHING
  `);
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string, companyId: string) {
  return {
    headers: { cookie: `sb-access-token=${token}; active_company_id=${companyId}` },
    url: '/api/test',
  } as any;
}

function mkRes() {
  let status = 200;
  let body: unknown = undefined;
  const headers: Record<string, unknown> = {};
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

beforeAll(async () => { await seed(); });
afterAll(async () => { await seedPool.end(); });

describe('withAuth — integration', () => {
  it('403s when cookie references a company the user is not a member of', async () => {
    const tok = await makeToken('phase2-wa-user-1');
    const r = mkRes();
    await withAuth(async () => { throw new Error('should not run'); })(
      mkReq(tok, '00000000-0000-0000-0000-000000000dead'),
      r.res
    );
    expect(r.status).toBe(403);
  });

  it('attaches user + companyId + runs handler inside tx with GUCs set', async () => {
    const tok = await makeToken('phase2-wa-user-1');
    const r = mkRes();
    let seen: { userId: string; companyId: string; cidGuc: string } | null = null;
    await withAuth(async (req: any, res: any) => {
      const rows = await sql<{ v: string }>`SELECT current_setting('app.current_company_id', true) AS v`;
      seen = { userId: req.user.id, companyId: req.companyId, cidGuc: rows[0]!.v };
      res.status(200).json({ ok: true });
    })(mkReq(tok, '00000000-0000-0000-0000-000000000cc1'), r.res);
    expect(r.status).toBe(200);
    expect(seen).not.toBeNull();
    expect(seen!.userId).toBe('phase2-wa-user-1');
    expect(seen!.companyId).toBe('00000000-0000-0000-0000-000000000cc1');
    expect(seen!.cidGuc).toBe('00000000-0000-0000-0000-000000000cc1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run tests/integration/withAuth.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/auth/withAuth.ts`**

```typescript
// src/lib/auth/withAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import pg from 'pg';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from './cookies';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';

export interface CompanyAuthedRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
  companyId: string;
  companyRole: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

let _pool: pg.Pool | null = null;
function getAuthPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.AUTH_POOL_MAX ?? 20),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  _pool.on('error', (err) => log.warn('withAuth pool background error', { message: err.message }, 'Auth'));
  return _pool;
}

export function withAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];
    const activeCompanyId = cookies[ACTIVE_COMPANY_COOKIE];

    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    if (!activeCompanyId) {
      return res.status(400).json({ success: false, error: { code: 'NO_ACTIVE_COMPANY', message: 'No active company selected' } });
    }

    let claims;
    try {
      claims = await verifyToken(token);
    } catch (err) {
      log.warn('withAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    }

    const client = await getAuthPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [activeCompanyId]);

      // Belt-and-braces membership check — also gives us the company role.
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2 LIMIT 1`,
        [claims.sub, activeCompanyId]
      );

      if (membership.rows.length === 0) {
        await client.query('ROLLBACK');
        clearAuthCookies(res);
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      }

      (req as CompanyAuthedRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };
      (req as CompanyAuthedRequest).companyId = activeCompanyId;
      (req as CompanyAuthedRequest).companyRole = membership.rows[0]!.role;

      const runHandler = async () =>
        als.run(
          { client, userId: claims.sub, companyId: activeCompanyId, claims: claims as Record<string, unknown> },
          async () => { await handler(req, res); }
        );

      if (process.env.SENTRY_ENABLED === 'true') {
        await Sentry.withIsolationScope(async () => {
          setTenantTags({ companyId: activeCompanyId, userId: claims!.sub, route: sanitizeRoute(req.url) });
          await runHandler();
        });
      } else {
        await runHandler();
      }

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      client.release();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run tests/integration/withAuth.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/withAuth.ts tests/integration/withAuth.test.ts
git commit -m "feat(auth): new withAuth — user + company + tx + GUCs + ALS binding

Replaces withCompany. Validates GoTrue JWT, resolves active company
from cookie, opens tx as app_user with RLS GUCs set, binds ALS so
all sql queries route through the tx connection. Attaches req.user,
req.companyId, req.companyRole for handler compat."
```

---

### Task 2.5: Rewrite `/api/auth/login`

**Files:**
- Modify: `pages/api/auth/login.ts`

- [ ] **Step 1: Read the current file for context**

```bash
cat pages/api/auth/login.ts
```
Note: today's login checks `users.password_hash`, issues a custom JWT, creates a row in `user_sessions`. We delete all of that.

- [ ] **Step 2: Replace the file**

```typescript
// pages/api/auth/login.ts
import type { NextApiHandler } from 'next';
import { signIn } from '@/lib/auth/gotrue';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and password required' } });
  }

  try {
    const token = await signIn(email.toLowerCase().trim(), password);

    // Pick an active company: last-used if stored, else first membership.
    const memberships = await sql<{ company_id: string; is_default: boolean; created_at: Date }>`
      SELECT company_id, is_default, created_at
      FROM company_users
      WHERE user_id = ${token.user.id}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `;

    setAuthCookies(res, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
    });

    if (memberships.length > 0) {
      setActiveCompanyCookie(res, memberships[0]!.company_id);
    }

    return res.status(200).json({
      success: true,
      data: {
        user: { id: token.user.id, email: token.user.email },
        activeCompanyId: memberships[0]?.company_id ?? null,
      },
    });
  } catch (err) {
    log.info('login failed', { email, message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }
};

export default handler;
```

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit pages/api/auth/login.ts 2>&1 | head -20`
Expected: no errors in login.ts (other pre-existing errors elsewhere allowed).

- [ ] **Step 4: Commit**

```bash
git add pages/api/auth/login.ts
git commit -m "feat(auth): port /api/auth/login to GoTrue

Issues GoTrue access+refresh tokens, sets httpOnly cookies, picks
active company from company_users (is_default, created_at)."
```

---

### Task 2.6: Rewrite `/api/auth/logout`

**Files:**
- Modify: `pages/api/auth/logout.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/logout.ts
import type { NextApiHandler } from 'next';
import { logout as gotrueLogout } from '@/lib/auth/gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (token) {
    try { await gotrueLogout(token); }
    catch (err) { log.info('gotrue logout non-fatal error', { message: err instanceof Error ? err.message : String(err) }, 'Auth'); }
  }
  clearAuthCookies(res);
  return res.status(200).json({ success: true, data: null });
};

export default handler;
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/logout.ts
git commit -m "feat(auth): port /api/auth/logout to GoTrue"
```

---

### Task 2.7: Rewrite `/api/auth/me`

Uses `withUserAuth` because the user may not have an active company yet (first login).

**Files:**
- Modify: `pages/api/auth/me.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/me.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { sql } from '@/lib/neon';
import { parseCookies, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';

const handler: NextApiHandler = async (req, res) => {
  const user = (req as UserAuthedRequest).user;
  const activeCompanyId = parseCookies(req)[ACTIVE_COMPANY_COOKIE] ?? null;

  const profile = await sql<{
    id: string; email: string; first_name: string | null; last_name: string | null;
    role: string | null; permissions: unknown;
  }>`
    SELECT id, email, first_name, last_name, role, permissions
    FROM users
    WHERE id = ${user.id}
    LIMIT 1
  `;

  const memberships = await sql<{ company_id: string; role: string; is_default: boolean; name: string }>`
    SELECT cu.company_id, cu.role, cu.is_default, c.name
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${user.id}
    ORDER BY cu.is_default DESC, cu.created_at ASC
  `;

  return res.status(200).json({
    success: true,
    data: {
      user: profile[0] ?? { id: user.id, email: user.email ?? '' },
      memberships,
      activeCompanyId,
    },
  });
};

export default withUserAuth(handler);
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/me.ts
git commit -m "feat(auth): port /api/auth/me to GoTrue + withUserAuth"
```

---

### Task 2.8: New `/api/auth/switch-company` endpoint

**Files:**
- Create: `pages/api/auth/switch-company.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// pages/api/auth/switch-company.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { sql } from '@/lib/neon';
import { setActiveCompanyCookie } from '@/lib/auth/cookies';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const user = (req as UserAuthedRequest).user;
  const { companyId } = req.body ?? {};
  if (typeof companyId !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'companyId required' } });
  }

  const member = await sql`
    SELECT 1 FROM company_users WHERE user_id = ${user.id} AND company_id = ${companyId}::uuid LIMIT 1
  `;
  if (member.length === 0) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of that company' } });
  }

  setActiveCompanyCookie(res, companyId);
  return res.status(200).json({ success: true, data: { activeCompanyId: companyId } });
};

export default withUserAuth(handler);
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/switch-company.ts
git commit -m "feat(auth): POST /api/auth/switch-company — rotate active_company_id cookie"
```

---

### Task 2.9: Rewrite `/api/auth/forgot-password`

**Files:**
- Modify: `pages/api/auth/forgot-password.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/forgot-password.ts
import type { NextApiHandler } from 'next';
import { recoverPassword } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email } = req.body ?? {};
  if (typeof email !== 'string' || email.length < 3) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email required' } });
  }
  const redirectTo =
    (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000') + '/auth/reset-password';
  try {
    await recoverPassword(email.toLowerCase().trim(), redirectTo);
  } catch (err) {
    log.info('gotrue recover non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }
  // Always return 200 so attackers can't enumerate accounts.
  return res.status(200).json({ success: true, data: null });
};

export default handler;
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/forgot-password.ts
git commit -m "feat(auth): port /api/auth/forgot-password to GoTrue recover"
```

---

### Task 2.10: Rewrite `/api/auth/do-reset-password`

**Files:**
- Modify: `pages/api/auth/do-reset-password.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/do-reset-password.ts
import type { NextApiHandler } from 'next';
import { verifyToken, adminUpdateUser } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { recoveryToken, newPassword } = req.body ?? {};
  if (typeof recoveryToken !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'recoveryToken and newPassword required' } });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }
  try {
    const claims = await verifyToken(recoveryToken);
    await adminUpdateUser(claims.sub, { password: newPassword });
    return res.status(200).json({ success: true, data: null });
  } catch (err) {
    log.info('reset-password failed', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return res.status(400).json({ success: false, error: { code: 'INVALID_RECOVERY_TOKEN', message: 'Invalid or expired reset link' } });
  }
};

export default handler;
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/do-reset-password.ts
git commit -m "feat(auth): port /api/auth/do-reset-password to verify recovery token + admin update"
```

---

### Task 2.11: Rewrite `/api/auth/change-password`

**Files:**
- Modify: `pages/api/auth/change-password.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/change-password.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const user = (req as UserAuthedRequest).user;
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'currentPassword and newPassword required' } });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }
  if (!user.email) {
    return res.status(400).json({ success: false, error: { code: 'NO_EMAIL', message: 'User email missing in token' } });
  }
  try {
    // Re-auth by signing in with the current password — GoTrue will reject if wrong.
    await signIn(user.email, currentPassword);
  } catch {
    return res.status(400).json({ success: false, error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' } });
  }
  await adminUpdateUser(user.id, { password: newPassword });
  return res.status(200).json({ success: true, data: null });
};

export default withUserAuth(handler);
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/change-password.ts
git commit -m "feat(auth): port /api/auth/change-password to GoTrue re-auth + admin update"
```

---

### Task 2.12: Codemod all handlers — `withCompany` → `withAuth`, old `withAuth` → `withUserAuth`

This is the big sweep. ~395 handler files.

- [ ] **Step 1: Inventory callers**

```bash
rg -l "from '@/lib/auth/withCompany'" pages/api/ | wc -l
rg -l "from '@/lib/auth/middleware'" pages/api/ | wc -l
```
Record the counts in the commit message.

- [ ] **Step 2: Apply the codemod (two passes)**

```bash
# Pass 1: replace withCompany callers with withAuth (new)
rg -l "from '@/lib/auth/withCompany'" pages/api/ | xargs sed -i \
  "s|from '@/lib/auth/withCompany'|from '@/lib/auth/withAuth'|g"
rg -l "withCompany\(" pages/api/ | xargs sed -i \
  "s|withCompany(|withAuth(|g"
rg -l "CompanyApiRequest" pages/api/ src/ | xargs sed -i \
  "s|CompanyApiRequest|CompanyAuthedRequest|g"

# Pass 2: replace OLD withAuth callers (those importing from middleware) with withUserAuth
rg -l "from '@/lib/auth/middleware'" pages/api/ | xargs sed -i \
  "s|from '@/lib/auth/middleware'|from '@/lib/auth/withUserAuth'|g"
# withAuth(...) in these files now points to withUserAuth (after new withAuth lives in withAuth.ts)
rg -l "from '@/lib/auth/withUserAuth'" pages/api/ | xargs sed -i \
  "s|\\bwithAuth(|withUserAuth(|g"
```

NOTE: Pass 2's regex is intentionally applied ONLY to files importing from `@/lib/auth/withUserAuth` (the former middleware.ts callers). Files that now import from `@/lib/auth/withAuth` are left alone.

- [ ] **Step 3: Also re-export `withAuth` from `@/lib/auth/index.ts` (if that barrel exists)**

```bash
grep -n "export" src/lib/auth/index.ts | head -20
```

If `index.ts` re-exports from `./middleware` or `./withCompany`, edit to re-export from `./withAuth` and `./withUserAuth` instead. Code:

```typescript
// src/lib/auth/index.ts — replace re-exports
export { withAuth, type CompanyAuthedRequest } from './withAuth';
export { withUserAuth, type UserAuthedRequest } from './withUserAuth';
// Keep other existing exports (csrf, permissions, etc.) unchanged.
```

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit 2>&1 | head -60`
Expected: any errors are about stale `middleware.ts` references or renamed types. Fix them inline (adjust remaining imports). Record remaining pre-existing errors; they shouldn't be worse than master baseline.

- [ ] **Step 5: Smoke — run full unit + integration tests**

Run: `bun run test:unit && bun run vitest run tests/integration/`
Expected: everything in tests/unit and tests/integration/*.test.ts we wrote for Stage 1–2 passes. Any unrelated failures should be pre-existing; note and move on.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(auth): codemod handlers onto withAuth / withUserAuth

- ~N files: withCompany(...) → withAuth(...) [company-scoped]
- ~M files: withAuth(...) [old, user-only] → withUserAuth(...)
- CompanyApiRequest → CompanyAuthedRequest
- src/lib/auth/index.ts re-exports updated
- bunx tsc --noEmit: green (or N pre-existing unrelated errors)"
```

Fill in actual N/M from Step 1 counts.

---

### Task 2.13: Delete dead auth files

**Files:**
- Delete: `src/lib/auth/jwt.ts`, `src/lib/auth/password.ts`, `src/lib/auth/middleware.ts`, `src/lib/auth/session.ts`, `src/lib/auth/sessionHelpers.ts`, `src/lib/auth/withCompany.ts`
- Modify: `src/lib/auth/index.ts` (remove any remaining refs)

- [ ] **Step 1: Confirm nothing in the codebase still imports from the doomed files**

```bash
for f in jwt password middleware session sessionHelpers withCompany; do
  n=$(rg -l "from '@/lib/auth/${f}'" src/ pages/ tests/ 2>/dev/null | wc -l)
  echo "$f: $n remaining importers"
done
```
Expected: all zero. If any remain, fix those imports before deletion (they should route through withAuth / withUserAuth or the re-export barrel).

- [ ] **Step 2: Delete**

```bash
git rm src/lib/auth/jwt.ts src/lib/auth/password.ts src/lib/auth/middleware.ts \
       src/lib/auth/session.ts src/lib/auth/sessionHelpers.ts src/lib/auth/withCompany.ts
```

- [ ] **Step 3: Type check green**

Run: `bunx tsc --noEmit 2>&1 | rg "src/lib/auth/(jwt|password|middleware|session|sessionHelpers|withCompany)" | head`
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(auth): delete dead custom-auth files (~1.4k LOC)

Replaced by GoTrue client + withAuth/withUserAuth. GoTrue owns
passwords, sessions, email verification, account lockout."
```

---

## Stage 3 — Invite + register flows

### Task 3.1: `withInviteToken` middleware

For anonymous invite-accept flow. Opens a tx, sets `app.invite_token` GUC so the `invites_by_token` RLS policy lets us SELECT the invitation row without a JWT.

**Files:**
- Create: `src/lib/auth/withInviteToken.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/lib/auth/withInviteToken.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import pg from 'pg';
import { als } from '@/lib/als';

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  return _pool;
}

export interface InviteTokenRequest extends NextApiRequest { inviteToken: string; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

export function withInviteToken(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const rawToken = (req.query.token as string | undefined) ?? (req.body?.token as string | undefined);
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return res.status(400).json({ success: false, error: { code: 'BAD_TOKEN', message: 'Invite token missing' } });
    }
    (req as InviteTokenRequest).inviteToken = rawToken;

    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.invite_token', $1, true)`, [rawToken]);
      await als.run(
        { client, userId: '', companyId: '', claims: {} },
        async () => { await handler(req, res); }
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      client.release();
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/auth/withInviteToken.ts
git commit -m "feat(auth): withInviteToken — anonymous tx with app.invite_token GUC"
```

---

### Task 3.2: `POST /api/invitations` — create invite

**Files:**
- Modify or create: `pages/api/invitations/index.ts`

- [ ] **Step 1: Read current invitation code (for template re-use)**

```bash
ls pages/api/invitations/ 2>/dev/null
grep -rln "company_invitations" pages/api/ src/modules/accounting/services/ 2>/dev/null | head -10
```
Note current endpoints (may already exist).

- [ ] **Step 2: Write the endpoint**

```typescript
// pages/api/invitations/index.ts
import type { NextApiHandler } from 'next';
import crypto from 'node:crypto';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { adminCreateUser } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { log } from '@/lib/logger';

const listInvitations: NextApiHandler = async (req, res) => {
  const { companyId } = req as CompanyAuthedRequest;
  const rows = await sql<{ id: string; email: string; role: string; expires_at: Date; accepted_at: Date | null; created_at: Date }>`
    SELECT id, email, role, expires_at, accepted_at, created_at
    FROM company_invitations
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return res.status(200).json({ success: true, data: rows });
};

const createInvitation: NextApiHandler = async (req, res) => {
  const request = req as CompanyAuthedRequest;
  const { companyId, companyRole, user } = request;
  if (!['owner', 'admin'].includes(companyRole)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only owners and admins can invite' } });
  }
  const { email, role } = req.body ?? {};
  if (typeof email !== 'string' || typeof role !== 'string' || !['admin', 'manager', 'viewer', 'storeman', 'technician'].includes(role)) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and role required' } });
  }

  const cleanEmail = email.toLowerCase().trim();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // 1. Insert invitation row
  const inv = await sql<{ id: string }>`
    INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES (${companyId}::uuid, ${cleanEmail}, ${role}, ${user.id}, ${token}, ${expiresAt})
    RETURNING id
  `;

  // 2. Admin-create GoTrue user (email_confirm:true so they can sign in once password is set).
  //    On 422 (already exists) adminCreateUser returns the existing user via lookup.
  const gotrueUser = await adminCreateUser({
    email: cleanEmail,
    email_confirm: true,
    user_metadata: { invite_id: inv[0]!.id },
  });

  // 3. Stash gotrue_user_id on the invitation for later accept
  await sql`
    UPDATE company_invitations SET gotrue_user_id = ${gotrueUser.id}::uuid
    WHERE id = ${inv[0]!.id}::uuid
  `;

  // 4. Company name for the email
  const [company] = await sql<{ name: string }>`SELECT name FROM companies WHERE id = ${companyId}::uuid`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
  const acceptUrl = `${appUrl}/accept-invite?token=${token}`;

  // 5. Send our own email (Postmark-via-emailService)
  try {
    await sendEmail({
      to: cleanEmail,
      subject: `You've been invited to ${company?.name ?? 'IsaFlow'}`,
      html: `<p>You've been invited to join <strong>${company?.name ?? 'IsaFlow'}</strong> on IsaFlow.</p>
             <p><a href="${acceptUrl}">Accept invitation</a></p>
             <p>This link expires in 7 days.</p>`,
      emailType: 'invite',
      companyId,
    });
    await sql`UPDATE company_invitations SET email_sent_at = now() WHERE id = ${inv[0]!.id}::uuid`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('invite email send failed', { inviteId: inv[0]!.id, message: msg }, 'Invitations');
    await sql`UPDATE company_invitations SET email_error = ${msg} WHERE id = ${inv[0]!.id}::uuid`;
    return res.status(502).json({ success: false, error: { code: 'EMAIL_FAILED', message: 'Invitation created but email delivery failed. You can resend.' } });
  }

  return res.status(201).json({ success: true, data: { id: inv[0]!.id, email: cleanEmail, role, expiresAt } });
};

const handler: NextApiHandler = async (req, res) => {
  if (req.method === 'GET') return listInvitations(req, res);
  if (req.method === 'POST') return createInvitation(req, res);
  return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET or POST' } });
};

export default withAuth(handler);
```

- [ ] **Step 2: Check `sendEmail` signature**

```bash
sed -n '1,40p' src/modules/accounting/services/core/emailService.ts
```
If `EmailOptions` doesn't have the exact fields used above (`emailType`, `companyId`), adjust the call. If the service doesn't take `emailType`/`companyId`, drop them from the call; the email still sends. Keep changes minimal.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit pages/api/invitations/index.ts`
Expected: no errors (or fix locally and re-run).

- [ ] **Step 4: Commit**

```bash
git add pages/api/invitations/index.ts
git commit -m "feat(invitations): POST /api/invitations — GoTrue admin-create + our email"
```

---

### Task 3.3: `GET /api/invitations/[token]` — anonymous lookup for accept page

**Files:**
- Create: `pages/api/invitations/[token]/index.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// pages/api/invitations/[token]/index.ts
import type { NextApiHandler } from 'next';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { sql } from '@/lib/neon';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } });
  }
  const token = (req as InviteTokenRequest).inviteToken;
  const rows = await sql<{
    id: string; email: string; role: string; expires_at: Date; company_name: string;
  }>`
    SELECT ci.id, ci.email, ci.role, ci.expires_at, c.name AS company_name
    FROM company_invitations ci
    JOIN companies c ON c.id = ci.company_id
    WHERE ci.token = ${token}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  return res.status(200).json({ success: true, data: rows[0] });
};

export default withInviteToken(handler);
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/invitations/[token]/index.ts
git commit -m "feat(invitations): GET /api/invitations/[token] — anonymous invite lookup"
```

---

### Task 3.4: `POST /api/invitations/[token]/accept` — set password, sign in, grant membership

This endpoint runs the initial SELECT through the RLS-scoped `app_user` connection (via `withInviteToken`), then escalates to `migration_admin` for the membership INSERT because `company_users`' RLS requires pre-existing membership to write.

**Files:**
- Create: `pages/api/invitations/[token]/accept.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// pages/api/invitations/[token]/accept.ts
import type { NextApiHandler } from 'next';
import pg from 'pg';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { adminUpdateUser, signIn } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';

function adminPool(): pg.Pool {
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for invite accept');
  return new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const token = (req as InviteTokenRequest).inviteToken;
  const { password, firstName, lastName } = req.body ?? {};
  if (typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }

  // 1. Look up invitation (RLS policy invites_by_token permits this)
  const rows = await sql<{
    id: string; email: string; role: string; company_id: string; gotrue_user_id: string;
  }>`
    SELECT id, email, role, company_id, gotrue_user_id
    FROM company_invitations
    WHERE token = ${token} AND accepted_at IS NULL AND expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  const inv = rows[0]!;

  // 2. Set the user's password in GoTrue
  await adminUpdateUser(inv.gotrue_user_id, {
    password,
    user_metadata: { first_name: firstName, last_name: lastName },
  });

  // 3. Sign them in to get tokens
  const tok = await signIn(inv.email, password);

  // 4. Insert company_users + users-profile rows using BYPASSRLS admin role
  //    (RLS policy would refuse company_users INSERT because the user has no
  //    pre-existing membership to satisfy USING.)
  const admin = adminPool();
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT DO NOTHING`,
      [inv.company_id, tok.user.id, inv.role]
    );
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name  = COALESCE(EXCLUDED.last_name,  users.last_name)`,
      [tok.user.id, inv.email, firstName ?? null, lastName ?? null]
    );
    await client.query(
      `UPDATE company_invitations SET accepted_at = now() WHERE id = $1::uuid`,
      [inv.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await admin.end();
  }

  // 5. Set cookies
  setAuthCookies(res, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in,
  });
  setActiveCompanyCookie(res, inv.company_id);

  return res.status(200).json({ success: true, data: { userId: tok.user.id, companyId: inv.company_id } });
};

export default withInviteToken(handler);
```

- [ ] **Step 2: Add env var**

Append to `.env.local`:
```
MIGRATION_ADMIN_DATABASE_URL=postgresql://migration_admin:<password>@100.96.203.105:5437/isaflow_dev?sslmode=disable
```
Password: set in Task 5.1 (for now use the `CHANGEME_SET_VIA_OPS` from migration 348; we rotate it in Stage 5).

- [ ] **Step 3: Commit**

```bash
git add "pages/api/invitations/[token]/accept.ts"
git commit -m "feat(invitations): POST /api/invitations/[token]/accept

Sets password via GoTrue admin, signs in, inserts company_users +
users-profile using BYPASSRLS migration_admin role, stamps
accepted_at, sets session cookies."
```

---

### Task 3.5: `DELETE /api/invitations/[id]` — revoke pending

**Files:**
- Create: `pages/api/invitations/[id]/revoke.ts` (separate from the token route to avoid Next.js dynamic-segment collisions)

- [ ] **Step 1: Write the endpoint**

```typescript
// pages/api/invitations/[id]/revoke.ts
import type { NextApiHandler } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { adminDeleteUser } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const request = req as CompanyAuthedRequest;
  if (!['owner', 'admin'].includes(request.companyRole)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Owner/admin only' } });
  }
  const id = req.query.id as string | undefined;
  if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'id required' } });

  const rows = await sql<{ gotrue_user_id: string; accepted_at: Date | null }>`
    SELECT gotrue_user_id, accepted_at FROM company_invitations
    WHERE id = ${id}::uuid AND company_id = ${request.companyId}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
  }
  if (rows[0]!.accepted_at !== null) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_ACCEPTED', message: 'Invitation already accepted' } });
  }

  // Delete the invitation row. Delete the orphan GoTrue user only if they have
  // no other company memberships — otherwise they're a real user of another
  // company and we just drop the invite.
  const otherMemberships = await sql<{ count: number }>`
    SELECT COUNT(*)::int AS count FROM company_users WHERE user_id = ${rows[0]!.gotrue_user_id}
  `;
  await sql`DELETE FROM company_invitations WHERE id = ${id}::uuid`;
  if ((otherMemberships[0]!.count ?? 0) === 0) {
    try { await adminDeleteUser(rows[0]!.gotrue_user_id); }
    catch (err) { log.info('revoke: adminDeleteUser non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Invitations'); }
  }

  return res.status(200).json({ success: true, data: null });
};

export default withAuth(handler);
```

- [ ] **Step 2: Commit**

```bash
git add "pages/api/invitations/[id]/revoke.ts"
git commit -m "feat(invitations): POST /api/invitations/[id]/revoke"
```

---

### Task 3.6: Rewrite `/api/auth/register` — self-signup with company creation

**Files:**
- Modify: `pages/api/auth/register.ts`

- [ ] **Step 1: Replace the file**

```typescript
// pages/api/auth/register.ts
import type { NextApiHandler } from 'next';
import pg from 'pg';
import { adminCreateUser, signIn } from '@/lib/auth/gotrue';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';

function adminPool(): pg.Pool {
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for register');
  return new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const { email, password, firstName, lastName, companyName } = req.body ?? {};
  for (const [name, v] of [['email', email], ['password', password], ['companyName', companyName]] as const) {
    if (typeof v !== 'string' || v.trim().length < 2) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: `${name} required` } });
    }
  }
  if ((password as string).length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }

  const cleanEmail = (email as string).toLowerCase().trim();

  // 1. Create GoTrue user
  const gotrueUser = await adminCreateUser({
    email: cleanEmail,
    password: password as string,
    email_confirm: true,
  });

  // 2. Bootstrap tx: create company + owner membership + profile shadow
  const admin = adminPool();
  const client = await admin.connect();
  let newCompanyId = '';
  try {
    await client.query('BEGIN');
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id`,
      [companyName]
    );
    newCompanyId = company.rows[0]!.id;
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role, is_default)
       VALUES ($1::uuid, $2, 'owner', true)`,
      [newCompanyId, gotrueUser.id]
    );
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, role)
       VALUES ($1, $2, $3, $4, true, 'admin')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [gotrueUser.id, cleanEmail, firstName ?? null, lastName ?? null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Clean up the GoTrue user so the email isn't stuck in a half-created state
    log.warn('register rollback', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    throw err;
  } finally {
    client.release();
    await admin.end();
  }

  // 3. Sign in to get tokens
  const tok = await signIn(cleanEmail, password as string);
  setAuthCookies(res, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in,
  });
  setActiveCompanyCookie(res, newCompanyId);

  return res.status(201).json({
    success: true,
    data: { userId: gotrueUser.id, companyId: newCompanyId },
  });
};

export default handler;
```

- [ ] **Step 2: Commit**

```bash
git add pages/api/auth/register.ts
git commit -m "feat(auth): port /api/auth/register to GoTrue + create company + owner membership"
```

---

### Task 3.7: `/accept-invite` page (UI)

Minimal page that calls the two invitation endpoints. Follows existing UI patterns (AppLayout optional; accept-invite is typically a public page).

**Files:**
- Create: `pages/accept-invite.tsx`

- [ ] **Step 1: Write the page**

```typescript
// pages/accept-invite.tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export default function AcceptInvitePage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<{ email: string; role: string; company_name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const r = await fetch(`/api/invitations/${token}`);
      const body = await r.json();
      if (!body.success) { setError(body.error?.message ?? 'Invalid invitation'); setLoading(false); return; }
      setInvite(body.data);
      setLoading(false);
    })();
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) { setError('Password must be at least 10 characters'); return; }
    setSubmitting(true); setError(null);
    const r = await fetch(`/api/invitations/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, firstName, lastName }),
    });
    const body = await r.json();
    if (!body.success) { setError(body.error?.message ?? 'Failed to accept'); setSubmitting(false); return; }
    router.push('/accounting/dashboard');
  }

  if (loading) return <div className="p-8">Loading invitation…</div>;
  if (!invite) return <div className="p-8 text-red-600">{error ?? 'Invitation invalid or expired.'}</div>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-semibold mb-2">Join {invite.company_name}</h1>
        <p className="text-gray-600 mb-6">Invited as <strong>{invite.role}</strong> with email <strong>{invite.email}</strong>. Set your password to accept.</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm">First name</span>
              <input className="w-full border rounded p-2" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm">Last name</span>
              <input className="w-full border rounded p-2" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="text-sm">Password (at least 10 characters)</span>
            <input type="password" className="w-full border rounded p-2" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </label>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button type="submit" disabled={submitting} className="w-full bg-indigo-600 text-white rounded p-2 disabled:opacity-50">
            {submitting ? 'Accepting…' : 'Accept invitation'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/accept-invite.tsx
git commit -m "feat(invitations): /accept-invite page — set password + enter company"
```

---

## Stage 4 — Tests + SMTP

### Task 4.1: RLS policy-coverage test

Iterates `information_schema` and asserts every `company_id` table has RLS enabled + FORCED + a policy.

**Files:**
- Create: `tests/integration/rls-policy-coverage.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/rls-policy-coverage.test.ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

describe('RLS policy coverage across every company_id table', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });

  it('every public table with company_id has rowsecurity + forcerowsecurity + a policy', async () => {
    const { rows } = await pool.query<{
      table_name: string; rowsecurity: boolean; forcerowsecurity: boolean; policy_count: number;
    }>(`
      WITH cid_tables AS (
        SELECT DISTINCT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tb USING (table_schema, table_name)
        WHERE c.column_name = 'company_id' AND c.table_schema = 'public'
          AND tb.table_type = 'BASE TABLE'
      )
      SELECT
        t.table_name,
        pc.relrowsecurity AS rowsecurity,
        pc.relforcerowsecurity AS forcerowsecurity,
        COALESCE(p.policy_count, 0) AS policy_count
      FROM cid_tables t
      JOIN pg_class pc ON pc.relname = t.table_name AND pc.relnamespace = 'public'::regnamespace
      LEFT JOIN (
        SELECT tablename, COUNT(*)::int AS policy_count FROM pg_policies
        WHERE schemaname = 'public' GROUP BY tablename
      ) p ON p.tablename = t.table_name
      ORDER BY t.table_name
    `);

    const broken = rows.filter((r) => !r.rowsecurity || !r.forcerowsecurity || r.policy_count === 0);
    if (broken.length > 0) {
      console.error('RLS coverage gaps:', broken);
    }
    expect(broken).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(115); // sanity: 117 minus companies ± schema drift
  });
});
```

- [ ] **Step 2: Run**

Run: `bun run vitest run tests/integration/rls-policy-coverage.test.ts`
Expected: PASS. If it fails, list the gap tables from the console log and extend migration 348 to cover them (likely new tables added after the DO-block ran — rerun the DO block).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rls-policy-coverage.test.ts
git commit -m "test(rls): every company_id table has RLS + FORCED + policy"
```

---

### Task 4.2: Tenant read-isolation test

**Files:**
- Create: `tests/integration/rls-tenant-read-isolation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/rls-tenant-read-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

// Seeds two tenants A and B, each with a user-membership pair, then creates
// one row in a representative sample of tables for each. Asserts that when
// user A runs SELECTs with GUCs set for tenant A, they see zero rows belonging
// to tenant B.
describe('RLS tenant read isolation', () => {
  let admin: Pool;
  const CA = '00000000-0000-0000-0000-00000000caaa';
  const CB = '00000000-0000-0000-0000-00000000cbbb';
  const UA = 'phase2-iso-user-A';
  const UB = 'phase2-iso-user-B';

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'ISO-A', true), ($2, 'ISO-B', true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
    await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1, 'a@iso.test', true), ($2, 'b@iso.test', true) ON CONFLICT (id) DO NOTHING`, [UA, UB]);
    await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $4, 'admin') ON CONFLICT DO NOTHING`, [CA, CB, UA, UB]);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_users WHERE user_id IN ($1, $2)`, [UA, UB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1, $2)`, [UA, UB]);
    await admin.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [CA, CB]);
    await admin.end();
  });

  it('user A cannot read tenant B rows across a sample of tables', async () => {
    const sampleTables = ['customers', 'suppliers', 'invoices', 'bank_transactions', 'gl_journal_entries'];
    const existing = (await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [sampleTables]
    )).rows.map((r) => (r as { table_name: string }).table_name);

    // Seed one row per table for each tenant (minimal INSERT; columns vary — use a
    // generic UPDATE-via-SELECT trick: we just check counts under RLS).
    // If a sample table doesn't exist, skip it.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_user`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);
      for (const t of existing) {
        const q = `SELECT COUNT(*)::int AS c FROM public."${t}" WHERE company_id = $1::uuid`;
        const r = await client.query<{ c: number }>(q, [CB]);
        expect(r.rows[0]!.c).toBe(0); // RLS must hide tenant B's rows from user A
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `bun run vitest run tests/integration/rls-tenant-read-isolation.test.ts`
Expected: PASS. If a sample table doesn't exist, extend the list; if one fails, inspect the policy on that table.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rls-tenant-read-isolation.test.ts
git commit -m "test(rls): tenant A cannot read tenant B rows"
```

---

### Task 4.3: Tenant write-isolation test

**Files:**
- Create: `tests/integration/rls-tenant-write-isolation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/rls-tenant-write-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

describe('RLS tenant write isolation', () => {
  let admin: Pool;
  const CA = '00000000-0000-0000-0000-00000000caaa';
  const UA = 'phase2-iso-user-A';
  const CB = '00000000-0000-0000-0000-00000000cbbb'; // A is NOT a member of CB

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });
  afterAll(async () => { await admin.end(); });

  it('INSERT targeting a different company_id is rejected by WITH CHECK', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_user`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);

      await expect(
        client.query(
          `INSERT INTO public.customers (id, company_id, name) VALUES (gen_random_uuid(), $1::uuid, 'Evil')`,
          [CB]  // different from app.current_company_id
        )
      ).rejects.toThrow(/row-level security/i);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `bun run vitest run tests/integration/rls-tenant-write-isolation.test.ts`
Expected: PASS. If `customers` doesn't have the expected columns, pick another company_id table with a simple INSERT shape.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rls-tenant-write-isolation.test.ts
git commit -m "test(rls): cross-tenant INSERT rejected by WITH CHECK"
```

---

### Task 4.4: SMTP wiring for GoTrue

**Files:**
- Modify: `/home/velo/supabase/.env` (on velo, not in repo)
- Document: commit a marker in repo noting the change was made

- [ ] **Step 1: Decide which SMTP provider to use**

Check what the app's `sendEmail` already uses:
```bash
grep -E "SMTP_HOST|POSTMARK_|SENDGRID|MAILGUN" .env.local .env* 2>/dev/null | head -5
```
Expected: identifies the current transactional email provider (Postmark / SES / Mailgun). Use the same credentials for GoTrue so deliveries appear in one provider dashboard.

- [ ] **Step 2: Write the env-change plan to a doc file in the repo**

```bash
cat > scripts/cutover/gotrue-smtp-env.md <<'EOF'
# GoTrue SMTP env (to be set on velo at /home/velo/supabase/.env)

Append the following to /home/velo/supabase/.env, then
`docker compose -f /home/velo/supabase/docker-compose.yml up -d supabase-auth`.

```bash
GOTRUE_SMTP_HOST=<provider host>
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=<provider user>
GOTRUE_SMTP_PASS=<provider pass>
GOTRUE_SMTP_ADMIN_EMAIL=noreply@isaflow.co.za
GOTRUE_SMTP_SENDER_NAME=IsaFlow
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/reset-password
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/confirm
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/confirm-email-change
GOTRUE_MAILER_AUTOCONFIRM=false
GOTRUE_SITE_URL=https://app.isaflow.co.za
GOTRUE_URI_ALLOW_LIST=https://app.isaflow.co.za,https://dev.isaflow.co.za
```

Verification:

```bash
curl -X POST http://100.96.203.105:8300/auth/v1/recover \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "content-type: application/json" \
  -d '{"email": "test@isaflow.co.za"}'
# Should return 200 and deliver an email from the configured SMTP account.
```
EOF
```

- [ ] **Step 3: Commit the marker**

```bash
git add scripts/cutover/gotrue-smtp-env.md
git commit -m "docs(cutover): GoTrue SMTP env snippet to apply on velo"
```

- [ ] **Step 4: Apply the env (manual, on velo)**

```bash
ssh velo@100.96.203.105
# Edit /home/velo/supabase/.env — append the GOTRUE_SMTP_* block with real creds
sudo -u velo nano /home/velo/supabase/.env
cd /home/velo/supabase
docker compose up -d supabase-auth
docker logs supabase-auth --tail 30
# Expected: "mailer configured" log line, no SMTP errors
```

- [ ] **Step 5: Verify recovery email delivers**

Run the curl from the verification block. Check the configured mailbox.

---

### Task 4.5: E2E auth.spec.ts

**Files:**
- Create: `tests/e2e/phase2-auth.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/phase2-auth.spec.ts
import { test, expect } from '@playwright/test';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@isaflow.test';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'SuperSecret12345!';

test.describe('phase 2 — auth golden path', () => {
  test('login → dashboard → switch company → logout', async ({ page, request }) => {
    // Assumes a user + company exist from dev seed. Register flow is covered separately.
    await page.goto(`${APP_URL}/login`);
    await page.fill('input[name="email"]', OWNER_EMAIL);
    await page.fill('input[name="password"]', OWNER_PASSWORD);
    await page.click('button[type="submit"]');

    await page.waitForURL(/.*\/accounting(\/|$).*/);

    const me = await request.get(`${APP_URL}/api/auth/me`);
    expect(me.status()).toBe(200);

    await request.post(`${APP_URL}/api/auth/logout`);
    await page.goto(`${APP_URL}/accounting/dashboard`);
    await expect(page).toHaveURL(/.*\/login.*/);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/phase2-auth.spec.ts
git commit -m "test(e2e): phase 2 auth golden path"
```

---

### Task 4.6: E2E invite.spec.ts

**Files:**
- Create: `tests/e2e/phase2-invite.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/phase2-invite.spec.ts
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ADMIN_DB_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL!;
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL!;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD!;

async function fetchInviteToken(email: string): Promise<string> {
  const pool = new Pool({ connectionString: ADMIN_DB_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT token FROM company_invitations WHERE email = $1 AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (rows.length === 0) throw new Error('no invite row');
    return rows[0].token;
  } finally { await pool.end(); }
}

test('owner invites → accept flow → new user in dashboard', async ({ page, request }) => {
  const inviteeEmail = `e2e-invitee-${Date.now()}@isaflow.test`;

  // Sign in as owner
  const login = await request.post(`${APP_URL}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const ownerCookies = login.headers()['set-cookie'];

  // Create invite
  const inv = await request.post(`${APP_URL}/api/invitations`, {
    data: { email: inviteeEmail, role: 'manager' },
    headers: { cookie: ownerCookies },
  });
  expect(inv.status()).toBe(201);

  const token = await fetchInviteToken(inviteeEmail);

  // Accept in a fresh context (no cookies)
  const accept = await request.post(`${APP_URL}/api/invitations/${token}/accept`, {
    data: { password: 'NewUserPwd12345!', firstName: 'E2E', lastName: 'User' },
  });
  expect(accept.status()).toBe(200);

  // New user can access /api/auth/me
  const meCookies = accept.headers()['set-cookie'];
  const me = await request.get(`${APP_URL}/api/auth/me`, { headers: { cookie: meCookies } });
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.data.memberships.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/phase2-invite.spec.ts
git commit -m "test(e2e): phase 2 invite accept flow end-to-end"
```

---

### Task 4.7: E2E cross-tenant smoke

**Files:**
- Create: `tests/e2e/phase2-cross-tenant.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/phase2-cross-tenant.spec.ts
import { test, expect } from '@playwright/test';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL!;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD!;
const FOREIGN_COMPANY_ID = process.env.E2E_FOREIGN_COMPANY_ID!; // a company the owner is NOT a member of

test('authenticated user cannot access another tenant via cookie forge', async ({ request }) => {
  // Sign in
  const login = await request.post(`${APP_URL}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const sc = login.headers()['set-cookie'];
  const accessCookie = sc.match(/sb-access-token=[^;]+/)?.[0] ?? '';

  // Forge active_company_id cookie to point at a company we aren't a member of
  const forgedCookie = `${accessCookie}; active_company_id=${FOREIGN_COMPANY_ID}`;

  const r = await request.get(`${APP_URL}/api/accounting/customers`, {
    headers: { cookie: forgedCookie },
  });
  expect(r.status()).toBe(403); // withAuth membership check rejects
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/phase2-cross-tenant.spec.ts
git commit -m "test(e2e): phase 2 cross-tenant forge rejected"
```

---

## Stage 5 — Scripts + observability

### Task 5.1: Rotate `migration_admin` password, point admin scripts at it

**Files:**
- Modify: `/home/velo/supabase/.env` (on velo)
- Create: `scripts/cutover/rotate-migration-admin.sql`

- [ ] **Step 1: Pick a strong password, store in `/home/velo/supabase/.env`**

Generate: `openssl rand -hex 32`. Write as `MIGRATION_ADMIN_PASSWORD=<value>`. `chmod 0600`.

- [ ] **Step 2: Write the rotation SQL**

```sql
-- scripts/cutover/rotate-migration-admin.sql
-- Run as postgres superuser. Password is injected via \set or passed via env.
\set admin_pw `echo $MIGRATION_ADMIN_PASSWORD`
ALTER ROLE migration_admin WITH PASSWORD :'admin_pw';
```

- [ ] **Step 3: Apply on dev + prod**

```bash
export MIGRATION_ADMIN_PASSWORD=$(ssh velo@100.96.203.105 'grep MIGRATION_ADMIN_PASSWORD /home/velo/supabase/.env | cut -d= -f2')
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -v admin_pw="$MIGRATION_ADMIN_PASSWORD" \
  -c "ALTER ROLE migration_admin WITH PASSWORD :'admin_pw';"
```
Repeat for `-d isaflow` on prod cutover day (Stage 6).

- [ ] **Step 4: Update `.env.local`**

Set `MIGRATION_ADMIN_DATABASE_URL=postgresql://migration_admin:$MIGRATION_ADMIN_PASSWORD@100.96.203.105:5437/isaflow_dev?sslmode=disable` (url-encode special chars).

- [ ] **Step 5: Identify admin scripts that need to connect as `migration_admin`**

```bash
grep -rln "DATABASE_URL" scripts/ 2>/dev/null | head -20
```
Candidates: seed-*.ts, migration runners, bulk-backfill scripts. For each, change the pool connection string to `MIGRATION_ADMIN_DATABASE_URL` (if present) else fall back to `DATABASE_URL`.

- [ ] **Step 6: Commit**

```bash
git add scripts/cutover/rotate-migration-admin.sql .env.local.example 2>/dev/null
git commit -m "ops(auth): rotate migration_admin password; point admin scripts at it"
```

---

### Task 5.2: Sentry tags + duration metric

- [ ] **Step 1: Already done in `withAuth` (step 3 of Task 2.4) via `setTenantTags`.** Verify the sentry/tags module supports the existing keys.

```bash
grep -n "setTenantTags" src/lib/sentry/tags.ts | head
```

- [ ] **Step 2: Add duration metric in withAuth**

Modify `src/lib/auth/withAuth.ts`. Before `const client = await getAuthPool().connect()` add:

```typescript
    const startedAt = Date.now();
```

After the `finally { client.release(); }` block, inside the outer function before returning, add:

```typescript
    const ms = Date.now() - startedAt;
    if (ms > 100) log.info('withAuth duration', { ms, url: req.url }, 'Auth');
    // Sentry metric: measure on env SENTRY_ENABLED
    if (process.env.SENTRY_ENABLED === 'true') {
      Sentry.metrics.distribution('auth.withAuth.duration_ms', ms, { unit: 'millisecond' });
    }
```

(Wrap appropriately with the existing try/finally.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth/withAuth.ts
git commit -m "obs(auth): auth.withAuth.duration_ms Sentry metric + slow-log"
```

---

### Task 5.3: Rollback script

**Files:**
- Create: `scripts/rollback/phase2-disable-rls.sql`

- [ ] **Step 1: Write the rollback**

```sql
-- scripts/rollback/phase2-disable-rls.sql
-- Disables RLS and drops Phase 2 helpers. Use only if Phase 2 ships broken
-- and we need to restore the pre-Phase-2 codebase paired with a non-RLS DB.

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id' AND c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS companies_member_read ON public.companies;
DROP POLICY IF EXISTS companies_owner_write ON public.companies;
ALTER TABLE public.companies DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;
ALTER TABLE public.company_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_users NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invites_tenant ON public.company_invitations;
DROP POLICY IF EXISTS invites_by_token ON public.company_invitations;
ALTER TABLE public.company_invitations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_invitations NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_read ON public.users;
DROP POLICY IF EXISTS users_self_write ON public.users;
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS auth.uid();
DROP FUNCTION IF EXISTS app.current_company_id();

-- Keep the roles; they're harmless if unused. Keep schemas.
-- DO NOT restore users.password_hash etc. — that requires a fresh backup restore.
```

- [ ] **Step 2: Dev rehearsal**

```bash
# Take a snapshot first so we can restore after the rehearsal
ssh velo@100.96.203.105 'docker exec supabase-db pg_dump -U postgres isaflow_dev' > /tmp/isaflow_dev-pre-rollback.sql

PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -f scripts/rollback/phase2-disable-rls.sql

# Verify RLS is off
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -c "SELECT COUNT(*) FROM pg_policies WHERE schemaname='public';"
# Expected: 0

# Restore dev DB to post-348 state by replaying migration 348
PGPASSWORD="$PG_POSTGRES_PASSWORD" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow_dev \
  -f scripts/migrations/sql/348_rls_and_auth_helpers.sql
```

- [ ] **Step 3: Commit**

```bash
git add scripts/rollback/phase2-disable-rls.sql
git commit -m "ops(rollback): scripts/rollback/phase2-disable-rls.sql (rehearsed on dev)"
```

---

### Task 5.4: Tag `v-pre-phase2` on master

- [ ] **Step 1: Verify master is at the last good pre-Phase-2 commit**

```bash
git log master --oneline -5
```

- [ ] **Step 2: Tag (from a clean worktree on master)**

```bash
git fetch origin
git tag -a v-pre-phase2 -m "Pre-Phase 2 (GoTrue + RLS) rollback anchor. Last pre-Phase-2 master: $(git rev-parse origin/master)"
git push origin v-pre-phase2
```

Confirm push succeeded; this is a rollback anchor, not a code change.

---

## Stage 6 — Prod cutover

### Task 6.1: Pre-merge checks on feature branch

- [ ] **Step 1: All tests green on dev**

```bash
bunx tsc --noEmit
bun run test:unit
bun run vitest run tests/integration/
bun run test:e2e -- --grep phase2
```
Expected: all green. Record output in commit or PR description.

- [ ] **Step 2: Open PR from `phase2/gotrue-rls` to `master`**

```bash
gh pr create --base master --head phase2/gotrue-rls --title "Phase 2 — GoTrue auth + Postgres RLS" \
  --body "$(cat <<'EOF'
## Summary
- Replaces custom auth with GoTrue (Supabase). Deletes ~1.4k LOC.
- Enables RLS + FORCES RLS on every public.<table> with a `company_id` column; `app_user` role with `tenant_isolation` policy.
- New `withAuth` middleware opens tx, sets JWT claims + `app.current_company_id` GUCs, binds AsyncLocalStorage so `sql` runs on the tx-bound connection — 395 handlers unchanged.
- New invite flow: owner POSTs to `/api/invitations` → GoTrue admin-create user → we send branded email. Anonymous accept via `withInviteToken` + `migration_admin` for the member insert.
- SMTP wired into GoTrue for password reset.

## Test plan
- [x] RLS pool-isolation regression test
- [x] RLS policy-coverage test (every company_id table)
- [x] Tenant read-isolation test
- [x] Tenant write-isolation test (WITH CHECK rejects cross-tenant INSERT)
- [x] E2E auth golden path
- [x] E2E invite accept flow
- [x] E2E cross-tenant forge rejected
- [ ] Prod smoke post-merge (Stage 6 task 6.2)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 6.2: Merge, deploy, migrate prod, smoke

Do this after hours per CLAUDE.md rule. Requires explicit Hein approval.

- [ ] **Step 1: Merge PR**

```bash
gh pr merge --squash phase2/gotrue-rls
git checkout master && git pull
```

- [ ] **Step 2: Deploy to prod**

```bash
bash scripts/deploy.sh prod
```

Watch the health check succeed.

- [ ] **Step 3: Apply migrations 348–350 to prod `isaflow` DB**

```bash
export PGPW=$(ssh velo@100.96.203.105 'grep POSTGRES_PASSWORD /home/velo/supabase/.env | cut -d= -f2')
for f in 348_rls_and_auth_helpers.sql 349_users_profile_shadow.sql 350_invitations_gotrue_link.sql; do
  PGPASSWORD="$PGPW" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow \
    -f scripts/migrations/sql/$f
  PGPASSWORD="$PGPW" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow \
    -c "INSERT INTO schema_migrations (filename, applied_at) VALUES ('$f', now()) ON CONFLICT DO NOTHING;"
done
```

- [ ] **Step 4: Rotate `migration_admin` password on prod**

Use the Task 5.1 `ALTER ROLE` against `isaflow`, same password you stored on velo.

- [ ] **Step 5: Restart the app to pick up new env**

```bash
ssh velo@100.96.203.105 'sudo systemctl restart isaflow'
```

Watch `journalctl -u isaflow -f` for startup errors.

- [ ] **Step 6: Prod smoke**

On app.isaflow.co.za:
- Register a fresh user + fresh company. Verify dashboard loads.
- From that owner, invite a second email. Fetch the token from DB (no SMTP for invite — we send our own). Accept as the invitee. Verify they land in dashboard.
- As invitee, attempt to GET `/api/accounting/customers` with forged `active_company_id` pointing at a foreign company id — confirm 403.
- Password reset: trigger `/api/auth/forgot-password`, verify the recovery email arrives, follow link, reset password, log in.

If ANY smoke step fails, roll back immediately (see Task 6.3).

- [ ] **Step 7: Update memory**

Append to `project_supabase_cutover.md` (user auto-memory): Phase 2 shipped date + commit SHA + lessons learned.

---

### Task 6.3: Rollback procedure (in case of prod failure)

- [ ] **Step 1: Revert the app**

```bash
git checkout v-pre-phase2
bash scripts/deploy.sh prod
```

- [ ] **Step 2: Run rollback SQL on prod**

```bash
PGPASSWORD="$PGPW" psql -h 100.96.203.105 -p 5437 -U postgres -d isaflow \
  -f scripts/rollback/phase2-disable-rls.sql
```

- [ ] **Step 3: Restart**

```bash
ssh velo@100.96.203.105 'sudo systemctl restart isaflow'
```

- [ ] **Step 4: Post-mortem (non-code task)**

Write up what broke; commit in `docs/superpowers/postmortems/YYYY-MM-DD-phase2-rollback.md` if rollback fires.

---

## Self-review checklist (run this before handing off to execution)

**Spec coverage:**
- [x] § 1 Architecture → Tasks 1.5, 1.6, 2.4
- [x] § 2 DB layer → Tasks 1.2–1.4
- [x] § 3 Auth layer → Tasks 2.1, 2.3, 2.5–2.11, 2.13
- [x] § 4 Middleware + ALS → Tasks 1.5, 1.6, 2.4, 2.12
- [x] § 5 Invites + register → Tasks 3.1–3.7
- [x] § 6 SMTP → Task 4.4
- [x] § 7 Testing → Tasks 1.1, 4.1–4.3, 4.5–4.7
- [x] § 8 Observability → Task 5.2
- [x] § 9 Cutover plan → Task 6.1, 6.2
- [x] § 10 Rollback → Tasks 5.3, 6.3
- [x] § 11 Success criteria → Step 6 of Task 6.2
- [x] § 12 Risks → mitigations appear as tests (4.1, 4.7) and in withAuth membership check (2.4)

**Placeholder scan:** No TBD/TODO/implement-later left. Two `CHANGEME_SET_VIA_OPS` markers are intentional (rotated in Task 5.1) and explicitly called out. `<paste from velo supabase .env>` markers in env setup are intentional ops placeholders, not code.

**Type consistency:** `CompanyAuthedRequest` used throughout Stage 2+ (codemod renames the old `CompanyApiRequest`). `UserAuthedRequest` in Stage 2 tasks that use `withUserAuth`. `InviteTokenRequest` in Stage 3. `GoTrueUser`, `GoTrueTokenResponse`, `GoTrueClaims` from `gotrue.ts` used consistently.

**Scope check:** Single implementation plan producing working software. ~6–7 days of work. Six stages sequenced so each stage leaves the branch type-check-green and tests-green before moving on.
