// src/modules/accounting/services/afs/afsDocumentTitle.ts
// What a document calls itself, wherever it prints its own name (PDF and DOCX
// cover, e-signing title, signer emails). A management pack is not "Annual
// Financial Statements"; anything that is not a pack keeps the AFS wording.

import type { DocumentType } from './afsTypes';

const AFS_TITLE = 'Annual Financial Statements';
const PACK_TITLE = 'Management Pack';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function afsDocumentTitle(documentType: DocumentType | string | null | undefined): string {
  return documentType === 'management_pack' ? PACK_TITLE : AFS_TITLE;
}

/** The same name for running text ("The management pack for your company ..."). */
export function afsDocumentNoun(documentType: DocumentType | string | null | undefined): string {
  return afsDocumentTitle(documentType).toLowerCase();
}

/** "2026-10" -> "October 2026"; a value that is not YYYY-MM stays as written. */
export function packPeriodLabel(period: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : period;
}

/** The cover's period wording for a pack: "month of October 2026". */
export function packPeriodPhrase(period: string): string {
  return `month of ${packPeriodLabel(period)}`;
}
