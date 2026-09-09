import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '@/lib/mcp/inputValidation';
import { clampLimit } from '@/lib/mcp/tools/toolHelpers';
import { MCP_INPUT_COMPATIBILITY } from '@/lib/mcp/inputCompatibility';
import type { McpTool } from '@/lib/mcp/types';

function tool(properties: Record<string, unknown>, extra: Partial<McpTool> = {}): McpTool {
  return { name: 'test_tool', description: '', scope: null, write: false,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    handler: async () => { throw new Error('Validator must never run a handler'); }, ...extra };
}
const number = { type: 'number', minimum: 0, maximum: 100 };
const line = { type: 'object', properties: { amount: number, kind: { type: 'string', enum: ['bank', 'cash'] } },
  required: ['amount', 'kind'], additionalProperties: false };
const batch = tool({ lines: { type: 'array', items: line, minItems: 1, maxItems: 2 } });
const write = tool({ idempotency_key: { type: 'string' } }, { write: true });

describe('bounded schema validation before any handler', () => {
  it.each([null, undefined, [], 'value', 42, false, new Date(), new Map()])('rejects malformed argument container %j', value => {
    expect(validateToolArguments(batch, value).ok).toBe(false);
  });
  it('rejects missing required fields at every nesting level', () => {
    for (const value of [{ lines: [{}] }, { lines: [{ amount: 1 }] }, { lines: [{ kind: 'bank' }] }]) {
      expect(validateToolArguments(batch, value).ok).toBe(false);
    }
    expect(validateToolArguments(tool({}, { inputSchema: { type: 'object', properties: { name: { type: 'string' } },
      required: ['name'], additionalProperties: false } }), {}).ok).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, 'Infinity', undefined, null, {}, [], true, -1, 101])('rejects malformed/bounded nested amount %j', amount => {
    expect(validateToolArguments(batch, { lines: [{ amount, kind: 'bank' }] }).ok).toBe(false);
  });
  it.each([{ lines: [] }, { lines: [{ amount: 1, kind: 'bank' }, { amount: 2, kind: 'cash' },
    { amount: 3, kind: 'bank' }] }])('enforces array bounds', ({ lines }) => {
    expect(validateToolArguments(batch, { lines }).ok).toBe(false);
  });
  it('checks enums, extra nested properties and safe error messages', () => {
    for (const value of [{ lines: [{ amount: 1, kind: 'invented' }] },
      { lines: [{ amount: 1, kind: 'bank', secret: 'sample' }] }, { verified: true }]) {
      const result = validateToolArguments(batch, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain('sample');
    }
  });
  it('accepts valid zero/false/null unions and preserves raw input without mutation', () => {
    const t = tool({ n: number, flag: { type: 'boolean' }, optional: { type: ['string', 'null'], enum: ['x', null] } });
    const args = Object.freeze({ n: 0, flag: false, optional: null });
    expect(validateToolArguments(t, args)).toEqual({ ok: true, args });
  });
  it('validates strict numeric/integer/exclusive bounds without accidental coercion', () => {
    const t = tool({ n: { type: 'integer', exclusiveMinimum: 0, maximum: 10 } });
    for (const n of [0, 1.5, 11, '1', true, Number.MAX_SAFE_INTEGER + 1]) expect(validateToolArguments(t, { n }).ok).toBe(false);
    expect(validateToolArguments(t, { n: 1 }).ok).toBe(true);
  });
  it('checks actual calendar dates and Unicode character length', () => {
    const t = tool({ date: { type: 'string', format: 'date' }, name: { type: 'string', maxLength: 2 } });
    expect(validateToolArguments(t, { date: '2024-02-29', name: '😀é' }).ok).toBe(true);
    for (const date of ['2026-02-29', '2026-04-31', '2026-1-01', '2026-09-09T00:00:00Z']) {
      expect(validateToolArguments(t, { date }).ok).toBe(false);
    }
    expect(validateToolArguments(t, { name: '😀éx' }).ok).toBe(false);
  });
  it('fails closed on unimplemented schema keywords and formats', () => {
    expect(validateToolArguments(tool({ value: { type: 'string', pattern: '^x$' } }), { value: 'x' }).ok).toBe(false);
    expect(validateToolArguments(tool({ value: { type: 'string', format: 'uuid' } }), { value: 'x' }).ok).toBe(false);
  });
  it('rejects getters, hidden fields, symbols, decorated/sparse arrays and cycles without calling accessors', () => {
    let read = false;
    const getter = Object.defineProperty({}, 'lines', { enumerable: true, get() { read = true; return []; } });
    const hidden = Object.defineProperty({}, 'secret', { value: 'hidden' });
    const sparse = Object.assign(new Array(1), { extra: 'hidden' });
    const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
    for (const args of [getter, hidden, { [Symbol('secret')]: true }, { lines: sparse }, cyclic]) {
      expect(validateToolArguments(batch, args).ok).toBe(false);
    }
    expect(read).toBe(false);
  });
  it('requires nonblank write idempotency and only permits the existing optional company assertion', () => {
    for (const idempotency_key of [undefined, '', ' ', null, 1]) expect(validateToolArguments(write, { idempotency_key }).ok).toBe(false);
    for (const company_id of ['11111111-1111-4111-8111-111111111111', null, undefined]) {
      expect(validateToolArguments(write, { idempotency_key: 'key', company_id }).ok).toBe(true);
    }
    for (const company_id of ['garbage', false, {}, []]) expect(validateToolArguments(write, { idempotency_key: 'key', company_id }).ok).toBe(false);
    for (const name of ['company_id', 'approver_id', 'verified', 'role', 'user_id']) {
      expect(validateToolArguments(tool({}), { [name]: 'invented' }).ok).toBe(false);
    }
  });
  it('rejects unsupported dry_run even false and validates supported dry_run strictly', () => {
    for (const dry_run of [true, false]) expect(validateToolArguments(write, { idempotency_key: 'key', dry_run }).ok).toBe(false);
    const t = tool({ idempotency_key: { type: 'string' }, dry_run: { type: 'boolean' } }, { write: true });
    expect(validateToolArguments(t, { idempotency_key: 'key', dry_run: true }).ok).toBe(true);
    expect(validateToolArguments(t, { idempotency_key: 'key', dry_run: 'false' }).ok).toBe(false);
  });
});

describe('named legacy compatibility, never a global schema weakening', () => {
  it('preserves named clamped limit inputs but rejects nonfinite and nonnumeric payloads', () => {
    const t = tool({ limit: { type: 'integer', minimum: 1, maximum: 500 } }, { name: 'trial_balance' });
    for (const limit of ['100', '1e3', 1000, 0, -5, 1.8, null]) {
      expect(validateToolArguments(t, { limit })).toEqual({ ok: true, args: { limit } });
    }
    for (const limit of [Infinity, 'Infinity', {}, true, 'bad']) expect(validateToolArguments(t, { limit }).ok).toBe(false);
    expect(validateToolArguments({ ...t, name: 'unreviewed_tool' }, { limit: 1000 }).ok).toBe(false);
  });
  it('permits numeric strings only on explicit existing Number conversion fields', () => {
    const t = tool({ amount: number, idempotency_key: { type: 'string' } }, { name: 'set_opening_balance', write: true });
    expect(validateToolArguments(t, { amount: '1.25', idempotency_key: 'key' }).ok).toBe(true);
    expect(validateToolArguments({ ...t, name: 'unreviewed_tool' }, { amount: '1.25', idempotency_key: 'key' }).ok).toBe(false);
    const statement = tool({ statement_balance: number }, { name: 'perform_bank_reconciliation' });
    expect(validateToolArguments(statement, { statement_balance: '1.25' }).ok).toBe(false);
  });
  it('matches explicit nested numeric paths without relaxing siblings', () => {
    const t = tool({ allocations: { type: 'array', items: { type: 'object', properties: { amount: number, invoice_id: { type: 'string' } },
      required: ['amount', 'invoice_id'], additionalProperties: false } } }, { name: 'apply_receipt_to_invoice' });
    expect(validateToolArguments(t, { allocations: [{ amount: '1.25', invoice_id: 'id' }] }).ok).toBe(true);
    expect(validateToolArguments(t, { allocations: [{ amount: true, invoice_id: 'id' }] }).ok).toBe(false);
    expect(validateToolArguments(t, { allocations: [{ amount: '1.25', invoice_id: 1 }] }).ok).toBe(false);
  });
  it('retains explicit nullable numeric defaults without admitting null required amounts', () => {
    const t = tool({ tax_rate: number, idempotency_key: { type: 'string' } }, { name: 'create_supplier_invoice', write: true });
    expect(validateToolArguments(t, { tax_rate: null, idempotency_key: 'key' }).ok).toBe(true);
    expect(validateToolArguments(tool({ amount: number }, { name: 'set_opening_balance' }), { amount: null }).ok).toBe(false);
  });
});


it('never echoes exceptions from exotic caller objects', () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('secret-do-not-echo'); } });
  const result = validateToolArguments(tool({}), hostile);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).not.toContain('secret-do-not-echo');
});
it('rejects unsupported schema keywords even in unused optional branches', () => {
  expect(validateToolArguments(tool({ unused: { type: 'string', pattern: '^x$' } }), {}).ok).toBe(false);
});
it('bounds recursive argument traversal', () => {
  let value: Record<string, unknown> = {};
  for (let i = 0; i < 66; i++) value = { child: value };
  const result = validateToolArguments(tool({}), value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('validation limits');
});
it('retains clamp helper behavior for each explicitly registered limit exception', () => {
  const cases = [['2', 2], ['1e3', 500], [1.8, 1], [-5, 200], [0, 200], [null, 200]] as const;
  for (const [name, compatibility] of Object.entries(MCP_INPUT_COMPATIBILITY)) {
    if (!compatibility.clamped?.includes('limit')) continue;
    const t = tool({ limit: { type: 'integer', minimum: 1, maximum: 500 } }, { name });
    for (const [limit, expected] of cases) {
      const result = validateToolArguments(t, { limit });
      expect(result.ok).toBe(true);
      if (result.ok) expect(clampLimit(result.args, 200, 500)).toBe(expected);
    }
  }
});
