/** Types and refusals for tax return versions (wave 5 L1a). */

export type ReturnForm = 'VAT201' | 'EMP201';
export type ReturnVersionStatus = 'finalised' | 'filed' | 'superseded';

export interface ReturnVersion {
  id: string;
  formType: ReturnForm;
  periodStart: string;
  periodEnd: string;
  versionNo: number;
  status: ReturnVersionStatus;
  /** VAT201: outputTax, inputTax, netVat, sarsFields. EMP201: generateEMP201's figures plus runs. */
  figures: Record<string, unknown>;
  postedThrough: string;
  vatPeriodLockId: string | null;
  sarsSubmissionId: string | null;
  filedReference: string | null;
  amendsVersionId: string | null;
  finalisedBy: string;
  finalisedAt: string;
  filedBy: string | null;
  filedAt: string | null;
  amendedBy: string | null;
  amendReason: string | null;
  amendedAt: string | null;
}

/** A finalise, filing or amend the caller can fix or must wait out. Raised before the first write. */
export class ReturnRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  /** A stable name the caller can act on (LEGACY_SUBMISSION_EXISTS), when the message alone is not enough. */
  readonly refusalCode: string | null;
  /** Data the caller needs to take the next step (LEGACY_SUBMISSION_EXISTS: legacySubmissionIds), sent in error.details. */
  readonly refusalDetails: Record<string, unknown> | null;
  constructor(status: 400 | 403 | 404 | 409, message: string, refusalCode: string | null = null,
    refusalDetails: Record<string, unknown> | null = null) {
    super(message);
    this.refusalCode = refusalCode;
    this.refusalDetails = refusalDetails;
    this.name = 'ReturnRefusal';
    this.status = status;
  }
}

export interface ReturnActor {
  userId: string;
  /** The caller's company role, from withAuth. */
  role: string;
}

export interface FinaliseOptions {
  /** Owner/admin only: records an override when blocking VAT exceptions are outstanding. */
  overrideReason?: string;
  /** Record a period failing SARS's 15% check, as the lock route's force does. */
  force?: boolean;
  /** Proceed although a submitted vat_returns row for the period disagrees; the reason is kept in figures.meta. */
  acknowledgeVatReturnMismatch?: { reason: string };
}

export interface VatReturnRecord {
  status: string;
  outputTax: number;
  inputTax: number;
  netVat: number;
  sarsReference: string | null;
  submittedAt: string | null;
  /** True when its figures differ from the version's (or, before finalising, the figures about to be recorded). */
  mismatch: boolean;
}
