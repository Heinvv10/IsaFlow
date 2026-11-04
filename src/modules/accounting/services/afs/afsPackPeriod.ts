// src/modules/accounting/services/afs/afsPackPeriod.ts
// What the pre-export checks do differently for a management pack. A pack has no
// fiscal year: its period is its own month, stored in afs_documents.period as
// 'YYYY-MM'. It also has none of the sections the AFS-only checks read.

import { isPackPeriod } from './afsDocumentTitle';
import type { ExportCheck } from './afsPreExportChecks';

const PACK_TYPE = 'management_pack';

/**
 * Which check path a document takes. Only 'afs' takes the AFS path and only
 * 'management_pack' skips it, so a document type added later can never silently
 * skip the AFS checks: it is 'unknown' until someone decides what applies to it.
 */
export function documentKind(documentType: string): 'afs' | 'pack' | 'unknown' {
  if (documentType === 'afs') return 'afs';
  return documentType === PACK_TYPE ? 'pack' : 'unknown';
}

/** Last calendar day of a pack month ('2026-02' -> '2026-02-28'), or null when the period is missing or not YYYY-MM. */
export function packPeriodEnd(period: string | null | undefined): string | null {
  if (!isPackPeriod(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

/** The blocker for a pack whose month is missing or malformed, or null when it is a real month. */
export function packPeriodBlocker(period: string | null | undefined): ExportCheck | null {
  if (packPeriodEnd(period) !== null) return null;
  return {
    label: 'Reporting period known',
    passed: false,
    severity: 'blocker',
    detail:
      'This management pack has no valid month (expected YYYY-MM), so the period it covers ' +
      'is unknown and its figures cannot be checked against the ledger.',
  };
}

/** The blocker for a document type the checks do not know how to treat. */
export function unknownDocumentTypeBlocker(documentType: string): ExportCheck {
  return {
    label: 'Reporting period known',
    passed: false,
    severity: 'blocker',
    detail:
      `This document has an unknown document type ('${documentType}'), so it cannot be ` +
      `determined which checks apply or what period it covers.`,
  };
}

/**
 * The result of an AFS-only check for a management pack. A pack has none of the
 * sections these checks read (statement_of_fp, notes, a directors report, a cash
 * flow with a closing cash figure), so running them could only fail for a reason
 * that has nothing to do with the pack.
 */
export function notApplicable(label: string, severity: ExportCheck['severity']): Promise<ExportCheck> {
  return Promise.resolve({
    label,
    passed: true,
    severity,
    detail: 'Not applicable to a management pack.',
  });
}
