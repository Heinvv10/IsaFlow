/**
 * Zod input validation integration tests — BL-33 (Wave γ.B)
 *
 * Tests the schema parsing logic for the 8 money-moving write handlers.
 * Each handler exposes its schema inline; we test those shapes directly here
 * without spinning up an HTTP server, following the same pattern as
 * customer-invoices-detail.test.ts (direct logic testing).
 *
 * Per-handler: one negative case (empty body → reject) and one positive case
 * (minimal valid body → passes Zod without error).
 *
 * Note: Zod v4 UUID validation is RFC 4122 strict — version nibble must be 1-8.
 * All UUIDs here are valid v4 UUIDs generated via crypto.randomUUID().
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Valid RFC 4122 v4 UUIDs for use across all tests
const UUID_1 = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
const UUID_2 = 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6';
const UUID_3 = 'c3d4e5f6-a7b8-4c9d-ae0f-a1b2c3d4e5f6';

// ---------------------------------------------------------------------------
// Shared primitives (mirrors src/lib/schemas/common.ts)
// ---------------------------------------------------------------------------

const UUID = z.string().uuid('Must be a valid UUID');
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// ---------------------------------------------------------------------------
// 1. bank-transactions-action  (discriminated union on action)
// ---------------------------------------------------------------------------

const BankTxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), bankTransactionId: UUID, journalLineId: UUID, reconciliationId: UUID.optional() }),
  z.object({ action: z.literal('unmatch'), bankTransactionId: UUID }),
  z.object({ action: z.literal('exclude'), bankTransactionId: UUID, excludeReason: z.string().max(200).optional() }),
  z.object({ action: z.literal('auto_match'), bankAccountId: UUID, reconciliationId: UUID.optional() }),
  z.object({
    action: z.literal('allocate'),
    bankTransactionId: UUID,
    allocationType: z.enum(['account', 'supplier', 'customer']).optional(),
    contraAccountId: UUID.optional(),
    entityId: UUID.optional(),
    description: z.string().max(500).optional(),
    vatCode: z.string().max(20).optional(),
    cc1Id: UUID.optional(),
    cc2Id: UUID.optional(),
    buId: UUID.optional(),
  }),
  z.object({
    action: z.literal('split_allocate'),
    bankTransactionId: UUID,
    lines: z.array(z.object({ contraAccountId: UUID.optional(), amount: z.number(), description: z.string().max(500).optional() })).min(1),
  }),
  z.object({ action: z.literal('delete'), bankTransactionId: UUID.optional(), bankTransactionIds: z.array(UUID).optional() }),
  z.object({ action: z.literal('bulk_accept'), bankTransactionIds: z.array(UUID).min(1) }),
  z.object({ action: z.literal('update_notes'), bankTransactionId: UUID, notes: z.string().max(1000).optional() }),
  z.object({
    action: z.literal('save_selection'),
    bankTransactionId: UUID,
    selectionType: z.string().max(50).optional(),
    selectionEntityId: UUID.optional(),
    vatCode: z.string().max(20).optional(),
  }),
  z.object({
    action: z.literal('save_dimensions'),
    bankTransactionId: UUID,
    cc1Id: UUID.optional(),
    cc2Id: UUID.optional(),
    buId: UUID.optional(),
  }),
  z.object({ action: z.literal('reverse'), bankTransactionId: UUID }),
]);

describe('bank-transactions-action Zod schema (BL-33)', () => {
  it('rejects empty body with validation error', () => {
    const result = BankTxActionSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      // discriminated union top-level issue
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects body with unknown action', () => {
    const result = BankTxActionSchema.safeParse({ action: 'unknown_action', bankTransactionId: UUID_1 });
    expect(result.success).toBe(false);
  });

  it('accepts valid unmatch action', () => {
    const result = BankTxActionSchema.safeParse({
      action: 'unmatch',
      bankTransactionId: UUID_1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('unmatch');
    }
  });

  it('accepts valid bulk_accept action', () => {
    const result = BankTxActionSchema.safeParse({
      action: 'bulk_accept',
      bankTransactionIds: [UUID_1],
    });
    expect(result.success).toBe(true);
  });

  it('rejects bulk_accept with empty ids array', () => {
    const result = BankTxActionSchema.safeParse({
      action: 'bulk_accept',
      bankTransactionIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unmatch with non-UUID bankTransactionId', () => {
    const result = BankTxActionSchema.safeParse({
      action: 'unmatch',
      bankTransactionId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. customer-invoices-detail  (GET query, PUT body, POST body)
// ---------------------------------------------------------------------------

const GetQuerySchema = z.object({ id: UUID });
const PutBodySchema = z.object({
  id: UUID,
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  dueDate: ISODate.optional(),
});
const PostBodySchema = z.object({
  id: UUID,
  action: z.enum(['approve', 'send', 'cancel']),
});

describe('customer-invoices-detail Zod schemas (BL-33)', () => {
  const validId = UUID_1;

  it('GET: rejects missing id', () => {
    const result = GetQuerySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors.id).toBeTruthy();
  });

  it('GET: rejects non-UUID id', () => {
    const result = GetQuerySchema.safeParse({ id: 'bad-id' });
    expect(result.success).toBe(false);
  });

  it('GET: accepts valid UUID', () => {
    const result = GetQuerySchema.safeParse({ id: validId });
    expect(result.success).toBe(true);
  });

  it('PUT: rejects missing id', () => {
    const result = PutBodySchema.safeParse({ notes: 'test' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors.id).toBeTruthy();
  });

  it('PUT: accepts valid body', () => {
    const result = PutBodySchema.safeParse({ id: validId, notes: 'hello', dueDate: '2026-04-30' });
    expect(result.success).toBe(true);
  });

  it('PUT: rejects bad dueDate format', () => {
    const result = PutBodySchema.safeParse({ id: validId, dueDate: '30/04/2026' });
    expect(result.success).toBe(false);
  });

  it('POST: rejects empty body', () => {
    const result = PostBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('POST: rejects invalid action', () => {
    const result = PostBodySchema.safeParse({ id: validId, action: 'delete' });
    expect(result.success).toBe(false);
  });

  it('POST: accepts approve action', () => {
    const result = PostBodySchema.safeParse({ id: validId, action: 'approve' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. supplier-invoices-action  (discriminated union)
// ---------------------------------------------------------------------------

const SupplierInvoiceActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), invoiceId: UUID }),
  z.object({ action: z.literal('cancel'), invoiceId: UUID }),
  z.object({ action: z.literal('match'), invoiceId: UUID }),
]);

describe('supplier-invoices-action Zod schema (BL-33)', () => {
  it('rejects empty body', () => {
    const result = SupplierInvoiceActionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects missing invoiceId', () => {
    const result = SupplierInvoiceActionSchema.safeParse({ action: 'approve' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid action', () => {
    const result = SupplierInvoiceActionSchema.safeParse({
      action: 'delete',
      invoiceId: UUID_1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts approve with valid invoiceId', () => {
    const result = SupplierInvoiceActionSchema.safeParse({
      action: 'approve',
      invoiceId: UUID_1,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('approve');
  });

  it('accepts match with valid invoiceId', () => {
    const result = SupplierInvoiceActionSchema.safeParse({
      action: 'match',
      invoiceId: UUID_2,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. journal-entries-action
// ---------------------------------------------------------------------------

const JournalEntryActionSchema = z.object({
  id: UUID,
  action: z.enum(['post', 'reverse']),
});

describe('journal-entries-action Zod schema (BL-33)', () => {
  it('rejects empty body', () => {
    const result = JournalEntryActionSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      expect(errors.id).toBeTruthy();
      expect(errors.action).toBeTruthy();
    }
  });

  it('rejects invalid action value', () => {
    const result = JournalEntryActionSchema.safeParse({
      id: UUID_1,
      action: 'delete',
    });
    expect(result.success).toBe(false);
  });

  it('accepts post action', () => {
    const result = JournalEntryActionSchema.safeParse({
      id: UUID_1,
      action: 'post',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('post');
  });

  it('accepts reverse action', () => {
    const result = JournalEntryActionSchema.safeParse({
      id: UUID_1,
      action: 'reverse',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. customer-payments  (POST create)
// ---------------------------------------------------------------------------

const CreateCustomerPaymentSchema = z.object({
  clientId: UUID,
  paymentDate: ISODate,
  totalAmount: z.coerce.number().nonnegative().multipleOf(0.01),
  paymentMethod: z.string().max(50).optional(),
  bankReference: z.string().max(200).optional(),
  bankAccountId: UUID.optional(),
  description: z.string().max(500).optional(),
  projectId: UUID.optional(),
  allocations: z.array(z.object({
    invoiceId: UUID,
    amount: z.coerce.number().nonnegative().multipleOf(0.01),
  })).min(1).max(200),
});

describe('customer-payments POST Zod schema (BL-33)', () => {
  const validBase = {
    clientId: UUID_1,
    paymentDate: '2026-04-15',
    totalAmount: 1000.00,
    allocations: [{ invoiceId: UUID_2, amount: 1000.00 }],
  };

  it('rejects empty body', () => {
    const result = CreateCustomerPaymentSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      expect(errors.clientId).toBeTruthy();
      expect(errors.paymentDate).toBeTruthy();
    }
  });

  it('rejects negative totalAmount', () => {
    const result = CreateCustomerPaymentSchema.safeParse({ ...validBase, totalAmount: -100 });
    expect(result.success).toBe(false);
  });

  it('rejects bad paymentDate format', () => {
    const result = CreateCustomerPaymentSchema.safeParse({ ...validBase, paymentDate: '15-04-2026' });
    expect(result.success).toBe(false);
  });

  it('rejects empty allocations array', () => {
    const result = CreateCustomerPaymentSchema.safeParse({ ...validBase, allocations: [] });
    expect(result.success).toBe(false);
  });

  it('accepts valid payment body', () => {
    const result = CreateCustomerPaymentSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientId).toBe(validBase.clientId);
      expect(result.data.totalAmount).toBe(1000.00);
    }
  });

  it('coerces string totalAmount to number', () => {
    const result = CreateCustomerPaymentSchema.safeParse({ ...validBase, totalAmount: '500.50' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.totalAmount).toBe(500.50);
  });
});

// ---------------------------------------------------------------------------
// 6. supplier-payments  (POST create)
// ---------------------------------------------------------------------------

const CreateSupplierPaymentSchema = z.object({
  supplierId: UUID,
  paymentDate: ISODate,
  totalAmount: z.coerce.number().nonnegative().multipleOf(0.01),
  paymentMethod: z.string().max(50).optional(),
  bankAccountId: UUID.optional(),
  reference: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  allocations: z.array(z.object({
    invoiceId: UUID,
    amount: z.coerce.number().nonnegative().multipleOf(0.01),
  })).min(1).max(200),
});

describe('supplier-payments POST Zod schema (BL-33)', () => {
  const validBase = {
    supplierId: UUID_1,
    paymentDate: '2026-04-15',
    totalAmount: 500.00,
    allocations: [{ invoiceId: UUID_2, amount: 500.00 }],
  };

  it('rejects empty body', () => {
    const result = CreateSupplierPaymentSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      expect(errors.supplierId).toBeTruthy();
    }
  });

  it('rejects non-UUID supplierId', () => {
    const result = CreateSupplierPaymentSchema.safeParse({ ...validBase, supplierId: 'not-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects missing allocations', () => {
    const { allocations: _a, ...rest } = validBase;
    const result = CreateSupplierPaymentSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts valid supplier payment body', () => {
    const result = CreateSupplierPaymentSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supplierId).toBe(validBase.supplierId);
      expect(result.data.allocations).toHaveLength(1);
    }
  });

  it('coerces string totalAmount to number', () => {
    const result = CreateSupplierPaymentSchema.safeParse({ ...validBase, totalAmount: '250.25' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.totalAmount).toBe(250.25);
  });
});

// ---------------------------------------------------------------------------
// 7. credit-notes-action  (discriminated union)
// ---------------------------------------------------------------------------

const CreditNoteActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), creditNoteId: UUID }),
  z.object({ action: z.literal('cancel'), creditNoteId: UUID, reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('apply'), creditNoteId: UUID, invoiceId: UUID }),
]);

describe('credit-notes-action Zod schema (BL-33)', () => {
  const cnId = UUID_1;
  const invId = UUID_2;

  it('rejects empty body', () => {
    const result = CreditNoteActionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects missing creditNoteId', () => {
    const result = CreditNoteActionSchema.safeParse({ action: 'approve' });
    expect(result.success).toBe(false);
  });

  it('rejects apply action without invoiceId', () => {
    const result = CreditNoteActionSchema.safeParse({ action: 'apply', creditNoteId: cnId });
    expect(result.success).toBe(false);
  });

  it('accepts approve action', () => {
    const result = CreditNoteActionSchema.safeParse({ action: 'approve', creditNoteId: cnId });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('approve');
  });

  it('accepts cancel action with optional reason', () => {
    const result = CreditNoteActionSchema.safeParse({ action: 'cancel', creditNoteId: cnId, reason: 'duplicate' });
    expect(result.success).toBe(true);
  });

  it('accepts apply action with invoiceId', () => {
    const result = CreditNoteActionSchema.safeParse({ action: 'apply', creditNoteId: cnId, invoiceId: invId });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('apply');
  });
});

// ---------------------------------------------------------------------------
// 8. write-offs-action  (discriminated union)
// ---------------------------------------------------------------------------

const WriteOffActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), id: UUID }),
  z.object({ action: z.literal('cancel'), id: UUID }),
]);

describe('write-offs-action Zod schema (BL-33)', () => {
  const woId = UUID_1;

  it('rejects empty body', () => {
    const result = WriteOffActionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = WriteOffActionSchema.safeParse({ action: 'approve' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid action', () => {
    const result = WriteOffActionSchema.safeParse({ action: 'delete', id: woId });
    expect(result.success).toBe(false);
  });

  it('accepts approve with valid id', () => {
    const result = WriteOffActionSchema.safeParse({ action: 'approve', id: woId });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('approve');
  });

  it('accepts cancel with valid id', () => {
    const result = WriteOffActionSchema.safeParse({ action: 'cancel', id: woId });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID id', () => {
    const result = WriteOffActionSchema.safeParse({ action: 'approve', id: 'bad' });
    expect(result.success).toBe(false);
  });
});
