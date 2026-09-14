# Bank Sync v1 — Release 1 (Canonical Feed Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live bank-feed source enters IsaFlow through one canonical, idempotent ingestion service. A feed row's bank lifecycle (`pending | posted | removed`) is modelled separately from its accounting status, and a non-posted row can't be matched, allocated, excluded, bulk-accepted, reconciled or counted in statement totals. The dead Stitch runtime is gone, and no screen claims a provider IsaFlow doesn't have.

**Architecture:** Migration 675 adds feed identity and lifecycle columns to `bank_transactions`, a conflicts table, and a `BEFORE UPDATE` trigger that refuses any accounting-column change on a non-posted row. That trigger is the fail-closed backstop for the ~39 writers. Typed pre-write refusals sit in the locked mutators, and `feed_state` predicates go on the set-based writers and the statement-total readers. A new `services/bank/feed/` module owns validation, the pure lifecycle decision, persistence and orchestration. The extension-ingest route becomes a thin transport into it.

**Tech Stack:** Next.js 14 Pages Router · TypeScript strict · Postgres (Supabase, self-hosted) via `sql` from `@/lib/neon` · Vitest 4 (unit + `vitest.integration.config.ts`) · Playwright · bun.

**Spec:** `docs/superpowers/specs/2026-09-11-bank-sync-v1-design.md` (Release 1 of 3). Read it before any task.

## Decisions taken after the spec (Hein, 2026-09-11)

These override the spec where they conflict. Task 0 writes them into the spec.

1. **Extension identity is content-hash.** The ABSA extension stays a *feed* source (connection, lease, sync log), but its rows are identified by the established `bankTransactionHash` (date|amount|description), not by provider IDs. Provider identity is required only for connections whose provider is neither `extension` nor `manual_csv`.
2. **Feeds only in R1.** The canonical service ingests feed sources. The statement-import paths (bulk-commit, agent import, OCR commit, import-classified, legacy `importBankStatement`) keep their current path, including their user-configured import-time sweep. The `statement` arm of `BankIngestionBatch.source` is **not** built in R1.
3. **Pending guards ship now, DB-backstopped.** They ship even though no R1 source produces pending rows.

Consequential scope trims (YAGNI; each goes to Release 3, which has a real provider to test against):

- No adapter registry.
- No consent columns, cursor advancement, `next_sync_at`, capability flags or institution columns.
- No scheduler.
- `POST /bank-feeds/[id]/sync` keeps its instruction/refusal behaviour.

## Behaviour changes users will notice (for the PR description)

- **Extension imports no longer auto-post.** They previously ran the transfer auto-link passes, the import-time auto-post sweep, and auto-create rules. After this release they only insert rows and apply *suggestion* rules (spec §6: "The existing unattended auto-post machinery is not invoked by bank sync v1").
- **Bank Feeds page and landing copy change.** Landing-page copy is customer-facing, so **Hein must approve that diff before merge** (global CLAUDE.md human gate).

## Global Constraints

- Every query includes `company_id`. Never string-concatenate SQL; use the `sql` tagged template (`sql.unsafe` only for fixed literals, as existing code does).
- API handlers: `withAuth(withErrorHandler(...))`. User writes add `withCsrf` and `withWriteAccess`: `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`. The extension route keeps `withExtensionToken(withErrorHandler(handler))`.
- Responses use `apiResponse.*`. Logging uses `log` from `@/lib/logger`, never `console.log`. No empty `catch`.
- Max 300 lines per **new** file. Don't restructure existing over-cap files (`BankTxTable.tsx` 760, `bankAllocationService.ts` 781); keep additions to them minimal and put new logic in new files.
- `withAuth` COMMITs below 500: every refusal must be decided from reads **before the first write** (`services/bank/.claude.md:31`). A caught SQL error still poisons the transaction, so wrap it in `withSavepoint` (names ≤31 chars, `^[a-zA-Z_][a-zA-Z0-9_]{0,30}$`).
- Canonical bank lock order is unchanged: (1) `bank_transactions`, (2) payments, (3) invoices `ORDER BY id`, (4) journals. Ingestion takes the connection lease **before** any `bank_transactions` lock. No accounting path locks `bank_feed_connections`, so no cycle is created.
- Migrations: `IF NOT EXISTS` on every CREATE. The migration is re-runnable (constraints in guarded `DO` blocks, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`). Every DML scopes `company_id`. There is no DML on existing customer rows in this release.
- The migration may reference only columns created by migrations. **Never** reference the drift columns `transfer_journal_entry_id`, `counterparty_account_id`, `linked_asset_id`, `linked_fleet_fuel_id`, `linked_fleet_service_id` or `suggested_cost_centre` in trigger or constraint SQL.
- Git: work in `/home/hein/Workspace/IsaFlow/.worktrees/bank-sync-v1-20260911` on `feat/bank-sync-v1-20260911`, and prefix every Bash call with `cd` to it. Stage explicit paths only. No `git add -A`, no `git stash`, no `--no-verify`, no amend.
- Billing's Stitch Express (`src/modules/billing/**`, `pages/api/billing/**`, `pages/api/cron/subscription-charges.ts`) is **out of scope**. Don't touch it.
- The CI gate before each PR is `bun run ci`.
- Production deploy isn't part of this plan. It needs Hein's explicit approval and must happen outside 08:00–17:00 SAST Mon–Fri.

## PR shape

Three sequential PRs, pushed one at a time (golden-path concurrency). Merge each before opening the next.

| PR | Tasks | Title |
|---|---|---|
| A | 0–5 | `feat(bank): feed lifecycle columns and pending guards` |
| B | 6–7 | `feat(bank): canonical feed ingestion; extension cuts over` |
| C | 8–11 | `feat(bank): truthful bank-feed connections; remove Stitch runtime` |

## Test environment (integration tests)

Integration tests run against the disposable schema fixture, **never** `isaflow` or `isaflow_dev` (see `docs/audits/remediation/evidence/schema-fixture.md`). Check that the fixture container is up with `docker ps --filter name=isaflow-remediation-schema-pg-20260908`.

```bash
# FIXTURE_PW: the disposable password named in docs/audits/remediation/evidence/schema-fixture.md
export ISAFLOW_DISPOSABLE_AUTH_TEST=1
export DATABASE_URL="postgresql://postgres:${FIXTURE_PW}@127.0.0.1:33140/isaflow_schema_fixture"
export PLATFORM_ADMIN_DATABASE_URL="postgresql://platform_admin:${FIXTURE_PW}@127.0.0.1:33140/isaflow_schema_fixture"
export GOTRUE_URL=http://127.0.0.1:9999
```

The fixture lags migrations, so apply 675 by hand before running any test that needs it:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql
```

The harness pattern comes from `tests/integration/k071-bank-import-best-effort-savepoint.int.test.ts`: `assertDisposable()`, then its own `pg` Pool, then synthetic `companies`/`users`/`gl_accounts(account_subtype='bank')` rows created in `beforeAll` and deleted in `afterAll`. Services run inside `client.query('BEGIN')` plus `als.run({ client, userId, companyId, claims: {} }, …)`, followed by `ROLLBACK` or `COMMIT`.

Run: `bun run test:integration -- <file>`.

Unit tests run with `env -u DATABASE_URL bun run test:unit -- <file>`, because a leaked `DATABASE_URL` breaks the unit suite's dummy.

---

### Task 0: Amend the spec with the three decisions

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-bank-sync-v1-design.md`

- [ ] **Step 1: Edit the spec**

Change the `**Status:**` line to `**Status:** Approved 2026-09-11; Release 1 plan: docs/superpowers/plans/2026-09-11-bank-sync-v1-release-1.md`.

Directly after the "Approved product decisions" list, add this section:

```markdown
## Release 1 amendments (Hein, 2026-09-11)

- The ABSA extension is a feed source whose rows use content-hash identity (`bankTransactionHash`: date|amount|description). Provider transaction IDs are required only for connections whose provider is neither `extension` nor `manual_csv`.
- Release 1 routes feed sources only through the canonical ingestion service. Statement imports keep their existing path and import-time behaviour; the `statement` source arm is deferred.
- Pending guards ship in Release 1 with a database trigger backstop, although no Release 1 source produces pending rows.
- A provider `removed` for a posted row, or `pending` for a posted row, is a protected conflict (the spec defines only `pending -> removed`). A changed row without a newer `provider_updated_at` is also a protected conflict (`unordered_change`), never a silent overwrite.
- Adapter registry, consent/cursor/next-sync/capability/institution columns, and the scheduler move to Release 3.
```

- [ ] **Step 2: Commit**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/bank-sync-v1-20260911
git add docs/superpowers/specs/2026-09-11-bank-sync-v1-design.md docs/superpowers/plans/2026-09-11-bank-sync-v1-release-1.md
git commit -m "docs(bank): record Release 1 decisions and plan for bank sync v1"
```

---

### Task 1: Migration 675: feed identity, lifecycle trigger, conflicts table

**Files:**
- Create: `scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql`
- Test: `tests/integration/bank-feed-schema-guard.int.test.ts`

**Interfaces:**
- Produces these `bank_transactions` columns: `bank_feed_connection_id UUID NULL`, `provider_transaction_id TEXT NULL`, `feed_state TEXT NOT NULL DEFAULT 'posted'`, `provider_updated_at TIMESTAMPTZ NULL`, `feed_last_seen_at TIMESTAMPTZ NULL`.
- Produces the unique index `uq_bank_tx_feed_identity (company_id, bank_feed_connection_id, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL`.
- Produces the table `bank_feed_transaction_conflicts` with unique index `uq_bank_feed_conflict_open (company_id, connection_id, provider_transaction_id) WHERE resolved_at IS NULL`.
- Produces these `bank_feed_sync_logs` columns: `transactions_updated`, `transactions_pending`, `transactions_removed`, `transactions_conflict`, `transactions_ignored` (all `INT NOT NULL DEFAULT 0`) and `error_code TEXT`.
- Produces `bank_feed_connections.last_success_at TIMESTAMPTZ`.
- The trigger raises SQLSTATE `23514` with a message that starts `BANK_TX_FEED_GUARD:`.

- [ ] **Step 1: Confirm that prefix 675 is unused on master**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/bank-sync-v1-20260911
git fetch origin master && git ls-tree --name-only origin/master scripts/migrations/sql/ | sed 's#.*/##' | grep -E '^67[5-9]_' || echo "675 free"
```

If the fetch fails with "Repository not found", the shell's `GITHUB_TOKEN` is shadowing (memory `feedback_github_token_env_shadowing`). Use `gh auth token` via `git -c credential.helper='!gh auth git-credential' fetch origin master`. If 675 is taken, use the next free prefix and rename every reference to it in this plan.

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/bank-feed-schema-guard.int.test.ts
/**
 * Migration 675's database backstop. A non-posted feed row must refuse every
 * accounting-column change whichever writer attempts it. Only pending -> posted
 * and pending -> removed are legal lifecycle moves. A processed feed row's
 * source fields must never be rewritten.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BF675 company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','BF675 Bank','asset','debit','bank')`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function feedRow(state: 'pending' | 'posted' | 'removed', providerId: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-01',-100,'BF675 row',$3,$4,$5) RETURNING id`,
    [company, bank, conn, providerId, state]);
  return String(rows[0].id);
}

describe('migration 675 — feed lifecycle backstop', () => {
  it('defaults existing and manual rows to posted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description)
       VALUES($1,$2,'2026-09-01',-5,'manual') RETURNING feed_state`, [company, bank]);
    expect(rows[0].feed_state).toBe('posted');
  });

  it('rejects a non-posted row without feed identity', async () => {
    await expect(pool.query(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,feed_state)
       VALUES($1,$2,'2026-09-01',-5,'orphan pending','pending')`, [company, bank],
    )).rejects.toThrow(/bank_tx_feed_identity_required/);
  });

  it('rejects a second row with the same connection + provider id', async () => {
    await feedRow('posted', 'dup-1');
    await expect(feedRow('posted', 'dup-1')).rejects.toThrow(/uq_bank_tx_feed_identity/);
  });

  it.each([
    ['status', "status = 'matched'"],
    ['status to excluded', "status = 'excluded'"],
    ['allocation_type', "allocation_type = 'account'"],
    ['provisional_je_id', 'provisional_je_id = gen_random_uuid()'],
  ])('refuses %s on a pending row', async (_label, setClause) => {
    const id = await feedRow('pending', `p-${crypto.randomUUID()}`);
    await expect(pool.query(`UPDATE bank_transactions SET ${setClause} WHERE id=$1`, [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('allows suggestion and note columns on a pending row', async () => {
    const id = await feedRow('pending', `s-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET notes='n', suggested_vat_code='standard' WHERE id=$1", [id]);
  });

  it('allows pending -> posted and pending -> removed, and nothing else', async () => {
    const a = await feedRow('pending', `t-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET feed_state='posted' WHERE id=$1", [a]);
    await expect(pool.query("UPDATE bank_transactions SET feed_state='removed' WHERE id=$1", [a]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
    const b = await feedRow('pending', `t-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET feed_state='removed' WHERE id=$1", [b]);
    await expect(pool.query("UPDATE bank_transactions SET feed_state='posted' WHERE id=$1", [b]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('refuses a source-field rewrite on a processed feed row', async () => {
    const id = await feedRow('posted', `x-${crypto.randomUUID()}`);
    await pool.query("UPDATE bank_transactions SET status='excluded' WHERE id=$1", [id]);
    await expect(pool.query('UPDATE bank_transactions SET amount=-999 WHERE id=$1', [id]))
      .rejects.toThrow(/BANK_TX_FEED_GUARD/);
  });

  it('allows one open conflict per provider transaction', async () => {
    const id = await feedRow('posted', 'c-1');
    const insert = () => pool.query(
      `INSERT INTO bank_feed_transaction_conflicts(company_id,connection_id,bank_transaction_id,
         provider_transaction_id,reason,proposed) VALUES($1,$2,$3,'c-1','processed_row_changed','{}')`,
      [company, conn, id]);
    await insert();
    await expect(insert()).rejects.toThrow(/uq_bank_feed_conflict_open/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run `bun run test:integration -- tests/integration/bank-feed-schema-guard.int.test.ts` with the env block exported.

Expected: FAIL on `column "bank_feed_connection_id" ... does not exist` (the migration hasn't been applied).

- [ ] **Step 4: Write the migration**

```sql
-- 675_bank_feed_canonical_ingestion.sql
-- Bank sync v1 Release 1: feed identity + lifecycle on bank_transactions, a
-- database backstop that keeps non-posted feed rows out of every accounting
-- mutation, protected-conflict storage, and richer sync-log counts.
-- No DML on existing rows: feed_state's constant DEFAULT is a catalog-only
-- change (PG11+), and every new column is NULL or defaulted.

-- 1. Tenant-composite key on connections so child FKs carry ownership.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_feed_connections_id_company
  ON bank_feed_connections (id, company_id);

ALTER TABLE bank_feed_connections
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;

-- 2. Feed columns on bank_transactions.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS bank_feed_connection_id UUID,
  ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS feed_state TEXT NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feed_last_seen_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_feed_state_check') THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_tx_feed_state_check
      CHECK (feed_state IN ('pending', 'posted', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_feed_identity_required') THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_tx_feed_identity_required
      CHECK (feed_state = 'posted'
             OR (bank_feed_connection_id IS NOT NULL AND provider_transaction_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bank_tx_feed_connection') THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT fk_bank_tx_feed_connection
      FOREIGN KEY (bank_feed_connection_id, company_id)
      REFERENCES bank_feed_connections (id, company_id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_feed_identity
  ON bank_transactions (company_id, bank_feed_connection_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_tx_feed_state_nonposted
  ON bank_transactions (company_id, bank_account_id)
  WHERE feed_state <> 'posted';

-- 3. Backstop trigger. Columns are the accounting-workflow columns created by
--    migrations (203, 253/282, 414, 492, 514, 520). The drift columns
--    (transfer_journal_entry_id etc.) are deliberately absent: every writer of
--    them also writes status, which is guarded.
CREATE OR REPLACE FUNCTION bank_tx_feed_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feed_state IS DISTINCT FROM OLD.feed_state
     AND NOT (OLD.feed_state = 'pending' AND NEW.feed_state IN ('posted', 'removed')) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: bank transaction % cannot move from % to %',
      OLD.id, OLD.feed_state, NEW.feed_state USING ERRCODE = '23514';
  END IF;

  IF OLD.feed_state <> 'posted' AND (
       NEW.status, NEW.matched_journal_line_id, NEW.reconciliation_id, NEW.allocation_type,
       NEW.provisional_je_id, NEW.auto_post_run_id, NEW.allocation_batch_id, NEW.allocation_rule_id
     ) IS DISTINCT FROM (
       OLD.status, OLD.matched_journal_line_id, OLD.reconciliation_id, OLD.allocation_type,
       OLD.provisional_je_id, OLD.auto_post_run_id, OLD.allocation_batch_id, OLD.allocation_rule_id
     ) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: bank transaction % is % at the bank and cannot be processed',
      OLD.id, OLD.feed_state USING ERRCODE = '23514';
  END IF;

  IF OLD.bank_feed_connection_id IS NOT NULL
     AND (OLD.status <> 'imported' OR OLD.matched_journal_line_id IS NOT NULL
          OR OLD.provisional_je_id IS NOT NULL)
     AND (NEW.transaction_date, NEW.value_date, NEW.amount, NEW.description, NEW.reference)
         IS DISTINCT FROM
         (OLD.transaction_date, OLD.value_date, OLD.amount, OLD.description, OLD.reference) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: processed feed transaction % source fields are immutable',
      OLD.id USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_bank_tx_feed_state_guard ON bank_transactions;
CREATE TRIGGER trg_bank_tx_feed_state_guard
  BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_tx_feed_state_guard();

-- 4. Protected conflicts.
CREATE TABLE IF NOT EXISTS bank_feed_transaction_conflicts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id),
  connection_id           UUID NOT NULL,
  bank_transaction_id     UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  provider_transaction_id TEXT NOT NULL,
  reason                  TEXT NOT NULL CHECK (reason IN (
                            'processed_row_changed', 'posted_row_removed',
                            'posted_row_reverted_to_pending', 'removed_row_reappeared',
                            'unordered_change')),
  proposed                JSONB NOT NULL,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at             TIMESTAMPTZ,
  CONSTRAINT fk_bfc_conflict_connection FOREIGN KEY (connection_id, company_id)
    REFERENCES bank_feed_connections (id, company_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_feed_conflict_open
  ON bank_feed_transaction_conflicts (company_id, connection_id, provider_transaction_id)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bank_feed_conflict_company_open
  ON bank_feed_transaction_conflicts (company_id, connection_id) WHERE resolved_at IS NULL;

ALTER TABLE bank_feed_transaction_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_transaction_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_feed_transaction_conflicts;
CREATE POLICY tenant_isolation ON bank_feed_transaction_conflicts
  FOR ALL
  TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_transaction_conflicts TO app_user;

-- 5. Sync-log counts.
ALTER TABLE bank_feed_sync_logs
  ADD COLUMN IF NOT EXISTS transactions_updated  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_pending  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_removed  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_conflict INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_ignored  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_code TEXT;
```

- [ ] **Step 5: Apply it to the fixture and run the test until it passes**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql  # re-run: must be idempotent
bun run test:integration -- tests/integration/bank-feed-schema-guard.int.test.ts
```

Expected: PASS, and the second `psql` run exits 0.

- [ ] **Step 6: Mutation check.** Delete `NEW.status,` and `OLD.status,` from the trigger's second tuple, re-apply, and re-run. The two `status` cases must go red. Restore the columns, re-apply, and confirm green.

- [ ] **Step 7: Run the migration gates**

```bash
bun scripts/ci/check-migration-rls.ts && node scripts/validate-migrations.mjs && bun scripts/audit-migration-naming.ts
```

Expected: exit 0 with no new RLS or duplicate-prefix findings.

- [ ] **Step 8: Commit**

```bash
git add scripts/migrations/sql/675_bank_feed_canonical_ingestion.sql tests/integration/bank-feed-schema-guard.int.test.ts
git commit -m "feat(bank): feed identity, lifecycle backstop and conflict storage (migration 675)"
```

---

### Task 2: Feed-state guard helper and locked-mutator refusals

**Files:**
- Create: `src/modules/accounting/services/bank/bankFeedStateGuard.ts`
- Modify: `src/modules/accounting/services/bank/bankTxStatusMutations.ts` (`lockForStatusWrite`, ~L84)
- Modify: `src/modules/accounting/services/bank/bankAllocationService.ts` (allocate ~L113, split ~L562)
- Modify: `src/modules/accounting/services/bank/bankRuleAutoPostLine.ts` (~L85)
- Modify: `src/modules/accounting/services/capture/provisionalPostingService.ts` (~L162–177)
- Modify: `src/modules/accounting/types/bank.types.ts` (`BankTransaction`, L40)
- Modify: `src/modules/accounting/services/bank/bankTxRowMapper.ts` (`mapTxRow`)
- Modify: `src/modules/accounting/services/bank/bankTxQueryFragments.ts` (`TX_SELECT`, L103)
- Test: `tests/unit/services/bank/bankFeedStateGuard.test.ts`
- Test: `tests/unit/services/bankAllocationPendingRefusal.test.ts`

**Interfaces:**
- Produces:

```ts
export type FeedState = 'pending' | 'posted' | 'removed';
export function feedStateOf(row: { feed_state?: unknown }): FeedState;
export class BankTransactionNotPostedError extends Error {
  readonly code: 'BANK_TX_NOT_POSTED'; readonly feedState: FeedState;
  constructor(bankTxId: string, feedState: FeedState, verb: string);
}
export function assertFeedPosted(row: { id?: unknown; feed_state?: unknown }, verb: string): void;
export function isBankTransactionNotPosted(err: unknown): err is BankTransactionNotPostedError;
export async function readFeedState(companyId: string, bankTxId: string): Promise<FeedState | null>;
```

- `BankTransaction` gains `feedState: FeedState`.

- [ ] **Step 1: Write the failing unit test for the helper**

```ts
// tests/unit/services/bank/bankFeedStateGuard.test.ts
import { describe, expect, it } from 'vitest';
import {
  assertFeedPosted, BankTransactionNotPostedError, feedStateOf, isBankTransactionNotPosted,
} from '@/modules/accounting/services/bank/bankFeedStateGuard';

describe('bankFeedStateGuard', () => {
  it('treats a row without feed_state as posted (pre-675 row shape)', () => {
    expect(feedStateOf({})).toBe('posted');
  });
  it('refuses a pending row with a typed, readable error', () => {
    let caught: unknown;
    try { assertFeedPosted({ id: 'tx-1', feed_state: 'pending' }, 'allocate'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BankTransactionNotPostedError);
    expect(isBankTransactionNotPosted(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/pending at the bank/);
    expect((caught as Error).message).toMatch(/allocate/);
  });
  it('refuses a removed row', () => {
    expect(() => assertFeedPosted({ id: 'tx-2', feed_state: 'removed' }, 'match')).toThrow(/removed/);
  });
  it('passes a posted row', () => {
    expect(() => assertFeedPosted({ id: 'tx-3', feed_state: 'posted' }, 'exclude')).not.toThrow();
  });
  it('rejects an unknown feed_state rather than guessing', () => {
    expect(() => feedStateOf({ feed_state: 'weird' })).toThrow(/Unknown feed_state/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run `env -u DATABASE_URL bun run test:unit -- tests/unit/services/bank/bankFeedStateGuard.test.ts`.

Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement the helper**

```ts
// src/modules/accounting/services/bank/bankFeedStateGuard.ts
/**
 * Bank feed lifecycle guard. A feed row is `pending` or `removed` at the bank
 * until the provider posts it. Such a row is visible in the review queue but
 * no accounting mutation may touch it.
 *
 * Migration 675's trigger refuses the write in the database whatever the
 * writer. That backstop answers with a 500 (the transaction rolls back). This
 * module lets the locked mutators refuse FIRST, from the row they already
 * hold, before any write, so the caller gets a 4xx with a reason instead.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type FeedState = 'pending' | 'posted' | 'removed';
const FEED_STATES: readonly FeedState[] = ['pending', 'posted', 'removed'];

export function feedStateOf(row: { feed_state?: unknown }): FeedState {
  if (row.feed_state === undefined || row.feed_state === null) return 'posted';
  const s = String(row.feed_state);
  if (!(FEED_STATES as readonly string[]).includes(s)) throw new Error(`Unknown feed_state "${s}"`);
  return s as FeedState;
}

export class BankTransactionNotPostedError extends Error {
  readonly code = 'BANK_TX_NOT_POSTED' as const;
  constructor(bankTxId: string, readonly feedState: FeedState, verb: string) {
    super(
      feedState === 'pending'
        ? `Bank transaction ${bankTxId} is still pending at the bank — you can ${verb} it once it posts.`
        : `Bank transaction ${bankTxId} was removed by the bank — it cannot be used to ${verb}.`,
    );
    this.name = 'BankTransactionNotPostedError';
  }
}

export function isBankTransactionNotPosted(err: unknown): err is BankTransactionNotPostedError {
  return err instanceof Error && (err as { code?: unknown }).code === 'BANK_TX_NOT_POSTED';
}

export function assertFeedPosted(row: { id?: unknown; feed_state?: unknown }, verb: string): void {
  const state = feedStateOf(row);
  if (state !== 'posted') throw new BankTransactionNotPostedError(String(row.id ?? ''), state, verb);
}

/** Unlocked read for routes that must refuse before their first write. */
export async function readFeedState(companyId: string, bankTxId: string): Promise<FeedState | null> {
  const rows = (await sql`
    SELECT feed_state FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ? feedStateOf(rows[0]) : null;
}
```

- [ ] **Step 4: Run the helper test and confirm it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Write the failing mutator test**

This follows the mocked-`sql` pattern in `tests/unit/services/bankAllocationRowLock.test.ts`: mock `@/lib/neon` and the logger, call `enterFakeRequestCtx()` from `tests/unit/helpers/requestCtx.ts`, and make the lock SELECT return a pending row.

```ts
// tests/unit/services/bankAllocationPendingRefusal.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return { ...actual, sql: vi.fn(async () => [] as unknown[]), withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(vi.fn())) };
});

import { sql } from '@/lib/neon';
import { enterFakeRequestCtx } from '../helpers/requestCtx';
import { allocateTransaction, splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { isBankTransactionNotPosted } from '@/modules/accounting/services/bank/bankFeedStateGuard';

const CO = '00000000-0000-0000-0000-00000000000c';
const TX = '00000000-0000-0000-0000-0000000000a1';
const pendingRow = { id: TX, company_id: CO, status: 'imported', amount: '-100', feed_state: 'pending', matched_journal_line_id: null };

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(sql).mockImplementation(async () => [pendingRow] as unknown[]);
  enterFakeRequestCtx();
});

describe('locked mutators refuse a pending feed row before writing', () => {
  it.each([
    ['allocate', () => allocateTransaction(CO, TX, 'gl-1', 'user-1')],
    ['split', () => splitAllocateTransaction(CO, TX, [{ glAccountId: 'gl-1', amount: 100 }] as never, 'user-1')],
    ['match', () => matchTransaction(CO, TX, 'line-1')],
    ['unmatch', () => unmatchTransaction(CO, TX)],
    ['exclude', () => excludeTransaction(CO, TX, 'r')],
  ])('%s', async (_verb, run) => {
    let caught: unknown;
    try { await run(); } catch (e) { caught = e; }
    expect(isBankTransactionNotPosted(caught)).toBe(true);
    // Only the lock SELECT ran; no INSERT/UPDATE was issued.
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => /\b(INSERT|UPDATE)\b/i.test(t))).toBe(false);
  });
});
```

If `enterFakeRequestCtx` needs arguments, or the lock helper's raw `client.query` calls need a fake client, copy exactly what `bankAllocationRowLock.test.ts` does. That file is the source of truth for this harness.

- [ ] **Step 6: Run it and confirm it fails**

Run `env -u DATABASE_URL bun run test:unit -- tests/unit/services/bankAllocationPendingRefusal.test.ts`.

Expected: FAIL. The mutators proceed past the lock.

- [ ] **Step 7: Wire the guard into each mutator**

In `bankTxStatusMutations.ts` `lockForStatusWrite`, directly after the `if (!row) throw …` line:

```ts
  assertFeedPosted(row, verb);
```

In `bankAllocationService.ts` `allocateTransaction`, directly after the `if (!tx) throw new BankAllocationRefusal(...)` line and **before** the `status !== 'imported'` check:

```ts
  // A pending/removed feed row carries status 'imported', so the status check
  // below would let it through. Refused from the locked row, before any write.
  if (feedStateOf(tx) !== 'posted') {
    throw new BankAllocationRefusal(new BankTransactionNotPostedError(bankTxId, feedStateOf(tx), 'allocate').message);
  }
```

It uses `BankAllocationRefusal` so the routes that already answer that class with a 4xx keep doing so. In `splitAllocateTransaction`, add the same lines with the verb `'split allocate'`. Add the imports `feedStateOf` and `BankTransactionNotPostedError` from `./bankFeedStateGuard`.

Then update the test expectation for allocate and split: `expect(isBankTransactionNotPosted(caught) || isBankAllocationRefusal(caught)).toBe(true)` and `expect((caught as Error).message).toMatch(/pending at the bank/)`. Import `isBankAllocationRefusal` from `bankAllocationRefusal`.

In `bankRuleAutoPostLine.ts` (~L85), extend the raced check:

```ts
  if (!locked || String(locked.status) !== 'imported' || locked.matched_journal_line_id
      || feedStateOf(locked) !== 'posted') {
    return { kind: 'raced' };
  }
```

In `provisionalPostingService.ts`, add `feed_state` to the SELECT column list at ~L162. Directly after the `status !== 'imported'` early return, add:

```ts
  if (feedStateOf(tx) !== 'posted') {
    return {
      journalEntryId: null,
      prediction: { supplierId: null, supplierName: null, glAccountId: null, vatCode: null, costCentreId: null, projectId: null, confidence: 0, basis: 'none' },
      skipped: `feed_state ${feedStateOf(tx)}`,
    };
  }
```

- [ ] **Step 8: Expose `feedState` on the domain type**

In `bank.types.ts`, import `FeedState` from `../services/bank/bankFeedStateGuard` and add `feedState: FeedState;` to `BankTransaction`. If that import creates a cycle (tsc will say), declare `export type FeedState = 'pending' | 'posted' | 'removed';` in `bank.types.ts` and have `bankFeedStateGuard.ts` import it from there instead.

In `TX_SELECT`, add `bt.feed_state,` after `bt.status,`. In `mapTxRow`, add `feedState: feedStateOf(row),` after `status`.

- [ ] **Step 9: Run the tests, type-check and the bank unit suite**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/services/bankAllocationPendingRefusal.test.ts tests/unit/services/bank/bankFeedStateGuard.test.ts
bun run type-check
env -u DATABASE_URL bun run test:unit -- tests/unit/services/bank tests/unit/services/bankAllocation tests/unit/services/bankTx
```

Expected: PASS. Fix any constructor of `BankTransaction` that tsc flags by adding `feedState: 'posted'`. Fixtures under `tests/**` sit outside tsconfig, so also grep `tests/` for object literals typed `BankTransaction` and add the field.

- [ ] **Step 10: Mutation check.** Comment out the `assertFeedPosted(row, verb)` line: the match/unmatch/exclude cases must go red. Restore it and confirm green.

- [ ] **Step 11: Commit**

```bash
git add src/modules/accounting/services/bank/bankFeedStateGuard.ts src/modules/accounting/services/bank/bankTxStatusMutations.ts \
  src/modules/accounting/services/bank/bankAllocationService.ts src/modules/accounting/services/bank/bankRuleAutoPostLine.ts \
  src/modules/accounting/services/capture/provisionalPostingService.ts src/modules/accounting/types/bank.types.ts \
  src/modules/accounting/services/bank/bankTxRowMapper.ts src/modules/accounting/services/bank/bankTxQueryFragments.ts \
  tests/unit/services/bank/bankFeedStateGuard.test.ts tests/unit/services/bankAllocationPendingRefusal.test.ts
git commit -m "feat(bank): locked mutators refuse pending and removed feed rows before writing"
```

(Add any fixture files you touched to the `git add` by explicit path.)

---

### Task 3: Set-based writers skip non-posted rows

These writers select candidates by predicate rather than locking one row. A pending row matching their predicate would hit the trigger and 500 the whole operation, so each gets an explicit `feed_state = 'posted'` predicate. Two routes (asset and fleet) write another table before the bank row, so they get a pre-write read instead.

**Files:**
- Modify: `src/modules/accounting/services/bank/bankTransactionQueryService.ts`: `deleteTransactions` (~L204) and `bulkAcceptTransactions` (~L227)
- Modify: `src/modules/accounting/services/bank/bankAutoMatchService.ts`: candidate SELECT (~L27–33)
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts`: `sweep` row SELECT (~L146)
- Modify: `src/modules/accounting/services/bank/bankRulesSuggestionPass.ts`: `matched` CTE WHERE (~L70)
- Modify: `src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts`: `findMatchingTxs` candidate WHERE
- Modify: `src/modules/accounting/services/bank/bankReconciliationService.ts`: `startReconciliation` UPDATE (~L95)
- Modify: `src/modules/accounting/services/bank/bankTransferLinkService.ts`: both passes (UPDATEs ~L99 and ~L221, plus the CTE candidate predicates feeding them)
- Modify: `src/modules/accounting/services/bank/bankTransferAutoLink.ts`: UPDATE (~L82) and its candidate SELECT
- Modify: `pages/api/accounting/bank-transactions-action.ts`: `save_selection` (~L158) and the error mapping
- Modify: `pages/api/accounting/bank-match-asset.ts` and `pages/api/accounting/bank-match-fleet.ts`: pre-write read
- Test: `tests/integration/bank-feed-pending-writers.int.test.ts`

**Interfaces:**
- Consumes `readFeedState`, `isBankTransactionNotPosted` and `BankTransactionNotPostedError` from Task 2, and the Task 1 schema.

- [ ] **Step 1: Write the failing integration test**

The test seeds one posted row and one pending row on the same account and runs each set-based writer through the service layer inside `als.run`. The pending row must come out unchanged, and no call may throw `BANK_TX_FEED_GUARD`.

```ts
// tests/integration/bank-feed-pending-writers.int.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();
let postedId = '';
let pendingId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPW company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','BFPW Bank','asset','debit','bank')`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function seed(): Promise<void> {
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  const ins = (state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-02',-42.5,'BFPW WOOLWORTHS',$3,$4,$5) RETURNING id`,
    [company, bank, pid ? conn : null, pid, state]);
  postedId = String((await ins('posted', null)).rows[0].id);
  pendingId = String((await ins('pending', `pend-${crypto.randomUUID()}`)).rows[0].id);
}

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function pendingUntouched(): Promise<void> {
  const { rows } = await pool.query(
    'SELECT status, reconciliation_id, feed_state FROM bank_transactions WHERE id=$1', [pendingId]);
  expect(rows[0]).toEqual({ status: 'imported', reconciliation_id: null, feed_state: 'pending' });
}

describe('set-based writers leave a pending feed row alone', () => {
  it('bulkAcceptTransactions', async () => {
    await seed();
    const { bulkAcceptTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const n = await inRequest(() => bulkAcceptTransactions(company, [postedId, pendingId]));
    expect(n).toBe(1);
    await pendingUntouched();
  });

  it('deleteTransactions', async () => {
    await seed();
    const { deleteTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const n = await inRequest(() => deleteTransactions(company, [postedId, pendingId]));
    expect(n).toBe(1);
    await pendingUntouched();
  });

  it('startReconciliation', async () => {
    await seed();
    const { startReconciliation } = await import('@/modules/accounting/services/bank/bankReconciliationService');
    await inRequest(() => startReconciliation(company, bank, '2026-09-30', 0, user));
    await pendingUntouched();
  });

  it('suggestion rules', async () => {
    await seed();
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,
         gl_account_id,is_active,auto_create_entry,priority)
       VALUES($1,'BFPW rule','description','contains','WOOLWORTHS',$2,true,false,1)`, [company, bank]);
    const { applySuggestionRules } = await import('@/modules/accounting/services/bank/bankRulesSuggestionPass');
    const rules = (await pool.query('SELECT * FROM bank_categorisation_rules WHERE company_id=$1', [company])).rows;
    const entries = await inRequest(() => applySuggestionRules(company, bank, rules));
    expect(entries.map((e) => e.transactionId ?? (e as { id?: string }).id)).not.toContain(pendingId);
  });

  it('autoMatchTransactions does not throw on a pending row', async () => {
    await seed();
    const { autoMatchTransactions } = await import('@/modules/accounting/services/bank/bankAutoMatchService');
    await inRequest(() => autoMatchTransactions(company, bank));
    await pendingUntouched();
  });
});
```

Before running, check the exact signatures of `startReconciliation` and `applySuggestionRules`'s entry shape in the source, and adjust the call and the `entries` mapping to match. **Don't** change production signatures to fit the test. Also check the `bank_categorisation_rules` NOT NULL columns in the fixture (`\d bank_categorisation_rules`) and supply any the INSERT is missing.

- [ ] **Step 2: Run it and confirm it fails**

Run `bun run test:integration -- tests/integration/bank-feed-pending-writers.int.test.ts`.

Expected: `bulkAccept` and `startReconciliation` reject with `BANK_TX_FEED_GUARD`, and `deleteTransactions` returns 2.

- [ ] **Step 3: Add the predicates**

On the `bank_transactions` alias of each statement, add `AND feed_state = 'posted'`, or `AND bt.feed_state = 'posted'` where the query uses the `bt` alias:

| File | Statement | Where to add |
|---|---|---|
| `bankTransactionQueryService.ts` | `deleteTransactions` DELETE | after `status = 'imported'` |
| `bankTransactionQueryService.ts` | `bulkAcceptTransactions` UPDATE | after `status IN ('imported', 'allocated')` |
| `bankAutoMatchService.ts` | candidate SELECT | after `status = 'imported'` |
| `autoPostGateService.ts` | `sweep` row SELECT | see below |
| `bankRulesSuggestionPass.ts` | `matched` CTE | after `bt.status = 'imported'` |
| `bankRulesMatchingHelpers.ts` | `findMatchingTxs` | beside its `status = 'imported'` predicate |
| `bankReconciliationService.ts` | `startReconciliation` UPDATE | after `status = 'imported'` |
| `bankTransferLinkService.ts` | both passes | every `status = 'imported'` predicate on a bank_transactions alias that selects rows the UPDATE writes, and the UPDATE's own WHERE |
| `bankTransferAutoLink.ts` | UPDATE and its candidate SELECT | beside `status = 'imported'` |
| `bank-transactions-action.ts` | `save_selection` UPDATE | after `status IN ('imported', 'allocated')` (suggestions on a pending row are harmless, but a saved selection is a user's pre-allocation choice, and the button is disabled for pending rows anyway) |

For `sweep`, don't filter silently. Add `feed_state` to its SELECT list and to `SweepRow`. Immediately after the SELECT, add:

```ts
  for (const r of rows) {
    if (r.feed_state && r.feed_state !== 'posted') {
      skipped.push({ txId: String(r.id), reason: `feed_state ${r.feed_state}` });
    }
  }
  const postable = rows.filter((r) => !r.feed_state || r.feed_state === 'posted');
```

Then iterate over `postable` wherever the function iterated over `rows`. Declare `skipped` above this block if it isn't already.

- [ ] **Step 4: Refuse before the first write in the asset and fleet routes, and map the typed refusal in the action route**

In `bank-match-asset.ts` and `bank-match-fleet.ts`, after body validation and before the first `await sql` write, add:

```ts
  const feedState = await readFeedState(companyId, bankTransactionId);
  if (feedState === null) return apiResponse.notFound(res, 'Bank transaction not found');
  if (feedState !== 'posted') {
    return apiResponse.conflict(res, new BankTransactionNotPostedError(bankTransactionId, feedState, 'link').message);
  }
```

In `bank-transactions-action.ts`, find the `catch` that maps service errors to 400. Before its generic branch, add `if (isBankTransactionNotPosted(err)) return apiResponse.conflict(res, err.message);`. This is safe because every path that throws it does so before its first write.

- [ ] **Step 5: Run the integration test and confirm it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 6: Mutation check.** Remove the predicate from `bulkAcceptTransactions`: that case must go red. Restore it.

- [ ] **Step 7: Run the unit suites for the touched services**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/services
```

Expected: PASS. Update any mocked-SQL test that asserts exact SQL text for these statements to include the new predicate; that's a legitimate expectation change.

- [ ] **Step 8: Commit** each modified file and the test, by explicit path, with the message `feat(bank): set-based bank writers skip pending and removed feed rows`.

---

### Task 4: Readers: the review queue hides removed rows and totals count only posted rows

**Files:**
- Modify: `src/modules/accounting/services/bank/bankTransactionQueryService.ts` (`getBankTransactions`: the `bankAccountId+status`, `bankAccountId` and company-wide branches, including their COUNT queries)
- Modify: `src/modules/accounting/services/bank/bankAccountStatusService.ts` (lateral WHERE, ~L113)
- Modify: `src/modules/accounting/services/bank/bankCoverageQueries.ts` (`fetchCoverageAccounts` ~L103 JOIN ON, `fetchCoverageMonths` ~L157, `fetchDuplicateReferences` ~L237)
- Modify: `src/modules/accounting/services/bank/bankCoverageDirections.ts` (~L43 `statement_only` subquery)
- Modify: `src/modules/accounting/services/reports/kpiDashboardService.ts` (~L88, ~L103)
- Modify: `src/modules/accounting/services/reports/kpiChartsService.ts` (~L92)
- Modify: `src/modules/accounting/services/consolidatedReportingService.ts` (~L111; confirm the path with `git ls-files | grep consolidatedReportingService`)
- Modify: `pages/api/accounting/reports/cash-movement.ts` (~L76, ~L99)
- Modify: `pages/api/accounting/bank-reconciliation-report.ts` (~L77–79, ~L94–96)
- Modify: `src/modules/accounting/services/bank/bankReconciliationService.ts` (`getReconciliations` counts ~L28–29)
- Modify: the workbench service (`workbenchService.ts` ~L24; find it with `git ls-files | grep workbenchService`)
- Test: `tests/integration/bank-feed-pending-readers.int.test.ts`

**Rules:**
- The **review queue** shows pending rows (with the badge from Task 9) and hides removed rows: add `AND bt.feed_state <> 'removed'`.
- **Totals and counts** include only posted rows: add `AND bt.feed_state = 'posted'`.
- In a `LEFT JOIN … ON` put the predicate inside the `ON`, not the `WHERE`, or the account row disappears.
- The `reconciliationId` branch needs nothing: a non-posted row can't acquire a `reconciliation_id` (Task 3 plus the trigger).

- [ ] **Step 1: Enumerate what else sums or counts bank rows.** Classify every hit before editing. Any hit that feeds a statement balance, coverage figure, KPI or reconciliation count joins the list above.

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/bank-sync-v1-20260911
grep -rnE "(SUM|COUNT)\([^)]*\)[^;]*FROM bank_transactions|FROM bank_transactions[^;]*(SUM|COUNT)" src pages --include=*.ts | grep -v '\.test\.'
grep -rln "FROM bank_transactions" src/modules/accounting/services/reports pages/api/accounting/reports
```

Record the classified list, with file:line and a verdict of "filtered" or "exempt: <reason>", in the PR description.

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/bank-feed-pending-readers.int.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const conn = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'BFPR company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
     VALUES($1,$2,'1110','BFPR Bank','asset','debit','bank',true)`, [bank, company]);
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active)
     VALUES($1,$2,$3,'test_provider','active',true)`, [conn, company, bank]);
  const ins = (amount: number, state: string, pid: string | null) => pool.query(
    `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,
       bank_feed_connection_id,provider_transaction_id,feed_state)
     VALUES($1,$2,'2026-09-03',$3,'BFPR',$4,$5,$6)`,
    [company, bank, amount, pid ? conn : null, pid, state]);
  await ins(-100, 'posted', null);
  await ins(-30, 'pending', 'bfpr-pending');
  await ins(-7, 'removed', 'bfpr-removed');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

describe('readers', () => {
  it('cash statement balance counts only posted rows', async () => {
    const { getBankAccountsStatus } = await import('@/modules/accounting/services/bank/bankAccountStatusService');
    const accounts = await inRequest(() => getBankAccountsStatus(company));
    const acct = (accounts as Array<{ id?: string; accountId?: string; balance?: number; txnCount?: number }>)
      .find((a) => (a.id ?? a.accountId) === bank);
    expect(acct?.balance).toBe(-100);
  });

  it('review queue shows pending, hides removed, and exposes feedState', async () => {
    const { getBankTransactions } = await import('@/modules/accounting/services/bank/bankTransactionQueryService');
    const page = await inRequest(() => getBankTransactions(company, { bankAccountId: bank, status: 'imported' }));
    const states = page.transactions.map((t) => t.feedState).sort();
    expect(states).toEqual(['pending', 'posted']);
    expect(page.total).toBe(2);
  });
});
```

Check `getBankAccountsStatus`'s real parameter list and return field names in `bankAccountStatusService.ts`, and adjust the `find` and the `balance` field to match.

- [ ] **Step 3: Run it and confirm it fails**

Run `bun run test:integration -- tests/integration/bank-feed-pending-readers.int.test.ts`.

Expected: FAIL, with balance −137 and 3 queue rows.

- [ ] **Step 4: Add the predicates** to every statement in the file list, following the rules above.

- [ ] **Step 5: Run the test and confirm it passes**

Same command as Step 3. Expected: PASS.

- [ ] **Step 6: Mutation check.** Remove the status-service predicate: the balance goes back to −137 and the test goes red. Restore it.

- [ ] **Step 7: Run `env -u DATABASE_URL bun run test:unit -- tests/unit/services tests/unit/benchmark`** and update any SQL-text assertions for the new predicates.

- [ ] **Step 8: Commit** with the message `feat(bank): statement totals count posted feed rows only; queue hides removed rows`.

---

### Task 5: Module docs for PR A, then open PR A

**Files:**
- Modify: `src/modules/accounting/services/bank/.claude.md`
- Generated: `src/modules/accounting/services/bank/AGENTS.md` (via `bun run agent-docs:generate`)

- [ ] **Step 1: Update the bank module rules**

Add these bullets under the existing rules in `src/modules/accounting/services/bank/.claude.md`, keeping the file under 50 lines of new content:

```markdown
- **Feed lifecycle (migration 675).** `bank_transactions.feed_state` is `pending | posted | removed`, independent of `status`. Manual and statement rows are `posted`. A non-posted row is visible in the review queue and nowhere else: every accounting mutation refuses it, and every statement total, coverage figure and KPI filters `feed_state = 'posted'`.
- **Three layers, all required.** (1) Locked mutators call `assertFeedPosted` from the row they hold, before the first write (`bankFeedStateGuard.ts`). (2) Set-based writers carry `feed_state = 'posted'` in their candidate predicate. (3) Trigger `trg_bank_tx_feed_state_guard` refuses any accounting-column change on a non-posted row and any source-field change on a processed feed row (SQLSTATE 23514, `BANK_TX_FEED_GUARD:`). A new writer that forgets (1) or (2) gets a 500 from (3); the trigger is a backstop, not the user-facing refusal.
- **Legal lifecycle moves:** `pending -> posted` and `pending -> removed` only.
```

- [ ] **Step 2: Regenerate and check the mirrors**

```bash
bun run agent-docs:generate && bun run agent-docs:check
```

- [ ] **Step 3: Run the full gate**

Run `bun run ci`. Expected: exit 0. Check the load average first (`uptime`) and don't run CI above ~30.

- [ ] **Step 4: Run the blind review.** Invoke the `/review` skill on the PR A commits. Don't pass session reasoning. Because this PR changes ledger-adjacent guards, also run the adversarial "policy-break" round (memory `feedback_adversarial_reviewer_for_ledger_writes`). Fix every H/M/L finding, then re-run CI.

- [ ] **Step 5: Commit the docs, push, and open PR A**

```bash
git add src/modules/accounting/services/bank/.claude.md src/modules/accounting/services/bank/AGENTS.md
git commit -m "docs(bank): feed lifecycle guard rules"
timeout 420 git push -u origin feat/bank-sync-v1-20260911
gh pr create --base master --title "feat(bank): feed lifecycle columns and pending guards" --body-file <(printf '%s\n' "Release 1 / PR A of bank sync v1. Spec: docs/superpowers/specs/2026-09-11-bank-sync-v1-design.md. Plan: docs/superpowers/plans/2026-09-11-bank-sync-v1-release-1.md (Tasks 0-5)." "" "Migration 675 needs psql application to the golden/dev DB before golden paths run." "" "Reader census (Task 4 Step 1): <paste classified list>" "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" "" "https://claude.ai/code/session_01CfdvUBW5ESk5cofPu5TVkw")
```

Before merging, run `gh pr view --json commits` and check that it lists only this branch's commits. Wait for PR A to merge before starting Task 6. Then rebase the branch onto the merged master, or cut `feat/bank-sync-v1-r1b-20260911` from master and continue there. Never force-push a shared branch.

---

### Task 6: Canonical feed ingestion service

**Files:**
- Create: `src/modules/accounting/services/bank/feed/bankIngestionTypes.ts`
- Create: `src/modules/accounting/services/bank/feed/bankIngestionValidation.ts`
- Create: `src/modules/accounting/services/bank/feed/bankFeedLifecycle.ts`
- Create: `src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts`
- Create: `src/modules/accounting/services/bank/feed/bankIngestionService.ts`
- Create: `src/modules/accounting/services/bank/feed/.claude.md`
- Test: `tests/unit/services/bank/feed/bankFeedLifecycle.test.ts`
- Test: `tests/unit/services/bank/feed/bankIngestionValidation.test.ts`
- Test: `tests/integration/bank-feed-ingestion.int.test.ts`

**Interfaces:**
- Consumes `FeedState` and `feedStateOf` (Task 2), `bankTransactionHash` from `@/modules/accounting/utils/bankTransactionHash`, `applySuggestionRules` from `../bankRulesSuggestionPass` (posted-only after Task 3), and `withSavepoint` and `assertTxUsable` from `@/lib/neon`.
- Produces the contents of `bankIngestionTypes.ts`, shown here in full:

```ts
// src/modules/accounting/services/bank/feed/bankIngestionTypes.ts
/** Canonical bank-feed ingestion contract (spec §1, Release 1 amendments). */
import type { FeedState } from '../bankFeedStateGuard';

export type { FeedState };

export interface BankIngestionSource {
  kind: 'feed';
  connectionId: string;
  providerBatchId?: string;
  cursor?: string;
}

export type BankTransactionIdentity =
  | { kind: 'provider'; providerTransactionId: string }
  | { kind: 'content_hash'; contentHash: string };

export interface NormalizedBankTransaction {
  identity: BankTransactionIdentity;
  state: FeedState;
  transactionDate: string;   // YYYY-MM-DD, a real calendar date
  valueDate?: string;
  amount: number;            // signed, finite
  currency: 'ZAR';
  description: string;
  reference?: string;
  balance?: number;
  providerUpdatedAt?: string; // ISO-8601
}

export interface BankIngestionBatch {
  source: BankIngestionSource;
  fetchedAt: string;
  transactions: NormalizedBankTransaction[];
}

export interface BankIngestionCounts {
  found: number; inserted: number; updated: number; duplicate: number;
  pending: number; removed: number; conflicts: number; ignored: number;
}

export interface BankIngestionResult {
  logId: string;
  importBatchId: string | null;
  counts: BankIngestionCounts;
  appliedSuggestions: number;
  warnings: string[];
}

export type IdentityMode = 'provider' | 'content_hash';

export type BankIngestionRefusalCode =
  | 'CONNECTION_NOT_FOUND' | 'CONNECTION_INACTIVE' | 'UNSUPPORTED_PROVIDER'
  | 'BANK_ACCOUNT_INVALID' | 'IDENTITY_MODE_MISMATCH' | 'INVALID_TRANSACTION'
  | 'DUPLICATE_PROVIDER_ID' | 'SYNC_IN_PROGRESS';

export class BankIngestionRefusal extends Error {
  constructor(readonly code: BankIngestionRefusalCode, message: string, readonly index?: number) {
    super(message);
    this.name = 'BankIngestionRefusal';
  }
}

export function isBankIngestionRefusal(err: unknown): err is BankIngestionRefusal {
  return err instanceof Error && err.name === 'BankIngestionRefusal';
}
```

- Produces this entry point: `ingestBankBatch(companyId: string, batch: BankIngestionBatch, opts: { userId: string; sourceLabel: string; bankFormat: string | null }): Promise<BankIngestionResult>`. It throws `BankIngestionRefusal` only before any `bank_transactions` write, having already committed a failed sync-log row when a connection exists. It throws anything else as a fault (500).
- Produces `contentHashIdentity(tx: { transactionDate: string; amount: number; description: string }): BankTransactionIdentity`, which callers use to build content-hash identities.

**Lifecycle table** (`decideFeedTransition`). Provider identity only; content-hash rows are either `insert` or `duplicate`.

| Existing row | Incoming | Decision |
|---|---|---|
| none | posted / pending | `insert` |
| none | removed | `ignore_removed_unknown` |
| removed | removed | `duplicate` |
| removed | posted / pending | `conflict removed_row_reappeared` |
| pending | posted | `post_pending` |
| pending | removed | `remove_pending` |
| pending | pending, same values, or not newer | `duplicate` |
| pending | pending, changed and newer-or-unknown | `refresh` |
| posted | any, with incoming `providerUpdatedAt` ≤ existing | `duplicate` (stale replay) |
| posted | removed | `conflict posted_row_removed` |
| posted | pending | `conflict posted_row_reverted_to_pending` |
| posted | posted, same values | `duplicate` |
| posted, processed | posted, changed | `conflict processed_row_changed` |
| posted, unprocessed | posted, changed, newer | `refresh` |
| posted, unprocessed | posted, changed, no timestamps to order | `conflict unordered_change` |

"Processed" means `status <> 'imported' OR matched_journal_line_id IS NOT NULL OR provisional_je_id IS NOT NULL`. "Same values" compares `transactionDate`, `valueDate ?? null`, `amount` to the cent, `description`, and `reference ?? null`.

- [ ] **Step 1: Write the failing lifecycle unit test**

```ts
// tests/unit/services/bank/feed/bankFeedLifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { decideFeedTransition, type ExistingFeedRow } from '@/modules/accounting/services/bank/feed/bankFeedLifecycle';
import type { NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

const base: NormalizedBankTransaction = {
  identity: { kind: 'provider', providerTransactionId: 'p1' }, state: 'posted',
  transactionDate: '2026-09-01', amount: -100, currency: 'ZAR', description: 'SHOP',
  providerUpdatedAt: '2026-09-01T10:00:00Z',
};
const existing = (o: Partial<ExistingFeedRow> = {}): ExistingFeedRow => ({
  id: 'bt1', feedState: 'posted', processed: false, transactionDate: '2026-09-01', valueDate: null,
  amount: -100, description: 'SHOP', reference: null, providerUpdatedAt: '2026-09-01T10:00:00Z', ...o,
});
const inc = (o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({ ...base, ...o });

describe('decideFeedTransition', () => {
  it.each<[string, ExistingFeedRow | null, NormalizedBankTransaction, string]>([
    ['new posted', null, inc(), 'insert'],
    ['new pending', null, inc({ state: 'pending' }), 'insert'],
    ['unknown removed', null, inc({ state: 'removed' }), 'ignore_removed_unknown'],
    ['removed again', existing({ feedState: 'removed' }), inc({ state: 'removed', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
    ['removed reappears', existing({ feedState: 'removed' }), inc({ providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:removed_row_reappeared'],
    ['pending posts', existing({ feedState: 'pending' }), inc({ amount: -101 }), 'post_pending'],
    ['pending removed', existing({ feedState: 'pending' }), inc({ state: 'removed' }), 'remove_pending'],
    ['pending same', existing({ feedState: 'pending' }), inc({ state: 'pending' }), 'duplicate'],
    ['pending changed newer', existing({ feedState: 'pending' }), inc({ state: 'pending', amount: -99, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'refresh'],
    ['posted stale replay', existing(), inc({ amount: -1, providerUpdatedAt: '2026-08-01T00:00:00Z' }), 'duplicate'],
    ['posted removed', existing(), inc({ state: 'removed', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:posted_row_removed'],
    ['posted to pending', existing(), inc({ state: 'pending', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:posted_row_reverted_to_pending'],
    ['posted same', existing(), inc({ providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
    ['processed changed', existing({ processed: true }), inc({ amount: -5, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:processed_row_changed'],
    ['unprocessed changed newer', existing(), inc({ description: 'SHOP 2', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'refresh'],
    ['unprocessed changed unordered', existing({ providerUpdatedAt: null }), inc({ description: 'SHOP 2', providerUpdatedAt: undefined }), 'conflict:unordered_change'],
    ['amount equal to the cent', existing(), inc({ amount: -100.001, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
  ])('%s', (_name, ex, incoming, expected) => {
    const d = decideFeedTransition(ex, incoming);
    expect(d.kind === 'conflict' ? `conflict:${d.reason}` : d.kind).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run `env -u DATABASE_URL bun run test:unit -- tests/unit/services/bank/feed/bankFeedLifecycle.test.ts`.

Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `bankFeedLifecycle.ts`**

```ts
// src/modules/accounting/services/bank/feed/bankFeedLifecycle.ts
/**
 * Pure lifecycle decision for a provider-identified feed transaction.
 * No I/O. The persistence layer applies whatever this returns. See the table
 * in docs/superpowers/plans/2026-09-11-bank-sync-v1-release-1.md, Task 6.
 */
import type { FeedState, NormalizedBankTransaction } from './bankIngestionTypes';

export interface ExistingFeedRow {
  id: string;
  feedState: FeedState;
  processed: boolean;
  transactionDate: string;
  valueDate: string | null;
  amount: number;
  description: string;
  reference: string | null;
  providerUpdatedAt: string | null;
}

export type ConflictReason =
  | 'processed_row_changed' | 'posted_row_removed' | 'posted_row_reverted_to_pending'
  | 'removed_row_reappeared' | 'unordered_change';

export type FeedDecision =
  | { kind: 'insert' }
  | { kind: 'ignore_removed_unknown' }
  | { kind: 'duplicate' }
  | { kind: 'refresh' }
  | { kind: 'post_pending' }
  | { kind: 'remove_pending' }
  | { kind: 'conflict'; reason: ConflictReason };

type Ordering = 'newer' | 'older_or_equal' | 'unknown';

function ordering(existing: string | null, incoming: string | undefined): Ordering {
  if (!existing || !incoming) return 'unknown';
  const e = Date.parse(existing);
  const i = Date.parse(incoming);
  if (Number.isNaN(e) || Number.isNaN(i)) return 'unknown';
  return i > e ? 'newer' : 'older_or_equal';
}

const cents = (n: number): number => Math.round(n * 100);

export function sameSourceValues(ex: ExistingFeedRow, inc: NormalizedBankTransaction): boolean {
  return ex.transactionDate === inc.transactionDate
    && (ex.valueDate ?? null) === (inc.valueDate ?? null)
    && cents(ex.amount) === cents(inc.amount)
    && ex.description === inc.description
    && (ex.reference ?? null) === (inc.reference ?? null);
}

const conflict = (reason: ConflictReason): FeedDecision => ({ kind: 'conflict', reason });

export function decideFeedTransition(
  existing: ExistingFeedRow | null,
  incoming: NormalizedBankTransaction,
): FeedDecision {
  if (!existing) return incoming.state === 'removed' ? { kind: 'ignore_removed_unknown' } : { kind: 'insert' };

  const order = ordering(existing.providerUpdatedAt, incoming.providerUpdatedAt);
  const same = sameSourceValues(existing, incoming);

  if (existing.feedState === 'removed') {
    return incoming.state === 'removed' ? { kind: 'duplicate' } : conflict('removed_row_reappeared');
  }

  if (existing.feedState === 'pending') {
    if (incoming.state === 'posted') return { kind: 'post_pending' };
    if (incoming.state === 'removed') return { kind: 'remove_pending' };
    if (same || order === 'older_or_equal') return { kind: 'duplicate' };
    return { kind: 'refresh' };
  }

  // existing posted
  if (order === 'older_or_equal') return { kind: 'duplicate' };
  if (incoming.state === 'removed') return conflict('posted_row_removed');
  if (incoming.state === 'pending') return conflict('posted_row_reverted_to_pending');
  if (same) return { kind: 'duplicate' };
  if (existing.processed) return conflict('processed_row_changed');
  return order === 'newer' ? { kind: 'refresh' } : conflict('unordered_change');
}
```

- [ ] **Step 4: Run the lifecycle test and confirm it passes**

Expected: PASS for all 17 cases.

- [ ] **Step 5: Write the failing validation unit test**

```ts
// tests/unit/services/bank/feed/bankIngestionValidation.test.ts
import { describe, expect, it } from 'vitest';
import { contentHashIdentity, identityModeFor, validateBatch } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import type { BankIngestionBatch, NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

const tx = (o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  identity: { kind: 'provider', providerTransactionId: 'p1' }, state: 'posted',
  transactionDate: '2026-09-01', amount: -10, currency: 'ZAR', description: 'X', ...o,
});
const batch = (txs: NormalizedBankTransaction[]): BankIngestionBatch => ({
  source: { kind: 'feed', connectionId: 'c1' }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs,
});
const code = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; }
};

describe('identityModeFor', () => {
  it('extension is content_hash', () => expect(identityModeFor('extension')).toBe('content_hash'));
  it('manual_csv cannot ingest', () => expect(code(() => identityModeFor('manual_csv'))).toBe('UNSUPPORTED_PROVIDER'));
  it('any other provider is provider identity', () => expect(identityModeFor('test_provider')).toBe('provider'));
});

describe('validateBatch', () => {
  it('accepts a clean provider batch', () => expect(() => validateBatch(batch([tx()]), 'provider')).not.toThrow());
  it('rejects an impossible calendar date', () =>
    expect(code(() => validateBatch(batch([tx({ transactionDate: '2026-02-30' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a non-finite amount', () =>
    expect(code(() => validateBatch(batch([tx({ amount: Number.NaN })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a non-ZAR currency', () =>
    expect(code(() => validateBatch(batch([tx({ currency: 'USD' as 'ZAR' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a blank description', () =>
    expect(code(() => validateBatch(batch([tx({ description: '  ' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a reference longer than the column', () =>
    expect(code(() => validateBatch(batch([tx({ reference: 'r'.repeat(256) })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a repeated provider id in one batch', () =>
    expect(code(() => validateBatch(batch([tx(), tx()]), 'provider'))).toBe('DUPLICATE_PROVIDER_ID'));
  it('rejects content-hash identity on a provider connection', () => {
    const t = tx({ identity: contentHashIdentity({ transactionDate: '2026-09-01', amount: -10, description: 'X' }) });
    expect(code(() => validateBatch(batch([t]), 'provider'))).toBe('IDENTITY_MODE_MISMATCH');
  });
  it('rejects a content hash that does not match the fields', () => {
    const t = tx({ identity: { kind: 'content_hash', contentHash: 'deadbeef' } });
    expect(code(() => validateBatch(batch([t]), 'content_hash'))).toBe('INVALID_TRANSACTION');
  });
  it('rejects a non-posted state on a content-hash batch', () => {
    const fields = { transactionDate: '2026-09-01', amount: -10, description: 'X' };
    const t = tx({ ...fields, state: 'pending', identity: contentHashIdentity(fields) });
    expect(code(() => validateBatch(batch([t]), 'content_hash'))).toBe('IDENTITY_MODE_MISMATCH');
  });
  it('allows two identical content-hash rows (two real R50 fees)', () => {
    const fields = { transactionDate: '2026-09-01', amount: -50, description: 'FEE' };
    const t = tx({ ...fields, identity: contentHashIdentity(fields) });
    expect(() => validateBatch(batch([t, t]), 'content_hash')).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it and confirm it fails.** Expected: module not found.

- [ ] **Step 7: Implement `bankIngestionValidation.ts`**

```ts
// src/modules/accounting/services/bank/feed/bankIngestionValidation.ts
/** Pure validation for canonical feed batches. Throws BankIngestionRefusal. */
import { bankTransactionHash } from '@/modules/accounting/utils/bankTransactionHash';
import {
  BankIngestionRefusal, type BankIngestionBatch, type BankTransactionIdentity, type IdentityMode,
  type NormalizedBankTransaction,
} from './bankIngestionTypes';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ABS_AMOUNT = 1e13; // NUMERIC(15,2)
const MAX_DESCRIPTION = 500;
const MAX_REFERENCE = 255;   // bank_transactions.reference VARCHAR(255)
const MAX_PROVIDER_ID = 200;

export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function contentHashIdentity(tx: { transactionDate: string; amount: number; description: string }): BankTransactionIdentity {
  return { kind: 'content_hash', contentHash: bankTransactionHash(tx) };
}

export function identityModeFor(provider: string): IdentityMode {
  if (provider === 'extension') return 'content_hash';
  if (provider === 'manual_csv') {
    throw new BankIngestionRefusal('UNSUPPORTED_PROVIDER', 'Manual CSV connections import through the statement import page, not a feed.');
  }
  return 'provider';
}

function invalid(i: number, why: string): never {
  throw new BankIngestionRefusal('INVALID_TRANSACTION', `Transaction ${i + 1}: ${why}`, i);
}

function validateOne(t: NormalizedBankTransaction, i: number, mode: IdentityMode): void {
  if (!isCalendarDate(t.transactionDate)) invalid(i, `transactionDate "${t.transactionDate}" is not a calendar date`);
  if (t.valueDate !== undefined && !isCalendarDate(t.valueDate)) invalid(i, `valueDate "${t.valueDate}" is not a calendar date`);
  if (!Number.isFinite(t.amount) || Math.abs(t.amount) >= MAX_ABS_AMOUNT) invalid(i, 'amount must be a finite number');
  if (t.currency !== 'ZAR') invalid(i, `currency "${String(t.currency)}" is not supported`);
  if (t.description.trim().length === 0 || t.description.length > MAX_DESCRIPTION) invalid(i, 'description must be 1-500 characters');
  if (t.reference !== undefined && t.reference.length > MAX_REFERENCE) invalid(i, 'reference exceeds 255 characters');
  if (t.balance !== undefined && !Number.isFinite(t.balance)) invalid(i, 'balance must be finite');
  if (t.providerUpdatedAt !== undefined && Number.isNaN(Date.parse(t.providerUpdatedAt))) invalid(i, 'providerUpdatedAt is not a timestamp');

  if (mode === 'content_hash') {
    if (t.identity.kind !== 'content_hash' || t.state !== 'posted') {
      throw new BankIngestionRefusal('IDENTITY_MODE_MISMATCH', `Transaction ${i + 1}: this connection sends posted content-hash rows only`, i);
    }
    if (t.identity.contentHash !== bankTransactionHash(t)) invalid(i, 'content hash does not match the transaction fields');
  } else {
    if (t.identity.kind !== 'provider') {
      throw new BankIngestionRefusal('IDENTITY_MODE_MISMATCH', `Transaction ${i + 1}: this connection requires provider transaction IDs`, i);
    }
    const id = t.identity.providerTransactionId;
    if (id.trim().length === 0 || id.length > MAX_PROVIDER_ID) invalid(i, 'providerTransactionId must be 1-200 characters');
  }
}

export function validateBatch(batch: BankIngestionBatch, mode: IdentityMode): void {
  const seen = new Set<string>();
  batch.transactions.forEach((t, i) => {
    validateOne(t, i, mode);
    if (t.identity.kind === 'provider') {
      if (seen.has(t.identity.providerTransactionId)) {
        throw new BankIngestionRefusal('DUPLICATE_PROVIDER_ID', `Transaction ${i + 1}: provider id repeated in one batch`, i);
      }
      seen.add(t.identity.providerTransactionId);
    }
  });
}
```

Check `bankTransactionHash`'s parameter type in `src/modules/accounting/utils/bankTransactionHash.ts` (`HashableTransaction`). Passing a `NormalizedBankTransaction` must hash only date, amount and description, with `balance` left out as the extension does today. If `HashableTransaction` includes an optional `balance`, call `bankTransactionHash({ transactionDate: t.transactionDate, amount: t.amount, description: t.description })` explicitly in both places.

- [ ] **Step 8: Run the validation test and confirm it passes.**

- [ ] **Step 9: Write the failing ingestion integration test**

```ts
// tests/integration/bank-feed-ingestion.int.test.ts
/**
 * Canonical feed ingestion against real Postgres: idempotent redelivery,
 * pending lifecycle, protected conflicts, content-hash identity, tenancy,
 * the connection lease, and "sync never posts".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { BankIngestionBatch, NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const otherBank = crypto.randomUUID();
const provConn = crypto.randomUUID();
const extConn = crypto.randomUUID();

beforeAll(async () => {
  for (const [id, name] of [[company, 'BFI co'], [otherCompany, 'BFI other']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, co] of [[bank, company], [otherBank, otherCompany]]) {
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_active)
       VALUES($1,$2,'1110','BFI Bank','asset','debit','bank',true)`, [id, co]);
  }
  await pool.query(
    `INSERT INTO bank_feed_connections(id,company_id,bank_account_id,provider,status,is_active,config)
     VALUES($1,$2,$3,'test_provider','active',true,'{}'),($4,$2,$3,'extension','active',true,'{"bankId":"absa"}')`,
    [provConn, company, bank, extConn]);
});

afterAll(async () => {
  try {
    for (const co of [company, otherCompany]) {
      await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM companies WHERE id=$1', [co]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

beforeEach(async () => {
  await pool.query('DELETE FROM bank_feed_transaction_conflicts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
});

async function inRequest<T>(fn: () => Promise<T>, co = company): Promise<T> {
  const { als } = await import('@/lib/als');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: co, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

const ptx = (id: string, o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  identity: { kind: 'provider', providerTransactionId: id }, state: 'posted',
  transactionDate: '2026-09-05', amount: -120, currency: 'ZAR', description: 'BFI SHOP',
  providerUpdatedAt: '2026-09-05T10:00:00Z', ...o,
});
const batchOf = (connectionId: string, txs: NormalizedBankTransaction[]): BankIngestionBatch => ({
  source: { kind: 'feed', connectionId }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs,
});

async function ingest(connectionId: string, txs: NormalizedBankTransaction[], co = company) {
  const { ingestBankBatch } = await import('@/modules/accounting/services/bank/feed/bankIngestionService');
  return inRequest(() => ingestBankBatch(co, batchOf(connectionId, txs), { userId: user, sourceLabel: 'test', bankFormat: null }), co);
}

describe('canonical feed ingestion', () => {
  it('redelivering the same provider transaction never creates a second row', async () => {
    const first = await ingest(provConn, [ptx('a1')]);
    const again = await ingest(provConn, [ptx('a1')]);
    expect(first.counts.inserted).toBe(1);
    expect(again.counts).toMatchObject({ inserted: 0, duplicate: 1 });
    const { rows } = await pool.query('SELECT count(*)::int n FROM bank_transactions WHERE company_id=$1', [company]);
    expect(rows[0].n).toBe(1);
  });

  it('concurrent delivery of one transaction yields one row', async () => {
    const results = await Promise.allSettled([ingest(provConn, [ptx('c1')]), ingest(provConn, [ptx('c1')])]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='c1'");
    expect(rows[0].n).toBe(1);
    // The loser either waited and counted a duplicate, or was refused as SYNC_IN_PROGRESS.
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('SYNC_IN_PROGRESS');
    }
  });

  it('pending then posted updates in place and becomes reviewable', async () => {
    const p = await ingest(provConn, [ptx('p1', { state: 'pending', amount: -119 })]);
    expect(p.counts).toMatchObject({ inserted: 1, pending: 1 });
    await ingest(provConn, [ptx('p1', { amount: -120, providerUpdatedAt: '2026-09-06T00:00:00Z' })]);
    const { rows } = await pool.query("SELECT feed_state, amount::float a, status FROM bank_transactions WHERE provider_transaction_id='p1'");
    expect(rows[0]).toEqual({ feed_state: 'posted', a: -120, status: 'imported' });
  });

  it('pending then removed keeps the audit row', async () => {
    await ingest(provConn, [ptx('r1', { state: 'pending' })]);
    const r = await ingest(provConn, [ptx('r1', { state: 'removed' })]);
    expect(r.counts.removed).toBe(1);
    const { rows } = await pool.query("SELECT feed_state FROM bank_transactions WHERE provider_transaction_id='r1'");
    expect(rows[0].feed_state).toBe('removed');
  });

  it('a provider change to a processed row becomes a conflict, never an overwrite', async () => {
    await ingest(provConn, [ptx('x1')]);
    await pool.query("UPDATE bank_transactions SET status='excluded' WHERE provider_transaction_id='x1'");
    const r = await ingest(provConn, [ptx('x1', { amount: -999, providerUpdatedAt: '2026-09-07T00:00:00Z' })]);
    expect(r.counts.conflicts).toBe(1);
    const { rows } = await pool.query("SELECT amount::float a FROM bank_transactions WHERE provider_transaction_id='x1'");
    expect(rows[0].a).toBe(-120);
    const c = await pool.query("SELECT reason, proposed->>'amount' amt FROM bank_feed_transaction_conflicts WHERE provider_transaction_id='x1' AND resolved_at IS NULL");
    expect(c.rows).toEqual([{ reason: 'processed_row_changed', amt: '-999' }]);
    // A second identical delivery refreshes the open conflict rather than adding one.
    await ingest(provConn, [ptx('x1', { amount: -999, providerUpdatedAt: '2026-09-08T00:00:00Z' })]);
    const c2 = await pool.query("SELECT count(*)::int n FROM bank_feed_transaction_conflicts WHERE provider_transaction_id='x1'");
    expect(c2.rows[0].n).toBe(1);
  });

  it('extension batches dedupe by content hash against existing rows but keep identical rows within a batch', async () => {
    const { contentHashIdentity } = await import('@/modules/accounting/services/bank/feed/bankIngestionValidation');
    const f = { transactionDate: '2026-09-05', amount: -50, description: 'ABSA FEE' };
    const t: NormalizedBankTransaction = { ...f, identity: contentHashIdentity(f), state: 'posted', currency: 'ZAR' };
    const first = await ingest(extConn, [t, t]);
    expect(first.counts.inserted).toBe(2);
    const again = await ingest(extConn, [t]);
    expect(again.counts).toMatchObject({ inserted: 0, duplicate: 1 });
    const { rows } = await pool.query('SELECT bank_feed_connection_id, provider_transaction_id FROM bank_transactions WHERE company_id=$1 LIMIT 1', [company]);
    expect(rows[0]).toEqual({ bank_feed_connection_id: extConn, provider_transaction_id: null });
  });

  it('refuses another company’s connection and writes nothing', async () => {
    await expect(ingest(provConn, [ptx('t1')], otherCompany)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    const { rows } = await pool.query("SELECT count(*)::int n FROM bank_transactions WHERE provider_transaction_id='t1'");
    expect(rows[0].n).toBe(0);
  });

  it('never creates a journal and only runs suggestion rules', async () => {
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,is_active,auto_create_entry,priority)
       VALUES($1,'auto','description','contains','BFI SHOP',$2,true,true,1),
             ($1,'suggest','description','contains','BFI SHOP',$2,true,false,2)`, [company, bank]);
    const before = await pool.query('SELECT count(*)::int n FROM gl_journal_entries WHERE company_id=$1', [company]);
    const r = await ingest(provConn, [ptx('j1')]);
    const after = await pool.query('SELECT count(*)::int n FROM gl_journal_entries WHERE company_id=$1', [company]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(r.appliedSuggestions).toBe(1);
    const { rows } = await pool.query("SELECT status, suggested_gl_account_id FROM bank_transactions WHERE provider_transaction_id='j1'");
    expect(rows[0]).toEqual({ status: 'imported', suggested_gl_account_id: bank });
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [company]);
  });

  it('writes a success sync log with the counts, and a failed log on refusal', async () => {
    await ingest(provConn, [ptx('l1'), ptx('l2', { state: 'pending' })]);
    const ok = await pool.query(
      `SELECT status, transactions_found f, transactions_imported i, transactions_pending p
       FROM bank_feed_sync_logs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1`, [provConn]);
    expect(ok.rows[0]).toEqual({ status: 'success', f: 2, i: 2, p: 1 });
    await expect(ingest(provConn, [ptx('bad', { transactionDate: '2026-02-30' })])).rejects.toMatchObject({ code: 'INVALID_TRANSACTION' });
    const bad = await pool.query(
      'SELECT status, error_code FROM bank_feed_sync_logs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1', [provConn]);
    expect(bad.rows[0]).toEqual({ status: 'failed', error_code: 'INVALID_TRANSACTION' });
  });
});
```

Note the harness: the refusal case needs the failed log to **commit** while the refusal still propagates. `inRequest` above rolls back on throw, so for that one assertion the service must write the failed log in a way that survives. Resolve this in the service, not the test. The route's real behaviour is a 4xx that `withExtensionToken`/`withAuth` COMMITs. Mirror that in the test by committing when the error `isBankIngestionRefusal`: in `inRequest`'s catch, `if (isBankIngestionRefusal(e)) { await client.query('COMMIT'); throw e; }`. Add that branch to `inRequest` in this test file, and import `isBankIngestionRefusal`.

- [ ] **Step 10: Run it and confirm it fails.** Expected: module not found.

- [ ] **Step 11: Implement `bankIngestionPersistence.ts`**

```ts
// src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts
/** SQL for canonical feed ingestion. Every statement is company-scoped. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { bankTransactionHash } from '@/modules/accounting/utils/bankTransactionHash';
import { feedStateOf } from '../bankFeedStateGuard';
import type { ConflictReason, ExistingFeedRow } from './bankFeedLifecycle';
import type { BankIngestionCounts, NormalizedBankTransaction } from './bankIngestionTypes';

export interface IngestConnection { id: string; provider: string; bankAccountId: string }

/** Lease row for this connection. FOR NO KEY UPDATE, so child FK inserts (KEY SHARE) don't block. */
export async function leaseConnection(companyId: string, connectionId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT id, provider, bank_account_id, is_active, status
    FROM bank_feed_connections
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
    FOR NO KEY UPDATE NOWAIT`) as DbRow[];
  return rows[0] ?? null;
}

export async function bankAccountIsValid(companyId: string, bankAccountId: string, subtypes: string[]): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId}::UUID
      AND account_subtype = ANY(${subtypes}) AND is_active = true`) as DbRow[];
  return rows.length > 0;
}

export async function openSyncLog(companyId: string, connectionId: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running') RETURNING id`) as DbRow[];
  return String(rows[0]!.id);
}

export async function closeSyncLogSuccess(companyId: string, logId: string, connectionId: string, c: BankIngestionCounts): Promise<void> {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'success', completed_at = NOW(),
        transactions_found = ${c.found}, transactions_imported = ${c.inserted},
        transactions_duplicate = ${c.duplicate}, transactions_updated = ${c.updated},
        transactions_pending = ${c.pending}, transactions_removed = ${c.removed},
        transactions_conflict = ${c.conflicts}, transactions_ignored = ${c.ignored}
    WHERE id = ${logId}::UUID AND company_id = ${companyId}::UUID`;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_success_at = NOW(), last_sync_status = 'success',
        last_sync_error = NULL, updated_at = NOW()
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
}

export async function closeSyncLogFailed(companyId: string, logId: string, connectionId: string, code: string, message: string): Promise<void> {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'failed', completed_at = NOW(), error_code = ${code}, error_message = ${message}
    WHERE id = ${logId}::UUID AND company_id = ${companyId}::UUID`;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'failed', last_sync_error = ${message}, updated_at = NOW()
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
}

export async function createImportBatch(
  companyId: string, bankAccountId: string, statementDate: string, count: number,
  sourceLabel: string, bankFormat: string | null, userId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, bank_format,
      transaction_count, source_filename, imported_by)
    VALUES (${id}::UUID, ${companyId}::UUID, ${bankAccountId}::UUID, ${statementDate}::DATE, ${bankFormat},
      ${count}, ${sourceLabel}, ${userId})`;
  return id;
}

/** Existing provider-identified rows, locked for the rest of the request. */
export async function lockExistingByProviderIds(
  companyId: string, connectionId: string, ids: string[],
): Promise<Map<string, ExistingFeedRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, provider_transaction_id, feed_state, transaction_date, value_date, amount,
           description, reference, provider_updated_at,
           (status <> 'imported' OR matched_journal_line_id IS NOT NULL OR provisional_je_id IS NOT NULL) AS processed
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND bank_feed_connection_id = ${connectionId}::UUID
      AND provider_transaction_id = ANY(${ids}::TEXT[])
    ORDER BY id
    FOR UPDATE`) as DbRow[];
  const map = new Map<string, ExistingFeedRow>();
  for (const r of rows) {
    map.set(String(r.provider_transaction_id), {
      id: String(r.id),
      feedState: feedStateOf(r),
      processed: Boolean(r.processed),
      transactionDate: fmtDate(r.transaction_date),
      valueDate: r.value_date ? fmtDate(r.value_date) : null,
      amount: Number(r.amount),
      description: String(r.description ?? ''),
      reference: r.reference != null ? String(r.reference) : null,
      providerUpdatedAt: r.provider_updated_at != null ? new Date(r.provider_updated_at as string | Date).toISOString() : null,
    });
  }
  return map;
}

/** Hashes of rows already on this bank account inside [from, to] — the established statement/extension dedup. */
export async function existingContentHashes(
  companyId: string, bankAccountId: string, from: string, to: string,
): Promise<Set<string>> {
  const rows = (await sql`
    SELECT transaction_date, amount, description FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND bank_account_id = ${bankAccountId}::UUID
      AND transaction_date BETWEEN ${from}::DATE AND ${to}::DATE`) as DbRow[];
  return new Set(rows.map((r) => bankTransactionHash({
    transactionDate: fmtDate(r.transaction_date), amount: Number(r.amount), description: String(r.description ?? ''),
  })));
}

export async function insertFeedRow(
  companyId: string, conn: IngestConnection, batchId: string, t: NormalizedBankTransaction,
): Promise<string | null> {
  const providerId = t.identity.kind === 'provider' ? t.identity.providerTransactionId : null;
  const rows = (await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, value_date, amount,
      description, reference, import_batch_id, bank_feed_connection_id, provider_transaction_id,
      feed_state, provider_updated_at, feed_last_seen_at)
    VALUES (${companyId}::UUID, ${conn.bankAccountId}::UUID, ${t.transactionDate}::DATE, ${t.valueDate ?? null}::DATE,
      ${t.amount}, ${t.description}, ${t.reference ?? null}, ${batchId}::UUID, ${conn.id}::UUID, ${providerId},
      ${t.state}, ${t.providerUpdatedAt ?? null}::TIMESTAMPTZ, NOW())
    ON CONFLICT (company_id, bank_feed_connection_id, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL DO NOTHING
    RETURNING id`) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * Apply a refresh / post_pending / remove_pending. The WHERE repeats the
 * decision's preconditions, so a row that changed under us updates nothing
 * and the caller records a conflict instead.
 */
export async function applyFeedUpdate(
  companyId: string, rowId: string, expectedState: 'pending' | 'posted', t: NormalizedBankTransaction, nextState: 'pending' | 'posted' | 'removed',
): Promise<boolean> {
  const rows = (await sql`
    UPDATE bank_transactions
    SET transaction_date = ${t.transactionDate}::DATE, value_date = ${t.valueDate ?? null}::DATE,
        amount = ${t.amount}, description = ${t.description}, reference = ${t.reference ?? null},
        feed_state = ${nextState}, provider_updated_at = ${t.providerUpdatedAt ?? null}::TIMESTAMPTZ,
        feed_last_seen_at = NOW(), updated_at = NOW()
    WHERE id = ${rowId}::UUID AND company_id = ${companyId}::UUID AND feed_state = ${expectedState}
      AND status = 'imported' AND matched_journal_line_id IS NULL AND provisional_je_id IS NULL
    RETURNING id`) as DbRow[];
  return rows.length > 0;
}

export async function touchSeen(companyId: string, rowId: string): Promise<void> {
  await sql`UPDATE bank_transactions SET feed_last_seen_at = NOW()
            WHERE id = ${rowId}::UUID AND company_id = ${companyId}::UUID`;
}

export async function upsertConflict(
  companyId: string, connectionId: string, rowId: string, t: NormalizedBankTransaction, reason: ConflictReason,
): Promise<void> {
  const providerId = t.identity.kind === 'provider' ? t.identity.providerTransactionId : '';
  // The validated, normalised transaction only, never a raw provider payload.
  const proposed = JSON.stringify({
    state: t.state, transactionDate: t.transactionDate, valueDate: t.valueDate ?? null, amount: t.amount,
    description: t.description, reference: t.reference ?? null, providerUpdatedAt: t.providerUpdatedAt ?? null,
  });
  await sql`
    INSERT INTO bank_feed_transaction_conflicts (company_id, connection_id, bank_transaction_id,
      provider_transaction_id, reason, proposed)
    VALUES (${companyId}::UUID, ${connectionId}::UUID, ${rowId}::UUID, ${providerId}, ${reason}, ${proposed}::JSONB)
    ON CONFLICT (company_id, connection_id, provider_transaction_id) WHERE resolved_at IS NULL
    DO UPDATE SET proposed = EXCLUDED.proposed, reason = EXCLUDED.reason, last_seen_at = NOW()`;
}
```

`touchSeen` updates only `feed_last_seen_at`, which the trigger doesn't guard, so it is safe on processed rows. Check `fmtDate`'s import path (`bankTxRowMapper.ts` imports it from `@/lib/fmtDate`). This file must stay under 300 lines; if it grows past that, split the sync-log functions into `bankFeedSyncLog.ts`.

- [ ] **Step 12: Implement `bankIngestionService.ts`**

```ts
// src/modules/accounting/services/bank/feed/bankIngestionService.ts
/**
 * Canonical bank-feed ingestion (spec §1, §2, §6). Order:
 *   lease connection -> validate -> open sync log -> identity-specific persist
 *   -> suggestion-only rules (savepoint) -> close log.
 * Every refusal is decided before the first bank_transactions write and is
 * recorded as a failed sync log, which the caller's 4xx COMMITs. Nothing here
 * posts a journal: no applyRules, no auto-post sweep, no transfer auto-link.
 */
import { sql, withSavepoint, assertTxUsable } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BANK_SUBTYPES } from '../../gl/accountSubtypes';
import { applySuggestionRules } from '../bankRulesSuggestionPass';
import { decideFeedTransition } from './bankFeedLifecycle';
import { identityModeFor, validateBatch } from './bankIngestionValidation';
import {
  applyFeedUpdate, bankAccountIsValid, closeSyncLogFailed, closeSyncLogSuccess, createImportBatch,
  existingContentHashes, insertFeedRow, leaseConnection, lockExistingByProviderIds, openSyncLog,
  touchSeen, upsertConflict, type IngestConnection,
} from './bankIngestionPersistence';
import {
  BankIngestionRefusal, isBankIngestionRefusal, type BankIngestionBatch, type BankIngestionCounts,
  type BankIngestionResult, type NormalizedBankTransaction,
} from './bankIngestionTypes';

const emptyCounts = (found: number): BankIngestionCounts =>
  ({ found, inserted: 0, updated: 0, duplicate: 0, pending: 0, removed: 0, conflicts: 0, ignored: 0 });

async function acquire(companyId: string, connectionId: string): Promise<IngestConnection> {
  let row: DbRow | null;
  try {
    row = await withSavepoint('bank_feed_lease', () => leaseConnection(companyId, connectionId));
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') {
      throw new BankIngestionRefusal('SYNC_IN_PROGRESS', 'A sync for this connection is already running.');
    }
    throw err;
  }
  if (!row) throw new BankIngestionRefusal('CONNECTION_NOT_FOUND', 'Bank feed connection not found.');
  return { id: String(row.id), provider: String(row.provider), bankAccountId: String(row.bank_account_id ?? '') };
}

async function preflight(companyId: string, connectionId: string, conn: IngestConnection, batch: BankIngestionBatch): Promise<void> {
  const rows = (await sql`SELECT is_active, status FROM bank_feed_connections
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const r = rows[0]!;
  if (!r.is_active || String(r.status ?? 'active') !== 'active') {
    throw new BankIngestionRefusal('CONNECTION_INACTIVE', 'Bank feed connection is not active.');
  }
  if (!conn.bankAccountId || !(await bankAccountIsValid(companyId, conn.bankAccountId, BANK_SUBTYPES as string[]))) {
    throw new BankIngestionRefusal('BANK_ACCOUNT_INVALID', 'The connection is not linked to an active bank account in this company.');
  }
  validateBatch(batch, identityModeFor(conn.provider));
}

async function persistProviderRows(companyId: string, conn: IngestConnection, batchId: string, txs: NormalizedBankTransaction[], c: BankIngestionCounts): Promise<void> {
  const ids = txs.map((t) => (t.identity.kind === 'provider' ? t.identity.providerTransactionId : ''));
  const existing = await lockExistingByProviderIds(companyId, conn.id, ids);
  for (const t of txs) {
    const pid = t.identity.kind === 'provider' ? t.identity.providerTransactionId : '';
    const ex = existing.get(pid) ?? null;
    const d = decideFeedTransition(ex, t);
    switch (d.kind) {
      case 'insert': {
        const id = await insertFeedRow(companyId, conn, batchId, t);
        if (id) { c.inserted++; if (t.state === 'pending') c.pending++; } else c.duplicate++;
        break;
      }
      case 'ignore_removed_unknown': c.ignored++; break;
      case 'duplicate': c.duplicate++; await touchSeen(companyId, ex!.id); break;
      case 'refresh':
      case 'post_pending':
      case 'remove_pending': {
        const next = d.kind === 'remove_pending' ? 'removed' : d.kind === 'post_pending' ? 'posted' : ex!.feedState as 'pending' | 'posted';
        const ok = await applyFeedUpdate(companyId, ex!.id, ex!.feedState as 'pending' | 'posted', t, next);
        if (!ok) { await upsertConflict(companyId, conn.id, ex!.id, t, 'processed_row_changed'); c.conflicts++; break; }
        if (next === 'removed') c.removed++; else c.updated++;
        if (next === 'pending') c.pending++;
        break;
      }
      case 'conflict': await upsertConflict(companyId, conn.id, ex!.id, t, d.reason); c.conflicts++; break;
    }
  }
}

async function persistContentHashRows(companyId: string, conn: IngestConnection, batchId: string, txs: NormalizedBankTransaction[], c: BankIngestionCounts): Promise<void> {
  const dates = txs.map((t) => t.transactionDate).sort();
  const known = await existingContentHashes(companyId, conn.bankAccountId, dates[0]!, dates[dates.length - 1]!);
  for (const t of txs) {
    const hash = t.identity.kind === 'content_hash' ? t.identity.contentHash : '';
    // Set semantics against EXISTING rows only, so two identical rows in one batch both insert (two real fees).
    if (known.has(hash)) { c.duplicate++; continue; }
    if (await insertFeedRow(companyId, conn, batchId, t)) c.inserted++;
  }
}

async function suggest(companyId: string, bankAccountId: string, warnings: string[]): Promise<number> {
  try {
    return await withSavepoint('bank_feed_suggest', async () => {
      const rules = (await sql`
        SELECT * FROM bank_categorisation_rules
        WHERE company_id = ${companyId}::UUID AND is_active = true AND auto_create_entry = false
        ORDER BY priority ASC`) as Record<string, unknown>[];
      if (rules.length === 0) return 0;
      return (await applySuggestionRules(companyId, bankAccountId, rules)).length;
    });
  } catch (err) {
    assertTxUsable();
    log.warn('Feed ingestion: suggestion rules failed', { error: err instanceof Error ? err.message : String(err) }, 'bank-feed');
    warnings.push('Rule suggestions could not be applied — run bank rules from the transactions page.');
    return 0;
  }
}

export async function ingestBankBatch(
  companyId: string, batch: BankIngestionBatch, opts: { userId: string; sourceLabel: string; bankFormat: string | null },
): Promise<BankIngestionResult> {
  const connectionId = batch.source.connectionId;
  const conn = await acquire(companyId, connectionId);
  const logId = await openSyncLog(companyId, conn.id);
  try {
    await preflight(companyId, connectionId, conn, batch);
  } catch (err) {
    if (isBankIngestionRefusal(err)) await closeSyncLogFailed(companyId, logId, conn.id, err.code, err.message);
    throw err;
  }

  const counts = emptyCounts(batch.transactions.length);
  const warnings: string[] = [];
  let importBatchId: string | null = null;
  if (batch.transactions.length > 0) {
    const statementDate = batch.transactions.map((t) => t.transactionDate).sort().at(-1)!;
    importBatchId = await createImportBatch(companyId, conn.bankAccountId, statementDate,
      batch.transactions.length, opts.sourceLabel, opts.bankFormat, opts.userId);
    if (identityModeFor(conn.provider) === 'provider') await persistProviderRows(companyId, conn, importBatchId, batch.transactions, counts);
    else await persistContentHashRows(companyId, conn, importBatchId, batch.transactions, counts);
  }

  const appliedSuggestions = counts.inserted + counts.updated > 0 ? await suggest(companyId, conn.bankAccountId, warnings) : 0;
  await closeSyncLogSuccess(companyId, logId, conn.id, counts);
  log.info('Bank feed batch ingested', { companyId, connectionId, ...counts, appliedSuggestions }, 'bank-feed');
  return { logId, importBatchId, counts, appliedSuggestions, warnings };
}
```

- [ ] **Step 13: Run all three test files until they pass**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/services/bank/feed
bun run test:integration -- tests/integration/bank-feed-ingestion.int.test.ts
```

Expected: PASS. If the concurrency case is flaky, don't loosen it. Diagnose first: the loser must either block on the lease (the pool gives each call its own connection, and NOWAIT refuses immediately) or be refused. Both are asserted.

- [ ] **Step 14: Mutation checks, each one reverted after it goes red:**
  1. In `applyFeedUpdate`, drop `AND status = 'imported'`. The conflict test still passes (the lifecycle routed the change to a conflict first), which is expected: the WHERE is defence in depth. Then remove `if (existing.processed) return conflict(...)` in the lifecycle as well: the processed-row test must go red via the trigger (`BANK_TX_FEED_GUARD`).
  2. Replace `auto_create_entry = false` with `true` in `suggest`: the no-journal test must go red.
  3. Remove `FOR NO KEY UPDATE NOWAIT`: run the concurrency test 5 times (`for i in 1 2 3 4 5; do …; done`); record whether it catches it. If it doesn't, say so in the PR (the unique index is then the only guard for provider identity).

- [ ] **Step 15: Write `src/modules/accounting/services/bank/feed/.claude.md`** (purpose / caller contract / main signatures / business rules / recent changes; under 50 lines). It must state:
- `ingestBankBatch` is the only writer of feed rows.
- Refusals come before the first write and are recorded as a failed log that the caller's 4xx COMMITs.
- Sync never posts: suggestion-only rules, no sweep, no auto-link.
- The lease is taken with `FOR NO KEY UPDATE NOWAIT` before any `bank_transactions` lock.
- Extension rows use content-hash identity with set-semantics dedup against existing rows only.
- Conflicts store the normalised proposal, never a raw payload.

Then run `bun run agent-docs:generate && bun run agent-docs:check`.

- [ ] **Step 16: Commit** every new file and the generated `AGENTS.md`, by explicit path, with the message `feat(bank): canonical feed ingestion service`.

---

### Task 7: Extension-ingest route cuts over to the canonical service

**Files:**
- Modify: `pages/api/accounting/bank-feeds/[id]/extension-ingest.ts` (rewrite the handler body; keep the schema, rate limit, daily cap and wrapper)
- Modify: `pages/api/accounting/bank-feeds/.claude.md`
- Test: `tests/unit/api/bankFeedExtensionIngestRoute.test.ts`

**Interfaces:**
- Consumes `ingestBankBatch`, `contentHashIdentity`, `isBankIngestionRefusal` and `BankIngestionRefusalCode` (Task 6).
- The response stays backward-compatible for `chrome-extension/bank-connector/lib/api.js`: `{ found, imported, duplicate, appliedRules, warnings }`. It gains `updated`, `pending`, `removed` and `conflicts`.

- [ ] **Step 1: Write the failing route test**

```ts
// tests/unit/api/bankFeedExtensionIngestRoute.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withExtensionToken: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ daily_tx_cap: 500, used: 0 }]) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    validationError: vi.fn((_r: unknown, e: unknown) => ({ kind: 'validation', e })),
    tooManyRequests: vi.fn((_r: unknown, m: string) => ({ kind: '429', m })),
    conflict: vi.fn((_r: unknown, m: string) => ({ kind: '409', m })),
    badRequest: vi.fn((_r: unknown, m: string) => ({ kind: '400', m })),
    methodNotAllowed: vi.fn(() => ({ kind: '405' })),
  },
}));
const ingest = vi.fn();
vi.mock('@/modules/accounting/services/bank/feed/bankIngestionService', () => ({ ingestBankBatch: (...a: unknown[]) => ingest(...a) }));

import { BankIngestionRefusal } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';
import { contentHashIdentity } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import handler from '../../../pages/api/accounting/bank-feeds/[id]/extension-ingest';

const body = {
  scraperId: 'absa', scraperVersion: '1.2.0', bankAccountExternalId: '4051234567',
  fromDate: '2026-09-01', toDate: '2026-09-10',
  transactions: [{ transactionDate: '2026-09-02', amount: -50, description: 'ABSA FEE' }],
};
const req = (b: unknown = body) => ({
  method: 'POST', query: { id: 'conn-1' }, body: b,
  extension: { userId: 'u1', companyId: 'c1', connectionId: 'conn-1', bankId: 'absa', bankAccountId: 'gl-1' },
}) as never;

beforeEach(() => { ingest.mockReset(); });

describe('POST extension-ingest', () => {
  it('submits a content-hash feed batch and keeps the extension response shape', async () => {
    ingest.mockResolvedValue({ logId: 'l', importBatchId: 'b', appliedSuggestions: 1, warnings: [],
      counts: { found: 1, inserted: 1, updated: 0, duplicate: 0, pending: 0, removed: 0, conflicts: 0, ignored: 0 } });
    const out = await handler(req(), {} as NextApiResponse) as { kind: string; data: Record<string, unknown> };
    expect(out.kind).toBe('success');
    expect(out.data).toMatchObject({ found: 1, imported: 1, duplicate: 0, appliedRules: 1, warnings: [] });
    const [companyId, batch, opts] = ingest.mock.calls[0]!;
    expect(companyId).toBe('c1');
    expect(batch.source).toEqual({ kind: 'feed', connectionId: 'conn-1' });
    expect(batch.transactions[0]).toMatchObject({
      state: 'posted', currency: 'ZAR',
      identity: contentHashIdentity({ transactionDate: '2026-09-02', amount: -50, description: 'ABSA FEE' }),
    });
    expect(opts).toEqual({ userId: 'u1', sourceLabel: 'extension/absa@1.2.0', bankFormat: 'absa' });
  });

  it('answers 409 when a sync is already running', async () => {
    ingest.mockRejectedValue(new BankIngestionRefusal('SYNC_IN_PROGRESS', 'A sync for this connection is already running.'));
    const out = await handler(req(), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('409');
  });

  it('answers 400 for any other refusal so the failed log commits', async () => {
    ingest.mockRejectedValue(new BankIngestionRefusal('INVALID_TRANSACTION', 'Transaction 1: bad'));
    const out = await handler(req(), {} as NextApiResponse) as { kind: string; m: string };
    expect(out).toEqual({ kind: '400', m: 'Transaction 1: bad' });
  });

  it('lets a fault through (500 rolls back)', async () => {
    ingest.mockRejectedValue(new Error('boom'));
    await expect(handler(req(), {} as NextApiResponse)).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: the `ingest` mock is never called, because the old handler runs its own SQL.

- [ ] **Step 3: Rewrite the handler.** Keep lines 1–63 (header comment, imports and schemas), updating the comment's pipeline description and dropping the now-unused imports. Replace everything from `// Open a sync log row.` down to the end of `handler` with:

```ts
  const transactions: NormalizedBankTransaction[] = body.transactions.map((t) => ({
    identity: contentHashIdentity({ transactionDate: t.transactionDate, amount: t.amount, description: t.description }),
    state: 'posted',
    transactionDate: t.transactionDate,
    ...(t.valueDate ? { valueDate: t.valueDate } : {}),
    amount: t.amount,
    currency: 'ZAR',
    description: t.description,
    ...(t.reference ? { reference: t.reference } : {}),
    ...(t.balance !== undefined ? { balance: t.balance } : {}),
  }));

  try {
    const result = await ingestBankBatch(
      companyId,
      { source: { kind: 'feed', connectionId }, fetchedAt: new Date().toISOString(), transactions },
      { userId, sourceLabel: `extension/${body.scraperId}@${body.scraperVersion}`, bankFormat: bankId },
    );
    await sql`
      UPDATE bank_feed_connections
         SET last_scraper_version = ${body.scraperVersion}, scraper_version = ${body.scraperVersion}, updated_at = NOW()
       WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
    const c = result.counts;
    return apiResponse.success(res, {
      found: c.found, imported: c.inserted, duplicate: c.duplicate, updated: c.updated,
      pending: c.pending, removed: c.removed, conflicts: c.conflicts,
      appliedRules: result.appliedSuggestions, warnings: result.warnings,
    });
  } catch (err) {
    // Refusals are decided before any bank_transactions write and the service
    // has already recorded a failed sync log; a 4xx COMMITs it.
    if (isBankIngestionRefusal(err)) {
      return err.code === 'SYNC_IN_PROGRESS'
        ? apiResponse.conflict(res, err.message)
        : apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
```

Also scope the two anti-abuse SELECTs by company: add `AND company_id = ${companyId}::UUID` to the `daily_tx_cap` query and to the `bank_feed_sync_logs` usage query.

**Pre-existing bug, fixed here:** the daily cap currently reads `SUM(transactions_imported)`. That's still correct, because `closeSyncLogSuccess` writes inserts into `transactions_imported`.

Remove the imports that are now unused: `importParsedTransactions`, `applyBankRulesService`, `bankTransactionHash`, `HashableTransaction`, `BankCsvParseResult` and `ParsedBankTransaction`.

- [ ] **Step 4: Run the route test, type-check and lint**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/api/bankFeedExtensionIngestRoute.test.ts && bun run type-check && bun run lint
```

Expected: PASS.

- [ ] **Step 5: Update `pages/api/accounting/bank-feeds/.claude.md`.** The extension ingest goes through `ingestBankBatch`. It no longer auto-posts, auto-links transfers or runs auto-create rules. Refusals map to 409 (`SYNC_IN_PROGRESS`) or 400, and faults to 500. Then run `bun run agent-docs:generate && bun run agent-docs:check`.

- [ ] **Step 6: Live proof on dev.** Use `isaflow_dev` only; never `isaflow`.
  1. Apply 675 to `isaflow_dev` via psql, following memory `feedback_dev_db_migrate_blocked_at_524`: apply the file, then insert its name into the migrations tracking table (memory `project_migration_tracking`).
  2. Start the dev server on :3200 from this worktree.
  3. Pair an extension connection for the reporting QA user (memory `project_reporting_qa_user`; mint a session per `feedback_mint_dev_session_without_password`), and call the pair route to get a token.
  4. POST the same body twice with `curl -H "Authorization: Bearer $TOKEN"`. Expect `imported: 1` and then `duplicate: 1`.
  5. With `psql`, check that exactly one row exists, with `bank_feed_connection_id` set and `feed_state='posted'`, and that no `gl_journal_entries` row was created for it (`SELECT count(*) FROM gl_journal_entries WHERE company_id=… AND created_at > now() - interval '5 minutes'`).
  6. Paste the curl outputs and the psql counts into the PR.

- [ ] **Step 7: Commit, CI, blind review, and PR B**

Commit the route, its test, and the `.claude.md`/`AGENTS.md` pair by explicit path, with the message `feat(bank): extension ingest submits through the canonical feed service`. Then:

1. Run `bun run ci`.
2. Run `/review` blind, plus the adversarial ledger round, and fix every finding.
3. Push, then open PR B with `gh pr create --base master --title "feat(bank): canonical feed ingestion; extension cuts over"`. The body must include the "Behaviour changes users will notice" section from this plan, the Task 6 Step 14 mutation-check results, and the Step 6 live proof. End it with the attribution lines.
4. Verify the commits with `gh pr view --json commits` before merging, and wait for the merge before Task 8.

---

### Task 8: Truthful connection types, services and routes

**Files:**
- Modify: `src/modules/accounting/services/bank/openBankingTypes.ts`
- Modify: `src/modules/accounting/services/bank/openBankingConnectionService.ts`
- Modify: `src/modules/accounting/services/bank/openBankingSyncService.ts`
- Modify: `pages/api/accounting/bank-feeds/index.ts`, `[id].ts`, `[id]/sync.ts`, `extension-pair.ts` (add `withWriteAccess` to the write methods)
- Modify: `tests/unit/services/openBankingSyncService.test.ts`, `tests/unit/services/bankFeedSyncRouteRefusal.test.ts`
- Test: `tests/unit/services/bank/openBankingConnectionTruth.test.ts`

**Interfaces:**
- Produces:

```ts
export type SupportedProvider = 'manual_csv' | 'extension';
export function isSupportedProvider(p: string): p is SupportedProvider;
export type ConnectionStatus = 'active' | 'paused' | 'error' | 'disconnected';
// BankFeedConnection: provider becomes `string`; gains `lastSuccessAt: string | null`,
// `accountNumberMasked: string | null`, `lastSync: BankFeedSyncCounts | null`.
export interface BankFeedSyncCounts {
  found: number; imported: number; duplicate: number; updated: number;
  pending: number; removed: number; conflicts: number; completedAt: string | null;
}
```

- `BankFeedConnectionInput.provider: SupportedProvider`; `BankFeedSyncResult.provider: string`.

- [ ] **Step 1: Write the failing test.** It mocks `sql` the same way `bankFeedSyncRouteRefusal.test.ts` does.

```ts
// tests/unit/services/bank/openBankingConnectionTruth.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import { sql } from '@/lib/neon';
import { deleteBankFeedConnection, listBankFeedConnections } from '@/modules/accounting/services/bank/openBankingConnectionService';
import { isSupportedProvider } from '@/modules/accounting/services/bank/openBankingTypes';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const text = (i: number) => (mockSql.mock.calls[i]![0] as unknown as string[]).join('?');
beforeEach(() => mockSql.mockReset());

describe('bank feed connection truthfulness', () => {
  it('supports only manual_csv and extension', () => {
    expect(['manual_csv', 'extension'].every(isSupportedProvider)).toBe(true);
    expect(['basiq', 'tink', 'plaid', 'stitch'].some(isSupportedProvider)).toBe(false);
  });

  it('disconnect is a soft state change that preserves history', async () => {
    mockSql.mockResolvedValue([]);
    await deleteBankFeedConnection('co', 'conn');
    expect(text(0)).toMatch(/status = 'disconnected'/);
    expect(text(0)).toMatch(/is_active = false/);
    expect(text(0)).not.toMatch(/DELETE/i);
  });

  it('lists masked account, last success and the latest sync counts', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'conn', company_id: 'co', provider: 'extension', account_id: 'gl', account_name: 'Cheque',
      account_number_masked: '****4567', external_account_id: null, status: 'active',
      last_sync_at: '2026-09-11T08:00:00Z', last_success_at: '2026-09-11T08:00:00Z',
      last_sync_status: 'success', last_sync_error: null, config: { bankId: 'absa' },
      created_at: '2026-09-01', updated_at: '2026-09-11',
      ls_found: 3, ls_imported: 2, ls_duplicate: 1, ls_updated: 0, ls_pending: 0, ls_removed: 0, ls_conflict: 0,
      ls_completed_at: '2026-09-11T08:00:01Z',
    }]);
    const [c] = await listBankFeedConnections('co');
    expect(c).toMatchObject({ accountNumberMasked: '****4567', lastSuccessAt: '2026-09-11T08:00:00Z',
      lastSync: { found: 3, imported: 2, duplicate: 1, pending: 0, conflicts: 0 } });
    expect(text(0)).toMatch(/company_id/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement.**
  - **`openBankingTypes.ts`:** replace the `Provider` union with `SupportedProvider` and `isSupportedProvider` (`p === 'manual_csv' || p === 'extension'`). Make `BankFeedConnection.provider: string`, add the three new fields and `BankFeedSyncCounts`, and extend `mapConnection` to map `account_number_masked`, `last_success_at` and the `ls_*` columns. `lastSync` is `null` when `ls_completed_at` and `ls_found` are both null. Add `transactionsUpdated`, `transactionsPending`, `transactionsRemoved`, `transactionsConflict` and `errorCode` to `BankFeedSyncLog` and `mapSyncLog`.
  - **`listBankFeedConnections`:** select `bfc.account_number_masked` and `bfc.last_success_at`, and add a `LEFT JOIN LATERAL (SELECT transactions_found AS ls_found, transactions_imported AS ls_imported, transactions_duplicate AS ls_duplicate, transactions_updated AS ls_updated, transactions_pending AS ls_pending, transactions_removed AS ls_removed, transactions_conflict AS ls_conflict, completed_at AS ls_completed_at FROM bank_feed_sync_logs l WHERE l.connection_id = bfc.id AND l.company_id = bfc.company_id ORDER BY l.started_at DESC LIMIT 1) ls ON TRUE`.
  - **`createBankFeedConnection`:** replace the `validProviders` check with `if (!isSupportedProvider(input.provider)) throw new Error(...)`. Also require `input.accountId` when `input.provider === 'extension'`, because `bank_account_id` is NOT NULL and the insert would otherwise fail with a raw constraint error. Throw `new Error('A bank account is required for this connection')`.
  - **`deleteBankFeedConnection`:** `SET is_active = false, status = 'disconnected', updated_at = NOW()`.
  - **`openBankingSyncService.ts`:** change the `LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id` to `LEFT JOIN gl_accounts ba ON ba.id = bfc.bank_account_id AND ba.company_id = bfc.company_id`. `bank_accounts` is the dead Stitch registry. Change the `manual_csv` instruction to `'Manual imports are user-operated: upload your statement (CSV, PDF, OFX or QIF) on the Bank Transactions import page.'` and the extension instruction to `'ABSA browser import is user-operated: open the IsaFlow extension in your signed-in ABSA tab and click Import. IsaFlow cannot fetch from your bank in the background.'`. Update the comment above the refusal so it no longer names basiq/tink/plaid as ever having existed, and type `provider` as `string`.
  - **Routes:** `index.ts` becomes `export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));`. Check `withWriteAccess`'s source for whether it lets GET through for read roles, and only wrap if it does; otherwise split out GET. Do the same for `[id].ts`, `[id]/sync.ts` and `extension-pair.ts`. Keep `[id]/logs.ts` read-only. The zod enum in `index.ts` stays `['manual_csv','extension']`.
  - **Tests:** update `bankFeedSyncRouteRefusal.test.ts` and `openBankingSyncService.test.ts` for the changed instruction text and the `gl_accounts` join. The legacy-provider refusal tests stay: legacy rows still exist.

- [ ] **Step 4: Run the tests and the type-check**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/services/bank/openBankingConnectionTruth.test.ts tests/unit/services/openBankingSyncService.test.ts tests/unit/services/bankFeedSyncRouteRefusal.test.ts && bun run type-check
```

Expected: PASS.

- [ ] **Step 5: Commit** the touched files by explicit path, with the message `feat(bank): bank-feed connections report only supported, user-operated modes`.

---

### Task 9: Truthful Bank Feeds UI, pending rows in the review table, and landing copy

**Files:**
- Modify: `src/components/accounting/bankFeeds/bankFeedTypes.ts`, `AddConnectionModal.tsx`, `BankFeedCard.tsx`
- Modify: `pages/accounting/bank-feeds/index.tsx` (subtitle L173, empty state L194)
- Modify: `src/components/landing/landingData.ts` (L128, L134, L256): **customer-facing, so Hein approves before merge**
- Modify: `pages/accounting/bank/provisional.tsx` (L157), only if its copy claims automatic feeds
- Create: `src/components/accounting/bank-transactions/pendingFeedRow.tsx`
- Modify: `src/components/accounting/BankTxTable.tsx` (row badge, row actions, row checkbox)
- Modify: `src/components/accounting/bank-transactions/useBankTxActions.ts` (bulk handlers skip pending ids)
- Modify: `tests/unit/components/bankFeedUnsupportedProvider.test.tsx`
- Test: `tests/unit/components/bankFeedTruthfulCopy.test.tsx`
- Test: `tests/unit/components/pendingFeedRow.test.tsx`

**Interfaces:**
- Produces:

```tsx
export function isPendingFeedRow(tx: { feedState?: string }): boolean;
export function actionableIds<T extends { id: string; feedState?: string }>(txs: T[], ids: string[]): string[];
export function PendingFeedBadge(): JSX.Element;       // text "Pending"
export function PendingFeedNotice(): JSX.Element;      // "Pending at the bank — actions unlock once it posts."
```

- Consumes `BankTransaction.feedState` (Task 2) via the page's transaction type. If the table uses its own row type, add `feedState?: 'pending' | 'posted' | 'removed'` to it.

- [ ] **Step 1: Write the failing component tests**

```tsx
// tests/unit/components/pendingFeedRow.test.tsx
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { actionableIds, isPendingFeedRow, PendingFeedBadge, PendingFeedNotice } from '@/components/accounting/bank-transactions/pendingFeedRow';

describe('pending feed rows', () => {
  it('recognises pending rows only', () => {
    expect(isPendingFeedRow({ feedState: 'pending' })).toBe(true);
    expect(isPendingFeedRow({ feedState: 'posted' })).toBe(false);
    expect(isPendingFeedRow({})).toBe(false);
  });
  it('drops pending rows from a bulk selection', () => {
    const txs = [{ id: 'a', feedState: 'posted' }, { id: 'b', feedState: 'pending' }, { id: 'c' }];
    expect(actionableIds(txs, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
  it('renders the badge and the explanation', () => {
    render(<><PendingFeedBadge /><PendingFeedNotice /></>);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText(/actions unlock once it posts/)).toBeTruthy();
  });
});
```

```tsx
// tests/unit/components/bankFeedTruthfulCopy.test.tsx
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { PROVIDER_LABELS, PROVIDER_DESCRIPTIONS, providerLabel } from '@/components/accounting/bankFeeds/bankFeedTypes';
import { AddConnectionModal } from '@/components/accounting/bankFeeds/AddConnectionModal';

describe('bank feed copy is truthful', () => {
  it('offers no provider IsaFlow does not have', () => {
    const all = JSON.stringify({ PROVIDER_LABELS, PROVIDER_DESCRIPTIONS });
    expect(all).not.toMatch(/Basiq|Tink|Plaid|Stitch/i);
    expect(all).not.toMatch(/automatic/i);
    expect(PROVIDER_DESCRIPTIONS.extension).toMatch(/user-operated|you run it/i);
  });
  it('labels a legacy provider as unsupported without naming it as an offering', () => {
    expect(providerLabel('basiq')).toBe('Unsupported legacy connection (basiq)');
  });
  it('the add-connection modal renders no unsupported option', () => {
    const { container } = render(<AddConnectionModal open onClose={() => {}} onCreated={() => {}} accounts={[]} />);
    expect(container.textContent ?? '').not.toMatch(/Basiq|Tink|Plaid|Stitch|automatic/i);
  });
});
```

Match `AddConnectionModal`'s real prop names from the source (L1–40) before running; don't change its props to fit the test.

- [ ] **Step 2: Run both tests and confirm they fail.**

- [ ] **Step 3: Implement**

`pendingFeedRow.tsx` (new, about 40 lines):

```tsx
import React from 'react';

export function isPendingFeedRow(tx: { feedState?: string }): boolean {
  return tx.feedState === 'pending';
}

export function actionableIds<T extends { id: string; feedState?: string }>(txs: T[], ids: string[]): string[] {
  const pending = new Set(txs.filter(isPendingFeedRow).map((t) => t.id));
  return ids.filter((id) => !pending.has(id));
}

export function PendingFeedBadge(): JSX.Element {
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      title="The bank has not posted this transaction yet">
      Pending
    </span>
  );
}

export function PendingFeedNotice(): JSX.Element {
  return <span className="text-xs text-gray-500 dark:text-gray-400">Pending at the bank — actions unlock once it posts.</span>;
}
```

`bankFeedTypes.ts`:
- Replace the `Provider` union with `export type SupportedProvider = 'manual_csv' | 'extension';`.
- Change `BankFeedConnection.provider` to `string`, and add `lastSuccessAt`, `accountNumberMasked` and `lastSync`, mirroring Task 8.
- `PROVIDER_LABELS: Record<SupportedProvider, string>` is `{ extension: 'ABSA browser import', manual_csv: 'Import statements' }`.
- `PROVIDER_DESCRIPTIONS` is `{ extension: 'User-operated: open the IsaFlow extension in your signed-in ABSA tab and import. IsaFlow never sees your banking password and cannot fetch in the background.', manual_csv: 'User-operated: upload CSV, PDF, OFX or QIF statements on the Bank Transactions page.' }`.
- Add `export function providerLabel(p: string): string { return isSupportedProvider(p) ? PROVIDER_LABELS[p] : \`Unsupported legacy connection (${p})\`; }`.
- Replace `UNSUPPORTED_PROVIDERS` and `isUnsupportedProvider` with `isSupportedProvider` (keep an `isUnsupportedProvider = (p) => !isSupportedProvider(p)` export only if the card still needs it).

`AddConnectionModal.tsx`: set the option titles and descriptions from the maps above.

`BankFeedCard.tsx`:
- Use `providerLabel`.
- Show the masked account, "Last successful import" (`lastSuccessAt`), "Last attempt" (`lastSyncAt`), and the latest counts (`lastSync`: imported · duplicate · pending · conflicts).
- Keep the legacy "not supported" notice.
- Rename the Sync button for `extension` to "How to import" (it shows the instruction the route returns). Hide it for `manual_csv` and link to the import page instead (spec: "`manual_csv` … has no Sync action").

`pages/accounting/bank-feeds/index.tsx`:
- The subtitle becomes "Import bank transactions — statement uploads and ABSA browser import".
- The empty state becomes "Import bank statements (CSV, PDF, OFX, QIF) or connect the ABSA browser import. Both are user-operated; IsaFlow does not yet offer automatic bank feeds."

`landingData.ts`: rewrite the three lines so they claim statement import and ABSA browser import, not "live bank feeds" or "real-time sync". **Put the old and new strings side by side in the PR description for Hein's approval.**

`BankTxTable.tsx`, with minimal edits:
- After the description cell text: `{isPendingFeedRow(tx) && <PendingFeedBadge />}`.
- Wrap the row-action button group (Accept L656, Find & Match L661, Split L666, Exclude L688) in `{isPendingFeedRow(tx) ? <PendingFeedNotice /> : (<>…existing buttons…</>)}`.
- Row checkbox: `disabled={isPendingFeedRow(tx)}`, plus the same predicate in select-all.

`useBankTxActions.ts`: in `handleBatchAccept` (L129), `handleBatchDelete` (L148) and `handleBulkAccept` (L157), pass the selected ids through `actionableIds(transactions, ids)` before the request. If that empties the list, show the existing toast pattern with "Pending transactions can’t be processed until they post."

`bankFeedUnsupportedProvider.test.tsx`: change the `Provider` import to `string`, and keep the basiq/tink/plaid rows as legacy data. The assertions about the disabled button and the notice stay.

- [ ] **Step 4: Run the component tests, type-check and lint**

```bash
env -u DATABASE_URL bun run test:unit -- tests/unit/components && bun run type-check && bun run lint
```

Expected: PASS.

- [ ] **Step 5: Browser proof on dev** (global rule: UI changes require loading the actual page). Delegate to the `browser-qa` agent, or do it directly with the playwriter tooling:
  1. Seed one pending feed row on the QA company's bank account in `isaflow_dev` via psql: a connection with provider `test_provider`, `feed_state='pending'`, and a provider id.
  2. Open `/accounting/bank-transactions` for that account and screenshot it. Show the Pending badge and the notice in place of the Accept, Find & Match, Split and Exclude buttons, and that the row checkbox is disabled.
  3. Open `/accounting/bank-feeds` and screenshot it. Show no Basiq, Tink, Plaid, Stitch or "automatic" wording, the extension card's last-import counts, and "How to import".
  4. Delete the seeded rows afterwards, scoped by the seeded ids and `company_id`.
  5. Attach the screenshots to the PR.

- [ ] **Step 6: Commit** the touched files by explicit path, with the message `feat(bank): truthful Bank Feeds copy and read-only pending rows in review`.

---

### Task 10: Remove the dead Stitch bank-feed runtime

**Files:**
- Delete: `pages/api/bank-feeds/connect.ts`, `pages/api/bank-feeds/callback.ts`, `pages/api/bank-feeds/connections.ts`
- Delete: `src/modules/accounting/services/bank/bankFeedService.ts`, `bankFeedConnectionService.ts`, `bankFeedOAuthService.ts`, `bankFeedSyncService.ts`
- Modify: `src/modules/accounting/services/bank/index.ts` (drop lines 14–15)
- Modify: `src/modules/accounting/services/bank/bankTransactionLookupService.ts` (the stale comment at L13–14 and any import of a deleted module)
- Modify: `tests/unit/security/idor/pentest-2026-04-29.test.ts` (remove only the Stitch-service cases)
- Modify: `tests/unit/benchmark/banking-reconciliation.test.ts`, `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` (remove only their references to the deleted modules)
- Modify: `tests/e2e/new-features.spec.ts` (drop the `/api/bank-feeds/connections?action=status` probe at ~L87)

- [ ] **Step 1: Confirm there are no live callers**, before deleting anything:

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/bank-sync-v1-20260911
grep -rnE "bankFeedService|bankFeedConnectionService|bankFeedOAuthService|bankFeedSyncService|/api/bank-feeds/" src pages chrome-extension --include=*.ts --include=*.tsx --include=*.js
```

Expected hits are only the files in the list above plus `services/bank/index.ts`. Any other hit is a live caller: **stop and report it**; don't delete.

Also check production traffic for the three routes over the last 30 days. Use `journalctl` for the isaflow service (memory `feedback_prod_request_logs_beat_guessing`; the command is read-only): `sudo -n journalctl -u isaflow --since '30 days ago' | grep -c '/api/bank-feeds/'`. Record the count in the PR. A non-zero count means stop and ask Hein.

- [ ] **Step 2: Delete and edit.** Use `git rm` for the seven files, then edit the barrel and the tests as listed. In the pentest test, remove the `describe`/`it` blocks that import the Stitch services, and keep every other case unchanged.

- [ ] **Step 3: Check whether the Stitch env vars are still referenced**

```bash
grep -rnE "STITCH_(CLIENT|GRAPHQL|TOKEN|REDIRECT)" --include=*.ts --include=*.tsx --include=*.example --include=*.md . | grep -v node_modules | grep -v src/modules/billing
```

Remove bank-feed-only entries from `.env.example`, if any exist. Billing's Stitch Express vars stay untouched: check each hit's file before removing it.

- [ ] **Step 4: Type-check, run the unit tests and build**

```bash
bun run type-check && env -u DATABASE_URL bun run test:unit && bun run build
```

Expected: PASS. Don't run the build beside a running dev server (memory `feedback_ci_build_kills_dev_server`).

- [ ] **Step 5: Commit** with `git add -u` limited to the explicit paths (`git add pages/api/bank-feeds src/modules/accounting/services/bank tests/unit/security/idor/pentest-2026-04-29.test.ts tests/unit/benchmark/banking-reconciliation.test.ts tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts tests/e2e/new-features.spec.ts`), then commit with the message `chore(bank): remove the dead Stitch bank-feed runtime`.

---

### Task 11: Release 1 verification, PR C, and acceptance check

- [ ] **Step 1: Run the acceptance-criteria sweep.** Each criterion in spec §"Acceptance criteria" that R1 owns maps to evidence:

| Criterion | Evidence |
|---|---|
| One canonical service ingests every live feed source | `grep -rn "INSERT INTO bank_transactions" pages/api/accounting/bank-feeds src/modules/accounting/services/bank/feed` shows only `bankIngestionPersistence.ts` |
| Redelivery never creates a second row | `bank-feed-ingestion.int.test.ts` redelivery and concurrency cases |
| Pending visible, excluded from totals, impossible to post | Tasks 1–4 integration tests plus the Task 9 browser screenshots |
| A provider update never silently rewrites a processed row | ingestion conflict case plus the trigger case in the schema test |
| Sync creates no journal; only suggestion rules run | ingestion "never creates a journal" case plus the Task 7 live proof |
| No runtime route calls Stitch; no UI claims Basiq/Tink/Plaid/Stitch | Task 10 grep plus `bankFeedTruthfulCopy.test.tsx` |
| Manual and extension labelled user-operated | `bankFeedTruthfulCopy.test.tsx` |
| No banking password accepted, stored or logged | `grep -rniE "password" pages/api/accounting/bank-feeds src/modules/accounting/services/bank/feed chrome-extension/bank-connector` returns nothing new; the ingest schema is `.strict()` |

The learned-rule and threshold-three criteria belong to **Release 2** and aren't claimed here.

- [ ] **Step 2: Run the full gate and review**

1. Run `bun run ci` (load below 30).
2. Run `/review` blind on the PR C commits.
3. Run the security review (the `security-review` skill), because this PR changes auth wrappers and removes OAuth routes.
4. Fix every finding, and re-run CI.

- [ ] **Step 3: Push and open PR C.** Title: `feat(bank): truthful bank-feed connections; remove Stitch runtime`. The body includes:
  - the Task 10 journalctl count;
  - the before/after landing-copy table marked **"Needs Hein's approval (customer-facing copy)"**;
  - the Task 9 screenshots;
  - the acceptance table from Step 1;
  - the attribution lines.

  Verify the commits with `gh pr view --json commits`.

- [ ] **Step 4: Don't merge PR C** until Hein has approved the landing copy. No production deploy is part of this plan. Migration 675 ships with PR A's deploy, which needs Hein's approval after hours.

- [ ] **Step 5: Hand off.** Write a handoff with the `handoff` skill listing:
  - the PR numbers and states;
  - that migration 675 was applied to the fixture and dev DBs;
  - that Release 2 (confirmed-pattern learning) is next and needs its own plan;
  - that Release 3 stays blocked on provider credentials and contract.
