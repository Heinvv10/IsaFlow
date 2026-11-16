/**
 * WP2 row 13: the VAT codes a bank allocation may carry are ONE set — the service's, the MCP tools' and the
 * routes' — and anything else is refused (BankAllocationRefusal, 400) instead of posting the gross.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOCATION_VAT_CODES, assertAllocationVatCode, isAllocationVatCode,
} from '@/modules/accounting/services/bank/bankVatCodes';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { VAT_CODES } from '@/lib/mcp/tools/allocationLine';

const ROOT = resolve(__dirname, '../../../..');

describe('bank allocation VAT codes', () => {
  it('are the same four the MCP tools and the allocate routes accept', () => {
    expect([...ALLOCATION_VAT_CODES].sort()).toEqual([...VAT_CODES].sort());
    // The split route's enum and the rule routes' enum name the same four.
    for (const route of ['pages/api/accounting/bank-transactions-action.ts', 'pages/api/accounting/bank-rules.ts']) {
      expect(readFileSync(resolve(ROOT, route), 'utf8'), route).toContain("z.enum(['none', 'standard', 'zero_rated', 'exempt'])");
    }
  });

  it('passes every known code and an absent one', () => {
    for (const code of [...ALLOCATION_VAT_CODES, undefined, null]) {
      expect(() => assertAllocationVatCode(code, 'x'), String(code)).not.toThrow();
    }
  });

  it.each(['STANDARD', 'std', '', 'no_vat', '15-VAT', ' standard'])('refuses %j as a typed allocation refusal', (code) => {
    expect(isAllocationVatCode(code)).toBe(false);
    let thrown: unknown;
    try { assertAllocationVatCode(code, 'This allocation'); } catch (e) { thrown = e; }
    expect(isBankAllocationRefusal(thrown)).toBe(true);
    expect((thrown as Error).message).toBe(
      `This allocation: unknown VAT code "${code}" — use one of none, standard, zero_rated, exempt. Nothing was posted.`,
    );
  });
});
