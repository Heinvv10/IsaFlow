/**
 * mark_vat_declared_elsewhere — dry_run preview, mark/unmark dispatch, and
 * the owner/admin refusal surfacing as a toolError before any write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  markVatDeclaredElsewhereBulk: vi.fn(),
  unmarkVatDeclaredElsewhere: vi.fn(),
  getCompanyRoleForUser: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatDeclaredElsewhereService', () => {
  class VatDeclaredElsewhereForbiddenError extends Error {}
  class VatDeclaredElsewhereRefusal extends Error {}
  return {
    markVatDeclaredElsewhereBulk: m.markVatDeclaredElsewhereBulk,
    unmarkVatDeclaredElsewhere: m.unmarkVatDeclaredElsewhere,
    VatDeclaredElsewhereForbiddenError,
    VatDeclaredElsewhereRefusal,
  };
});
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({
  getCompanyRoleForUser: m.getCompanyRoleForUser,
}));

import { markVatDeclaredElsewhereTool } from '@/lib/mcp/tools/vatDeclaredElsewhere';
import {
  VatDeclaredElsewhereForbiddenError, VatDeclaredElsewhereRefusal,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const INV = 'cccccccc-0000-4000-8000-cccccccccccc';
const ctx: McpToolContext = { userId: USER, companyId: COMPANY, scopes: ['read:vat', 'write:vat'], tokenJti: 'tok-1', oauthAppId: null };
const args = { action: 'mark', kind: 'customer', invoice_ids: [INV], reason: 'Historical import', idempotency_key: 'k-1' };

function text(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getCompanyRoleForUser.mockResolvedValue('owner');
  m.markVatDeclaredElsewhereBulk.mockResolvedValue([{ invoiceId: INV, marked: true }]);
  m.unmarkVatDeclaredElsewhere.mockResolvedValue({ invoiceId: INV, marked: false });
});

it('dry_run previews without calling the service', async () => {
  const result = await markVatDeclaredElsewhereTool.handler({ ...args, dry_run: true }, ctx);
  expect(text(result).wouldAffect).toBe(1);
  expect(m.markVatDeclaredElsewhereBulk).not.toHaveBeenCalled();
});

it('mark reads the role fresh and calls the bulk mark service', async () => {
  await markVatDeclaredElsewhereTool.handler(args, ctx);
  expect(m.getCompanyRoleForUser).toHaveBeenCalledWith(COMPANY, USER);
  expect(m.markVatDeclaredElsewhereBulk).toHaveBeenCalledWith(
    COMPANY, 'customer', [INV], { userId: USER, role: 'owner' }, 'Historical import',
  );
});

it('unmark calls unmarkVatDeclaredElsewhere per id', async () => {
  await markVatDeclaredElsewhereTool.handler({ ...args, action: 'unmark' }, ctx);
  expect(m.unmarkVatDeclaredElsewhere).toHaveBeenCalledWith(COMPANY, 'customer', INV, { userId: USER, role: 'owner' }, 'Historical import');
  expect(m.markVatDeclaredElsewhereBulk).not.toHaveBeenCalled();
});

it('returns a toolError, not a throw, for a non-owner/admin refusal', async () => {
  m.markVatDeclaredElsewhereBulk.mockRejectedValue(new VatDeclaredElsewhereForbiddenError());
  const result = await markVatDeclaredElsewhereTool.handler(args, ctx);
  expect(result.isError).toBe(true);
});

// Breaker fix (VAT-gaps review, item 1c): the eligibility refusal (VAT is or
// was in the GL) is pre-write for every id in the batch — the tool must
// surface it as a toolError with the refusal code, not rethrow it as a
// generic failure.
it('returns a toolError, not a throw, when a document is ineligible (VAT in the GL)', async () => {
  m.markVatDeclaredElsewhereBulk.mockRejectedValue(new VatDeclaredElsewhereRefusal('not eligible'));
  const result = await markVatDeclaredElsewhereTool.handler(args, ctx);
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('not eligible');
});

it('refuses a missing reason before any lookup', async () => {
  const { reason: _drop, ...noReason } = args;
  const result = await markVatDeclaredElsewhereTool.handler(noReason, ctx);
  expect(result.isError).toBe(true);
  expect(m.getCompanyRoleForUser).not.toHaveBeenCalled();
});
