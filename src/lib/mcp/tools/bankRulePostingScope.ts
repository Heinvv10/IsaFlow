import { ErrorCode, type ApiErrorResponse } from '@/lib/apiResponse.types';
import {
  rulePostsMoney,
  type RuleWriteGuard,
} from '@/modules/accounting/services/bank/bankRuleChangeControl';
import type { McpToolContext, McpToolResult } from '../types';
import { toolError } from './toolHelpers';

const AUTO_POST_SCOPE_REFUSAL = 'Creating, updating or re-enabling a bank rule that can post '
  + 'automatically needs the "Post to ledger" permission (write:post). Set auto_create_entry=false '
  + 'with company-wide auto-post off, keep the rule inactive, or reconnect with posting allowed. '
  + 'Nothing was changed.';

const AUTO_POST_SCOPE_ERROR = {
  success: false,
  error: { code: ErrorCode.INSUFFICIENT_SCOPE, message: AUTO_POST_SCOPE_REFUSAL },
} satisfies ApiErrorResponse;

export class AutoPostScopeError extends Error {}

export const autoPostScopeError = (): McpToolResult => (
  toolError(JSON.stringify(AUTO_POST_SCOPE_ERROR))
);

export const autoPostScopeRefusal = (
  ctx: McpToolContext,
  autoPosts: boolean,
): McpToolResult | null => (
  autoPosts && !ctx.scopes.includes('write:post') ? autoPostScopeError() : null
);

export const lockedAutoPostScopeGuard = (
  ctx: McpToolContext,
  autoPosts: (after: Record<string, unknown>) => boolean,
): RuleWriteGuard => (after, postsMoney) => {
  if ((autoPosts(after) || postsMoney) && !ctx.scopes.includes('write:post')) {
    throw new AutoPostScopeError(AUTO_POST_SCOPE_REFUSAL);
  }
};

export const previewScopeRefusal = async (
  ctx: McpToolContext,
  isActive: boolean,
  autoCreateEntry: boolean,
): Promise<McpToolResult | null> => (
  !ctx.scopes.includes('write:post')
    && await rulePostsMoney(ctx.companyId, {
      is_active: isActive,
      auto_create_entry: autoCreateEntry,
    })
    ? autoPostScopeError()
    : null
);
