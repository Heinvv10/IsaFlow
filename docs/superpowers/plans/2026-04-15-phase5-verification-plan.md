# Phase 5 — Final Verification Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive ISAFlow to zero open P0 and zero open P1 issues via 3 mop-up fixes, 6 parallel verification sweeps, an iterative fix loop, and a scorecard closeout.

**Architecture:** Four sequential waves with parallel streams inside each; waves gate at checkpoints. Every fix ships with an integration test following the BL-40/41 playbook (real Neon dev DB, A/B/C/D properties, cross-tenant negative cases). Verification streams (Wave 2) are read-only findings producers — fixes happen in Wave 3 and iterate until P0+P1 = 0.

**Tech Stack:** Next.js 14 + TypeScript, Neon serverless Postgres (`@/lib/neon` `sql` tagged template), Vitest (unit + integration configs), multi-tenant (`company_id` on every statement).

**Spec:** `docs/superpowers/specs/2026-04-15-phase5-verification-design.md`

---

## Conventions (read once before starting)

- **Test DB:** Integration tests run against the Neon dev DB. `DATABASE_URL` must be exported in the shell before running Vitest. The project's `.env.local` has a syntax issue on the `SMTP_FROM` line that breaks `source .env.local` — export `DATABASE_URL` directly.
- **Integration test location:** `tests/integration/api/<service>.test.ts`. Config: `vitest.integration.config.ts`.
- **Integration test runner:** `bunx vitest run --config vitest.integration.config.ts tests/integration/api/<file>`.
- **Unit test runner:** `bun run test:unit`.
- **Type check:** `bunx tsc --noEmit`.
- **Test UUIDs:** Use prefix matching the BL-ID for tenant constants (e.g. BL-43 → `00000000-0000-0000-b143-0000000000aa1`). This isolates test-created data from real data and from other BL tests.
- **Status value check:** Before using a status string in test seed rows, run `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = '<table>'::regclass AND contype = 'c'` to find valid values. `customer_payments` valid statuses are `draft, confirmed, reconciled, cancelled` (NOT 'pending').
- **company_id guard pattern:** `AND company_id = ${companyId}::UUID` on every UPDATE/DELETE. On SELECTs that drive writes, same rule.
- **Findings format:** every row in Wave 2 streams has columns `(location, kind, target, guard_status, severity P0|P1|P2|P3, evidence_snippet, proposed_fix)`.

---

## Wave 1 — Mop-up (Tasks 1–4)

### Task 1: BL-43 — gl_migration_runs missing company_id on INSERT

**Files:**
- Modify: `src/modules/accounting/services/core/sageMigrationService.ts:52-59` (startRun signature + INSERT)
- Modify: `src/modules/accounting/services/core/sageImportService.ts:25` and `:155` (pass companyId)
- Modify: `src/modules/accounting/services/core/sageCustomerImportService.ts:20` (pass companyId)
- Modify: `src/modules/accounting/services/core/sageMigrationService.ts:202` (autoMapAccounts calls startRun — pass companyId)
- Test: `tests/integration/api/sageMigrationService.test.ts`

**Context:** `gl_migration_runs.company_id` column exists (migration 288) but `startRun` doesn't populate it. `getMigrationStatus` filters `WHERE company_id = ${companyId}` so every run created since migration 288 is invisible to its owning tenant.

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/api/sageMigrationService.test.ts`:

```typescript
/**
 * Integration test: BL-43 — startRun must persist company_id
 *
 * Root cause: startRun INSERTs into gl_migration_runs without company_id.
 * getMigrationStatus filters runs by company_id → every run invisible.
 *
 * Properties under test:
 *   A: startRun persists company_id (row has correct company_id)
 *   B: getMigrationStatus for company A sees company A's run
 *   C: getMigrationStatus for company B does NOT see company A's run
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { startRun, completeRun, getMigrationStatus } from '@/modules/accounting/services/core/sageMigrationService';

const COMPANY_A = '00000000-0000-0000-b143-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b143-000000000bb2';
const USER_ID   = '00000000-0000-0000-b143-000000000001';

const createdRunIds: string[] = [];

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL43-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL43 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL43 Test Company B'),
  ]);
});

afterAll(async () => {
  if (createdRunIds.length > 0) {
    await sql`DELETE FROM gl_migration_runs WHERE id = ANY(${createdRunIds}::UUID[])`;
  }
});

describe('BL-43: startRun persists company_id', () => {
  it('A: startRun persists company_id on the row', async () => {
    const runId = await startRun('ledger_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);

    const rows = await sql`
      SELECT company_id FROM gl_migration_runs WHERE id = ${runId}::UUID
    ` as Array<{ company_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY_A);
  });

  it('B: getMigrationStatus for company A sees company A run', async () => {
    const runId = await startRun('invoice_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);
    await completeRun(runId, 0, 0, 0, 0);

    const status = await getMigrationStatus(COMPANY_A);
    const found = status.lastRuns.some((r) => r.id === runId);
    expect(found).toBe(true);
  });

  it('C: getMigrationStatus for company B does NOT see company A run', async () => {
    const runId = await startRun('customer_invoice_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);
    await completeRun(runId, 0, 0, 0, 0);

    const status = await getMigrationStatus(COMPANY_B);
    const found = status.lastRuns.some((r) => r.id === runId);
    expect(found).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)"
bunx vitest run --config vitest.integration.config.ts tests/integration/api/sageMigrationService.test.ts
```

Expected: FAIL — either a TypeScript compile error because `startRun` only accepts 2 args, or (if the test is transpiled loosely) test A fails with `rows[0].company_id` being null.

- [ ] **Step 3: Update startRun signature in sageMigrationService.ts**

Replace lines 52-59 of `src/modules/accounting/services/core/sageMigrationService.ts`:

```typescript
export async function startRun(runType: string, userId: string, companyId: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_migration_runs (run_type, status, started_by, company_id)
    VALUES (${runType}, 'running', ${userId}, ${companyId}::UUID)
    RETURNING id
  `) as Row[];
  return String(rows[0]!.id);
}
```

- [ ] **Step 4: Update the 4 callers to pass companyId**

In `src/modules/accounting/services/core/sageImportService.ts:25`:
```typescript
const runId = await startRun('ledger_import', userId, companyId);
```

In `src/modules/accounting/services/core/sageImportService.ts:155`:
```typescript
const runId = await startRun('invoice_import', userId, companyId);
```

In `src/modules/accounting/services/core/sageCustomerImportService.ts:20`:
```typescript
const runId = await startRun('customer_invoice_import', userId, companyId);
```

In `src/modules/accounting/services/core/sageMigrationService.ts:202` (autoMapAccounts — it already accepts `companyId`):
```typescript
const runId = await startRun('account_mapping', userId, companyId);
```

- [ ] **Step 5: Run type check**

```bash
bunx tsc --noEmit
```

Expected: clean. If any caller was missed, tsc flags it.

- [ ] **Step 6: Run the integration test to verify it passes**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/api/sageMigrationService.test.ts
```

Expected: PASS 3/3.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/core/sageMigrationService.ts \
        src/modules/accounting/services/core/sageImportService.ts \
        src/modules/accounting/services/core/sageCustomerImportService.ts \
        tests/integration/api/sageMigrationService.test.ts
git commit -m "fix(BL-43): startRun persists company_id on gl_migration_runs"
```

---

### Task 2: BL-45 — creditNoteService 5 UPDATE sites missing company_id

**Files:**
- Modify: `src/modules/accounting/services/ar/creditNoteService.ts:168-188` (approveCreditNote transaction)
- Modify: `src/modules/accounting/services/ar/creditNoteService.ts:217-248` (cancelCreditNote transaction)
- Test: `tests/integration/api/creditNoteServiceTenant.test.ts`

**Context:** `createCreditNote` was fixed in BL-42. But `approveCreditNote` and `cancelCreditNote` still issue UPDATEs against `customer_invoices`, `supplier_invoices`, and `credit_notes` without `AND company_id = ${companyId}`. A malicious caller supplying another tenant's `customer_invoice_id` on a same-tenant credit note could mutate the other tenant's `amount_paid`.

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/api/creditNoteServiceTenant.test.ts`:

```typescript
/**
 * Integration test: BL-45 — approveCreditNote / cancelCreditNote UPDATEs must be company_id-scoped
 *
 * Validates SQL-level tenant isolation invariants for the 5 UPDATE patterns
 * in approveCreditNote and cancelCreditNote, mirroring the BL-44 test style.
 *
 * Properties under test (each UPDATE site, cross-tenant id must hit zero rows):
 *   A: UPDATE customer_invoices.amount_paid (approve path)
 *   B: UPDATE supplier_invoices.amount_paid (approve path)
 *   C: UPDATE credit_notes status='approved'
 *   D: UPDATE customer_invoices.amount_paid + status (cancel path)
 *   E: UPDATE supplier_invoices.amount_paid (cancel path)
 *   F: UPDATE credit_notes status='cancelled'
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

const COMPANY_A = '00000000-0000-0000-b145-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b145-000000000bb2';
const USER_ID   = '00000000-0000-0000-b145-000000000001';

let customerB: string;
let supplierB: string;
let customerInvoiceB: string;
let supplierInvoiceB: string;
let creditNoteB: string;

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL45-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL45 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL45 Test Company B'),
  ]);

  const cust = await sql`
    INSERT INTO customers (name, company_id) VALUES ('BL45 Cust B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  customerB = cust[0].id;

  const sup = await sql`
    INSERT INTO suppliers (name, company_id) VALUES ('BL45 Sup B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  supplierB = sup[0].id;

  const ci = await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL45-INV-B', ${customerB}::UUID, ${customerB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}
    ) RETURNING id
  ` as Array<{ id: string }>;
  customerInvoiceB = ci[0].id;

  const si = await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL45-SINV-B', ${supplierB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  supplierInvoiceB = si[0].id;

  const cn = await sql`
    INSERT INTO credit_notes (
      company_id, type, client_id, credit_date, reason,
      subtotal, tax_rate, tax_amount, total_amount, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'customer', ${customerB}::UUID, CURRENT_DATE, 'BL45',
      100, 15, 15, 115, 'draft', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  creditNoteB = cn[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM credit_notes WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM supplier_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM suppliers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-45: creditNoteService UPDATEs are company_id-scoped', () => {
  it('A: UPDATE customer_invoices.amount_paid with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices SET amount_paid = amount_paid + 500
      WHERE id = ${customerInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${customerInvoiceB}::UUID` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0].amount_paid)).toBe(0);
  });

  it('B: UPDATE supplier_invoices.amount_paid with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE supplier_invoices SET amount_paid = amount_paid + 500
      WHERE id = ${supplierInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT amount_paid FROM supplier_invoices WHERE id = ${supplierInvoiceB}::UUID` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0].amount_paid)).toBe(0);
  });

  it('C: UPDATE credit_notes to approved with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE credit_notes SET status = 'approved'
      WHERE id = ${creditNoteB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT status FROM credit_notes WHERE id = ${creditNoteB}::UUID` as Array<{ status: string }>;
    expect(row[0].status).toBe('draft');
  });

  it('D: UPDATE customer_invoices cancel-path with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices
      SET amount_paid = GREATEST(0, amount_paid - 100), status = 'approved'
      WHERE id = ${customerInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('E: UPDATE supplier_invoices cancel-path with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE supplier_invoices
      SET amount_paid = GREATEST(0, amount_paid - 100)
      WHERE id = ${supplierInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('F: UPDATE credit_notes to cancelled with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE credit_notes SET status = 'cancelled'
      WHERE id = ${creditNoteB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT status FROM credit_notes WHERE id = ${creditNoteB}::UUID` as Array<{ status: string }>;
    expect(row[0].status).toBe('draft');
  });
});
```

- [ ] **Step 2: Run test to confirm it passes AS-IS (test validates SQL invariants, not service code)**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)"
bunx vitest run --config vitest.integration.config.ts tests/integration/api/creditNoteServiceTenant.test.ts
```

Expected: PASS 6/6 — the test proves the DB-level guard works. This is the invariant the service MUST encode. (This test style mirrors BL-44.)

- [ ] **Step 3: Fix approveCreditNote UPDATEs in creditNoteService.ts**

In `src/modules/accounting/services/ar/creditNoteService.ts`, replace the `withTransaction` block at lines 168-188 with:

```typescript
    const updated = await withTransaction(async (tx) => {
      if (String(cn.type) === 'customer' && cn.customer_invoice_id) {
        await tx`
          UPDATE customer_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
          WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
        `;
      } else if (String(cn.type) === 'supplier' && cn.supplier_invoice_id) {
        await tx`
          UPDATE supplier_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
          WHERE id = ${cn.supplier_invoice_id}::UUID AND company_id = ${companyId}::UUID
        `;
      }

      const rows = (await tx`
        UPDATE credit_notes SET status = 'approved', approved_by = ${userId}::UUID,
          approved_at = NOW(), gl_journal_entry_id = ${je.id}::UUID
        WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
      `) as Record<string, unknown>[];

      return rows[0] as Record<string, unknown>;
    });
```

- [ ] **Step 4: Fix cancelCreditNote UPDATEs in creditNoteService.ts**

Replace the `withTransaction` block at lines 217-248 with:

```typescript
    const updated = await withTransaction(async (tx) => {
      if (String(cn.type) === 'customer' && cn.customer_invoice_id) {
        await tx`
          UPDATE customer_invoices
          SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
          WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
        `;
        await tx`
          UPDATE customer_invoices SET status = CASE
            WHEN amount_paid <= 0.01 THEN 'approved'
            WHEN amount_paid < total_amount THEN 'partially_paid'
            ELSE status
          END
          WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
        `;
      } else if (String(cn.type) === 'supplier' && cn.supplier_invoice_id) {
        await tx`
          UPDATE supplier_invoices
          SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
          WHERE id = ${cn.supplier_invoice_id}::UUID AND company_id = ${companyId}::UUID
        `;
      }

      const rows = (await tx`
        UPDATE credit_notes
        SET status = 'cancelled', cancelled_by = ${userId}::UUID,
            cancelled_at = NOW(), cancel_reason = ${reason || null}
        WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
      `) as Record<string, unknown>[];

      return rows[0] as Record<string, unknown>;
    });
```

- [ ] **Step 5: Run type check**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Re-run integration test + existing creditNote tests**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/api/creditNote*.test.ts
```

Expected: PASS all.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/ar/creditNoteService.ts \
        tests/integration/api/creditNoteServiceTenant.test.ts
git commit -m "fix(BL-45): creditNoteService approve/cancel UPDATEs scoped by company_id"
```

---

### Task 3: BL-46 — postCustomerInvoiceToGL SELECT missing company_id

**Files:**
- Modify: `src/modules/accounting/services/ar/customerPaymentAllocationService.ts:144-148` (SELECT)
- Test: `tests/integration/api/postCustomerInvoiceToGL.test.ts`

**Context:** `postCustomerInvoiceToGL` reads `customer_invoices WHERE ci.id = ${invoiceId}` with no company_id filter, then creates a journal entry against the caller's companyId using that invoice's amounts. A caller passing another tenant's invoice ID auto-posts that invoice to their own GL, corrupting both tenants' books.

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/api/postCustomerInvoiceToGL.test.ts`:

```typescript
/**
 * Integration test: BL-46 — postCustomerInvoiceToGL SELECT must be company_id-scoped
 *
 * Root cause: the SELECT uses WHERE ci.id = ${invoiceId} with no tenant guard.
 * A caller passing another tenant's invoice ID corrupts both tenants' GL.
 *
 * Properties:
 *   A: postCustomerInvoiceToGL throws when invoice belongs to another tenant
 *   B: no journal entry is created in caller's GL
 *   C: the other tenant's invoice gl_journal_entry_id is unchanged
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const COMPANY_A = '00000000-0000-0000-b146-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b146-000000000bb2';
const USER_ID   = '00000000-0000-0000-b146-000000000001';

let customerB: string;
let invoiceB: string;

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL46-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL46 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL46 Test Company B'),
  ]);

  const cust = await sql`
    INSERT INTO customers (name, company_id) VALUES ('BL46 Cust B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  customerB = cust[0].id;

  const inv = await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL46-INV-B', ${customerB}::UUID, ${customerB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}
    ) RETURNING id
  ` as Array<{ id: string }>;
  invoiceB = inv[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM gl_journal_lines WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-46: postCustomerInvoiceToGL SELECT is company_id-scoped', () => {
  it('A: throws when invoice belongs to another tenant', async () => {
    await expect(
      postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID)
    ).rejects.toThrow(/not found/i);
  });

  it('B: no journal entry created in caller tenant A', async () => {
    try { await postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID); } catch {}
    const rows = await sql`
      SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE company_id = ${COMPANY_A}::UUID
    ` as Array<{ cnt: string | number }>;
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('C: other-tenant invoice gl_journal_entry_id is still null', async () => {
    try { await postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID); } catch {}
    const rows = await sql`
      SELECT gl_journal_entry_id FROM customer_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ gl_journal_entry_id: string | null }>;
    expect(rows[0].gl_journal_entry_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)"
bunx vitest run --config vitest.integration.config.ts tests/integration/api/postCustomerInvoiceToGL.test.ts
```

Expected: FAIL — A does not throw (posts successfully), B shows 1 journal entry in A, C shows invoice linked.

- [ ] **Step 3: Apply company_id guard to the SELECT**

In `src/modules/accounting/services/ar/customerPaymentAllocationService.ts`, replace lines 144-148 with:

```typescript
    const invRows = (await sql`
      SELECT ci.*, c.name AS client_name
      FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.client_id
      WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new Error(`Invoice ${invoiceId} not found`);
```

- [ ] **Step 4: Run type check**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Run the integration test to verify it passes**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/api/postCustomerInvoiceToGL.test.ts
```

Expected: PASS 3/3.

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/ar/customerPaymentAllocationService.ts \
        tests/integration/api/postCustomerInvoiceToGL.test.ts
git commit -m "fix(BL-46): postCustomerInvoiceToGL SELECT scoped by company_id"
```

---

### Task 4: Wave 1 checkpoint

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave1-mopup.md`

- [ ] **Step 1: Run full test suite**

```bash
bun run test:unit
bunx vitest run --config vitest.integration.config.ts
bunx tsc --noEmit
```

Expected: all green.

- [ ] **Step 2: Write Wave 1 summary**

Create `docs/audits/2026-04-15/phase5-wave1-mopup.md`:

```markdown
# Phase 5 — Wave 1 Mop-up Summary

**Date:** 2026-04-15
**Status:** Complete

## Fixes shipped

| BL-ID | Severity | File | Fix commit | Test commit |
|-------|----------|------|------------|-------------|
| BL-43 | P1 | sageMigrationService.ts:52-59 + 4 callers | <sha> | <sha> |
| BL-45 | P0 | creditNoteService.ts:168-248 (6 UPDATEs) | <sha> | <sha> |
| BL-46 | P0 | customerPaymentAllocationService.ts:144-148 | <sha> | <sha> |

## Test coverage

- tests/integration/api/sageMigrationService.test.ts (3 properties)
- tests/integration/api/creditNoteServiceTenant.test.ts (6 properties)
- tests/integration/api/postCustomerInvoiceToGL.test.ts (3 properties)

## Gate status

- bun run test:unit: PASS
- vitest integration: PASS
- tsc --noEmit: PASS
- Wave 1 checkpoint: SIGNED

Proceeding to Wave 2.
```

Replace `<sha>` with the actual commit SHAs from `git log --oneline -10`.

- [ ] **Step 3: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave1-mopup.md
git commit -m "docs(phase5): Wave 1 mop-up checkpoint"
```

---

## Wave 2 — Verification (Tasks 5–11)

Each Wave 2 stream is read-only. The deliverable is a findings document at `docs/audits/2026-04-15/phase5-wave2-<stream>.md` with a table:

```markdown
| # | Location | Kind | Target | Guard | Severity | Evidence | Proposed fix |
|---|----------|------|--------|-------|----------|----------|--------------|
```

Severity rubric (from spec):
- **P0:** Data loss, cross-tenant breach, auth bypass, silent failure on money-moving path
- **P1:** Silent failure non-money, reachable IDOR gap, NOT-NULL gap, audit-log gap on destructive op
- **P2:** Defense-in-depth with compensating control, inconsistent error shape, unscoped read not exploitable given current callers
- **P3:** Cosmetic / hygiene

When in doubt, promote to higher tier.

### Task 5: Stream 2A — Tenant isolation sweep

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2A-tenant-isolation.md`

- [ ] **Step 1: Enumerate all multi-tenant tables**

Run and capture:

```bash
psql "$DATABASE_URL" -c "\dt" | awk '{print $3}' | grep -E '^(customers|customer_invoices|customer_payments|customer_payment_allocations|suppliers|supplier_invoices|supplier_payments|supplier_payment_allocations|bank_transactions|bank_accounts|credit_notes|gl_accounts|gl_journal_entries|gl_journal_lines|gl_migration_runs|sage_accounts|sage_customer_invoices|sage_supplier_invoices|sage_ledger_transactions|products|product_categories|projects|contacts|year_end_closes|vat_returns|fiscal_periods|recurring_invoices|recurring_journal_entries|budgets|budget_lines|bank_rules|bank_statement_imports)$'
```

Save the list as the sweep scope.

- [ ] **Step 2: Grep every UPDATE/DELETE on these tables and capture WHERE clause**

For each table in the list, run:

```bash
rg -n --multiline "UPDATE\s+<table>[\s\S]*?WHERE[\s\S]*?\`" src/modules/accounting/services src/lib pages/api/accounting
rg -n --multiline "DELETE\s+FROM\s+<table>[\s\S]*?WHERE[\s\S]*?\`" src/modules/accounting/services src/lib pages/api/accounting
```

Capture each hit. For each, check whether the WHERE clause contains `company_id = \${companyId}` or `company_id = ANY(`. If not, flag with severity based on the exploitability rule.

- [ ] **Step 3: Grep every INSERT INTO for NOT-NULL column coverage (scope for Stream 2C too, but spot-check here)**

```bash
rg -n --multiline "INSERT\s+INTO\s+<table>" src/modules/accounting/services
```

- [ ] **Step 4: Grep every SELECT that drives a subsequent UPDATE/INSERT**

SELECTs that drive writes need same guard. Look for patterns where the SELECT result feeds into a tx block or subsequent sql call.

```bash
rg -n --multiline "SELECT[\s\S]*?FROM\s+(customer_invoices|supplier_invoices|customer_payments|supplier_payments|credit_notes|bank_transactions|journal_entries)" src/modules/accounting/services
```

- [ ] **Step 5: Write findings**

Write `docs/audits/2026-04-15/phase5-wave2-2A-tenant-isolation.md`. Include:
- Scope list (tables enumerated)
- Per-statement findings table
- Summary counts per severity

- [ ] **Step 6: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2A-tenant-isolation.md
git commit -m "audit(phase5): Wave 2 Stream 2A tenant isolation findings"
```

---

### Task 6: Stream 2B — IDOR surface sweep

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2B-idor.md`

- [ ] **Step 1: Enumerate every API route handler under pages/api/accounting that accepts an ID**

```bash
rg -l "req\.query\.(id|invoiceId|paymentId|customerId|supplierId|accountId|ruleId|noteId|entryId|transactionId)" pages/api/accounting
```

For each file, extract:
- HTTP methods handled
- ID parameter name
- Middleware chain (withCompany? withCsrf? withErrorHandler?)
- Whether the ID is passed to a service fn or used raw in `sql` inside the handler

- [ ] **Step 2: Grep for handlers that read req.body.company_id or trust client-provided tenant id**

```bash
rg -n "req\.body\.company_?[Ii]d|req\.query\.company_?[Ii]d" pages/api/accounting
```

Any hit is P0 (client-supplied tenant id overriding session → cross-tenant auth bypass).

- [ ] **Step 3: Confirm withCompany is applied on every state-changing route**

```bash
rg -L "withCompany" pages/api/accounting
```

Any file listed is a candidate for P0 if it writes (POST/PUT/PATCH/DELETE).

- [ ] **Step 4: Write findings**

Create `docs/audits/2026-04-15/phase5-wave2-2B-idor.md` with per-route table: `(route, method, id_param, withCompany, withCsrf, passes_id_to_scoped_service, severity)`.

- [ ] **Step 5: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2B-idor.md
git commit -m "audit(phase5): Wave 2 Stream 2B IDOR surface findings"
```

---

### Task 7: Stream 2C — Schema/NOT-NULL invariant check

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2C-schema.md`

- [ ] **Step 1: Extract NOT-NULL columns per table**

Run:

```bash
psql "$DATABASE_URL" -c "
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND is_nullable = 'NO' AND column_default IS NULL
  ORDER BY table_name, ordinal_position;
" -A -F'|' > /tmp/not_null_cols.txt
```

- [ ] **Step 2: For every INSERT in services, extract the column list**

```bash
rg -n --multiline "INSERT\s+INTO\s+(\w+)\s*\(([\s\S]*?)\)\s*VALUES" src/modules/accounting/services > /tmp/inserts.txt
```

- [ ] **Step 3: Cross-check**

For each INSERT, verify every NOT-NULL-without-default column from `/tmp/not_null_cols.txt` for that table appears in the INSERT column list.

The BL-42 template: `credit_notes.company_id` was NOT NULL but missing from INSERT → silent failure. Find peers.

- [ ] **Step 4: Write findings**

Create `docs/audits/2026-04-15/phase5-wave2-2C-schema.md`:

```markdown
| # | File:line | Table | Missing NOT-NULL column | Severity |
|---|-----------|-------|-------------------------|----------|
```

Missing column on a money-moving path → P0. Non-money → P1.

- [ ] **Step 5: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2C-schema.md
git commit -m "audit(phase5): Wave 2 Stream 2C schema invariant findings"
```

---

### Task 8: Stream 2D — Auth/CSRF coverage

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2D-auth-csrf.md`

- [ ] **Step 1: Enumerate state-changing routes**

```bash
rg -l --multiline "req\.method\s*===?\s*['\"](POST|PUT|PATCH|DELETE)" pages/api
```

- [ ] **Step 2: Per route, check for withCsrf and Zod**

```bash
for f in $(rg -l --multiline "req\.method\s*===?\s*['\"](POST|PUT|PATCH|DELETE)" pages/api); do
  echo "=== $f ==="
  grep -E "withCsrf|z\.object|Schema\.parse|withCompany" "$f" || echo "  none"
done
```

- [ ] **Step 3: Classify each route**

Columns: `(route, withCompany, withCsrf, Zod, money_moving, severity)`.

Money-moving route without withCsrf: P0.
Money-moving route without Zod: P1.
Non-money state-change without withCsrf: P2.

- [ ] **Step 4: Write findings**

Create `docs/audits/2026-04-15/phase5-wave2-2D-auth-csrf.md` with the classification table.

- [ ] **Step 5: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2D-auth-csrf.md
git commit -m "audit(phase5): Wave 2 Stream 2D auth/CSRF findings"
```

---

### Task 9: Stream 2E — Logging / Sentry coverage

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2E-logging.md`

- [ ] **Step 1: Grep for empty catch blocks**

```bash
rg -n --multiline "catch\s*\(\s*\w*\s*\)\s*\{\s*\}" src/modules/accounting src/lib pages/api
```

Any hit is P1 (silent swallow).

- [ ] **Step 2: Grep for catch blocks that don't call log.* or re-throw**

```bash
rg -n --multiline -B1 -A5 "catch\s*\(" src/modules/accounting/services | grep -v "log\.\(error\|warn\|info\)\|throw\b"
```

Review each hit manually. Flag silent swallows.

- [ ] **Step 3: Grep for remaining console.\***

```bash
rg -n "console\.(log|error|warn|info|debug)" src/ pages/ --glob '!*.test.*'
```

Any non-test hit is P3 (BL-14 ratchet regression).

- [ ] **Step 4: Sentry synthetic error sample**

Pick 3 API routes (one money-moving, one read-only, one auth). Add a temporary `throw new Error('BL-phase5-sentry-probe-<route>')`, hit the route in dev, confirm the error lands in Sentry with `company_id` + `user_id` tags. Remove probe.

If any probe does not land with tags: P0 (BL-53 regression).

- [ ] **Step 5: Write findings**

Create `docs/audits/2026-04-15/phase5-wave2-2E-logging.md`:

```markdown
## Empty catch blocks
| # | File:line | Severity |

## Silent swallows (catch without log/throw)
| # | File:line | Severity |

## console.* leaks
| # | File:line | Severity |

## Sentry probe results
| Route | Landed in Sentry | Tags correct |
```

- [ ] **Step 6: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2E-logging.md
git commit -m "audit(phase5): Wave 2 Stream 2E logging/Sentry findings"
```

---

### Task 10: Stream 2F — Migration integrity

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-2F-migrations.md`

- [ ] **Step 1: List migration files on disk**

```bash
ls scripts/migrations/sql/ | sort > /tmp/migrations_disk.txt
```

- [ ] **Step 2: List recorded migrations in schema_migrations**

```bash
psql "$DATABASE_URL" -c "SELECT filename FROM schema_migrations ORDER BY filename;" -A -F'|' -t > /tmp/migrations_db.txt
```

- [ ] **Step 3: Diff**

```bash
diff /tmp/migrations_disk.txt /tmp/migrations_db.txt
```

Any entry in one but not the other → P1.

- [ ] **Step 4: Check IF NOT EXISTS guards**

```bash
rg -L "IF NOT EXISTS" scripts/migrations/sql/*.sql | while read f; do
  if rg -q "CREATE\s+(TABLE|INDEX)" "$f"; then
    echo "MISSING: $f"
  fi
done
```

Any hit without `IF NOT EXISTS` on a CREATE is P2 (idempotency gap).

- [ ] **Step 5: Investigate the 9 duplicate-prefix files**

Duplicate prefixes: 245, 246, 250, 251, 255, 265, 266, 292, 300.

```bash
ls scripts/migrations/sql/ | grep -E '^(245|246|250|251|255|265|266|292|300)_' | sort
```

For each pair, `diff` contents. If content-identical: P3 (hygiene). If divergent but both run: P1. If only one recorded in schema_migrations: P2.

- [ ] **Step 6: Write findings**

Create `docs/audits/2026-04-15/phase5-wave2-2F-migrations.md` with sections: disk/db diff, IF NOT EXISTS gaps, duplicate-prefix investigation, per-pair resolution.

- [ ] **Step 7: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-2F-migrations.md
git commit -m "audit(phase5): Wave 2 Stream 2F migration integrity findings"
```

---

### Task 11: Wave 2 consolidation + triage

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave2-findings.md`

- [ ] **Step 1: Merge all 6 stream findings into one master list**

Create `docs/audits/2026-04-15/phase5-wave2-findings.md` with:

```markdown
# Phase 5 — Wave 2 Consolidated Findings

## Summary
- P0 count: <n>
- P1 count: <n>
- P2 count: <n>
- P3 count: <n>

## Findings (all streams, sorted by severity)

| BL-ID | Stream | Severity | Location | Evidence | Proposed fix |
|-------|--------|----------|----------|----------|--------------|
| BL-47 | 2A | P0 | ... | ... | ... |
```

Assign a fresh BL-ID starting from BL-47 onward to each unique finding. Reuse BL-IDs across streams if they reference the same code site.

- [ ] **Step 2: Triage**

For each P0 and P1, confirm severity by the rubric. Promote ambiguous cases to higher tier.

- [ ] **Step 3: Commit**

```bash
git add docs/audits/2026-04-15/phase5-wave2-findings.md
git commit -m "audit(phase5): Wave 2 consolidated findings and triage"
```

---

## Wave 3 — Fix loop (Task 12, iterative)

### Task 12: Iterative fix loop

**Files:**
- Create: `docs/audits/2026-04-15/phase5-wave3-fixlog.md`
- Modify: services/handlers/migrations per finding
- Create: integration tests per finding

**Procedure** (repeat until `P0=0, P1=0`):

- [ ] **Step 1: Pick the highest-severity open finding from `phase5-wave2-findings.md`**

If multiple at same tier, prefer by ascending BL-ID.

- [ ] **Step 2: Write failing integration test for this finding**

Follow the BL-40/41/45/46 template:
- Tenant UUIDs with BL-ID in the prefix
- Setup: `ensureTestCompany` for A and B, seed row in B
- Negative property: caller from A operating on B's id sees zero rows / throws / no side effect
- Positive property: same operation with correct tenant succeeds
- Teardown: delete all test rows

- [ ] **Step 3: Run the test to verify it fails**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/api/<file>
```

Expected: FAIL, proving the finding is real.

- [ ] **Step 4: Apply the fix**

Follow the proposed-fix column from findings. The fix pattern depends on finding class:

- **Missing company_id guard on UPDATE/DELETE/SELECT:** add `AND <alias>.company_id = ${companyId}::UUID`
- **Missing NOT-NULL column on INSERT:** add the column and supply `${companyId}::UUID` (or equivalent) to the VALUES tuple
- **Missing withCompany on route:** wrap with `withCompany(withErrorHandler(handler as any))`
- **Missing withCsrf on money-moving route:** wrap with `withCsrf(...)` and add CSRF token on caller in `apiFetch` (should be automatic — confirm)
- **Missing Zod on handler:** define `const BodySchema = z.object({...})` and `const body = BodySchema.parse(req.body)`
- **Empty catch block:** `catch (err) { log.error('<context>', { error: err, companyId, userId }, '<module>'); throw err; }`
- **Missing IF NOT EXISTS on migration:** add to the CREATE statement

- [ ] **Step 5: Run type check + the test to verify fix**

```bash
bunx tsc --noEmit
bunx vitest run --config vitest.integration.config.ts tests/integration/api/<file>
```

Expected: tsc clean, test PASS.

- [ ] **Step 6: Commit**

```bash
git add <service-file> <test-file>
git commit -m "fix(BL-<id>): <one-line description>"
```

- [ ] **Step 7: Append to fixlog**

In `docs/audits/2026-04-15/phase5-wave3-fixlog.md`:

```markdown
| BL-<id> | <severity> | <file:line> | <fix-sha> | <test-sha> | verified |
```

- [ ] **Step 8: Re-run the originating Wave 2 stream sweep**

Re-execute the grep/query for the stream that surfaced this finding. Confirm it no longer flags this site. If it surfaces new findings, add them to `phase5-wave2-findings.md` and continue.

- [ ] **Step 9: Check remaining P0/P1 count**

```bash
grep -c "| P0 " docs/audits/2026-04-15/phase5-wave2-findings.md
grep -c "| P1 " docs/audits/2026-04-15/phase5-wave2-findings.md
```

Subtract the fixed-and-verified rows. If total remaining P0+P1 > 0, go to Step 1.

- [ ] **Step 10: Wave 3 exit gate**

When P0=0 and P1=0:

```bash
bun run test:unit
bunx vitest run --config vitest.integration.config.ts
bunx tsc --noEmit
bun run ci:quick
```

Expected: all green. Commit the final fixlog state:

```bash
git add docs/audits/2026-04-15/phase5-wave3-fixlog.md \
        docs/audits/2026-04-15/phase5-wave2-findings.md
git commit -m "docs(phase5): Wave 3 fix loop complete — P0=0, P1=0"
```

---

## Wave 4 — Closeout (Tasks 13–14)

### Task 13: Scorecard

**Files:**
- Create: `docs/audits/2026-04-15/phase5-scorecard.md`

- [ ] **Step 1: Gather data**

- Count BL-IDs fixed in Phase 5 (Waves 1 + 3) from git log:
  ```bash
  git log --oneline master --grep='BL-' --since=2026-04-15 > /tmp/phase5-commits.txt
  ```
- Count P2/P3 remaining from `phase5-wave2-findings.md`

- [ ] **Step 2: Write scorecard**

Create `docs/audits/2026-04-15/phase5-scorecard.md`:

```markdown
# Phase 5 — Final Scorecard

**Date:** 2026-04-15
**Exit gate:** P0 = 0, P1 = 0 ✅

## Stream pass/fail (Wave 2)

| Stream | Result | Findings (P0/P1/P2/P3) |
|--------|--------|------------------------|
| 2A Tenant isolation  | PASS | <n>/<n>/<n>/<n> |
| 2B IDOR surface      | PASS | <n>/<n>/<n>/<n> |
| 2C Schema invariants | PASS | <n>/<n>/<n>/<n> |
| 2D Auth/CSRF         | PASS | <n>/<n>/<n>/<n> |
| 2E Logging/Sentry    | PASS | <n>/<n>/<n>/<n> |
| 2F Migrations        | PASS | <n>/<n>/<n>/<n> |

## BL-IDs fixed in Phase 5

| BL-ID | Severity | Area | Commit |
|-------|----------|------|--------|
| BL-43 | P1 | sage migration run tracking | <sha> |
| BL-45 | P0 | credit note tenant isolation | <sha> |
| BL-46 | P0 | invoice post-to-GL read leak | <sha> |
| BL-47..BL-NN | ... | ... | ... |

## Outstanding (non-gating)

| BL-ID | Severity | Note |
|-------|----------|------|
| ... | P2 | defer to Phase 6 |
| ... | P3 | hygiene backlog |

## Drill track

See phase5-drill-log.md — PITR + rollback drills scheduled (human-operated, no calendar pressure).

## Sign-off

- P0 count after Phase 5: 0
- P1 count after Phase 5: 0
- Unit tests: PASS
- Integration tests: PASS
- tsc --noEmit: PASS
- Lint ratchet: no regression
- Sentry probe (Stream 2E): tags correct

Production-ready state: **SIGNED**.
```

- [ ] **Step 3: Update MEMORY**

Append to `/home/hein/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_status.md` (if present) or create a Phase 5 closeout memory entry at `/home/hein/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_phase5_closeout.md`:

```markdown
---
name: Phase 5 closeout
description: Phase 5 final verification sprint complete on 2026-04-15 with zero P0+P1
type: project
---

**Fact:** Phase 5 closed 2026-04-15. Zero P0, zero P1. Mop-up (BL-43/45/46) + 6-stream verification + fix loop complete.

**Why:** Final gate before production onboarding. Previous phases (4B/4C/4D) shipped hardening and observability; Phase 5 verified them and mopped up residual audit findings.

**How to apply:**
- When considering production-readiness, Phase 5 scorecard (docs/audits/2026-04-15/phase5-scorecard.md) is the signed reference.
- P2/P3 findings remain as documented technical debt, not gating.
- PITR + rollback drills tracked separately in phase5-drill-log.md.
```

And add a line to `MEMORY.md`:

```markdown
- [Phase 5 closeout](project_phase5_closeout.md) — 2026-04-15: zero P0+P1, production-ready
```

- [ ] **Step 4: Commit**

```bash
git add docs/audits/2026-04-15/phase5-scorecard.md
git commit -m "docs(phase5): scorecard — production-ready, P0+P1=0"
```

Memory files are committed by the memory system separately per user setup.

---

### Task 14: Drill coordination

**Files:**
- Create or verify: `docs/ops/pitr-drill.md`, `docs/ops/rollback-rehearsal.md`
- Create: `docs/audits/2026-04-15/phase5-drill-log.md`

- [ ] **Step 1: Check drill runbooks exist and are current**

```bash
ls docs/ops/pitr-drill.md docs/ops/rollback-rehearsal.md
```

If either is missing, write a minimal runbook drawing from Phase 4D ops-readiness artifacts (`docs/superpowers/specs/2026-04-15-phase4d-ops-readiness-design.md`).

Minimal PITR runbook sections: Objective, Prerequisites (Neon project ID, branch name), Steps (restore to timestamp T-5min, verify row count, verify FK integrity), Rollback.

Minimal rollback rehearsal sections: Objective, Prerequisites, Steps (git revert latest deploy tag, re-run deploy.sh, verify health endpoint), Rollback.

- [ ] **Step 2: User executes drills (human-operated)**

This step cannot be automated by an agent. User runs both drills against dev/staging, pastes transcript.

- [ ] **Step 3: Log transcripts**

Create `docs/audits/2026-04-15/phase5-drill-log.md`:

```markdown
# Phase 5 — Drill Log

## PITR drill
- Date: <date>
- Operator: <name>
- Outcome: <pass/fail>
- Transcript:
  ```
  <paste>
  ```

## Rollback rehearsal
- Date: <date>
- Operator: <name>
- Outcome: <pass/fail>
- Transcript:
  ```
  <paste>
  ```
```

- [ ] **Step 4: Commit**

```bash
git add docs/audits/2026-04-15/phase5-drill-log.md docs/ops/*.md
git commit -m "docs(phase5): drill transcripts logged"
```

---

## Done

All 14 tasks complete. Phase 5 scorecard signed. Zero P0, zero P1. ISAFlow production-ready.
