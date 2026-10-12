/**
 * MCP tools for audit snapshots (forensic-controls step 4, migration 890):
 *  - audit_snapshots         list / get (with the check run and its findings) / verify — owner, admin, manager;
 *  - compare_audit_snapshot  against today's books or a later snapshot — owner, admin, manager;
 *  - take_audit_snapshot     take one now — owner / admin token holders with write:journals (the scope a period
 *                            close already needs, and a close takes a snapshot anyway; no new scope, no re-grant).
 * Reading is read:reports, as every report tool.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { auditRefusal, mayReadAudit, mayTakeAudit } from '@/modules/accounting/services/audit/auditAccess';
import { principalFromRequest } from '@/modules/accounting/services/audit/auditTx';
import { takeSnapshot } from '@/modules/accounting/services/audit/snapshotService';
import { getCheckRun, getSnapshot, listSnapshots } from '@/modules/accounting/services/audit/snapshotRead';
import { verifyChain, verifySnapshot } from '@/modules/accounting/services/audit/snapshotVerify';
import { compareSnapshotToLive, compareSnapshots } from '@/modules/accounting/services/audit/comparisonService';
import { withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';
import { chargeAuditJob } from '@/lib/auth/autoRateLimit';

/** The web routes' audit bucket, charged per member: MCP requests all arrive on /api/mcp, which no URL bucket matches. */
const RATE_LIMITED = 'Too many audit jobs (verify, chain, compare, take) in a minute — at most 30 per member. Try again shortly.';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const CAVEAT = 'A snapshot holds the current values of records dated on or before its cutoff, as at taken_at — not the '
  + 'historical database state.';

/** A refusal the services raise on purpose, as the tool's error; anything else is rethrown. */
function refused(err: unknown) {
  const r = auditRefusal(err);
  if (!r) throw err;
  return toolError(`${r.code}: ${r.message}`);
}

export const auditSnapshotsTool: McpTool = {
  name: 'audit_snapshots',
  description:
    'SEALED AUDIT SNAPSHOTS OF THE BOOKS. Without snapshot_id: the company\'s snapshots, newest first — cutoff, when and '
    + 'by whom taken, trigger (manual / period_close / vat_lock / year_close), status (sealed, or failed with the reason), '
    + 'canonical hash; status unchanged = the books (ledger, ageing and control totals) read the same as an earlier sealed snapshot (same_as_snapshot_id), with its own sealed check run. '
    + 'verify_chain: true checks the company\'s chain of sealed snapshots for a missing or replaced link, and lists sealed rows whose seal does not verify (forged) separately. '
    + 'With snapshot_id: that snapshot\'s header and totals plus its check run (15 integrity checks, the '
    + 'anomaly scan and the journal-risk leads, each with status pass / fail / unknown and its findings). With verify: '
    + 'true: recompute every row hash and the canonical hash from what is stored and check the HMAC seal — status valid, '
    + `invalid (a row, hash or seal does not match, or the seal names a key the server does not hold), not_sealed or unchanged. ${CAVEAT} Owner, admin or manager.`,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      snapshot_id: { type: 'string', description: 'Id from this tool\'s list.' },
      verify: { type: 'boolean', description: 'With snapshot_id: verify the seal from the stored rows.' },
      verify_chain: { type: 'boolean', description: 'Without snapshot_id: check the company\'s chain of sealed snapshots (broken links, forged rows).' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['snapshot_id'] });
    if (bad) return bad;
    if (!mayReadAudit(ctx.companyRole)) return toolError(`Your role (${ctx.companyRole ?? 'unknown'}) cannot view audit snapshots.`);
    const id = strArg(args, 'snapshot_id');
    try {
      if (!id && args.verify_chain === true) {
        if (!(await chargeAuditJob(ctx.companyId, ctx.userId))) return toolError(RATE_LIMITED);
        return ok({ chain: await verifyChain(ctx.companyId) });
      }
      if (!id) return ok({ snapshots: await listSnapshots(ctx.companyId), caveat: CAVEAT });
      const snapshot = await getSnapshot(ctx.companyId, id);
      if (!snapshot) return toolError('Not found');
      if (args.verify === true) {
        if (!(await chargeAuditJob(ctx.companyId, ctx.userId))) return toolError(RATE_LIMITED);
        return ok({ verification: await withSnapshotSlot(ctx.companyId, false, () => verifySnapshot(ctx.companyId, id)) });
      }
      const checkRun = snapshot.checkRunId ? await getCheckRun(ctx.companyId, snapshot.checkRunId) : null;
      return ok({ snapshot, checkRun });
    } catch (err) {
      return refused(err);
    }
  },
};

export const compareAuditSnapshotTool: McpTool = {
  name: 'compare_audit_snapshot',
  description:
    'WHAT CHANGED IN THE BOOKS BEHIND A SNAPSHOT. Compares a sealed snapshot with today\'s books at its cutoff (or, with '
    + 'against_snapshot_id, with a later snapshot at the same or a later cutoff): journals dated on or before the cutoff '
    + 'that are new — backdated ones (created or posted after the snapshot was taken) listed with who and when — changed '
    + 'ones with field-level before / after and their line changes, removed ones with their status now, ones reversed '
    + 'after the snapshot, the closing balance of every account that moved, and (against today) master-data changes '
    + `recorded since the snapshot. Read-only. ${CAVEAT} Owner, admin or manager.`,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      snapshot_id: { type: 'string', description: 'The earlier snapshot (audit_snapshots).' },
      against_snapshot_id: { type: 'string', description: 'Optional: a later snapshot instead of today\'s books.' },
    },
    required: ['snapshot_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['snapshot_id', 'against_snapshot_id'] });
    if (bad) return bad;
    if (!mayReadAudit(ctx.companyRole)) return toolError(`Your role (${ctx.companyRole ?? 'unknown'}) cannot compare audit snapshots.`);
    const id = strArg(args, 'snapshot_id');
    if (!id) return toolError('snapshot_id is required');
    const against = strArg(args, 'against_snapshot_id');
    try {
      const p = principalFromRequest();
      if (!(await chargeAuditJob(ctx.companyId, ctx.userId))) return toolError(RATE_LIMITED);
      return ok({ comparison: await withSnapshotSlot(ctx.companyId, false, () => (against ? compareSnapshots(p, id, against) : compareSnapshotToLive(p, id))) });
    } catch (err) {
      return refused(err);
    }
  },
};

export const takeAuditSnapshotTool: McpTool = {
  name: 'take_audit_snapshot',
  description:
    'TAKE A SEALED AUDIT SNAPSHOT NOW at an accounting-date cutoff: the trial balance, every posted journal and line dated '
    + 'on or before it (each hashed), AR / AP ageing and control totals, and a check run, sealed with an HMAC. Append-only: '
    + 'it cannot be changed or deleted afterwards. Refused over the size cap (choose an earlier cutoff). Owner or admin '
    + `only; needs write:journals. Closing a period, locking a VAT period or closing a year takes one automatically. ${CAVEAT}`,
  scope: 'read:reports',
  requiresScope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      cutoff: { type: 'string', format: 'date', description: 'YYYY-MM-DD — the last accounting date frozen.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['cutoff', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['cutoff'] });
    if (bad) return bad;
    if (!mayTakeAudit(ctx.companyRole)) return toolError('Only an owner or admin can take an audit snapshot.');
    const cutoff = strArg(args, 'cutoff');
    if (!cutoff) return toolError('cutoff is required (YYYY-MM-DD)');
    try {
      if (!(await chargeAuditJob(ctx.companyId, ctx.userId))) return toolError(RATE_LIMITED);
      return ok({ snapshot: await takeSnapshot(principalFromRequest(), { cutoff, trigger: 'manual' }), caveat: CAVEAT });
    } catch (err) {
      return refused(err);
    }
  },
};
