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
import { NOT_FOUND, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

/**
 * The pre-check below is read-then-write and cannot be atomic on its own, so
 * migration 527 puts a unique index behind it. Under concurrency the INSERT is
 * what actually loses, and it does so as a 23505 — translate that back into the
 * same refusal the pre-check would have given rather than a generic failure the
 * agent cannot act on.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export const createJobCategoryTool: McpTool = {
  name: 'create_job_category',
  description:
    'Create a job category — the top level of the time-entry taxonomy. A category on its own cannot be booked against: create_work_item must add at least one work item under it before time can be logged. Names are unique per company, case- and whitespace-insensitively; a clash is refused and the reply names the existing id.',
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

    // Pre-check so the agent gets the clashing id back and can reuse it,
    // rather than only a 23505 it has to look up. The index added in migration
    // 527 is what actually makes this safe under concurrency.
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
      if (isUniqueViolation(err)) {
        return toolError(`A job category named "${name}" already exists.`);
      }
      return toolError(safeErrorText(err, 'Could not create the job category.'));
    }
  },
};

export const createWorkItemTool: McpTool = {
  name: 'create_work_item',
  description:
    'Create a work item under a job category — the second level of the time-entry taxonomy, and the one log_time_entry requires. Work items are NOT seeded when a company is set up, so a category returning an empty list_work_items needs this before any time can be booked against it. Names are unique within a category, case- and whitespace-insensitively. default_billable seeds the entry\'s billable flag and defaults to true.',
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

    // The category id comes from the agent, so confirm it belongs to THIS
    // company before the service call, and refuse with the shared NOT_FOUND —
    // a distinct "belongs to another company" reply would be an existence
    // oracle (src/lib/mcp/AGENTS.md). createWorkItem re-checks too; this is the
    // layer that controls the wording.
    const categories = await listJobCategories(ctx.companyId, true);
    if (!categories.some((c) => c.id === categoryId)) return toolError(NOT_FOUND);

    // Pre-check so the agent gets the clashing id back; migration 527's index
    // is what holds under concurrency. An unnoticed second "VAT201 submission"
    // would split every service-mix report thereafter.
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
      if (isUniqueViolation(err)) {
        return toolError(`A work item named "${name}" already exists in this category.`);
      }
      // The service's own ownership check races the one above (a category
      // deactivated or deleted in between). Keep the shared wording.
      if (err instanceof Error && err.message === 'job category not found') {
        return toolError(NOT_FOUND);
      }
      return toolError(safeErrorText(err, 'Could not create the work item.'));
    }
  },
};
