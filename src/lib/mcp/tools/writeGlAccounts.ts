/**
 * MCP write tools: the chart of accounts.
 *
 * There was no way to create or modify a GL account through the connector at
 * all. Rebuilding Velocity Fibre's chart meant driving the browser UI for 46
 * accounts — roughly 200 automated interactions, three of which failed
 * silently when a button reference shifted between iterations.
 *
 * None of these post to the ledger, so none is `requiresPost`. They are still
 * `write`, so each takes an idempotency_key and runs inside the registry's
 * savepoint. `update_gl_account` is the one that matters most: `account_subtype`
 * and `parent_account_id` were previously writable only at creation time,
 * anywhere in the product, and an account without `subtype = bank` cannot
 * receive a statement import at all.
 */
import type { McpTool } from '../types';
import {
  createAccount,
  getAccountById,
  updateAccount,
  deleteAccount,
} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  reclassifyAccount,
  ReclassifyError,
} from '@/modules/accounting/services/gl/accountReclassifyService';
import {
  GL_ACCOUNT_TYPES,
  GL_ACCOUNT_SUBTYPES,
  type GLAccountSubtype,
  type GLAccountType,
} from '@/modules/accounting/types/gl.types';
import { UUID_RE } from '@/lib/validation';
import { NOT_FOUND, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const VAT_CODES = ['none', 'standard', 'zero_rated', 'exempt'] as const;

/**
 * `normal_balance` is NOT an agent decision. It is fully determined by the
 * account type, and getting it wrong inverts the account in every report while
 * looking perfectly valid in the row. The UI derives it the same way.
 */
function normalBalanceFor(accountType: GLAccountType): 'debit' | 'credit' {
  return accountType === 'asset' || accountType === 'expense' ? 'debit' : 'credit';
}

function parseAccountType(args: Record<string, unknown>): GLAccountType | null {
  const raw = strArg(args, 'account_type');
  if (!raw) return null;
  return (GL_ACCOUNT_TYPES as readonly string[]).includes(raw) ? (raw as GLAccountType) : null;
}

/**
 * `undefined` = key absent (leave alone), `null` = explicit JSON null (clear).
 * The two are different instructions and the distinction has to survive all
 * the way to the service — collapsing them is how `parent_account_id` ends up
 * with no way to be cleared.
 */
function optionalNullable(args: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (value === null || value === '') return null;
  return typeof value === 'string' ? value.trim() : undefined;
}

export const createGlAccountTool: McpTool = {
  name: 'create_gl_account',
  description:
    'Create a GL account in the chart of accounts. account_type is one of asset, liability, equity, revenue, expense. ' +
    'account_subtype drives behaviour, not just labelling — an asset account needs subtype "bank" before it can receive a bank statement import. ' +
    'normal_balance is derived from account_type and is not accepted. Use list_gl_accounts first to check the code is free and to resolve parent_account_id.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      account_code: { type: 'string', description: 'Unique code within the company, e.g. "1150"' },
      account_name: { type: 'string' },
      account_type: { type: 'string', enum: [...GL_ACCOUNT_TYPES] },
      account_subtype: {
        type: 'string',
        enum: [...GL_ACCOUNT_SUBTYPES],
        description: 'Must be valid for the account_type. Subtypes reserved for system accounts (vat_input, receivable, payable, …) are refused.',
      },
      parent_account_id: { type: 'string', description: 'GL account UUID. Must be the same account_type and must have no postings of its own.' },
      description: { type: 'string' },
      vat_default: { type: 'string', enum: [...VAT_CODES], description: 'Default VAT treatment for postings to this account.' },
      idempotency_key: { type: 'string' },
    },
    required: ['account_code', 'account_name', 'account_type', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const accountCode = strArg(args, 'account_code');
    const accountName = strArg(args, 'account_name');
    if (!accountCode) return toolError('account_code is required');
    if (!accountName) return toolError('account_name is required');

    const accountType = parseAccountType(args);
    if (!accountType) {
      return toolError(`account_type must be one of: ${GL_ACCOUNT_TYPES.join(', ')}`);
    }
    const bad = guardCastableArgs(args, { uuid: ['parent_account_id'] });
    if (bad) return bad;

    const vatDefault = strArg(args, 'vat_default');
    if (vatDefault && !(VAT_CODES as readonly string[]).includes(vatDefault)) {
      return toolError(`vat_default must be one of: ${VAT_CODES.join(', ')}`);
    }

    // Ownership: parent_account_id becomes a foreign key. The service checks
    // the parent is in the company too, but doing it here keeps the refusal
    // text identical to a genuine miss.
    const parentAccountId = strArg(args, 'parent_account_id');
    if (parentAccountId && !(await getAccountById(ctx.companyId, parentAccountId))) {
      return toolError(NOT_FOUND);
    }

    try {
      const account = await createAccount(ctx.companyId, {
        accountCode,
        accountName,
        accountType,
        accountSubtype: strArg(args, 'account_subtype'),
        parentAccountId,
        description: strArg(args, 'description'),
        normalBalance: normalBalanceFor(accountType),
        defaultVatCode: vatDefault as 'none' | 'standard' | 'zero_rated' | 'exempt' | undefined,
      });
      return ok(account);
    } catch (err) {
      // Every refusal createAccount raises (duplicate code, invalid subtype,
      // missing parent) happens BEFORE its INSERT, so flattening them into a
      // tool error keeps nothing written. A pg error still generic-ifies.
      return toolError(safeErrorText(err, 'Failed to create account.'));
    }
  },
};

export const updateGlAccountTool: McpTool = {
  name: 'update_gl_account',
  description:
    'Update a GL account. Pass only the fields you want to change; omit the rest. ' +
    'account_subtype and parent_account_id can be CHANGED here — set either to null to clear it. ' +
    'Setting account_subtype to "bank" is what makes an existing account able to receive a bank statement import. ' +
    'Refusals are specific: a system account\'s subtype is fixed, a parent must be the same account_type with no postings of its own, ' +
    'and the bank subtype cannot be removed while bank transactions still reference the account. ' +
    'account_code is not editable here (it is locked once anything has posted); account_type is never editable.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'GL account UUID (from list_gl_accounts)' },
      account_name: { type: 'string' },
      description: { type: 'string' },
      account_subtype: {
        type: ['string', 'null'],
        enum: [...GL_ACCOUNT_SUBTYPES, null],
        description: 'null clears the subtype. Must be valid for the account\'s existing account_type.',
      },
      parent_account_id: {
        type: ['string', 'null'],
        description: 'GL account UUID, or null to move the account to the top level.',
      },
      vat_default: { type: 'string', enum: [...VAT_CODES] },
      is_active: { type: 'boolean', description: 'false deactivates; prefer deactivate_gl_account, which reports why it refused.' },
      idempotency_key: { type: 'string' },
    },
    required: ['account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const accountId = strArg(args, 'account_id');
    if (!accountId) return toolError('account_id is required');
    const bad = guardCastableArgs(args, { uuid: ['account_id'] });
    if (bad) return bad;

    const parentAccountId = optionalNullable(args, 'parent_account_id');
    if (typeof parentAccountId === 'string' && !UUID_RE.test(parentAccountId)) {
      return toolError('invalid parent_account_id');
    }

    const vatDefault = strArg(args, 'vat_default');
    if (vatDefault && !(VAT_CODES as readonly string[]).includes(vatDefault)) {
      return toolError(`vat_default must be one of: ${VAT_CODES.join(', ')}`);
    }

    // Ownership answered from a READ, before anything is written, and with the
    // shared NOT_FOUND text so a cross-tenant id is indistinguishable from a
    // typo'd one.
    if (!(await getAccountById(ctx.companyId, accountId))) return toolError(NOT_FOUND);

    const subtype = optionalNullable(args, 'account_subtype') as GLAccountSubtype | null | undefined;
    const isActive = typeof args.is_active === 'boolean' ? args.is_active : undefined;
    const accountName = strArg(args, 'account_name');
    const description = strArg(args, 'description');

    if (
      subtype === undefined && parentAccountId === undefined && isActive === undefined &&
      accountName === undefined && description === undefined && vatDefault === undefined
    ) {
      return toolError('Nothing to update — pass at least one field besides account_id.');
    }

    try {
      // Reclassification carries the structural guards (cycles, the leaf rule,
      // orphaned bank transactions) and refuses BEFORE writing, so it runs
      // first: a refusal here must not leave a half-applied rename behind.
      if (subtype !== undefined || parentAccountId !== undefined) {
        await reclassifyAccount(ctx.companyId, accountId, {
          ...(subtype !== undefined ? { accountSubtype: subtype } : {}),
          ...(parentAccountId !== undefined ? { parentAccountId } : {}),
        });
      }
    } catch (err) {
      if (err instanceof ReclassifyError) return toolError(err.message);
      throw err;
    }

    // No catch: reclassifyAccount may already have written, so a failure from
    // here has to reach the registry's savepoint rather than being flattened
    // into a tool error that keeps the half-applied change.
    return ok(
      await updateAccount(ctx.companyId, accountId, {
        accountName,
        description,
        isActive,
        defaultVatCode: vatDefault as 'none' | 'standard' | 'zero_rated' | 'exempt' | undefined,
      }),
    );
  },
};

export const deactivateGlAccountTool: McpTool = {
  name: 'deactivate_gl_account',
  description:
    'Deactivate (soft-delete) a GL account. Refuses with the reason if the account has active children, ' +
    'a non-zero GL balance, or — for a bank account — unreconciled bank transactions. Nothing is ever hard-deleted.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const accountId = strArg(args, 'account_id');
    if (!accountId) return toolError('account_id is required');
    const bad = guardCastableArgs(args, { uuid: ['account_id'] });
    if (bad) return bad;

    const account = await getAccountById(ctx.companyId, accountId);
    if (!account) return toolError(NOT_FOUND);
    if (!account.isActive) {
      return ok({ id: accountId, is_active: false, already_inactive: true });
    }

    try {
      await deleteAccount(ctx.companyId, accountId);
    } catch (err) {
      // Every refusal deleteAccount raises is checked before its UPDATE, so a
      // tool error here leaves nothing written and the message (balance,
      // children, unreconciled transactions) is what the agent needs.
      return toolError(safeErrorText(err, 'Failed to deactivate account.'));
    }
    return ok({ id: accountId, is_active: false, already_inactive: false });
  },
};
