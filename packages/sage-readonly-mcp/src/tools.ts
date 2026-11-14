/**
 * The five read-only tools. Each takes plain arguments and calls SageClient; none takes a
 * credential, a URL or a company (the company is the one in the env file).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_SIZE, SageClient, SageRequestError } from './client';
import { SageLockoutGuardError } from './lockout';
import { PULL_KINDS, RESOURCE_NAMES, resolveResource, type PullKind } from './endpoints';
import { partyBalance } from './partyBalance';
import { fail, isRealDateTime, odataDate, ok, type ToolResult } from './result';

export type { ToolResult } from './result';

export interface SageTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, deps: { client: SageClient; downloadDir: string }): Promise<ToolResult>;
}

const MAX_PULL_PAGES = 10;

function intArg(v: unknown, def: number, min: number, max: number): number | null {
  if (v === undefined) return def;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const pullSince: SageTool = {
  name: 'sage_pull_since',
  description:
    'Documents created or changed in Sage since a date, per kind: bank (bank transactions), siv (supplier invoices), '
    + 'ti (customer tax invoices), ret (supplier returns), cret (customer returns). Give a date (YYYY-MM-DD or '
    + 'YYYY-MM-DDTHH:MM:SS) for each kind you want. Reads up to max_pages pages of 100 per kind; next_page says where '
    + 'to continue (pass it back as page_start). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      ...Object.fromEntries(Object.keys(PULL_KINDS).map((k) => [k, { type: 'string', description: 'Modified on or after' }])),
      max_pages: { type: 'integer', minimum: 1, maximum: MAX_PULL_PAGES, description: 'Default 1' },
      page_start: { type: 'object', description: 'Per kind, the next_page a previous call returned', additionalProperties: { type: 'integer' } },
    },
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const kinds = (Object.keys(PULL_KINDS) as PullKind[]).filter((k) => args[k] !== undefined);
    if (kinds.length === 0) return fail(`Give a since-date for at least one of: ${Object.keys(PULL_KINDS).join(', ')}`);
    const maxPages = intArg(args.max_pages, 1, 1, MAX_PULL_PAGES);
    if (maxPages === null) return fail(`max_pages must be an integer 1-${MAX_PULL_PAGES}`);
    const starts = (args.page_start ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const kind of kinds) {
      const since = args[kind];
      if (typeof since !== 'string' || !isRealDateTime(since)) return fail(`${kind}: date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS`);
      const first = intArg(starts[kind], 0, 0, 100_000);
      if (first === null) return fail(`page_start.${kind} must be a non-negative integer`);
      const resource = PULL_KINDS[kind];
      const filter = `Modified ge ${odataDate(since)}`;
      const items: unknown[] = [];
      let total = 0;
      let page = first;
      let done = false;
      while (page < first + maxPages) {
        // ID breaks ties, so rows sharing a Modified time cannot move between pages.
        const p = await client.list(resource, { filter, orderBy: 'Modified,ID', page });
        total = p.totalResults;
        items.push(...p.results);
        page++;
        if (p.results.length === 0 || page * PAGE_SIZE >= total) { done = true; break; }
      }
      out[kind] = { resource, since, total, returned: items.length, next_page: done ? null : page, items };
    }
    return ok(out);
  },
};

const getDocument: SageTool = {
  name: 'sage_get_document',
  description: `One Sage record by numeric id. type is a short kind (${Object.keys(PULL_KINDS).join(', ')}) or a resource name (${RESOURCE_NAMES.join(', ')}). Read-only.`,
  inputSchema: {
    type: 'object',
    properties: { type: { type: 'string' }, id: { type: ['integer', 'string'] } },
    required: ['type', 'id'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const resource = typeof args.type === 'string' ? resolveResource(args.type) : null;
    if (!resource) return fail(`Unknown type. Use one of: ${[...Object.keys(PULL_KINDS), ...RESOURCE_NAMES].join(', ')}`);
    return ok({ resource, document: await client.get(resource, args.id as string | number) });
  },
};

const list: SageTool = {
  name: 'sage_list',
  description:
    `One page (100 rows) of a Sage resource: ${RESOURCE_NAMES.join(', ')}. filter is an OData $filter `
    + "(e.g. \"SupplierId eq 123 and Date ge datetime'2026-11-01T00:00:00'\"); order_by an OData $orderby; page is zero-based. Read-only.",
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: RESOURCE_NAMES },
      filter: { type: 'string' },
      order_by: { type: 'string' },
      page: { type: 'integer', minimum: 0 },
    },
    required: ['service'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const resource = typeof args.service === 'string' ? resolveResource(args.service) : null;
    if (!resource) return fail(`service must be one of: ${RESOURCE_NAMES.join(', ')}`);
    const page = intArg(args.page, 0, 0, 100_000);
    if (page === null) return fail('page must be a non-negative integer');
    const p = await client.list(resource, {
      filter: typeof args.filter === 'string' ? args.filter : undefined,
      orderBy: typeof args.order_by === 'string' ? args.order_by : undefined,
      page,
    });
    return ok({ resource, page, total: p.totalResults, returned: p.returnedResults, next_page: (page + 1) * PAGE_SIZE < p.totalResults ? page + 1 : null, items: p.results });
  },
};

const download: SageTool = {
  name: 'sage_download_attachment',
  description:
    'Download one Sage attachment by numeric id to the local download folder and return its path, size, sha256 and '
    + 'content type (the bytes themselves are not returned). Find ids with sage_list service "Attachment". Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: ['integer', 'string'] }, file_name: { type: 'string', description: 'Optional name to save as' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args, { client, downloadDir }) => {
    const { bytes, contentType } = await client.download(args.id as string | number);
    const safe = (typeof args.file_name === 'string' ? args.file_name : 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.').slice(0, 120);
    mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
    const path = join(downloadDir, `${String(args.id)}-${safe.replace(/^\.+/, '') || 'attachment'}`);
    // Replace, never write through: an existing path (or a symlink planted there) is removed first and
    // the file is created fresh (wx), so it always gets mode 600 and lands in the download folder.
    rmSync(path, { force: true });
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    return ok({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_type: contentType });
  },
};

const balance: SageTool = {
  name: 'sage_party_balance',
  description:
    'A supplier\'s or customer\'s balance in Sage, by numeric id or exact name. Without as_at it is Sage\'s own Balance '
    + 'field (balance). With as_at (YYYY-MM-DD) it is documents_balance, flagged incomplete: true, COMPUTED from the documents dated on or before it (invoices less returns '
    + 'less payments/receipts; adjustments and opening balances are listed but NOT counted), with the components; when as_at is today '
    + 'or later, Sage\'s own figure and the difference are returned too. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      party: { type: 'string', enum: ['supplier', 'customer'] },
      id: { type: ['integer', 'string'] },
      name: { type: 'string' },
      as_at: { type: 'string' },
    },
    required: ['party'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => partyBalance(args, client),
};

export const TOOLS: SageTool[] = [pullSince, balance, getDocument, download, list];

/** Runs a tool, turning the client's own refusals into tool errors (they are safe to show). */
export async function callTool(name: string, args: Record<string, unknown>, deps: { client: SageClient; downloadDir: string }): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`Unknown tool: ${name}`);
  try {
    return await tool.handler(args, deps);
  } catch (err) {
    if (err instanceof SageRequestError || err instanceof SageLockoutGuardError) return fail(err.message);
    throw err;
  }
}
