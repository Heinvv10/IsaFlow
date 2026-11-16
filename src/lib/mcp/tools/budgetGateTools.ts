/**
 * MCP write tools for the four human-gated budget moves (Hein's ruling 2, 2026-11-16): approve, lock,
 * unlock and set primary. Only a token whose user is the company's OWNER may make them; every other role
 * (admin and manager included, though an admin may approve or lock in the app) is refused "A person must
 * approve this budget in IsaFlow" BEFORE any service is called. An owner's move runs the app's own services
 * (`transitionVersion`, `setPrimary`) with every rule the app applies: slices pending refuse an approve
 * unless the owner forces it with a reason, unlock needs a reason (1-500), a stale version_token is refused.
 * The database audits status moves; setPrimary writes its own audit row; both as the token user.
 */
import { transitionVersion, type VersionAction } from '@/modules/accounting/services/budgets/budgetVersionStatus';
import { setPrimary } from '@/modules/accounting/services/budgets/budgetVersions';
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { BUDGET_WRITE_FENCE, isResult, ownerGate, ownVersion, versionTokenArg, versionView } from './budgetToolArgs';
import { ok, toolError } from './toolHelpers';

const GATE_NOTE = 'Only a token whose user is the company owner may do this; any other role is told "A person must approve this budget in IsaFlow".';

const base = {
  version_id: { type: 'string', format: 'uuid' },
  version_token: { type: 'string', description: 'The version_token you read; refused when the version changed since.' },
  idempotency_key: { type: 'string' },
};

async function move(ctx: McpToolContext, args: Record<string, unknown>, action: VersionAction): Promise<McpToolResult> {
  const gate = ownerGate(ctx);
  if (gate) return gate;
  const token = versionTokenArg(args);
  if (isResult(token)) return token;
  const version = await ownVersion(ctx, args.version_id);
  if (isResult(version)) return version;
  if (args.force !== undefined && typeof args.force !== 'boolean') return toolError('force must be true or false');
  if (args.reason !== undefined && typeof args.reason !== 'string') return toolError('reason must be text');
  const moved = await transitionVersion(ctx.companyId, version.id, {
    action, reason: args.reason, expectedUpdatedAt: token ?? undefined, force: args.force === true,
  }, { userId: ctx.userId, role: ctx.companyRole ?? '' });
  return ok({ version: versionView(moved) });
}

export const approveBudgetVersionTool: McpTool = {
  name: 'approve_budget_version',
  description: `Approve a DRAFT budget version (draft → approved; it stays editable, every edit audited). ${GATE_NOTE} `
    + 'Refused while a budget holder\'s slice is not approved, unless force true with a reason (1-500 characters), recorded in the audit log.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { ...base, force: { type: 'boolean' }, reason: { type: 'string', maxLength: 500 } },
    required: ['version_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: (args, ctx) => move(ctx, args, 'approve'),
};

export const lockBudgetVersionTool: McpTool = {
  name: 'lock_budget_version',
  description: `Lock an APPROVED budget version (approved → locked: immutable, the database refuses any change). ${GATE_NOTE}`,
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: { type: 'object', properties: { ...base }, required: ['version_id', 'idempotency_key'], additionalProperties: false },
  handler: (args, ctx) => move(ctx, args, 'lock'),
};

export const unlockBudgetVersionTool: McpTool = {
  name: 'unlock_budget_version',
  description: `Unlock a LOCKED budget version (locked → approved, editable again). reason (1-500 characters) is required and kept in the audit log. ${GATE_NOTE}`,
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { ...base, reason: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['version_id', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: (args, ctx) => move(ctx, args, 'unlock'),
};

export const setPrimaryBudgetVersionTool: McpTool = {
  name: 'set_primary_budget_version',
  description: `Make a budget version its financial year's PRIMARY: every report without a named version (Budget vs Actual, packs, budget_variance) then reads it. ${GATE_NOTE}`,
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: { type: 'object', properties: { version_id: base.version_id, idempotency_key: base.idempotency_key }, required: ['version_id', 'idempotency_key'], additionalProperties: false },
  handler: async (args, ctx) => {
    const gate = ownerGate(ctx);
    if (gate) return gate;
    const version = await ownVersion(ctx, args.version_id);
    if (isResult(version)) return version;
    const made = await setPrimary(ctx.companyId, version.id, { userId: ctx.userId, role: ctx.companyRole ?? '' });
    return ok({ version: versionView(made) });
  },
};

export const BUDGET_GATE_TOOLS: McpTool[] = [approveBudgetVersionTool, lockBudgetVersionTool, unlockBudgetVersionTool, setPrimaryBudgetVersionTool];
