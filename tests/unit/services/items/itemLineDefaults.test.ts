/**
 * A document line may name a catalogue item (migration 1002): the item's purchases account is the default of a PO / bill
 * line, its sales account the default of an invoice / quote line; an account the line names wins; another company's,
 * deleted or inactive item refuses the line before the document's first write. The query names company_id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  ItemLineRefusal, applyItemDefaultsToAccountIdLines, applyItemDefaultsToSnakeLines, applyItemLineDefaults,
} from '@/modules/accounting/services/items/itemLineDefaults';

const COMPANY = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const SALES = '44444444-4444-4444-8444-444444444444';
const PURCH = '55555555-5555-4555-8555-555555555555';
const OWN = '66666666-6666-4666-8666-666666666666';
const label = (i: number) => `items[${i}]`;
const sqlMock = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;

/** The item read answers `items`; the account read answers every account asked for as active unless told otherwise. */
function db(items: Array<Record<string, unknown>>, accounts?: (ids: string[]) => Array<Record<string, unknown>>) {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: ReadonlyArray<string>, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM items')) return items;
    if (text.includes('FROM gl_accounts')) return accounts ? accounts(values[1] as string[]) : (values[1] as string[]).map((id) => ({ id, is_active: true }));
    return [];
  });
}
const item = (over: Record<string, unknown> = {}) => ({ id: ITEM, is_active: true, sales_account_id: SALES, purchases_account_id: PURCH, ...over });
const queryValues = () => sqlMock.mock.calls.flatMap((c: unknown[]) => c.slice(1));

beforeEach(() => db([item()]));

describe('applyItemLineDefaults', () => {
  it('reads nothing when no line names an item', async () => {
    const lines = [{ description: 'a', glAccountId: OWN }, { description: 'b' }];
    expect(await applyItemLineDefaults(COMPANY, lines, 'sales', label)).toEqual(lines);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('a sales line takes the SALES account and a purchase line the PURCHASES account', async () => {
    expect(await applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'sales', label)).toEqual([{ itemId: ITEM, glAccountId: SALES }]);
    expect(await applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'purchase', label)).toEqual([{ itemId: ITEM, glAccountId: PURCH }]);
  });

  it('an account the line names itself wins, and an item with no default account leaves the line open', async () => {
    expect(await applyItemLineDefaults(COMPANY, [{ itemId: ITEM, glAccountId: OWN }], 'sales', label)).toEqual([{ itemId: ITEM, glAccountId: OWN }]);
    db([item({ sales_account_id: null })]);
    expect((await applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'sales', label))[0]!.glAccountId).toBeUndefined();
  });

  it('refuses an item that is not this company\'s (the read is scoped, so it comes back empty), naming the line', async () => {
    db([]);
    await expect(applyItemLineDefaults(COMPANY, [{}, { itemId: ITEM }], 'sales', label)).rejects.toThrow(new ItemLineRefusal('items[1].item_id is not an item of your company'));
    expect(queryValues()).toContain(COMPANY);
    expect(sqlMock.mock.calls[0]![0].join('?')).toMatch(/company_id = \?::UUID/);
  });

  it('refuses an inactive item and a malformed id', async () => {
    db([item({ is_active: false })]);
    await expect(applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'sales', label)).rejects.toThrow(/items\[0\]\.item_id is an inactive item/);
    await expect(applyItemLineDefaults(COMPANY, [{ itemId: 'nope' }], 'sales', label)).rejects.toThrow(/must be a UUID/);
  });

  it('refuses a default account that is not an active account of this company, unless the line names its own', async () => {
    db([item()], () => []);
    await expect(applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'sales', label)).rejects.toThrow(/sales account is not an active account of your company/);
    db([item()], (ids) => ids.map((id) => ({ id, is_active: false })));
    await expect(applyItemLineDefaults(COMPANY, [{ itemId: ITEM }], 'purchase', label)).rejects.toThrow(/purchase account is not an active account/);
    expect(await applyItemLineDefaults(COMPANY, [{ itemId: ITEM, glAccountId: OWN }], 'sales', label)).toHaveLength(1);
  });

  it('carries the refusal code the MCP layer shows an agent', () => {
    expect(new ItemLineRefusal('x').code).toBe('ITEM_LINE_REFUSED');
  });
});

describe('the quote and PO adapters', () => {
  it('quote lines name the account accountId; PO PUT lines name it gl_account_id', async () => {
    expect(await applyItemDefaultsToAccountIdLines(COMPANY, [{ itemId: ITEM, description: 'd' }, { description: 'plain' }], 'sales', label))
      .toEqual([{ itemId: ITEM, accountId: SALES, description: 'd' }, { description: 'plain' }]);
    expect(await applyItemDefaultsToSnakeLines(COMPANY, [{ item_id: ITEM, quantity: 2 }, { quantity: 1 }], 'purchase', label))
      .toEqual([{ item_id: ITEM, gl_account_id: PURCH, quantity: 2 }, { quantity: 1 }]);
  });
});
