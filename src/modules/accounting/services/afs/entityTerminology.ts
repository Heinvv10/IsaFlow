// src/modules/accounting/services/afs/entityTerminology.ts
// Centralized entity-type terminology for AFS output
// Switches director/member/trustee, dividends/distributions, etc.

import { sql } from '@/lib/neon';

// ── Types ───────────────────────────────────────────────────────────────────

export type EntityType = 'pty' | 'cc' | 'trust';

export interface EntityTerminology {
  entityType: EntityType;
  /** "company" | "close corporation" | "trust" */
  entityName: string;
  /** "the company" | "the close corporation" | "the trust" */
  entityRef: string;
  /** "directors" | "members" | "trustees" */
  leadership: string;
  /** "director" | "member" | "trustee" */
  leaderSingular: string;
  /** "Directors" | "Members" | "Trustees" */
  leadershipCapital: string;
  /** "shareholders" | "members" | "beneficiaries" */
  owners: string;
  /** "shareholder" | "member" | "beneficiary" */
  ownerSingular: string;
  /** "dividends" | "distributions" | "distributions to beneficiaries" */
  dividends: string;
  /** "share capital" | "members' contribution" | "trust capital" */
  equityLabel: string;
  /** "Directors' Report" | "Members' Report" | "Trustees' Report" */
  reportTitle: string;
  /** "Directors' Responsibility" | "Members' Responsibility" | "Trustees' Responsibility" */
  responsibilityTitle: string;
  /** SA Companies Act reference for the entity type */
  actReference: string;
  /** Whether entity uses "share capital" in equity section */
  hasShareCapital: boolean;
  /** Whether entity is subject to Companies Act s30 AFS requirement */
  requiresAfs: boolean;
  /** "Annual Financial Statements" | "Annual Financial Statements" | "Financial Statements" */
  statementsTitle: string;
  /** Section type for equity in statement of financial position */
  equitySectionTitle: string;
  /** Changes in equity statement title */
  equityChangeTitle: string;
}

// ── Terminology Maps ────────────────────────────────────────────────────────

const TERMINOLOGY: Record<EntityType, EntityTerminology> = {
  pty: {
    entityType: 'pty',
    entityName: 'company',
    entityRef: 'the company',
    leadership: 'directors',
    leaderSingular: 'director',
    leadershipCapital: 'Directors',
    owners: 'shareholders',
    ownerSingular: 'shareholder',
    dividends: 'dividends',
    equityLabel: 'Share capital',
    reportTitle: "Directors' Report",
    responsibilityTitle: "Directors' Responsibility",
    actReference: 'Companies Act 71 of 2008',
    hasShareCapital: true,
    requiresAfs: true,
    statementsTitle: 'Annual Financial Statements',
    equitySectionTitle: "Equity and Shareholders' Funds",
    equityChangeTitle: 'Statement of Changes in Equity',
  },
  cc: {
    entityType: 'cc',
    entityName: 'close corporation',
    entityRef: 'the close corporation',
    leadership: 'members',
    leaderSingular: 'member',
    leadershipCapital: 'Members',
    owners: 'members',
    ownerSingular: 'member',
    dividends: 'distributions',
    equityLabel: "Members' contribution",
    reportTitle: "Members' Report",
    responsibilityTitle: "Members' Responsibility",
    actReference: 'Close Corporations Act 69 of 1984',
    hasShareCapital: false,
    requiresAfs: true,
    statementsTitle: 'Annual Financial Statements',
    equitySectionTitle: "Members' Interest",
    equityChangeTitle: "Statement of Changes in Members' Interest",
  },
  trust: {
    entityType: 'trust',
    entityName: 'trust',
    entityRef: 'the trust',
    leadership: 'trustees',
    leaderSingular: 'trustee',
    leadershipCapital: 'Trustees',
    owners: 'beneficiaries',
    ownerSingular: 'beneficiary',
    dividends: 'distributions to beneficiaries',
    equityLabel: 'Trust capital',
    reportTitle: "Trustees' Report",
    responsibilityTitle: "Trustees' Responsibility",
    actReference: 'Trust Property Control Act 57 of 1988',
    hasShareCapital: false,
    requiresAfs: false,
    statementsTitle: 'Financial Statements',
    equitySectionTitle: 'Trust Capital and Accumulated Funds',
    equityChangeTitle: 'Statement of Changes in Trust Capital',
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get terminology for a given entity type.
 */
export function getTerminology(entityType: EntityType): EntityTerminology {
  return TERMINOLOGY[entityType] ?? TERMINOLOGY.pty;
}

/**
 * Fetch entity type from the companies table and return full terminology.
 */
export async function getCompanyTerminology(companyId: string): Promise<EntityTerminology> {
  const rows = (await sql`
    SELECT COALESCE(entity_type, 'pty') AS entity_type
    FROM companies WHERE id = ${companyId}
  `) as Record<string, unknown>[];

  const entityType = (rows[0]?.entity_type as EntityType) ?? 'pty';
  return getTerminology(entityType);
}

/**
 * Replace terminology placeholders in text.
 * Placeholders: {directors}, {director}, {Directors}, {shareholders}, {shareholder},
 *               {dividends}, {the company}, {company}, {equityLabel}
 */
export function applyTerminology(text: string, terms: EntityTerminology): string {
  return text
    .replace(/\{directors\}/g, terms.leadership)
    .replace(/\{director\}/g, terms.leaderSingular)
    .replace(/\{Directors\}/g, terms.leadershipCapital)
    .replace(/\{shareholders\}/g, terms.owners)
    .replace(/\{shareholder\}/g, terms.ownerSingular)
    .replace(/\{dividends\}/g, terms.dividends)
    .replace(/\{the company\}/g, terms.entityRef)
    .replace(/\{company\}/g, terms.entityName)
    .replace(/\{equityLabel\}/g, terms.equityLabel)
    .replace(/\{actReference\}/g, terms.actReference);
}

// ── Entity-specific disclosure requirements ─────────────────────────────────

export interface EntityDisclosureRequirements {
  entityType: EntityType;
  mandatoryNotes: number[];
  optionalNotes: number[];
  additionalDisclosures: string[];
}

/**
 * Get entity-specific disclosure requirements.
 * CCs and Trusts have fewer mandatory disclosures than Pty companies.
 */
export function getDisclosureRequirements(entityType: EntityType): EntityDisclosureRequirements {
  const base = {
    // Common mandatory notes for all entity types
    mandatoryNotes: [1, 2, 3, 10, 11, 16, 17, 18, 20, 25, 26, 27],
    optionalNotes: [4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 19, 21, 22, 23, 24, 28, 29, 30],
    additionalDisclosures: [] as string[],
  };

  switch (entityType) {
    case 'pty':
      return {
        entityType,
        mandatoryNotes: [...base.mandatoryNotes, 12], // Share capital mandatory for Pty
        optionalNotes: base.optionalNotes.filter((n) => n !== 12),
        additionalDisclosures: [
          'Authorised and issued share capital disclosure',
          'Dividends declared and paid',
          'Directors\' emoluments (if PIS >= 100)',
        ],
      };
    case 'cc':
      return {
        entityType,
        mandatoryNotes: base.mandatoryNotes,
        optionalNotes: [...base.optionalNotes],
        additionalDisclosures: [
          "Members' interest and contributions",
          'Distributions to members',
          'Accounting officer confirmation (s62)',
        ],
      };
    case 'trust':
      return {
        entityType,
        mandatoryNotes: base.mandatoryNotes.filter((n) => n !== 17), // Tax note optional for exempt trusts
        optionalNotes: [...base.optionalNotes, 17],
        additionalDisclosures: [
          'Trust deed provisions affecting financial statements',
          'Distributions to beneficiaries',
          'Trustee fees and related party transactions',
          'Trust capital movements',
        ],
      };
  }
}
