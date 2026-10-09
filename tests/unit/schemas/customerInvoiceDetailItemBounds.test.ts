/**
 * The draft edit's line schema (PUT customer-invoices-detail) holds a line to
 * what create accepts: quantity and price within their numeric(…, 2) columns
 * (a quantity that stores as 0.00 refused), and a discount of at most two
 * places — what the edit page can read back exactly (invoiceLineAmount.ts).
 * Past these bounds the edit used to answer 500 (numeric field overflow).
 */
import { describe, it, expect } from 'vitest';
import { PutItemSchema } from '@/lib/schemas/customerInvoiceDetail';

const line = (over: Record<string, unknown>) => PutItemSchema.safeParse({ description: 'X', quantity: 1, unitPrice: 10, ...over });

describe('PutItemSchema bounds', () => {
  it.each([
    [{ quantity: 0.01 }], [{ quantity: 99999999.99 }], [{ unitPrice: 0 }], [{ unitPrice: 9999999999999.99 }],
    [{ discount: 12.34 }], [{ discount: 0 }], [{ discount: 100 }], [{}],
  ])('accepts %j', (over) => expect(line(over).success).toBe(true));

  it.each([
    [{ quantity: 0.004 }], [{ quantity: 1e8 }], [{ quantity: 0 }], [{ unitPrice: 1e13 }], [{ unitPrice: -1 }],
    [{ discount: 12.345 }], [{ discount: 87.2574374 }], [{ discount: -1 }], [{ discount: 100.01 }], [{ discount: '10' }],
  ])('refuses %j', (over) => expect(line(over).success).toBe(false));
});
