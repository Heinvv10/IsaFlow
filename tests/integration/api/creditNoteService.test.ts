/**
 * Integration test: BL-42 — createCreditNote INSERT requires company_id
 *
 * Root cause: `createCreditNote` INSERT into credit_notes omitted company_id.
 * credit_notes.company_id is NOT NULL in DB → every call threw NotNullViolation.
 * Error bubbled up (not swallowed) so the feature is visibly broken rather than
 * silent, but no integration test existed to catch it.
 *
 * Properties under test:
 *   A: INSERT into credit_notes with company_id succeeds (was throwing pre-BL-42)
 *   B: INSERT into credit_notes WITHOUT company_id fails with NOT NULL violation
 *      (schema invariant guard — if this ever stops failing, company_id has
 *       been made nullable and this test should be revisited)
 *   C: Row created via createCreditNote is scoped to the expected company_id
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  validateCreditNoteLinks,
  findOpenDuplicateDraft,
} from '@/modules/accounting/services/ar/creditNoteLinkService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-b142-000000000aa1';
const USER_ID   = '00000000-0000-0000-b142-000000000001';

// ── State ─────────────────────────────────────────────────────────────────────

let customerA: string;
let supplierA: string;
let createdIds: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL42-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createCustomer(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customers (name, company_id)
    VALUES ('BL42 Test Customer', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createSupplier(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO suppliers (name, company_id)
    VALUES ('BL42 Test Supplier', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureTestCompany(COMPANY_A, 'BL42 Test Company A');
  customerA = await createCustomer(COMPANY_A);
  supplierA = await createSupplier(COMPANY_A);
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await sql`
      DELETE FROM credit_notes WHERE id = ANY(${createdIds}::UUID[])
    `;
  }
  await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY_A}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${COMPANY_A}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY_A}::UUID`;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BL-42: createCreditNote supplies company_id', () => {
  /**
   * A: The FIXED createCreditNote now includes company_id in INSERT.
   * Must succeed (previously threw NOT NULL violation on every call).
   */
  it('A: createCreditNote succeeds (was throwing pre-BL-42)', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      {
        type: 'customer',
        clientId: customerA,
        creditDate: '2026-04-15',
        reason: 'BL-42 integration test',
        subtotal: 100,
        taxRate: 15,
      },
      USER_ID,
    );

    expect(cn).toBeDefined();
    expect(cn.id).toBeDefined();
    createdIds.push(cn.id);
  });

  /**
   * B: Schema invariant guard. INSERT without company_id must throw.
   * If this ever passes, credit_notes.company_id has been made nullable
   * and we need to reassess the tenant isolation model.
   */
  it('B: raw INSERT into credit_notes WITHOUT company_id throws NOT NULL violation', async () => {
    await expect(sql`
      INSERT INTO credit_notes (
        type, client_id, credit_date, reason, subtotal, tax_rate, tax_amount, total_amount, created_by
      ) VALUES (
        'customer', ${customerA}::UUID, '2026-04-15', 'BL-42 schema guard',
        100, 15, 15, 115, ${USER_ID}::UUID
      )
    `).rejects.toThrow(/null value in column "company_id"|violates not-null/i);
  });

  /**
   * C: The row created via createCreditNote is scoped to the expected tenant.
   */
  it('C: created credit_note row has company_id = calling company', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      {
        type: 'customer',
        clientId: customerA,
        creditDate: '2026-04-15',
        reason: 'BL-42 scope check',
        subtotal: 50,
        taxRate: 15,
      },
      USER_ID,
    );
    createdIds.push(cn.id);

    const rows = await sql`
      SELECT company_id FROM credit_notes WHERE id = ${cn.id}::UUID
    ` as Array<{ company_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY_A);
  });
});


/**
 * credit_notes.supplier_id is a UUID referencing suppliers(id) (migration 202).
 * createCreditNote used to interpolate `Number(input.supplierId)`, so every real
 * supplier UUID became NaN and Postgres refused the INSERT outright with
 * `invalid input syntax for type uuid: "NaN"`. This runs against the real
 * database precisely because the bug lived in the driver's type handling — a
 * mocked sql tag would have accepted NaN happily, which is why the existing
 * unit suite never caught it.
 */
describe('createCreditNote — supplier credit notes reach the table with their supplier', () => {
  it('creates a supplier credit note carrying a real supplier UUID', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      {
        type: 'supplier',
        supplierId: supplierA,
        creditDate: '2026-04-15',
        reason: 'supplier uuid regression',
        subtotal: 200,
        taxRate: 15,
      },
      USER_ID,
    );
    createdIds.push(cn.id);

    // Read the stored value back rather than trusting the mapped return: the
    // point of the bug was what reached the column.
    const rows = await sql`
      SELECT supplier_id, type, total_amount FROM credit_notes WHERE id = ${cn.id}::UUID
    ` as Array<{ supplier_id: string; type: string; total_amount: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].supplier_id).toBe(supplierA);
    expect(rows[0].type).toBe('supplier');
    expect(Number(rows[0].total_amount)).toBeCloseTo(230, 2);
  });
});

/**
 * The link validation is the only fence between an agent-supplied UUID and a
 * cross-tenant document — no (id, company_id) constraint exists on any of these
 * foreign keys, and createCreditNote re-reads none of them.
 */
describe('validateCreditNoteLinks — tenant and counterparty fences', () => {
  const OTHER_COMPANY = '00000000-0000-0000-b142-000000000aa2';

  it('accepts a customer and a supplier that belong to the calling company', async () => {
    expect(await validateCreditNoteLinks(COMPANY_A, { type: 'customer', clientId: customerA })).toBeNull();
    expect(await validateCreditNoteLinks(COMPANY_A, { type: 'supplier', supplierId: supplierA })).toBeNull();
  });

  it('refuses a customer belonging to another company with the generic miss text', async () => {
    expect(await validateCreditNoteLinks(OTHER_COMPANY, { type: 'customer', clientId: customerA }))
      .toBe('Not found');
    expect(await validateCreditNoteLinks(OTHER_COMPANY, { type: 'supplier', supplierId: supplierA }))
      .toBe('Not found');
  });

  it('requires the counterparty that matches the note type', async () => {
    expect(await validateCreditNoteLinks(COMPANY_A, { type: 'customer' }))
      .toContain('client_id is required');
    expect(await validateCreditNoteLinks(COMPANY_A, { type: 'supplier' }))
      .toContain('supplier_id is required');
  });
});


/**
 * The tenant + counterparty fence must live in createCreditNote, not in one of
 * its callers. It was originally added to the MCP tool only, which left
 * POST /api/accounting/credit-notes — which passes its request body straight
 * through — able to create a note pointing at another company's customer.
 */
describe('createCreditNote — the tenant fence is in the service, so every caller inherits it', () => {
  const OTHER_COMPANY = '00000000-0000-0000-b142-000000000aa2';

  it('refuses a customer belonging to another company', async () => {
    await expect(createCreditNote(
      OTHER_COMPANY,
      { type: 'customer', clientId: customerA, creditDate: '2026-04-15', subtotal: 100 },
      USER_ID,
    )).rejects.toThrow('Not found');
  });

  it('refuses a supplier belonging to another company', async () => {
    await expect(createCreditNote(
      OTHER_COMPANY,
      { type: 'supplier', supplierId: supplierA, creditDate: '2026-04-15', subtotal: 100 },
      USER_ID,
    )).rejects.toThrow('Not found');
  });

  it('refuses a customer note with no client_id at all', async () => {
    await expect(createCreditNote(
      COMPANY_A,
      { type: 'customer', creditDate: '2026-04-15', subtotal: 100 },
      USER_ID,
    )).rejects.toThrow('client_id is required');
  });
});


/**
 * The dedupe predicate has to run against a real database: it leans on
 * IS NOT DISTINCT FROM for the four nullable link columns, which a mock cannot
 * exercise, and NULL = NULL would silently match nothing.
 */
describe('findOpenDuplicateDraft', () => {
  it('matches an identical draft, and only an identical one', async () => {
    const base = {
      type: 'customer' as const,
      clientId: customerA,
      creditDate: '2026-05-01',
      subtotal: 100,
      taxRate: 15,
    };
    const cn = await createCreditNote(COMPANY_A, base, USER_ID);
    createdIds.push(cn.id);

    const key = { type: base.type, clientId: customerA, creditDate: base.creditDate };

    // Same everything -> found.
    expect(await findOpenDuplicateDraft(COMPANY_A, key, 115)).toBe(cn.id);

    // Different amount, date, tenant or counterparty -> not found.
    expect(await findOpenDuplicateDraft(COMPANY_A, key, 116)).toBeNull();
    expect(await findOpenDuplicateDraft(COMPANY_A, { ...key, creditDate: '2026-05-02' }, 115)).toBeNull();
    expect(await findOpenDuplicateDraft('00000000-0000-0000-b142-000000000aa2', key, 115)).toBeNull();
    expect(await findOpenDuplicateDraft(COMPANY_A, { ...key, clientId: undefined }, 115)).toBeNull();

    // A note carrying an invoice link is NOT the same as one without: the
    // nullable columns are compared with IS NOT DISTINCT FROM precisely so the
    // absent case is a real value rather than an unknown that matches nothing.
    expect(await findOpenDuplicateDraft(
      COMPANY_A, { ...key, customerInvoiceId: '00000000-0000-4000-8000-000000000123' }, 115,
    )).toBeNull();
  });

  /**
   * The case IS NOT DISTINCT FROM exists for. A supplier note leaves client_id
   * and customer_invoice_id NULL, and plain `client_id = NULL` evaluates to
   * NULL — never true — so an `=` comparison finds no supplier duplicate at
   * all, silently. Mutating the operator makes only THIS test fail.
   */
  it('matches a supplier draft, whose customer columns are NULL', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      { type: 'supplier', supplierId: supplierA, creditDate: '2026-05-04', subtotal: 300, taxRate: 15 },
      USER_ID,
    );
    createdIds.push(cn.id);

    expect(await findOpenDuplicateDraft(
      COMPANY_A,
      { type: 'supplier', supplierId: supplierA, creditDate: '2026-05-04' },
      345,
    )).toBe(cn.id);
  });

  it('ignores notes that are no longer drafts', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      { type: 'customer', clientId: customerA, creditDate: '2026-05-03', subtotal: 200, taxRate: 15 },
      USER_ID,
    );
    createdIds.push(cn.id);
    const key = { type: 'customer' as const, clientId: customerA, creditDate: '2026-05-03' };
    expect(await findOpenDuplicateDraft(COMPANY_A, key, 230)).toBe(cn.id);

    await sql`UPDATE credit_notes SET status = 'approved' WHERE id = ${cn.id}::UUID`;
    expect(await findOpenDuplicateDraft(COMPANY_A, key, 230)).toBeNull();
  });
});
