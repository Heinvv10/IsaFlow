# Phase 4D Ops Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four ops-readiness deliverables — PITR drill, rollback rehearsal, secrets rotation runbook + inventory, migration runner + prod go-live plan — with real drill-captured timings.

**Architecture:** Pure documentation + one TypeScript migration runner. No runtime app changes. Drills (Tasks 7, 8) are human-operated on a prod-clone Neon branch; their outputs feed the runbooks and the migration go-live plan.

**Tech Stack:** TypeScript (bun), Vitest, pg, Neon branching, Markdown.

**Spec deviation from design doc:** Migration runner written in TypeScript (`scripts/apply-migrations.ts`) rather than bash. Rationale: Vitest-testable in the existing test harness; bash would require synthetic tests. All other files match the spec exactly.

---

## File Structure

**New files:**
- `scripts/migrations/sql/332_schema_migrations_tracking.sql` — tracking table DDL.
- `scripts/apply-migrations.ts` — idempotent migration runner with `--dry-run` and `--backfill` flags.
- `tests/unit/scripts/apply-migrations.test.ts` — Vitest unit tests.
- `docs/runbooks/pitr-restore-drill.md` — drill procedure + captured timings.
- `docs/runbooks/rollback-rehearsal.md` — rehearsal procedure + captured timings.
- `docs/runbooks/secrets-rotation.md` — generic playbook + per-secret notes.
- `docs/runbooks/prod-migration-go-live.md` — go-live plan for the 292+325–331 batch.
- `docs/audits/2026-04-15/secrets-inventory.md` — classified secrets inventory.
- `docs/audits/2026-04-15/phase4d-closeout.md` — phase wrap-up.

**Modified:** None.

---

## Task 1: Secrets inventory

**Files:**
- Create: `docs/audits/2026-04-15/secrets-inventory.md`

- [ ] **Step 1: Grep all `process.env.*` references**

Run:
```
grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*" src pages scripts --include='*.ts' --include='*.tsx' --include='*.js' | sort -u
```

Expected: deduplicated list of every env var the app reads. Copy this list; classify each one in the next step.

- [ ] **Step 2: Write `docs/audits/2026-04-15/secrets-inventory.md`**

Structure the file as follows, filling the tables from the grep output:

```
# Secrets Inventory — 2026-04-15

**Source:** grep of `process.env.*` across src/ pages/ scripts/ (run 2026-04-15)

## Classification legend
- **auth-critical** — rotation invalidates active user sessions; requires maintenance window.
- **data** — rotation requires connection draining; transient errors during cutover.
- **third-party** — rotation must coordinate with vendor; silent integration break if mistimed.
- **infra** — stateless; low risk; rotate any time.

## auth-critical
| Var | Used in | Notes |
|---|---|---|
| JWT_SECRET | src/lib/auth/*, middleware.ts | Rotation logs every user out. Maintenance window required, or dual-secret migration strategy. |

## data
| Var | Used in | Notes |
|---|---|---|
| DATABASE_URL | src/lib/neon.ts, scripts/* | Rotate during deploy; ~30s transient 503s during pod restart. |

## third-party
| Var | Used in | Notes |
|---|---|---|
| SMTP_* | src/lib/email/* | Rotate in vendor console first; deploy new creds second. |
| STITCH_* | src/lib/banking/stitch* | Coordinate with Stitch support before rotating. |
| ANTHROPIC_API_KEY / OPENAI_API_KEY | src/lib/ai/* | Vendor dashboards; rotate after new key verified working. |

## infra
| Var | Used in | Notes |
|---|---|---|
| NEXT_PUBLIC_* | various | Build-time; rotate by rebuild. |
| SLOW_QUERY_MS_THRESHOLD | src/lib/neon.ts | Threshold; not a secret. |
| HEALTH_CHECK_TIMEOUT_MS | src/lib/observability/* | Threshold; not a secret. |

## Coverage check
Grep returned N unique env vars. Inventory classifies N. Delta: 0.
```

Classify every variable from the grep. No "uncategorized" rows allowed.

- [ ] **Step 3: Commit**

```
git add docs/audits/2026-04-15/secrets-inventory.md
git commit -m "docs(4D): secrets inventory classified by rotation risk"
```

---

## Task 2: Secrets rotation runbook

**Files:**
- Create: `docs/runbooks/secrets-rotation.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/secrets-rotation.md` with this structure:

```
# Secrets Rotation Runbook

**Companion:** `docs/audits/2026-04-15/secrets-inventory.md`

## When to use this
- Scheduled rotation (quarterly for auth-critical, annually for third-party).
- Suspected compromise (rotate immediately, skip maintenance window).
- Staff offboarding with access to the secret.

## Generic playbook (all secrets)

### Pre-flight
1. Check inventory. What class is the secret?
2. For auth-critical: schedule maintenance window. Notify users.
3. For data: confirm deploy tooling restarts cleanly.
4. For third-party: confirm vendor can issue the new credential with grace period.
5. Capture the current value in 1Password (not git) for rollback.

### Rotate
1. Generate new value (vendor console / openssl rand).
2. Update value in deploy config (Vercel env / systemd env file / .env on server).
3. Do NOT revoke the old value yet.

### Deploy
1. Trigger deploy. Watch health endpoint during pod cycling.
2. Verify /api/health returns 200.
3. Verify /api/health/deep shows all deps healthy.

### Verify
1. Functional check: log in (JWT), send email (SMTP), etc.
2. Check logs for auth failures, connection errors, vendor 401s.
3. Watch for 15 minutes.

### Post-flight
1. Revoke old value in source of truth.
2. Update secrets-inventory.md with rotation date.
3. Remove old value from 1Password after 48h cooling period.

## Per-secret notes

### JWT_SECRET (auth-critical)
- Rotation logs every user out — their tokens become invalid signatures.
- Maintenance window required, or implement dual-secret verification (accept old + new for 2h, then drop old).
- Post-rotation: verify login works; verify existing sessions were invalidated.

### DATABASE_URL (data)
- Neon: create new role with new password, update DATABASE_URL, deploy, verify, drop old role.
- Expect ~30s of 503s during pod restart.
- Post-rotation: SELECT 1 succeeds from new pods.

### SMTP credentials (third-party)
- Generate new creds in mail provider console.
- Deploy. Send a test email. Then revoke old creds.

### STITCH_CLIENT_SECRET (third-party)
- Contact Stitch support before rotation.
- Dual-cred window: ~1h overlap.

### AI provider keys (third-party)
- Vendor dashboards. Revoke old after new is confirmed working via a dev test call.

## Rollback
- If rotation breaks auth/data: redeploy previous env (keep the old secret value for 48h).
- If third-party rotation silently breaks integration: revert deploy, re-enable old creds in vendor console.
```

- [ ] **Step 2: Commit**

```
git add docs/runbooks/secrets-rotation.md
git commit -m "docs(4D): secrets rotation runbook + per-secret notes"
```

---

## Task 3: Migration 332 — schema_migrations tracking table

**Files:**
- Create: `scripts/migrations/sql/332_schema_migrations_tracking.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 332_schema_migrations_tracking.sql
-- Tracks which numbered migrations have been applied, so apply-migrations.ts
-- can be idempotent and detect post-apply edits via checksum.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);
```

- [ ] **Step 2: Commit**

```
git add scripts/migrations/sql/332_schema_migrations_tracking.sql
git commit -m "feat(4D): migration 332 schema_migrations tracking table"
```

---

## Task 4: apply-migrations.ts — failing tests

**Files:**
- Create: `tests/unit/scripts/apply-migrations.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeChecksum,
  parseVersionFromFilename,
  planApply,
  type MigrationFile,
  type TrackingRow,
} from '@/scripts/apply-migrations';

describe('parseVersionFromFilename', () => {
  it('extracts version from numeric prefix', () => {
    expect(parseVersionFromFilename('292_foo.sql')).toBe(292);
    expect(parseVersionFromFilename('001_bar.sql')).toBe(1);
  });

  it('throws on non-numeric prefix', () => {
    expect(() => parseVersionFromFilename('foo_bar.sql')).toThrow(/numeric prefix/);
  });
});

describe('computeChecksum', () => {
  it('is stable for identical content', () => {
    expect(computeChecksum('SELECT 1;')).toBe(computeChecksum('SELECT 1;'));
  });

  it('differs for different content', () => {
    expect(computeChecksum('SELECT 1;')).not.toBe(computeChecksum('SELECT 2;'));
  });

  it('is 64 hex chars (SHA-256)', () => {
    expect(computeChecksum('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('planApply', () => {
  const files: MigrationFile[] = [
    { version: 292, name: '292_a.sql', content: 'A', checksum: computeChecksum('A') },
    { version: 325, name: '325_b.sql', content: 'B', checksum: computeChecksum('B') },
    { version: 326, name: '326_c.sql', content: 'C', checksum: computeChecksum('C') },
  ];

  it('returns all files when tracking table is empty', () => {
    const plan = planApply(files, []);
    expect(plan.toApply.map((f) => f.version)).toEqual([292, 325, 326]);
    expect(plan.skipped).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('skips already-applied files with matching checksums', () => {
    const applied: TrackingRow[] = [
      { version: 292, name: '292_a.sql', checksum: computeChecksum('A') },
      { version: 325, name: '325_b.sql', checksum: computeChecksum('B') },
    ];
    const plan = planApply(files, applied);
    expect(plan.toApply.map((f) => f.version)).toEqual([326]);
    expect(plan.skipped.map((f) => f.version)).toEqual([292, 325]);
    expect(plan.conflicts).toEqual([]);
  });

  it('flags checksum mismatches as conflicts and excludes from toApply', () => {
    const applied: TrackingRow[] = [
      { version: 292, name: '292_a.sql', checksum: 'WRONG' },
    ];
    const plan = planApply(files, applied);
    expect(plan.conflicts.map((c) => c.version)).toEqual([292]);
    expect(plan.toApply.map((f) => f.version)).toEqual([325, 326]);
  });

  it('sorts toApply by version ascending', () => {
    const shuffled = [files[2]!, files[0]!, files[1]!];
    const plan = planApply(shuffled, []);
    expect(plan.toApply.map((f) => f.version)).toEqual([292, 325, 326]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- apply-migrations`
Expected: FAIL — "Cannot find module '@/scripts/apply-migrations'".

---

## Task 5: apply-migrations.ts — implementation

**Files:**
- Create: `scripts/apply-migrations.ts`

- [ ] **Step 1: Implement the module**

```typescript
/**
 * Idempotent migration runner.
 *
 * Usage:
 *   bun scripts/apply-migrations.ts             # apply pending
 *   bun scripts/apply-migrations.ts --dry-run   # print plan, no writes
 *   bun scripts/apply-migrations.ts --backfill  # mark already-applied without running SQL
 *
 * Reads *.sql from scripts/migrations/sql/, sorts by numeric prefix,
 * skips ones in schema_migrations, refuses on checksum mismatch.
 *
 * Uses pg_advisory_lock(73014132) to prevent concurrent runners from
 * double-applying.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const ADVISORY_LOCK_KEY = 73014132;
const MIGRATIONS_DIR = join(process.cwd(), 'scripts', 'migrations', 'sql');

export interface MigrationFile {
  version: number;
  name: string;
  content: string;
  checksum: string;
}

export interface TrackingRow {
  version: number;
  name: string;
  checksum: string | null;
}

export interface ApplyPlan {
  toApply: MigrationFile[];
  skipped: MigrationFile[];
  conflicts: Array<{ version: number; name: string; fileChecksum: string; dbChecksum: string | null }>;
}

export function parseVersionFromFilename(filename: string): number {
  const match = /^(\d+)_/.exec(filename);
  if (!match) {
    throw new Error(`Migration filename missing numeric prefix: ${filename}`);
  }
  return Number(match[1]);
}

export function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function planApply(files: MigrationFile[], applied: TrackingRow[]): ApplyPlan {
  const appliedByVersion = new Map(applied.map((a) => [a.version, a]));
  const toApply: MigrationFile[] = [];
  const skipped: MigrationFile[] = [];
  const conflicts: ApplyPlan['conflicts'] = [];

  const sorted = [...files].sort((a, b) => a.version - b.version);

  for (const file of sorted) {
    const prior = appliedByVersion.get(file.version);
    if (!prior) {
      toApply.push(file);
      continue;
    }
    if (prior.checksum !== file.checksum) {
      conflicts.push({
        version: file.version,
        name: file.name,
        fileChecksum: file.checksum,
        dbChecksum: prior.checksum,
      });
    } else {
      skipped.push(file);
    }
  }

  return { toApply, skipped, conflicts };
}

function loadMigrationFiles(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return entries.map((name) => {
    const content = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    return {
      version: parseVersionFromFilename(name),
      name,
      content,
      checksum: computeChecksum(content),
    };
  });
}

async function fetchApplied(client: pg.PoolClient): Promise<TrackingRow[]> {
  const res = await client.query<TrackingRow>(
    'SELECT version, name, checksum FROM schema_migrations'
  );
  return res.rows;
}

async function applyOne(client: pg.PoolClient, file: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(file.content);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
         ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, checksum = EXCLUDED.checksum, applied_at = now()`,
      [file.version, file.name, file.checksum]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function backfillOne(client: pg.PoolClient, file: MigrationFile): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
       ON CONFLICT (version) DO NOTHING`,
    [file.version, file.name, file.checksum]
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const backfill = process.argv.includes('--backfill');

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Strip Neon pooler + channel_binding for stable session connection.
  const directUrl = url
    .replace('-pooler.', '.')
    .replace('&channel_binding=require', '')
    .replace('?channel_binding=require', '?');

  const pool = new pg.Pool({
    connectionString: directUrl,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    // Bootstrap: ensure tracking table exists even on first run.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version int PRIMARY KEY,
         name text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         checksum text
       )`
    );

    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);

    try {
      const files = loadMigrationFiles();
      const applied = await fetchApplied(client);
      const plan = planApply(files, applied);

      console.log(`Found ${files.length} migration files, ${applied.length} already tracked`);
      console.log(`  toApply:   ${plan.toApply.map((f) => f.version).join(', ') || '(none)'}`);
      console.log(`  skipped:   ${plan.skipped.map((f) => f.version).join(', ') || '(none)'}`);
      console.log(`  conflicts: ${plan.conflicts.map((c) => c.version).join(', ') || '(none)'}`);

      if (plan.conflicts.length > 0) {
        console.error('Checksum conflicts — migration files edited after apply:');
        for (const c of plan.conflicts) {
          console.error(`  ${c.name}  file=${c.fileChecksum.slice(0, 8)}  db=${(c.dbChecksum ?? 'null').slice(0, 8)}`);
        }
        process.exit(2);
      }

      if (dryRun) {
        console.log('--dry-run: no changes made');
        return;
      }

      if (backfill) {
        for (const file of plan.toApply) {
          await backfillOne(client, file);
          console.log(`backfilled ${file.name}`);
        }
        console.log(`Backfill complete: ${plan.toApply.length} rows`);
        return;
      }

      for (const file of plan.toApply) {
        console.log(`applying ${file.name} …`);
        const t0 = Date.now();
        await applyOne(client, file);
        console.log(`  ok (${Date.now() - t0}ms)`);
      }
      console.log(`Applied ${plan.toApply.length} migrations`);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run main when invoked directly, not when imported by tests.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun run test:unit -- apply-migrations`
Expected: PASS — 9 tests pass.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```
git add scripts/apply-migrations.ts tests/unit/scripts/apply-migrations.test.ts
git commit -m "feat(4D): idempotent migration runner with checksum + advisory lock"
```

---

## Task 6: Dev rollout of migration 332 + backfill

**Files:** None modified (DB state change only).

- [ ] **Step 1: Dry-run against dev**

Run: `bun scripts/apply-migrations.ts --dry-run`
Expected: output shows `toApply: 292, 325, 326, 327, 328, 329, 330, 331, 332` (none tracked yet, fresh tracking table).

- [ ] **Step 2: Use --backfill to mark 292+325–331 as applied without re-running**

All prior migrations have already been applied to dev (they ran from raw SQL). We don't want to re-run them. Backfill marks them as tracked:

Run: `bun scripts/apply-migrations.ts --backfill`
Expected: 9 rows inserted into schema_migrations (including 332).

Wait — 332 itself also needs its SQL applied to create the index. Options:
- (a) Manually apply 332's SQL first via direct psql/Neon console, then `--backfill` everything.
- (b) Apply 332 normally first with the runner: `bun scripts/apply-migrations.ts` WILL try to apply all 9; but the others are idempotent per CLAUDE.md (`IF NOT EXISTS`), so they no-op.

Recommendation: option (b) for simplicity. The prior migrations all use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, so re-running them is safe per CLAUDE.md rule.

Revised sequence:
1. Run: `bun scripts/apply-migrations.ts --dry-run` to confirm the plan.
2. Run: `bun scripts/apply-migrations.ts` to apply all 9 (including 332 creating the tracking table entries). The 8 prior ones no-op on existing objects.
3. Verify the tracking table has 9 rows.

- [ ] **Step 3: Verify tracking table populated**

Run (via psql or Neon console):
```sql
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;
```
Expected: 9 rows for versions 292, 325, 326, 327, 328, 329, 330, 331, 332.

- [ ] **Step 4: Re-run to verify idempotence**

Run: `bun scripts/apply-migrations.ts`
Expected output: `toApply: (none)` — all tracked, nothing to do.

- [ ] **Step 5: Run regression suite**

Run: `bun run test:unit && bunx tsc --noEmit`
Expected: all pass, exit 0.

- [ ] **Step 6: Record outcome**

No file to commit; DB state change only. Record outcome (row count, timings) in the closeout (Task 10).

---

## Task 7: PITR drill runbook + drill execution

**Files:**
- Create: `docs/runbooks/pitr-restore-drill.md`

- [ ] **Step 1: Write the runbook template**

```
# PITR Restore Drill

**Purpose:** Validate we can point-in-time restore prod-sized data within a known RTO.

**Retention window on current Neon plan:** 7 days.

## Pre-flight
- [ ] Confirm Neon plan has branch capacity (console → Branches).
- [ ] Calendar block 2h to avoid bill surprise from forgotten branch.
- [ ] Note current prod tip timestamp T0 (UTC).

## Drill procedure

### 1. Create prod-clone branch
- Neon console → Branches → Create branch from `production` at timestamp T0.
- Name: `drill-YYYYMMDD-pitr`.
- Record connection string into `.env.drill` (NOT committed).

### 2. Capture pre-state
Run against clone:
    SELECT
      (SELECT count(*) FROM bank_transactions) AS bank_tx,
      (SELECT count(*) FROM customer_invoices) AS inv,
      (SELECT count(*) FROM gl_journal_lines) AS gl_lines,
      (SELECT count(*) FROM companies) AS companies;

Record row counts below.

### 3. Apply destructive change
Run against clone at T1 (note timestamp):
    BEGIN;
    DELETE FROM bank_transactions WHERE company_id = (SELECT id FROM companies LIMIT 1);
    COMMIT;
Verify row count drop with same query as step 2.

### 4. Invoke PITR
- Neon console → Branches → drill-YYYYMMDD-pitr → Restore → select timestamp just before T1.
- Record T_restore_start.

### 5. Verify restore
Wait until Neon reports restore complete. Record T_restore_complete.
Re-run row-count query. Expected: counts match pre-state from step 2.

### 6. Teardown
- Delete branch drill-YYYYMMDD-pitr.
- Verify disappearance in Branches list.
- Delete .env.drill.

## Drill execution evidence (fill during drill)

**Drill date:** YYYY-MM-DD
**Operator:** <name>

**Pre-state row counts:**
| Table | Count |
|---|---|
| bank_transactions | <n> |
| customer_invoices | <n> |
| gl_journal_lines | <n> |
| companies | <n> |

**Timings:**
| Event | Timestamp (UTC) | Delta |
|---|---|---|
| T0 (branch created from prod) | | |
| T1 (destructive change applied) | | |
| T_restore_start | | |
| T_restore_complete | | |
| **Total RTO** | | |

**Post-restore verification:** counts match / differ (explain)

**Neon console artifacts:** paste screenshot paths or CLI output excerpts.

**Gotchas encountered:** <free text>

**Conclusion:** RTO estimate for prod = <minutes>
```

- [ ] **Step 2: Run the drill**

Perform steps 1–6 from the runbook above. Fill in the "Drill execution evidence" section with real timings, row counts, and any issues.

- [ ] **Step 3: Commit**

```
git add docs/runbooks/pitr-restore-drill.md
git commit -m "docs(4D): PITR restore drill runbook + execution evidence"
```

---

## Task 8: Rollback rehearsal runbook + run

**Files:**
- Create: `docs/runbooks/rollback-rehearsal.md`

- [ ] **Step 1: Write the runbook template**

```
# Migration Rollback Rehearsal

**Scenario:** Migration N applied to prod. Discovered to be wrong. Recover.

**Two paths:**

### Path A — PITR to pre-migration timestamp
Applicable: always, but costs T_restore minutes of downtime (see pitr-restore-drill.md).

Steps:
1. Stop writes (put app in maintenance mode).
2. Neon console → Restore branch to T_pre_migration.
3. App pods restart, read from restored state.
4. Post-verification: row counts, critical queries return expected data.

### Path B — Manual DDL reversal
Applicable: only when migration is purely additive (added columns/tables/indexes).
NOT applicable: DROP COLUMN, ALTER COLUMN TYPE, DELETE, UPDATE.

Steps:
1. Identify the reverse DDL (e.g., DROP INDEX IF EXISTS idx_x for a migration that did CREATE INDEX idx_x).
2. Apply reverse DDL as an ad-hoc hotfix migration (next number).
3. DELETE FROM schema_migrations WHERE version = N.

## Decision tree
    Is the migration purely additive (added columns/tables/indexes, no data changes)?
    ├── Yes → Path B (fast, no downtime)
    └── No  → Path A (PITR, costs T_restore)

## Rehearsal procedure
Use same prod-clone Neon branch workflow as PITR drill.
1. Create drill-YYYYMMDD-rollback branch.
2. Simulate a bad migration: apply a fake migration that wrongly alters a column.
3. Choose a path (A or B), run it, capture timings.
4. Verify: application-level smoke query returns expected data.
5. Teardown branch.

## Rehearsal execution evidence (fill during rehearsal)

**Date:** YYYY-MM-DD
**Scenario simulated:** <describe bad migration>
**Path chosen:** A / B
**Rationale:** <why>

**Timings:**
| Event | Timestamp (UTC) | Delta |
|---|---|---|
| "This is broken" declared | | |
| Recovery path decided | | |
| Recovery started | | |
| Service verified healthy | | |
| **Total elapsed** | | |

**Post-recovery verification queries run:**
    -- paste actual queries used
**Results:** pass / fail

**Gotchas:** <free text>

**Conclusion:** path A cost = <minutes>, path B typical cost = <minutes>.
```

- [ ] **Step 2: Run the rehearsal**

Perform it. Fill in evidence section.

- [ ] **Step 3: Commit**

```
git add docs/runbooks/rollback-rehearsal.md
git commit -m "docs(4D): rollback rehearsal runbook + execution evidence"
```

---

## Task 9: Prod migration go-live plan

**Files:**
- Create: `docs/runbooks/prod-migration-go-live.md`

- [ ] **Step 1: Write the go-live plan using drill timings**

```
# Prod Migration Go-Live Plan — 2026-04-15 Batch

**Batch scope:** Migrations 292, 325, 326, 327, 328, 329, 330, 331, 332.
**Prior applied to prod:** none (all are Phase 3/4 dev-only changes).
**Tool:** scripts/apply-migrations.ts
**Drill evidence:** docs/runbooks/pitr-restore-drill.md, docs/runbooks/rollback-rehearsal.md
**Estimated total duration:** <sum from drill timings per migration>

## Pre-flight checklist
- [ ] PITR retention window on prod ≥ 24h (Neon console).
- [ ] Latest prod backup point noted (timestamp).
- [ ] Operator + one reviewer on call.
- [ ] Maintenance window scheduled (after hours; see CLAUDE.md production time gate rule).
- [ ] Hein has given explicit approval (required per CLAUDE.md).
- [ ] Dev tracking table populated (verify: bun scripts/apply-migrations.ts --dry-run against dev → toApply empty).
- [ ] Dry-run against prod-clone branch done; output matches this plan.

## Migration list (in order)

| Version | File | Change summary | Expected duration | Lock behavior |
|---|---|---|---|---|
| 292 | 292_product_categories_company_id.sql | Add company_id to product_categories | <from drill> | brief AccessExclusive on product_categories |
| 325 | 325_supplier_payment_allocations.sql | Create table supplier_payment_allocations | <from drill> | none (new table) |
| 326 | 326_gl_journal_entries_company_date_posted_index.sql | Create composite index | <from drill> | ShareUpdateExclusive |
| 327 | 327_vat_and_retained_earnings_subtypes.sql | Data backfill | <from drill> | row locks only |
| 328 | 328_bank_transactions_company_date_index.sql | Create composite index | <from drill> | ShareUpdateExclusive |
| 329 | 329_gl_journal_lines_company_id.sql | STRUCTURAL — column add + backfill + NOT NULL | <from drill — LONGEST> | AccessExclusive then row locks |
| 330 | 330_customer_invoices_coalesce_index.sql | Expression index | <from drill> | ShareUpdateExclusive |
| 331 | 331_rate_limit_counters.sql | Create table rate_limit_counters | <from drill> | none (new table) |
| 332 | 332_schema_migrations_tracking.sql | Create tracking table | <1s> | none (new table) |

## Execution sequence

1. Put app in maintenance mode (if migration 329 is in scope — it locks gl_journal_lines).
2. Run: `DATABASE_URL=<prod> bun scripts/apply-migrations.ts --dry-run`.
3. Compare dry-run output to this plan. If mismatch → abort, investigate.
4. Run: `DATABASE_URL=<prod> bun scripts/apply-migrations.ts`.
5. Watch per-migration timing output; compare to "Expected duration" column.
6. On completion, run verification queries (below).
7. Take app out of maintenance mode.
8. Watch /api/health/deep and structured logs for 30 minutes.

## Verification queries
    -- Migrations tracked
    SELECT version, name, applied_at FROM schema_migrations WHERE version >= 292 ORDER BY version;

    -- 292: product_categories scoped
    SELECT count(*) FROM product_categories WHERE company_id IS NULL;  -- expected: 0

    -- 325: new table exists
    SELECT to_regclass('supplier_payment_allocations') IS NOT NULL AS exists;  -- expected: true

    -- 329: column exists, no NULLs
    SELECT count(*) FROM gl_journal_lines WHERE company_id IS NULL;  -- expected: 0

    -- 331: new table exists
    SELECT to_regclass('rate_limit_counters') IS NOT NULL AS exists;  -- expected: true

    -- 332: tracking works
    SELECT count(*) FROM schema_migrations WHERE version BETWEEN 292 AND 332;  -- expected: 9

## Go / no-go criteria
- **Go** if all pre-flight checkboxes ticked AND drill evidence exists AND dry-run matches plan.
- **No-go** if ANY pre-flight item unchecked, dry-run deviates, or Hein approval missing.

## Abort criteria (during run)
- Any migration takes 3× expected duration → abort (Ctrl+C), trigger rollback per rollback-rehearsal.md path A.
- Verification query fails → abort, rollback.
- App health endpoint returns 503 post-migration → rollback.

## Who calls abort
Operator has authority to abort; reviewer must be informed. Full rollback decision requires both.

## Post go-live
- Update this doc with actual timings.
- Append outcome to docs/audits/2026-04-15/phase4d-closeout.md.
- Keep maintenance window log for 7 days (PITR retention).
```

- [ ] **Step 2: Fill in drill-captured timings**

Update "Expected duration" column and total from Task 7's drill timings. Applied migrations on the clone during the drill capture per-migration duration.

- [ ] **Step 3: Commit**

```
git add docs/runbooks/prod-migration-go-live.md
git commit -m "docs(4D): prod migration go-live plan for 292+325-332 batch"
```

---

## Task 10: Phase 4D closeout

**Files:**
- Create: `docs/audits/2026-04-15/phase4d-closeout.md`

- [ ] **Step 1: Write the closeout**

```
# Phase 4D — Ops Readiness Closeout

**Date:** 2026-04-15
**Spec:** docs/superpowers/specs/2026-04-15-phase4d-ops-readiness-design.md
**Plan:** docs/superpowers/plans/2026-04-15-phase4d-ops-readiness-plan.md

## Scorecard

| Item | Status |
|---|---|
| PITR restore drill + RTO captured | ✅ docs/runbooks/pitr-restore-drill.md |
| Rollback rehearsal + timings | ✅ docs/runbooks/rollback-rehearsal.md |
| Secrets inventory classified | ✅ docs/audits/2026-04-15/secrets-inventory.md |
| Secrets rotation runbook | ✅ docs/runbooks/secrets-rotation.md |
| Migration runner + tests | ✅ scripts/apply-migrations.ts |
| Migration 332 applied to dev | ✅ verified via schema_migrations table |
| Prod migration go-live plan | ✅ docs/runbooks/prod-migration-go-live.md |
| tsc --noEmit | ✅ exit 0 |
| Regression suite | ✅ <N> unit + <N> integration passing |

## What landed
Summarize each commit in 1–2 lines.

## Drill outcomes

- **PITR RTO on prod-sized data:** <minutes>
- **Rollback path A elapsed:** <minutes>
- **Rollback path B elapsed:** <minutes>

## What was NOT done (deferred)

- Secrets manager integration (Vault/Doppler) — Phase 5+ decision.
- CI hook for migration dry-run on PRs — Phase 5+.
- Automated PITR drill in CI — not planned; drill is human-operated.

## Follow-ups

- **Task #41** (still pending): sage_customer_invoices mirror of BL-40.
- **Task #53** (deferred): multi-project error tracker.
- **Phase 5**: final re-verification sprint.

## Next phase

Phase 5 — final verification. Separate spec + plan + cycle when Hein is ready.
```

- [ ] **Step 2: Commit**

```
git add docs/audits/2026-04-15/phase4d-closeout.md
git commit -m "docs(4D): Phase 4D ops readiness closeout"
```

---

## Self-review notes

**Spec coverage:**
- Item 1 PITR drill → Task 7 ✅
- Item 2 rollback rehearsal → Task 8 ✅
- Item 3a secrets inventory → Task 1 ✅
- Item 3b secrets rotation runbook → Task 2 ✅
- Item 4a migration 332 → Task 3 ✅
- Item 4a runner + tests → Tasks 4, 5 ✅
- Item 4a dev rollout + backfill → Task 6 ✅
- Item 4b go-live plan → Task 9 ✅
- Closeout → Task 10 ✅

**Type consistency:** `MigrationFile`, `TrackingRow`, `ApplyPlan`, `computeChecksum`, `parseVersionFromFilename`, `planApply` — names match between test and implementation.

**Placeholder scan:** Runbook templates contain intentional fill-during-drill tokens (`<minutes>`, `YYYY-MM-DD`, `<n>`). These are template placeholders filled during drill execution — not plan failures. The plan itself has no unresolved TBDs.

**Sequencing:** Task 6 depends on Tasks 3, 4, 5. Task 9 depends on Task 7 (needs drill timings). Task 8 shares clone branch with Task 7. Task 10 depends on all.
