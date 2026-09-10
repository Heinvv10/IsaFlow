// src/modules/accounting/services/afs/afsPortalTypes.ts

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
