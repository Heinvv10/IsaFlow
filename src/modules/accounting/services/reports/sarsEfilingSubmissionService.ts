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
import { getLedgerVAT201, evaluateVat201Filability, type LedgerVAT201 } from './vat201LedgerFields';
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
/** The VAT201 was already filed to SARS — refuse to file it twice (a double
 *  statutory submission). Carries the existing correlation id for reference. */
export class EfilingAlreadyFiledError extends Error {
  readonly correlationId: string;
  constructor(correlationId: string) {
    super('This VAT201 has already been filed to SARS');
    this.name = 'EfilingAlreadyFiledError';
    this.correlationId = correlationId;
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

/** The eleven statutory figures. Everything else on the form is drill-down. */
const VAT201_FIELDS = [
  'field1_standardRatedSupplies', 'field2_zeroRatedSupplies', 'field3_exemptSupplies',
  'field4_totalImports', 'field5_outputVAT', 'field6_capitalGoods', 'field7_otherGoods',
  'field8_services', 'field9_imports', 'field10_totalInputVAT', 'field11_vatPayableOrRefundable',
] as const;

/**
 * Which of the reviewed draft's figures the regenerated return no longer
 * matches. A draft saved before `form_data` carried the fields (or with none of
 * them) cannot be compared, and is reported as such rather than passed.
 */
export function draftDrift(
  saved: Record<string, unknown> | null,
  regenerated: LedgerVAT201,
): string[] {
  if (!saved || VAT201_FIELDS.every((f) => saved[f] === undefined)) {
    return ['this draft holds no saved VAT201 figures to compare against'];
  }
  const drift: string[] = [];
  for (const field of VAT201_FIELDS) {
    const before = Number(saved[field] ?? 0);
    const after = Number(regenerated[field] ?? 0);
    if (Math.abs(before - after) >= 0.005) {
      drift.push(`${field} ${before.toFixed(2)} -> ${after.toFixed(2)}`);
    }
  }
  return drift;
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

  // Idempotency: never re-file a return already sent to / accepted by SARS —
  // a second submit is a duplicate statutory filing.
  if (submission.efilingCorrelationId || submission.status === 'submitted' || submission.status === 'accepted') {
    throw new EfilingAlreadyFiledError(submission.efilingCorrelationId ?? '');
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

  // Regenerate the authoritative box totals for the period FROM THE LEDGER.
  // The invoice-derived `generateVAT201` — which the exceptions report still
  // reconciles against — cannot see credit notes or manual VAT journals, so
  // filing its figures would file a return higher than the books (K-031).
  const vat201 = await getLedgerVAT201(companyId, submission.periodStart, submission.periodEnd);

  // The form's own arithmetic, which the invoice-population exceptions report
  // does not check: SARS's 15% tie-out, and negative supply values.
  const filability = evaluateVat201Filability(vat201);
  if (!filability.filable) {
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'blocked', message: filability.reason,
      detail: { rateCheckTies: vat201.rateCheck.ties, outputVariance: vat201.rateCheck.outputVariance, inputVariance: vat201.rateCheck.inputVariance },
      createdBy: userId,
    });
    throw new EfilingBlockedError(filability.reason!);
  }

  // File what was reviewed. The draft was saved at one instant and the ledger
  // has moved since if anybody posted into the period; sending the regenerated
  // figures under an approval given for the old ones is the hazard
  // `exportVat201` guards with its period lock, and this path had neither.
  const drift = draftDrift(submission.formData, vat201);
  if (drift.length > 0) {
    const reason = `The ledger has moved since this draft was saved (${drift.join('; ')}) — re-save the draft and review it before filing`;
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'blocked', message: reason,
      detail: { drift }, createdBy: userId,
    });
    throw new EfilingBlockedError(reason);
  }

  const taxPeriod = submission.periodStart.replace(/-/g, '').slice(0, 6); // CCYYMM
  const {
    degradedSources: _drop, outputInvoices: _o, inputInvoices: _i,
    periodStart: _ps, periodEnd: _pe, rateCheck: _rc, ...fields
  } = vat201;

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

export async function pollVAT201Status(companyId: string, submissionId: string, userId?: string): Promise<PollOutcome> {
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
      createdBy: userId ?? null,
    });
    return { status: result.status, submissionStatus, sarsReference: result.sarsReference, errors: result.errors };
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus ?? null;
    await insertEfilingEvent({
      companyId, submissionId, eventType: 'error', httpStatus,
      message: err instanceof Error ? err.message : 'SARS eFiling transport error',
      createdBy: userId ?? null,
    });
    throw err;
  }
}
