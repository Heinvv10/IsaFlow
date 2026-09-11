// src/modules/accounting/services/afs/afsDocumentTitle.ts
import type { DocumentType } from './afsTypes';

/**
 * The title a document is printed and sent for signing under: a management pack is not annual financial
 * statements. The one copy the PDF cover, the DOCX cover and the Signum title share. document_type is set when a
 * document is created and never updated, so a document's title cannot change under a signature.
 */
export function statementsTitle(documentType: DocumentType): string {
  return documentType === 'management_pack' ? 'Management Accounts' : 'Annual Financial Statements';
}
