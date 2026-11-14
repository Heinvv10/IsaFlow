/**
 * MCP read tool: list_missing_documents — which accounting documents have NO supporting document on file.
 *
 * The audit question "what is undocumented?" across the app's document types in one call: supplier bills, customer
 * invoices, credit notes, bank spend lines and journals that claim input VAT. "Has a document" is computed from the
 * document tables on every call (core/documentPresenceSql, bank/bankLineDocumentSql, reports/vatInputSupport) — the
 * same tests as the bill hasDocument flag, the "Missing document" filter and the pre-filing VAT warnings.
 *
 * Read scope per type, as the existing list tools: the tool needs read:reports; supplier_invoice, customer_invoice and
 * credit_note also need read:invoices, bank_transaction read:bank-tx, vat_journal read:vat. Types the token cannot
 * read are left out and named in skipped_entity_types; naming one explicitly is refused.
 */
import type { McpTool } from '../types';
import {
  MISSING_DOCUMENT_TYPES, type MissingDocumentKey, type MissingDocumentType,
} from '@/modules/accounting/services/core/missingDocumentsTypes';
import { listMissingDocuments } from '@/modules/accounting/services/core/missingDocumentsService';
import { buildEnvelope, decodeCursor, encodeCursor, isDetailLevel, type DetailLevel } from '../contracts';
import { todayInSast } from '@/lib/saDateParser';
import { shiftYearISO } from '@/lib/dateUtils';
import { insufficientScopeMessage } from '../scopeRemediation';
import { UUID_RE } from '@/lib/validation';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const MAX_LIMIT = 200;
/** Every page re-runs the scan, so the range is bounded. */
const MAX_RANGE_YEARS = 2;

const TYPE_SCOPE: Record<MissingDocumentType, string> = {
  supplier_invoice: 'read:invoices',
  customer_invoice: 'read:invoices',
  credit_note: 'read:invoices',
  bank_transaction: 'read:bank-tx',
  vat_journal: 'read:vat',
};

/** The tool that files a document against each type. */
const ATTACH_WITH: Record<MissingDocumentType, string> = {
  supplier_invoice: 'attach_entity_document',
  customer_invoice: 'attach_entity_document',
  credit_note: 'attach_entity_document',
  bank_transaction: 'attach_entity_document',
  vat_journal: 'link_document_to_journal',
};

function parseCursor(raw: string): MissingDocumentKey | null {
  const decoded = decodeCursor(raw, 3);
  if (!decoded) return null;
  const [cents, type, id] = decoded.parts as [string, string, string];
  if (!/^\d{1,15}$/.test(cents) || !UUID_RE.test(id)) return null;
  if (!(MISSING_DOCUMENT_TYPES as readonly string[]).includes(type)) return null;
  return { cents: Number(cents), entityType: type as MissingDocumentType, id: id.toLowerCase() };
}

export const listMissingDocumentsTool: McpTool = {
  name: 'list_missing_documents',
  description:
    'Accounting documents with NO supporting document on file: supplier bills, customer invoices, credit notes, bank SPEND lines and journals that claim input VAT. The audit test "what is undocumented?" in one call, largest first. ' +
    'Whether a document exists is computed from the document tables on every call, never read from a cached flag, and uses the same tests as the bill has_document flag, the bills "Missing document" filter, list_unsupported_transactions and the pre-filing VAT input warnings, so they agree. ' +
    'entity_types (default: every type this token may read): ' + MISSING_DOCUMENT_TYPES.join(', ') + '. Reading bills, invoices and credit notes needs read:invoices, bank lines read:bank-tx, VAT journals read:vat; types the token lacks the scope for come back in skipped_entity_types. ' +
    'from / to bound the document date (YYYY-MM-DD) and may span at most 24 months; default is the last 12 months to today, echoed back. min_amount is a materiality threshold on the absolute amount (default 0). ' +
    'A customer invoice counts as documented through the app\'s own PDF snapshot of the invoice it issued (its source document) as well as an uploaded file; a bill needs an uploaded file or a stored source scan, and a link to the bill\'s purchase order or goods receipt paperwork does not count. ' +
    'amount is the gross total for bills, invoices and credit notes, the absolute amount for a bank line, and the input VAT claimed for a vat_journal. ' +
    'summary gives, per type, candidates (rows checked), with_document, missing and missing_amount over the WHOLE range, not just the page; vat_journal has no candidates count because the VAT check reports only its exceptions. ' +
    'Draft and cancelled bills, invoices and credit notes are not checked; bank lines that are not spend, are excluded, or are own-account transfers are not either. A bank line whose receipt was filed against the related bill is still reported on the line (the two stores are not linked), and a VAT journal built from an undocumented bank line is reported under both types, so the per-type figures overlap and are not summed. ' +
    'detail "summary" returns the summary only. Rows are paged with next_cursor (at most ' + MAX_LIMIT + ' per page). Each row names the tool that files the missing document.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      entity_types: { type: 'array', items: { type: 'string', enum: [...MISSING_DOCUMENT_TYPES] } },
      from: { type: 'string', description: 'Document date from, YYYY-MM-DD. Default: 12 months before to.' },
      to: { type: 'string', description: 'Document date to, YYYY-MM-DD. Default: today.' },
      min_amount: { type: 'number', minimum: 0, description: 'Materiality threshold on the absolute amount. Default 0.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
      detail: { type: 'string', enum: ['summary', 'standard'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['from', 'to'] });
    if (bad) return bad;
    const to = strArg(args, 'to') ?? todayInSast();
    const from = strArg(args, 'from') ?? shiftYearISO(to, -1);
    if (from > to) return toolError('from must not be after to');
    if (from < shiftYearISO(to, -MAX_RANGE_YEARS)) {
      return toolError(`from and to may span at most ${MAX_RANGE_YEARS * 12} months (every page re-checks the whole range); narrow from, or work year by year`);
    }

    const raw = args.min_amount;
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) {
      return toolError('min_amount must be a number of 0 or more — it is compared against the absolute amount');
    }
    const minAmount = raw === undefined ? 0 : Number(raw);

    const asked = args.entity_types;
    if (asked !== undefined && (!Array.isArray(asked) || asked.length === 0
      || !asked.every((t) => typeof t === 'string' && (MISSING_DOCUMENT_TYPES as readonly string[]).includes(t)))) {
      return toolError(`entity_types must be a non-empty list of: ${MISSING_DOCUMENT_TYPES.join(', ')}`);
    }
    const requested = asked === undefined
      ? [...MISSING_DOCUMENT_TYPES]
      : MISSING_DOCUMENT_TYPES.filter((t) => (asked as string[]).includes(t));
    const mayRead = (t: MissingDocumentType) => ctx.scopes.includes(TYPE_SCOPE[t]);
    const denied = requested.filter((t) => !mayRead(t));
    if (asked !== undefined && denied.length > 0) return toolError(insufficientScopeMessage(TYPE_SCOPE[denied[0]!]));
    const types = requested.filter(mayRead);
    if (types.length === 0) return toolError(insufficientScopeMessage('read:invoices'));

    const rawCursor = strArg(args, 'cursor');
    const after = rawCursor === undefined ? null : parseCursor(rawCursor);
    if (rawCursor !== undefined && after === null) return toolError('invalid cursor');

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) && rawDetail !== 'full' ? rawDetail : 'standard';
    const limit = detail === 'summary' ? 1 : clampLimit(args, 50, MAX_LIMIT);

    const page = await listMissingDocuments({ companyId: ctx.companyId, types, from, to, minAmount, limit, after });
    const rowsTotal = page.summary.reduce((n, s) => n + s.missing, 0);
    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : page.rows.map((r) => ({
        entity_type: r.entityType,
        entity_id: r.entityId,
        date: r.documentDate,
        amount: r.amount,
        reference: r.reference,
        counterparty: r.counterparty,
        description: r.description,
        status: r.status,
        ...(r.reason === null ? {} : { reason: r.reason }),
        attach_with: ATTACH_WITH[r.entityType],
      })),
      rowsTotal,
      detail,
      as_at: to,
      posted_through: null,
      next_cursor: detail === 'summary' || page.next === null
        ? null : encodeCursor({ parts: [String(page.next.cents), page.next.entityType, page.next.id] }),
    });
    return ok({
      ...envelope,
      from,
      to,
      min_amount: minAmount,
      entity_types: types,
      skipped_entity_types: denied.map((t) => ({ entity_type: t, needs_scope: TYPE_SCOPE[t] })),
      summary: page.summary.map((s) => ({
        entity_type: s.entityType,
        candidates: s.candidates,
        with_document: s.withDocument,
        missing: s.missing,
        missing_amount: s.missingAmount,
      })),
    });
  },
};
