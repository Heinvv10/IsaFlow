/**
 * SARS eFiling submission orchestration.
 *
 * The DIFFERENTIATOR lives here: a VAT201 is submitted to SARS only when the
 * ISV channel is configured AND the pre-filing exceptions report is clean. The
 * gate is enforced SERVER-SIDE and every refusal/attempt is written to the
 * audit log (migration 504) — the UI gate is a convenience, this is the
 * enforcement. Live submission is blocked on Hein's SARS ISV registration
 * (docs/sars/2026-07-VAT201-isv-dossier.md); until then the channel is dark.
 */

import { log } from '@/lib/logger';
import { getEfilingConfig } from './sarsEfilingConfig';
import { getVatExceptions } from './vatExceptionsService';
import type { VatExceptionsReport } from './vatExceptionsTypes';
import { generateVAT201 } from './vat201Service';
import { authenticate, submitVAT201, pollStatus } from './sarsEfilingClient';
import {
  getEfilingSubmission,
  getCompanyVatInfo,
  markSubmissionSubmitted,
  applyPollResult,
  insertEfilingEvent,
} from './sarsEfilingRepo';

export class EfilingNotConfiguredError extends Error {
  constructor() {
    super('SARS eFiling is not configured on this server');
    this.name = 'EfilingNotConfiguredError';
  }
}
export class EfilingSubmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`SARS submission ${id} not found`);
    this.name = 'EfilingSubmissionNotFoundError';
  }
}
/** A deliberate refusal to file — exceptions present, degraded data, bad VAT
 *  number, or nothing to poll. NOT a system error; surfaced to the user as
 *  "do not file". */
export class EfilingBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'EfilingBlockedError';
    this.reason = reason;
  }
}

/**
 * Pure decision: may this exceptions report be filed? Clean = zero exceptions
 * and non-degraded source data. Trivially testable without any IO.
 */
export function evaluateEfilingGate(
  report: Pick<VatExceptionsReport, 'totalExceptions' | 'degradedData'>,
): { allowed: boolean; reason: string | null } {
  if (report.degradedData) {
    return { allowed: false, reason: 'VAT201 source data is incomplete — the return cannot be trusted for filing' };
  }
  if (report.totalExceptions > 0) {
    return {
      allowed: false,
      reason: `${report.totalExceptions} pre-filing exception${report.totalExceptions === 1 ? '' : 's'} must be cleared before filing`,
    };
  }
  return { allowed: true, reason: null };
}

const VAT_NUMBER_RE = /^4\d{9}$/;

export interface SubmitOutcome {
  submissionId: string;
  correlationId: string;
  status: string;
}

export async function submitVAT201ToSars(
  companyId: string,
  submissionId: string,
  userId: string,
): Promise<SubmitOutcome> {
  const config = getEfilingConfig();
  if (!config) throw new EfilingNotConfiguredError();

  const submission = await getEfilingSubmission(companyId, submissionId);
  if (!submission) throw new EfilingSubmissionNotFoundError(submissionId);
  if (submission.formType !== 'VAT201') {
    throw new EfilingBlockedError(`Only VAT201 returns can be filed via the ISV channel (got ${submission.formType})`);
  }

  // Server-side exceptions gate — the enforcement point.
  const report = await getVatExceptions(companyId, submission.periodStart, submission.periodEnd);
  const gate = evaluateEfilingGate(report);
  if (!gate.allowed) {
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'blocked',
      message: gate.reason, detail: { totalExceptions: report.totalExceptions, degradedData: report.degradedData },
      createdBy: userId,
    });
    throw new EfilingBlockedError(gate.reason!);
  }

  const { vatNumber, companyName } = await getCompanyVatInfo(companyId);
  if (!vatNumber || !VAT_NUMBER_RE.test(vatNumber)) {
    const reason = 'Company VAT number is missing or invalid (must be 10 digits starting with 4)';
    await insertEfilingEvent({ companyId, submissionId, eventType: 'blocked', message: reason, createdBy: userId });
    throw new EfilingBlockedError(reason);
  }

  // Regenerate the authoritative box totals for the period (same source the
  // reviewed exceptions report reconciled against).
  const vat201 = await generateVAT201(companyId, submission.periodStart, submission.periodEnd);
  const taxPeriod = submission.periodStart.replace(/-/g, '').slice(0, 6); // CCYYMM
  const { degradedSources: _drop, outputInvoices: _o, inputInvoices: _i, periodStart: _ps, periodEnd: _pe, ...fields } = vat201;

  try {
    const auth = await authenticate(config);
    const result = await submitVAT201(config, auth.token, {
      vatNumber, taxPeriod, fields: fields as unknown as Record<string, number>,
    });
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'submit',
      efilingStatus: result.status, httpStatus: result.httpStatus, correlationId: result.correlationId,
      detail: { taxPeriod, companyName, netVat: vat201.field11_vatPayableOrRefundable },
      createdBy: userId,
    });
    await markSubmissionSubmitted(companyId, submissionId, result.correlationId, result.status, userId);
    log.info('VAT201 submitted to SARS', { companyId, submissionId, correlationId: result.correlationId }, 'sarsEfilingSubmissionService');
    return { submissionId, correlationId: result.correlationId, status: result.status };
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus ?? null;
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'error', httpStatus,
      message: err instanceof Error ? err.message : 'SARS eFiling transport error', createdBy: userId,
    });
    throw err;
  }
}

export interface PollOutcome {
  status: string;
  submissionStatus: string;
  sarsReference: string | null;
  errors: string[];
}

/** Map a SARS-reported eFiling status to our submission status. */
function mapSubmissionStatus(efilingStatus: string): string {
  if (efilingStatus === 'accepted') return 'accepted';
  if (efilingStatus === 'rejected') return 'rejected';
  return 'submitted'; // processing / unknown — stay submitted
}

export async function pollVAT201Status(companyId: string, submissionId: string): Promise<PollOutcome> {
  const config = getEfilingConfig();
  if (!config) throw new EfilingNotConfiguredError();

  const submission = await getEfilingSubmission(companyId, submissionId);
  if (!submission) throw new EfilingSubmissionNotFoundError(submissionId);
  if (!submission.efilingCorrelationId) {
    throw new EfilingBlockedError('No ISV submission to poll for this return');
  }

  try {
    const auth = await authenticate(config);
    const result = await pollStatus(config, auth.token, submission.efilingCorrelationId);
    const submissionStatus = mapSubmissionStatus(result.status);
    await applyPollResult(companyId, submissionId, {
      submissionStatus, efilingStatus: result.status, sarsReference: result.sarsReference,
    });
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'poll',
      efilingStatus: result.status, httpStatus: result.httpStatus, correlationId: submission.efilingCorrelationId,
      message: result.errors.length ? result.errors.join('; ') : null,
    });
    return { status: result.status, submissionStatus, sarsReference: result.sarsReference, errors: result.errors };
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus ?? null;
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'error', httpStatus,
      message: err instanceof Error ? err.message : 'SARS eFiling transport error',
    });
    throw err;
  }
}
