/**
 * External references on MCP creates, and find_by_external_ref (brief step 3).
 *
 * A create tool that accepts `external_ref` (+ `external_system`, optional
 * `external_document_number`) becomes idempotent on it:
 *
 *   1. createReplayOrLock() takes the per-reference transaction lock, then looks for a LIVE row
 *      already carrying that reference. If there is one, the tool returns it (already_existed: true)
 *      and writes nothing — a Sage document loaded twice, or a retried create, never doubles.
 *   2. Otherwise the tool creates as before and calls stampCreated(), which writes the reference onto
 *      the new row inside the same transaction.
 *
 * A cancelled or soft-deleted row with the reference does not block a new create (it is listed as
 * `superseded` in find_by_external_ref instead).
 */
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { EXTERNAL_REF_ARG_SCHEMA, parseExternalRef } from '../contracts/externalRef';
import {
  EXTERNAL_REF_KIND_ALIASES, EXTERNAL_REF_KINDS, findByExternalRef, lockExternalRef, stampExternalRef,
  type ExternalRefKind, type ExternalRefMatch,
} from '@/modules/accounting/services/core/externalRefService';
import { ok, toolError } from './toolHelpers';

/** Spread into a create tool's inputSchema.properties. */
export const EXTERNAL_REF_CREATE_PROPS = {
  ...EXTERNAL_REF_ARG_SCHEMA,
  external_ref: {
    ...EXTERNAL_REF_ARG_SCHEMA.external_ref,
    description:
      "The source system's own id for this record (e.g. Sage's numeric id). With external_system, makes the create IDEMPOTENT: "
      + 'if a live record of this kind already carries the same (external_system, external_ref), it is returned with already_existed: true and nothing is written.',
  },
} as const;

export interface ParsedCreateRef { system: string; ref: string; documentNumber: string | null }

/** null = no reference given; string = refusal text; otherwise the reference. */
export function parseCreateRef(args: Record<string, unknown>): ParsedCreateRef | string | null {
  const p = parseExternalRef(args);
  if (!p.ok) return p.error;
  const { external_ref: ref, external_system: system, external_document_number: doc } = p.value;
  if (!ref) return doc || system ? 'external_ref is required when external_system or external_document_number is given' : null;
  if (!system) return 'external_system is required with external_ref (e.g. "sage")';
  return { system: system.toLowerCase(), ref, documentNumber: doc ?? null };
}

const matchOut = (m: ExternalRefMatch) => ({
  entity_type: m.entityType,
  id: m.id,
  number: m.number,
  status: m.status,
  date: m.date,
  total_amount: m.totalAmount,
  external_document_number: m.externalDocumentNumber,
  ...(m.creditNoteType ? { credit_note_type: m.creditNoteType } : {}),
});

/**
 * Lock the reference and return the replay result when a live row already has it.
 * Returns null when the caller should go on and create.
 */
export async function createReplayOrLock(
  ctx: McpToolContext, kind: ExternalRefKind, ref: ParsedCreateRef | null,
  opts: { creditNoteType?: 'supplier' | 'customer' } = {},
): Promise<McpToolResult | null> {
  if (!ref) return null;
  await lockExternalRef(ctx.companyId, kind, ref.system, ref.ref);
  const live = (await findByExternalRef(ctx.companyId, kind, ref.system, ref.ref, opts)).filter((m) => m.live);
  if (live.length === 0) return null;
  return {
    ...ok({
      already_existed: true,
      ...matchOut(live[0]!),
      external_system: ref.system,
      external_ref: ref.ref,
      ...(live.length > 1 ? { other_live_ids: live.slice(1).map((m) => m.id) } : {}),
      note: 'A record with this external reference already exists; nothing was created.',
    }),
    wroteNothing: true,
  };
}

export async function stampCreated(ctx: McpToolContext, kind: ExternalRefKind, id: string, ref: ParsedCreateRef | null): Promise<void> {
  if (ref) await stampExternalRef(ctx.companyId, kind, id, ref);
}

/** The scope each kind's own list tool needs, so this tool reads nothing a token could not already list. */
export const KIND_SCOPE: Record<ExternalRefKind, string> = {
  supplier_invoice: 'read:invoices',
  customer_invoice: 'read:invoices',
  credit_note: 'read:invoices',
  journal: 'read:reports',
  bank_transaction: 'read:bank-tx',
  supplier: 'read:contacts',
  customer: 'read:contacts',
};

export const findByExternalRefTool: McpTool = {
  name: 'find_by_external_ref',
  description:
    'Look up IsaFlow records by a source system\'s own id, e.g. a Sage document id, before creating it again. '
    + `kind: ${EXTERNAL_REF_KINDS.join(', ')}, or a Sage code (${Object.keys(EXTERNAL_REF_KIND_ALIASES).join(', ')}; ret/cret = supplier/customer credit notes). `
    + 'Returns found: false, or the live match (record) plus any superseded (cancelled, reversed or deleted) rows carrying the same reference. '
    + 'Only records created or imported with external_ref are found; older loads that put the Sage id in a description are not. '
    + 'Needs the read permission of that kind\'s own list tool (read:invoices, read:reports for journals, read:bank-tx, read:contacts).',
  // Per kind, the scope of that kind's own list tool (KIND_SCOPE); the registry checks none.
  scope: null,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', maxLength: 32, description: 'The external_system, e.g. "sage"' },
      kind: { type: 'string', enum: [...EXTERNAL_REF_KINDS, ...Object.keys(EXTERNAL_REF_KIND_ALIASES)] },
      id: { type: ['string', 'integer'], description: 'The source system\'s id for the record' },
    },
    required: ['source', 'kind', 'id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const source = typeof args.source === 'string' ? args.source.trim().toLowerCase() : '';
    if (!source || source.length > 32) return toolError('source is required (at most 32 characters)');
    const rawId = typeof args.id === 'number' && Number.isInteger(args.id) ? String(args.id) : typeof args.id === 'string' ? args.id.trim() : '';
    if (!rawId || rawId.length > 128) return toolError('id is required (at most 128 characters)');
    const alias = typeof args.kind === 'string' ? EXTERNAL_REF_KIND_ALIASES[args.kind] : undefined;
    const kind = alias?.kind ?? ((EXTERNAL_REF_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as ExternalRefKind) : null);
    if (!kind) return toolError(`kind must be one of: ${[...EXTERNAL_REF_KINDS, ...Object.keys(EXTERNAL_REF_KIND_ALIASES)].join(', ')}`);

    if (!ctx.scopes.includes(KIND_SCOPE[kind])) {
      return toolError(`Looking up a ${kind} needs the ${KIND_SCOPE[kind]} permission.`);
    }

    const matches = await findByExternalRef(ctx.companyId, kind, source, rawId, { creditNoteType: alias?.creditNoteType });
    const live = matches.filter((m) => m.live);
    return ok({
      found: live.length > 0,
      kind,
      source,
      id: rawId,
      record: live[0] ? matchOut(live[0]) : null,
      ...(live.length > 1 ? { other_live: live.slice(1).map(matchOut) } : {}),
      superseded: matches.filter((m) => !m.live).map(matchOut),
    });
  },
};
