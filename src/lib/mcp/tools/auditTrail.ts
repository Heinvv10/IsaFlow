/**
 * MCP read tool: audit_trail. Supersedes list_agent_postings, which could only
 * ever see the postings that were already provable (`posting_agent LIKE
 * 'mcp:%'`) and was therefore blind to exactly the rows an auditor needs.
 */
import type { McpTool } from '../types';
import {
  queryAuditTrail,
  AUDIT_ENTITY_TYPES,
  AUDIT_ACTIONS,
  type AuditEntityType,
  type AuditAction,
} from '@/modules/accounting/services/gl/auditTrailLedgerService';
import { ACTOR_TYPES, isActorType } from '../contracts/actor';
import { buildEnvelope, isDetailLevel, decodeCursor, type DetailLevel } from '../contracts';
import { clampLimit, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const MAX_LIMIT = 200;

export const auditTrailTool: McpTool = {
  name: 'audit_trail',
  description:
    'WHO POSTED TO THE GENERAL LEDGER, and whether that attribution is a recorded fact or an inference. ' +
    'One row per GL journal entry in an entry-date range, with the actor (human | agent | system), the MCP token behind an agent posting, the posting_agent stamp, and the entry\'s status and amount. ' +
    'TWO PEOPLE, NOT ONE: user_id/user_name is who RAISED the entry, posted_by_user_id/posted_by_user_name is who COMMITTED it to the ledger. Across every production company today those are the SAME person on every single journal — there is no segregation of duties anywhere in this system, and that is a control conclusion you can state from this endpoint in one line rather than sampling for it. A draft has no poster at all. company_id, on the response rather than on each row, is whose books these are — the token decides it, so a page is never mixed. ' +
    'WHICH FIRM the actor was acting for is acting_company_id — the practice, on a client engagement. Read acting_company_known first: when it is false the firm was NOT RECORDED, and cross_company is null, meaning UNKNOWN. Null is not "in-house": it is the absence of a record, and every row written before migration 581 has it. Never read a null as "posted from inside this company". Filter posted_from_outside_this_company to get only postings made into these books by someone acting for a DIFFERENT recorded company — the first question a client\'s auditor asks of a practice engagement. Rows with no recorded firm can never satisfy it, so that filter under-reports while the write side is still being built. ' +
    'READ actor_provenance ON EVERY ROW. "recorded" means the write itself stored the actor. "derived" means it was inferred from the posting_agent stamp because the row predates that column, and the inference is ASYMMETRIC: an "mcp:" stamp does prove an agent, but a "human:" one proves only "not stamped as an agent" — journal creation falls back to a human stamp whenever a caller omits the posting metadata, so an unknown number of agent postings sit under derived human. actor_caveat spells this out per row. Never report a derived human as a person having typed the entry. ' +
    'AND A RECORDED HUMAN IS A WEAKER CLAIM THAN IT LOOKS: nothing in IsaFlow writes actor_type "human" by default, so a recorded human means some caller explicitly asserted one — it is not produced by a person using the UI, and the absence of an agent stamp is not proof of a person. An agent posting is provable; a human posting is not. Say "not recorded as an agent", never "typed by a person". ' +
    'The attribution block totals recorded vs derived across the whole filtered range (not just the page), which is the honest measure of how much of this ledger can be relied on. ' +
    'DOES NOT COVER: non-ledger changes. Editing a customer, changing a bank rule or logging in leaves no journal and does not appear here; the separate audit_log table holds field-level change history and is effectively unused (5 rows across production). Nor does it cover documents that have not posted — an unapproved draft invoice or credit note has no journal yet. ' +
    'entity_id needs an entity_type saying which link to match: "journal" = the entry\'s own id, "source_record" = the bank transaction / invoice / credit note it was raised from, "source_document" = the captured document. ' +
    'universeTotal is present unless an actor_type, token_jti or acting_company_id filter is applied — with one the result is a selection, not a census, and completeness is not a claim being made. Rows whose actor cannot be established at all (neither column set) are never counted in the totals; they appear in excludedRows with reason "unattributed_posting", and excludedTotal counts ALL of them while excludedRows shows at most 200 — truncatedExcludedRows tells you when the list is shorter than the count. ' +
    'Paginate with next_cursor; at most 200 rows per page. Free to call — reviewing what was posted is the control every write depends on.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Entry date from, YYYY-MM-DD (inclusive).' },
      to: { type: 'string', description: 'Entry date to, YYYY-MM-DD (inclusive).' },
      actor_type: { type: 'string', enum: [...ACTOR_TYPES], description: 'Matches recorded actors AND the equivalent legacy posting_agent stamp.' },
      token_jti: { type: 'string', description: 'Only postings made by one MCP token — the first question after a credential is withdrawn. Recorded postings only.' },
      acting_company_id: { type: 'string', description: 'Only postings made while acting for this firm. Recorded firms only; rows with no recorded firm never match.' },
      posted_from_outside_this_company: { type: 'boolean', description: 'Only postings whose recorded acting company DIFFERS from the company whose books these are. Rows with no recorded firm are excluded — they cannot answer the question either way.' },
      user_id: { type: 'string', description: 'The user the entry is booked against (created_by).' },
      source: { type: 'string', description: 'Journal source, e.g. manual, auto_bank_recon, auto_invoice.' },
      entity_type: { type: 'string', enum: [...AUDIT_ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'Requires entity_type.' },
      action: { type: 'string', enum: [...AUDIT_ACTIONS], description: 'Derived from the entry: reversed beats posted beats draft.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'], description: 'summary returns totals and the attribution census with no rows.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const from = strArg(args, 'from');
    const to = strArg(args, 'to');
    if (!from || !to) return toolError('from and to are required, formatted YYYY-MM-DD');
    // These reach an entry_date comparison; a read tool has no savepoint, so a
    // 22008 there aborts the whole request transaction.
    const bad = guardCastableArgs(args, { date: ['from', 'to'] });
    if (bad) return bad;

    const actorTypeRaw = strArg(args, 'actor_type');
    if (actorTypeRaw !== undefined && !isActorType(actorTypeRaw)) {
      return toolError(`invalid actor_type — expected one of: ${ACTOR_TYPES.join(', ')}`);
    }
    const entityId = strArg(args, 'entity_id');
    const entityType = strArg(args, 'entity_type');
    if (entityId !== undefined && entityType === undefined) {
      return toolError(`entity_id requires entity_type — one of: ${AUDIT_ENTITY_TYPES.join(', ')}`);
    }
    if (entityType !== undefined && !(AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return toolError(`invalid entity_type — expected one of: ${AUDIT_ENTITY_TYPES.join(', ')}`);
    }
    const action = strArg(args, 'action');
    if (action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      return toolError(`invalid action — expected one of: ${AUDIT_ACTIONS.join(', ')}`);
    }
    const detailRaw = strArg(args, 'detail');
    if (detailRaw !== undefined && !isDetailLevel(detailRaw)) {
      return toolError('invalid detail — expected one of: summary, standard, full');
    }
    const detail: DetailLevel = detailRaw ?? 'standard';

    // acting_company_id reaches a ::TEXT comparison, but guard it anyway: a
    // caller passing a company NAME should be told which argument is wrong.
    const badUuid = guardCastableArgs(args, { uuid: ['acting_company_id'] });
    if (badUuid) return badUuid;

    const rawCursor = strArg(args, 'cursor');
    // Two parts: (entry_date, id) — the page's own ordering.
    const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor, 2);
    if (rawCursor !== undefined && cursor === null) return toolError('invalid cursor');

    try {
      const page = await queryAuditTrail(ctx.companyId, {
        from,
        to,
        limit: clampLimit(args, 50, MAX_LIMIT),
        ...(actorTypeRaw === undefined ? {} : { actorType: actorTypeRaw }),
        ...(strArg(args, 'token_jti') === undefined ? {} : { tokenJti: strArg(args, 'token_jti')! }),
        ...(strArg(args, 'acting_company_id') === undefined
          ? {} : { actingCompanyId: strArg(args, 'acting_company_id')! }),
        ...(args.posted_from_outside_this_company === true ? { crossCompanyOnly: true } : {}),
        ...(strArg(args, 'user_id') === undefined ? {} : { userId: strArg(args, 'user_id')! }),
        ...(strArg(args, 'source') === undefined ? {} : { source: strArg(args, 'source')! }),
        ...(entityType === undefined ? {} : { entityType: entityType as AuditEntityType }),
        ...(entityId === undefined ? {} : { entityId }),
        ...(action === undefined ? {} : { action: action as AuditAction }),
        cursor,
      });

      const envelope = buildEnvelope({
        rows: detail === 'summary' ? [] : page.rows.map(toWireRow),
        rowsTotal: page.rowsTotal,
        detail,
        as_at: to,
        posted_through: page.postedThrough,
        next_cursor: page.nextCursor,
        excludedRows: page.excludedRows,
        // The COUNT, not the 200-row sample. buildEnvelope checks
        // rowsTotal + excludedTotal === universeTotal and sets
        // truncatedExcludedRows when the list is shorter than the count.
        excludedTotal: page.excludedTotal,
        ...(page.universeTotal === undefined ? {} : { universeTotal: page.universeTotal }),
      });
      // The census rides alongside the envelope: it is the finding, not a row.
      // company_id is stated ONCE rather than repeated on every row: the whole
      // page is one company's books, because scope comes from the token.
      return ok({
        ...envelope,
        company_id: ctx.companyId,
        from,
        to,
        attribution: page.attribution,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to read the audit trail.'));
    }
  },
};

type Entry = Awaited<ReturnType<typeof queryAuditTrail>>['rows'][number];

/** snake_case on the wire, matching every other tool's row shape. */
function toWireRow(r: Entry) {
  return {
    journal_entry_id: r.journalEntryId,
    entry_number: r.entryNumber,
    entry_date: r.entryDate,
    description: r.description,
    source: r.source,
    status: r.status,
    action: r.action,
    amount: r.amount,
    actor_type: r.actorType,
    actor_provenance: r.actorProvenance,
    actor_caveat: r.actorCaveat,
    actor_token_jti: r.actorTokenJti,
    acting_company_id: r.actingCompanyId,
    acting_company_known: r.actingCompanyKnown,
    cross_company: r.crossCompany,
    acting_company_caveat: r.actingCompanyCaveat,
    posting_agent: r.postingAgent,
    user_id: r.userId,
    user_name: r.userName,
    posted_by_user_id: r.postedByUserId,
    posted_by_user_name: r.postedByUserName,
    created_at: r.createdAt,
    posted_at: r.postedAt,
    reversed_at: r.reversedAt,
    reversal_of_id: r.reversalOfId,
    source_record_id: r.sourceRecordId,
  };
}
