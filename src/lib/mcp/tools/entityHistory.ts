/**
 * MCP read tool: entity_history — the master-data change history migration 890
 * records (forensic-controls step 3). Read-only, always masked (Hein's
 * decisions 2 and 3, 2026-10-10: no reveal over MCP). The same reading rules
 * as the route and RLS: one entity's timeline for whoever may read that type,
 * the company-wide feed for owner / admin only; employees also need
 * `read:payroll`, suppliers and customers `read:contacts` (as their list tools).
 */
import type { McpTool } from '../types';
import { listEntityChanges, MAX_PAGE } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import {
  CHANNELS, ENTITY_TYPES, isEntityType, isHistoryAdmin, mayReadType, type EntityType,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** Beyond read:reports, the scope each type's own read tool needs. */
const TYPE_SCOPE: Partial<Record<EntityType, string>> = {
  supplier: 'read:contacts',
  customer: 'read:contacts',
  payroll_employee: 'read:payroll',
};

export const entityHistoryTool: McpTool = {
  name: 'entity_history',
  description:
    'WHO CHANGED A SUPPLIER, CUSTOMER, GL / BANK ACCOUNT, EMPLOYEE, MEMBER OR COMPANY SETTING, AND FROM WHAT TO WHAT. '
    + 'One row per write that changed a master-data record, recorded by the database itself whoever wrote it (the app, an '
    + 'MCP token, Login-as, the platform admin portal, a script, raw SQL), newest first: op (create / update / delete), the '
    + 'changed fields with their before and after values, the actor (a user id, or db:<role> for a write with no signed-in '
    + 'user) and the channel — session (a person signed in as themselves), impersonation (Login-as; impersonator is the '
    + 'platform admin behind it), token (an API / MCP token), platform_admin, system. '
    + 'Bank account numbers and ID / tax numbers are MASKED to their last four characters (masked: true); a changed value '
    + 'still shows as changed. Netcash keys are recorded only as a sha256 digest. '
    + 'entity_id needs entity_type. Without entity_id this is the company-wide feed (optionally one entity_type), owner / '
    + 'admin only. Members, invitations, permissions, company settings, approval rules and switches: owner / admin; '
    + 'employees: owner / admin / manager with the read:payroll scope; suppliers and customers need read:contacts (the '
    + 'feed leaves out any type a scope is missing for). History starts when migration 890 was deployed; '
    + 'earlier changes were not recorded. Bank rules have their own history (list_bank_rules). '
    + `Paginate with next_cursor; at most ${MAX_PAGE} rows per page.`,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      entity_type: { type: 'string', enum: [...ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'Requires entity_type. E.g. a supplier id from list_suppliers.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['entity_id', 'cursor'] });
    if (bad) return bad;
    const entityTypeRaw = strArg(args, 'entity_type');
    if (entityTypeRaw !== undefined && !isEntityType(entityTypeRaw)) {
      return toolError(`invalid entity_type — expected one of: ${ENTITY_TYPES.join(', ')}`);
    }
    const entityType = entityTypeRaw as (typeof ENTITY_TYPES)[number] | undefined;
    const entityId = strArg(args, 'entity_id');
    const cursor = strArg(args, 'cursor');
    const role = ctx.companyRole ?? undefined;
    const limit = clampLimit(args, 50, MAX_PAGE);

    // A type's history needs the scope that reads the entity itself — whether one record or the feed is asked for
    // (security review: payroll; breaker #696 R5: list_suppliers / list_customers need read:contacts).
    const allowed = (t: EntityType) => !TYPE_SCOPE[t] || ctx.scopes.includes(TYPE_SCOPE[t]!);
    if (entityType && !allowed(entityType)) {
      return toolError(`${entityType} history needs the ${TYPE_SCOPE[entityType]} scope.`);
    }
    if (entityId !== undefined) {
      if (!entityType) return toolError(`entity_id requires entity_type — one of: ${ENTITY_TYPES.join(', ')}`);
      if (!mayReadType(role, entityType)) return toolError(`Your role (${role ?? 'unknown'}) cannot view ${entityType} history.`);
    } else if (!isHistoryAdmin(role)) {
      return toolError('Only an owner or admin can read the company-wide change history; pass entity_type and entity_id.');
    }
    const types = entityType ? [entityType] : ENTITY_TYPES.filter(allowed);
    const page = await listEntityChanges(ctx.companyId, { types, entityType, entityId, before: cursor, limit });
    return ok({
      company_id: ctx.companyId,
      channels: CHANNELS,
      items: page.items.map((c) => ({
        id: c.id, entity_type: c.entityType, entity_id: c.entityId, entity_label: c.entityLabel, op: c.op,
        fields: c.fields, actor: c.actor, actor_name: c.actorName, channel: c.channel, impersonator: c.impersonator,
        recorded_at: c.recordedAt,
      })),
      next_cursor: page.nextCursor,
    });
  },
};
