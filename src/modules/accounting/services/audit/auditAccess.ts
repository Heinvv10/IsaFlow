/**
 * Who may do what with audit snapshots and check runs (forensic-controls
 * step 4) — the same rules RLS and the writers enforce in 890, said once for
 * the routes, the MCP tools and the UI:
 *  - read (list, detail, verify, compare): owner, admin, manager — manager is
 *    the payroll-detail reader, and snapshots carry no person data;
 *  - take a snapshot or a check run by hand, build a pack: owner, admin — a
 *    person in their own session (Login-as and tokens refused) on the web;
 *    over MCP an owner / admin token holder with write:journals.
 * And how each refusal reads, so a route and a tool answer alike.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { ISODate } from '@/lib/schemas/common';
import { isRealCalendarDate } from '@/lib/validation';
import { BankControlError } from '@/modules/accounting/services/bank/bankControlRefusal';
import { SigningKeyMissingError } from './seal';
import { SnapshotTimeBudgetError, SnapshotTooLargeError } from './snapshotService';
import { SnapshotBusyError } from './auditTx';
import { ComparisonError } from './comparisonService';
import { PackRefusedError } from './packExport';

/** YYYY-MM-DD that is also a real day: 2026-02-30 is a 422, not a 500 from the ::DATE cast. */
export const AuditDate = ISODate.refine(isRealCalendarDate, 'Must be a real calendar date');

export const AUDIT_READ_ROLES = ['owner', 'admin', 'manager'] as const;
export const AUDIT_TAKE_ROLES = ['owner', 'admin'] as const;

export const mayReadAudit = (role: string | null | undefined): boolean => (AUDIT_READ_ROLES as readonly string[]).includes(role ?? '');
export const mayTakeAudit = (role: string | null | undefined): boolean => (AUDIT_TAKE_ROLES as readonly string[]).includes(role ?? '');

export type AuditRefusal = { status: 400 | 403 | 404 | 409 | 413 | 503; code: string; message: string; details?: Record<string, unknown> };

/** A typed refusal for the errors the audit services raise on purpose; null for anything else (rethrow it). */
export function auditRefusal(err: unknown): AuditRefusal | null {
  if (err instanceof SnapshotTooLargeError) {
    return { status: 413, code: 'SNAPSHOT_TOO_LARGE', message: err.message, details: { lines: err.lines, max: err.max } };
  }
  if (err instanceof SnapshotTimeBudgetError) return { status: 413, code: 'SNAPSHOT_TOO_SLOW', message: err.message };
  if (err instanceof SnapshotBusyError) return { status: 409, code: 'SNAPSHOT_BUSY', message: err.message };
  if (err instanceof SigningKeyMissingError) return { status: 503, code: 'SIGNING_KEY_MISSING', message: err.message };
  if (err instanceof ComparisonError) return { status: 400, code: 'COMPARISON_REFUSED', message: err.message };
  if (err instanceof PackRefusedError) return { status: 400, code: 'PACK_REFUSED', message: err.message };
  if (err instanceof BankControlError) return { status: 403, code: err.code, message: err.message };
  return null;
}

const CODE_FOR: Record<AuditRefusal['status'], ErrorCode> = {
  400: ErrorCode.BAD_REQUEST, 403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT, 413: ErrorCode.PAYLOAD_TOO_LARGE,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

/** Answers `err` as its typed refusal; false when it is not one (the caller rethrows). */
export function respondAuditRefusal(res: NextApiResponse, err: unknown): boolean {
  const r = auditRefusal(err);
  if (!r) return false;
  apiResponse.error(res, CODE_FOR[r.status], r.message, { reason: r.code, ...r.details });
  return true;
}
