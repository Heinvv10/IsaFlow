/**
 * AFS review workflow and client-portal types. Moved out of `afsTypes.ts`
 * unchanged to bring that file under the 300-line cap; `afsTypes.ts`
 * re-exports everything here, so existing import paths still resolve.
 */
import type { DocumentStatus, SectionStatus } from './afsTypes';

// ── Review workflow additions ────────────────────────────────────────────────

export const SECTION_STATUS_ORDER: Record<SectionStatus, number> = {
  pending: 0,
  auto_generated: 1,
  ai_enhanced: 2,
  reviewed: 3,
  signed_off: 4,
};

export const DOCUMENT_STATUS_ORDER: Record<DocumentStatus, number> = {
  draft: 0,
  in_review: 1,
  partner_review: 2,
  signed_off: 3,
  filed: 4,
};

export interface AfsSectionComment {
  id: string;
  sectionId: string;
  companyId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: Date | string | null;
  parentId: string | null;
  createdAt: Date | string;
}

export interface ProofCopyChecklistItem {
  key: string;
  label: string;
  checked: boolean;
}

export interface ProofCopyChecklist {
  documentId: string;
  generatedAt: string;
  items: ProofCopyChecklistItem[];
  allPassed: boolean;
}

// ── Client Portal Types ────────────────────────────────────────────────────────

export type PortalRole = 'director' | 'cfo' | 'shareholder_readonly' | 'external_auditor';

export interface PortalContact {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: PortalRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MagicLink {
  id: string;
  companyId: string;
  contactId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface PortalSession {
  contactId: string;
  companyId: string;
  role: PortalRole;
  expiresAt: string; // ISO string — stored in signed cookie
}

// Document access rules by portal role
export const PORTAL_ACCESS_RULES: Record<PortalRole, {
  documentTypes: Array<'afs' | 'management_pack'>;
  statuses: string[]; // empty array = all statuses
  canAnnotate: boolean;
}> = {
  director: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  cfo: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  shareholder_readonly: {
    documentTypes: ['afs'],
    statuses: ['signed_off', 'filed'],
    canAnnotate: false,
  },
  external_auditor: {
    documentTypes: ['afs'],
    statuses: [], // all
    canAnnotate: false,
  },
};
