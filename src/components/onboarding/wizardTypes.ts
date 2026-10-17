/**
 * Onboarding wizard state: the data every step reads and writes, and how it
 * changes when the business type changes. No React here.
 */

import { getEntityType, type EntityTypeCode } from '@/lib/entityTypes';
import type { CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { allowedDocumentTypes } from '@/modules/onboarding/services/entityOnboardingRules';

export interface DocFile {
  type: string; name: string; data: string; mimeType: string; size: number;
}

export interface Director {
  name: string;
  idNumber: string;
  role: string; // the entity's person role: 'Owner', 'Partner', 'Director', 'Member', 'Trustee', 'Representative'
  idDocument?: DocFile;
  extracting?: boolean;
  idVerification?: 'verified' | 'updated' | 'failed'; // result of ID upload extraction
  idVerificationMsg?: string;
}

export type { CoaTemplate };

export interface WizardData {
  /** null until the user answers "What kind of business is this?" */
  entityType: EntityTypeCode | null;
  name: string; tradingName: string; registrationNumber: string;
  vatNumber: string; taxNumber: string;
  addressLine1: string; addressLine2: string; city: string;
  province: string; postalCode: string; country: string;
  phone: string; email: string; website: string;
  logoData: string;
  bankName: string; bankAccountNumber: string;
  bankBranchCode: string; bankAccountType: string;
  financialYearStart: number; vatPeriod: string; defaultCurrency: string;
  coaTemplate: CoaTemplate;
  directors: Director[];
  cipcDirectors: Director[]; // directors extracted from CIPC for validation
  documents: DocFile[];
}

export const INITIAL_WIZARD: WizardData = {
  entityType: null,
  name: '', tradingName: '', registrationNumber: '', vatNumber: '', taxNumber: '',
  addressLine1: '', addressLine2: '', city: '', province: '', postalCode: '',
  country: 'South Africa', phone: '', email: '', website: '', logoData: '',
  bankName: '', bankAccountNumber: '', bankBranchCode: '', bankAccountType: 'Current',
  financialYearStart: 3, vatPeriod: 'bi-monthly', defaultCurrency: 'ZAR',
  coaTemplate: 'isaflow_standard',
  directors: [],
  cipcDirectors: [],
  documents: [],
};

export type SetFn = <K extends keyof WizardData>(k: K, v: WizardData[K]) => void;

/**
 * The data with a new business type: documents the entity does not use are
 * dropped, people are capped at its maximum and take its role, and a
 * registration number is cleared when the entity has none.
 */
export function withEntityType(d: WizardData, code: EntityTypeCode): WizardData {
  const def = getEntityType(code);
  const allowed = allowedDocumentTypes(code);
  const people = def.maxPeople === null ? d.directors : d.directors.slice(0, def.maxPeople);
  return {
    ...d,
    entityType: code,
    registrationNumber: def.registration ? d.registrationNumber : '',
    documents: d.documents.filter(doc => allowed.includes(doc.type)),
    directors: people.map(p => ({ ...p, role: def.personRole })),
  };
}
