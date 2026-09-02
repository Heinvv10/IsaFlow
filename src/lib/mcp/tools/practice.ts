/**
 * MCP read tools: practice management (clients, job taxonomy, time entries).
 *
 * The connector had no practice surface at all — an agent could read the whole
 * ledger but could not see who the practice's clients were, what work it books
 * time against, or how many hours had been logged.
 *
 * `list_work_items` matters more than it looks. A time entry REQUIRES a work
 * item, categories are seeded on first client creation but work items are not,
 * so a real practice sits on N categories and zero work items and cannot log
 * time at all. This tool is how an agent discovers that state; create_work_item
 * is how it fixes it.
 */
import type { McpTool } from '../types';
import { listPracticeClients } from '@/modules/accounting/services/practice/practiceClientService';
import {
  listJobCategories,
  listWorkItems,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';
import { listPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { clampLimit, guardCastableArgs, ok, strArg } from './toolHelpers';

const CLIENT_STATUSES = ['prospect', 'onboarding', 'active', 'inactive', 'archived'] as const;
const ENTRY_STATUSES = [
  'draft', 'submitted', 'approved', 'billed', 'not_billable', 'leave', 'invoiced',
] as const;

export const listPracticeClientsTool: McpTool = {
  name: 'list_practice_clients',
  description:
    'List the practice\'s clients (the firms it does work for). These are practice clients, NOT the AR customers returned by list_customers — a practice client is who time is booked against. Filter by status; default returns every status.',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...CLIENT_STATUSES] },
      search: { type: 'string', description: 'Matches legal name or trading name.' },
      limit: { type: 'number', description: 'Default 50, max 200.' },
      offset: { type: 'number' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const offsetRaw = Number(args.offset);
    const { clients, total } = await listPracticeClients(ctx.companyId, {
      status: strArg(args, 'status'),
      search: strArg(args, 'search'),
      limit: clampLimit(args, 50, 200),
      offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
    });
    return ok({
      total,
      clients: clients.map((c) => ({
        id: c.id,
        legal_name: c.legalName,
        trading_name: c.tradingName,
        status: c.status,
        billing_model: c.billingModel,
      })),
    });
  },
};

export const listJobCategoriesTool: McpTool = {
  name: 'list_job_categories',
  description:
    'List the practice\'s job categories — the top level of the two-level taxonomy a time entry is booked against (category → work item). Inactive categories are excluded unless include_inactive is true.',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      include_inactive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const categories = await listJobCategories(ctx.companyId, args.include_inactive === true);
    return ok({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        reporting_tag: c.reportingTag,
        is_active: c.isActive,
      })),
    });
  },
};

export const listWorkItemsTool: McpTool = {
  name: 'list_work_items',
  description:
    'List work items — the second level of the time-entry taxonomy. A time entry REQUIRES a work item, and work items are NOT seeded when a company is set up, so a category with zero work items cannot be booked against. Omit category_id to audit every category at once; an empty result for a category is the signal to call create_work_item.',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      category_id: { type: 'string', description: 'Job category UUID from list_job_categories.' },
      include_inactive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['category_id'] });
    if (guard) return guard;

    const items = await listWorkItems(
      ctx.companyId,
      strArg(args, 'category_id'),
      args.include_inactive === true,
    );
    return ok({
      work_items: items.map((w) => ({
        id: w.id,
        category_id: w.categoryId,
        name: w.name,
        is_active: w.isActive,
        default_billable: w.defaultBillable,
      })),
    });
  },
};

export const listTimeEntriesTool: McpTool = {
  name: 'list_time_entries',
  description:
    'List logged time entries. Defaults to the calling user\'s own entries; pass all_users to see the whole practice. date_from/date_to are inclusive ISO dates (YYYY-MM-DD).',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', description: 'Inclusive ISO date, e.g. "2026-09-01".' },
      date_to: { type: 'string', description: 'Inclusive ISO date.' },
      status: { type: 'string', enum: [...ENTRY_STATUSES] },
      practice_client_id: { type: 'string' },
      all_users: {
        type: 'boolean',
        description: 'False (default) restricts to the calling user\'s entries. True returns every user in the company.',
      },
      limit: { type: 'number', description: 'Default 50, max 200.' },
      offset: { type: 'number' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, {
      uuid: ['practice_client_id'],
      date: ['date_from', 'date_to'],
    });
    if (guard) return guard;

    const offsetRaw = Number(args.offset);
    const { entries, total } = await listPracticeEntries(ctx.companyId, {
      // Default to the token's own user. An agent that wants the practice-wide
      // view has to say so, so a naive "how much time did I log" cannot quietly
      // return a colleague's hours.
      userId: args.all_users === true ? undefined : ctx.userId,
      dateFrom: strArg(args, 'date_from'),
      dateTo: strArg(args, 'date_to'),
      // Narrowed via the schema enum; the cast is the enum, not a guess.
      status: strArg(args, 'status') as (typeof ENTRY_STATUSES)[number] | undefined,
      practiceClientId: strArg(args, 'practice_client_id'),
      limit: clampLimit(args, 50, 200),
      offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
    });
    return ok({
      total,
      entries: entries.map((e) => ({
        id: e.id,
        entry_date: e.entryDate,
        hours: e.hours,
        status: e.status,
        billable: e.billable,
        practice_client: e.practiceClientName,
        job_category: e.jobCategoryName,
        work_item: e.workItemName,
        task_description: e.taskDescription,
        applied_rate: e.appliedRate,
        line_total: e.lineTotal,
      })),
    });
  },
};
