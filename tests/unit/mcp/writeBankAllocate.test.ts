import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  // Batched resolution (one query per bulk call) — the plural is what the
  // selector resolver actually calls; default to "nothing matched".
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  getBankTransactionStatus: vi.fn(),
}));

import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { allocateBankTransactionTool, reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null } as never;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the row exists and is in the state the tool under test needs. The
  // allocate/reverse handlers now answer their pre-write refusals from this
  // read, so the service call below can rethrow everything.
  vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
  // Default: every id belongs to the token's company.
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
});

describe('allocate_bank_transaction', () => {
  it('demands the write:post permission — it posts a journal, not a suggestion', () => {
    expect(allocateBankTransactionTool.scope).toBe('write:bank-tx');
    expect(allocateBankTransactionTool.requiresPost).toBe(true);
    expect(allocateBankTransactionTool.write).toBe(true);
    expect(allocateBankTransactionTool.inputSchema.required).toContain('idempotency_key');
  });

  it('stamps the posting agent so the write is attributable and reversible as a set', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
    } as never);

    await allocateBankTransactionTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', idempotency_key: 'k1' },
      ctx,
    );

    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');           // tenant from ctx
    expect(call[3]).toBe('user-1');
    expect(call[12]).toEqual({ postingAgent: 'mcp:allocate_bank_transaction:v1', actorType: 'agent', actorTokenJti: 'jti' });
  });

  it('rejects a missing transaction_id without touching the ledger', async () => {
    const res = await allocateBankTransactionTool.handler(
      { contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses an already-allocated transaction without calling the service', async () => {
    // The refusal moved OUT of the catch and into a pre-write read: only that
    // way can everything the service throws be rethrown for the savepoint.
    vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated');

    const res = await allocateBankTransactionTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
  });

  it('rejects alloc_type "transfer" — undocumented, live bank-to-bank-transfer semantics — without touching the ledger', async () => {
    const res = await allocateBankTransactionTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', alloc_type: 'transfer', idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('accepts a valid alloc_type and passes it through to the service', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
    } as never);

    const res = await allocateBankTransactionTool.handler(
      {
        transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', alloc_type: 'supplier',
        entity_id: '3fc5ec9c-e919-4f35-822a-aa193ae94984', idempotency_key: 'k1',
      },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[5]).toBe('supplier');
  });

  // ── Finding 3: vat_code is validated at runtime, not just in the manifest ──
  // bankAllocationService maps an unrecognised vat_code to `undefined`, which
  // posts the line with NO vatType at all: a silently lost VAT201
  // classification on a journal that still balances.
  it.each(['zero-rated', 'ZERO_RATED', 'vat', ''])(
    'rejects the unrecognised vat_code %j rather than silently posting with no VAT type',
    async (bad) => {
      const res = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', vat_code: bad, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(allocateTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(['standard', 'zero_rated', 'exempt', 'none'])(
    'accepts the documented vat_code %j and passes it through unchanged',
    async (code) => {
      vi.mocked(allocateTransaction).mockResolvedValue({
        journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
      } as never);

      const res = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', vat_code: code, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(vi.mocked(allocateTransaction).mock.calls[0]![7]).toBe(code);
    },
  );

  it('keeps the manifest enum and the runtime gate in sync for vat_code', () => {
    const props = allocateBankTransactionTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.vat_code?.enum).toEqual(['standard', 'zero_rated', 'exempt', 'none']);
  });

  // ── Finding 4: entity_id is required for supplier/customer ────────────────
  // Without it, allocateTransaction falls through to the plain GL-account
  // branch: a structurally different journal (no AP/AR control account, no
  // match) returned as a SUCCESS. The REST route over the same service guards
  // this explicitly (bank-transactions-action.ts).
  it.each(['supplier', 'customer'])(
    'rejects a %s allocation with no entity_id instead of posting a different journal',
    async (allocType) => {
      const res = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', alloc_type: allocType, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(allocateTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects a blank entity_id for a supplier allocation — whitespace is not an entity', async () => {
    const res = await allocateBankTransactionTool.handler(
      {
        transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', alloc_type: 'supplier',
        entity_id: '   ', idempotency_key: 'k1',
      },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('still allows an account allocation without entity_id', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
    } as never);

    const res = await allocateBankTransactionTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', alloc_type: 'account', idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(allocateTransaction).toHaveBeenCalled();
  });

  // ── Finding 1: cross-tenant write via unchecked ids ───────────────────────
  // NOTHING downstream re-checks the tenant on these ids. allocateTransaction
  // looks the contra account up only to build a display label, sets it null on
  // zero rows, and posts the line anyway; there is no composite
  // (id, company_id) FK. So the tool handler is the only gate between an
  // agent-supplied UUID and another tenant's ledger.
  describe('ownership guards', () => {
    it("refuses a contra_account_id that is not this company's GL account, and posts nothing", async () => {
      vi.mocked(accountsBelongToCompany).mockResolvedValue(false);

      const res = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'f8849626-ab9e-4219-8501-a6c72135d281', idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(accountsBelongToCompany).toHaveBeenCalledWith('company-1', ['f8849626-ab9e-4219-8501-a6c72135d281']);
      expect(allocateTransaction).not.toHaveBeenCalled();
    });

    it("refuses a supplier entity_id from another tenant, and posts nothing", async () => {
      vi.mocked(suppliersBelongToCompany).mockResolvedValue(false);

      const res = await allocateBankTransactionTool.handler(
        {
          transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', alloc_type: 'supplier',
          entity_id: '7e3efb2c-6422-4c7c-891c-9e28377b91eb', idempotency_key: 'k1',
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(suppliersBelongToCompany).toHaveBeenCalledWith('company-1', ['7e3efb2c-6422-4c7c-891c-9e28377b91eb']);
      expect(allocateTransaction).not.toHaveBeenCalled();
    });

    it("refuses a customer entity_id from another tenant, and posts nothing", async () => {
      vi.mocked(customersBelongToCompany).mockResolvedValue(false);

      const res = await allocateBankTransactionTool.handler(
        {
          transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', alloc_type: 'customer',
          entity_id: '58a4fa7b-0ead-430d-8acc-071b902f5d2f', idempotency_key: 'k1',
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(customersBelongToCompany).toHaveBeenCalledWith('company-1', ['58a4fa7b-0ead-430d-8acc-071b902f5d2f']);
      expect(allocateTransaction).not.toHaveBeenCalled();
    });

    it('checks ownership against ctx.companyId only — args cannot name the tenant', async () => {
      vi.mocked(allocateTransaction).mockResolvedValue({
        journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
      } as never);

      await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', idempotency_key: 'k1' }, ctx,
      );

      expect(vi.mocked(accountsBelongToCompany).mock.calls[0]![0]).toBe('company-1');
      const props = Object.keys(allocateBankTransactionTool.inputSchema.properties as object);
      for (const p of props) expect(p).not.toMatch(/company/i);
    });

    // A distinguishable "belongs to another company" reply would let an agent
    // probe UUIDs and learn which are real in tenants it cannot read.
    it('returns the SAME generic text for a foreign id as for a nonexistent one — no existence oracle', async () => {
      vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
      const foreign = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: '7116ae1a-f83f-45ea-8bfa-b311e26b358b', idempotency_key: 'k1' },
        ctx,
      );

      vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
      const nonexistent = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'b5bcb868-8477-46dc-8a90-1c903604ef81', idempotency_key: 'k1' },
        ctx,
      );

      expect(foreign.content[0]!.text).toBe(nonexistent.content[0]!.text);
      expect(foreign.content[0]!.text).toBe('Not found');
      // and it must not echo the probed id back
      expect(foreign.content[0]!.text).not.toContain('7116ae1a-f83f-45ea-8bfa-b311e26b358b');
    });

    it('gives a supplier id the same generic refusal as a GL account id', async () => {
      vi.mocked(suppliersBelongToCompany).mockResolvedValue(false);
      const supplier = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', alloc_type: 'supplier', entity_id: '6f0b1e01-0d39-4bb4-8d88-53f485a3d987', idempotency_key: 'k1' }, ctx,
      );

      vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
      const account = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'f7be3e1f-2a9f-4a4b-8937-ef4113e11cab', idempotency_key: 'k1' }, ctx,
      );

      expect(supplier.content[0]!.text).toBe(account.content[0]!.text);
    });
  });

  // ── Finding 3: contra_account_id is only meaningful for `account` ─────────
  // allocateTransaction reads it in the `account` branch only; supplier and
  // customer resolve their contra side from getSystemAccountId. Requiring it
  // everywhere made the agent invent a GL account that then went unused. The
  // REST route over the same service already scopes the requirement this way.
  describe('contra_account_id is conditionally required', () => {
    it('is not unconditionally required in the manifest', () => {
      expect(allocateBankTransactionTool.inputSchema.required).not.toContain('contra_account_id');
      // transaction_id dropped out of `required` when bank_reference became an
      // alternative (PRD-11 §5); the either/or is enforced in the handler.
      expect(allocateBankTransactionTool.inputSchema.required).toContain('idempotency_key');
    });

    it('documents what the property is and when it applies', () => {
      const props = allocateBankTransactionTool.inputSchema.properties as
        Record<string, { description?: string }>;
      expect(props.contra_account_id?.description).toBeTruthy();
      expect(props.contra_account_id!.description).toMatch(/account/i);
    });

    it.each(['supplier', 'customer'])(
      'allocates a %s WITHOUT contra_account_id and passes null to the service',
      async (allocType) => {
        vi.mocked(allocateTransaction).mockResolvedValue({
          journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' },
        } as never);

        const res = await allocateBankTransactionTool.handler(
          { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', alloc_type: allocType, entity_id: 'b94f5231-96aa-4cd8-8db9-ef0d8cf2e1d8', idempotency_key: 'k1' },
          ctx,
        );

        expect(res.isError).toBeFalsy();
        const call = vi.mocked(allocateTransaction).mock.calls[0]!;
        expect(call[2]).toBeNull();       // contraAccountId
        expect(call[5]).toBe(allocType);
        // No account to own, so no pointless ownership query either.
        expect(accountsBelongToCompany).not.toHaveBeenCalled();
      },
    );

    it('still demands contra_account_id for the default account allocation', async () => {
      const res = await allocateBankTransactionTool.handler(
        { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', idempotency_key: 'k1' }, ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('contra_account_id');
      expect(allocateTransaction).not.toHaveBeenCalled();
    });

    it('still validates a contra_account_id supplied alongside a supplier allocation', async () => {
      vi.mocked(accountsBelongToCompany).mockResolvedValue(false);

      const res = await allocateBankTransactionTool.handler(
        {
          transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', alloc_type: 'supplier', entity_id: '3fc5ec9c-e919-4f35-822a-aa193ae94984',
          contra_account_id: 'f8849626-ab9e-4219-8501-a6c72135d281', idempotency_key: 'k1',
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(allocateTransaction).not.toHaveBeenCalled();
    });
  });
});

describe('reverse_bank_allocation', () => {
  // Reversal's pre-write check wants a row that HAS an allocation to undo.
  beforeEach(() => { vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated'); });

  it('is a write behind the write:post permission and demands an idempotency key', () => {
    expect(reverseBankAllocationTool.scope).toBe('write:bank-tx');
    expect(reverseBankAllocationTool.requiresPost).toBe(true);
    expect(reverseBankAllocationTool.write).toBe(true);
    expect(reverseBankAllocationTool.inputSchema.required).toContain('idempotency_key');
  });

  it('refuses a malformed transaction_id before any SQL runs', async () => {
    // Both ids reach pg as `$n::UUID` — transaction_id in the status read,
    // bank_account_id in the reference lookup — so an unguarded call raised
    // 22P02 from inside the handler. The allocate tool has always been guarded
    // via parseAllocationLine; this path parses no line and had no guard.
    const res = await reverseBankAllocationTool.handler(
      { transaction_id: 'not-a-uuid', idempotency_key: 'k9' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid transaction_id');
    expect(getBankTransactionStatus).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('refuses a malformed bank_account_id on the reference route', async () => {
    const res = await reverseBankAllocationTool.handler(
      { bank_reference: 'REF-1', bank_account_id: 'nope', idempotency_key: 'k9' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid bank_account_id');
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('reports the ambiguity, not the bad id, when a call is both malformed and ambiguous', () => {
    // Selector first, cast-guard second — parseAllocationLine's documented
    // order. Told 'invalid transaction_id', an agent fixes the UUID and is
    // refused again for naming both.
    return reverseBankAllocationTool.handler(
      { transaction_id: 'not-a-uuid', bank_reference: 'REF-1', idempotency_key: 'k9' }, ctx,
    ).then((res) => {
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/^Provide either transaction_id or bank_reference/);
    });
  });

  it('reverses using the tenant from ctx', async () => {
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', idempotency_key: 'k9' }, ctx,
    );

    const call = vi.mocked(reverseReconciledTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');
    expect(call[1]).toBe('045ef594-d81d-4f21-84d6-1151ed71260d');
    expect(call[2]).toBe('user-1');
    expect(res.isError).toBeFalsy();
  });

  // ── Finding 1: the correction must not escape attribution ─────────────────
  // The reversal posts a REAL contra journal. Left unstamped it lands as
  // human:<userId> and disappears from list_agent_postings — the corrective
  // mechanism the whole attribution safety model leans on would be the one
  // operation the review surface cannot see.
  it('stamps the contra journal with the reversal tool, not the human default', async () => {
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    await reverseBankAllocationTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', idempotency_key: 'k9' }, ctx,
    );

    expect(vi.mocked(reverseReconciledTransaction).mock.calls[0]![3]).toEqual({
      postingAgent: 'mcp:reverse_bank_allocation:v1',
      actorType: 'agent',
      actorTokenJti: 'jti',
    });
  });

  it('surfaces the refusal when the transaction is not in a reversible state', async () => {
    // Now answered from the pre-write read rather than caught from the service:
    // reverseReconciledTransaction posts the contra BEFORE resetting the row, so
    // a catch around it cannot tell this refusal from a half-done reversal.
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', idempotency_key: 'k9' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Can only reverse/);
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });
});
