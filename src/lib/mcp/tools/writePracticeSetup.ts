/**
 * MCP write tools: practice setup (the job taxonomy a time entry needs).
 *
 * These post nothing to the ledger, so neither is `requiresPost`. They are the
 * remedy for the state that blocks time entry entirely: categories are seeded
 * on first client creation, work items never are, so a live practice sits on N
 * categories and zero work items and every time entry is refused because
 * work_item_id is required. Pricing the remedy for that would be the wrong
 * incentive, so both are free — same rule as the chart-of-accounts tools.
 */
import type { McpTool } from '../types';
import {
  createJobCategory,
  createWorkItem,
  listJobCategories,
  listWorkItems,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';
import { guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

export const createJobCategoryTool: McpTool = {
  name: 'create_job_category',
  description:
    'Create a job category — the top level of the time-entry taxonomy. A category on its own cannot be booked against: create_work_item must add at least one work item under it before time can be logged. Call list_job_categories first; names are not deduplicated for you.',
  scope: 'write:practice',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'e.g. "VAT", "Payroll", "Financial Statements".' },
      reporting_tag: { type: 'string', description: 'Optional grouping label used by practice reports.' },
      sort_order: { type: 'number' },
      idempotency_key: { type: 'string' },
    },
    required: ['name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const name = strArg(args, 'name');
    if (!name) return toolError('name is required');

    // A duplicate name is not a DB error here (no unique index), so it would
    // silently produce a second identical category that splits the practice's
    // reporting. Refuse instead — the agent can reuse the id it gets back.
    const existing = await listJobCategories(ctx.companyId, true);
    const clash = existing.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (clash) {
      return toolError(`A job category named "${clash.name}" already exists (id ${clash.id}).`);
    }

    const sortOrderRaw = Number(args.sort_order);
    try {
      const category = await createJobCategory(ctx.companyId, {
        name,
        reportingTag: strArg(args, 'reporting_tag'),
        sortOrder: Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : undefined,
      });
      return ok({
        id: category.id,
        name: category.name,
        reporting_tag: category.reportingTag,
        is_active: category.isActive,
        next_step: 'Add at least one work item with create_work_item before logging time against this category.',
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not create the job category.'));
    }
  },
};

export const createWorkItemTool: McpTool = {
  name: 'create_work_item',
  description:
    'Create a work item under a job category — the second level of the time-entry taxonomy, and the one log_time_entry requires. Work items are NOT seeded when a company is set up, so a category returning an empty list_work_items needs this before any time can be booked against it. default_billable seeds the entry\'s billable flag and defaults to true.',
  scope: 'write:practice',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      category_id: { type: 'string', description: 'Job category UUID from list_job_categories.' },
      name: { type: 'string', description: 'e.g. "VAT201 submission", "Monthly processing".' },
      default_billable: { type: 'boolean', description: 'Defaults to true.' },
      sort_order: { type: 'number' },
      idempotency_key: { type: 'string' },
    },
    required: ['category_id', 'name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['category_id'] });
    if (guard) return guard;

    const categoryId = strArg(args, 'category_id');
    const name = strArg(args, 'name');
    if (!categoryId) return toolError('category_id is required');
    if (!name) return toolError('name is required');

    // createWorkItem refuses a category from another tenant, but its message is
    // the generic service one. Check here too so a duplicate NAME inside the
    // category is caught in the same pass — an unnoticed second "VAT201
    // submission" splits every service-mix report thereafter.
    const siblings = await listWorkItems(ctx.companyId, categoryId, true);
    const clash = siblings.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
    if (clash) {
      return toolError(`A work item named "${clash.name}" already exists in this category (id ${clash.id}).`);
    }

    const sortOrderRaw = Number(args.sort_order);
    try {
      const item = await createWorkItem(ctx.companyId, categoryId, {
        name,
        defaultBillable: args.default_billable === undefined ? true : args.default_billable === true,
        sortOrder: Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : undefined,
      });
      return ok({
        id: item.id,
        category_id: item.categoryId,
        name: item.name,
        is_active: item.isActive,
        default_billable: item.defaultBillable,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not create the work item.'));
    }
  },
};
