// src/modules/accounting/services/afs/afsTypes.ts

export type ReportingFramework = 'ifrs_smes' | 'full_ifrs';
export type DocumentType = 'afs' | 'management_pack';
export type DocumentStatus = 'draft' | 'in_review' | 'partner_review' | 'signed_off' | 'filed';
export type SectionStatus = 'pending' | 'auto_generated' | 'ai_enhanced' | 'reviewed' | 'signed_off';
export type SectionType =
  | 'cover'
  | 'directors_report'
  | 'auditors_report'
  | 'statement_of_fp'
  | 'income_statement'
  | 'changes_in_equity'
  | 'cash_flow'
  | 'note_1'  | 'note_2'  | 'note_3'  | 'note_4'  | 'note_5'
  | 'note_6'  | 'note_7'  | 'note_8'  | 'note_9'  | 'note_10'
  | 'note_11' | 'note_12' | 'note_13' | 'note_14' | 'note_15'
  | 'note_16' | 'note_17' | 'note_18' | 'note_19' | 'note_20'
  | 'note_21' | 'note_22' | 'note_23' | 'note_24' | 'note_25'
  | 'note_26' | 'note_27' | 'note_28' | 'note_29' | 'note_30';
export type PackStyle = 'executive' | 'detailed' | 'board';
export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

// ── NoteContent ──────────────────────────────────────────────────────────────

export interface NoteContentParagraph { type: 'paragraph'; text: string }
export interface NoteContentTable     { type: 'table'; headers: string[]; rows: string[][] }
export interface NoteContentList      { type: 'list'; items: string[] }
export interface NoteContentHeading   { type: 'heading'; text: string; level: 2 | 3 }

export type NoteContentBlock =
  | NoteContentParagraph
  | NoteContentTable
  | NoteContentList
  | NoteContentHeading;

export interface NoteContent {
  title: string;
  blocks: NoteContentBlock[];
}

// ── AfsDocument ──────────────────────────────────────────────────────────────

export interface AfsDocument {
  id: string;
  companyId: string;
  fiscalYear: number | null;
  period: string | null;
  documentType: DocumentType;
  reportingFramework: ReportingFramework;
  status: DocumentStatus;
  lockedAt: Date | null;
  lockedBy: string | null;
  /** Set while the document is out for signature: no section of it takes a write. */
  signingRequestedAt: Date | null;
  /** Why the last signature was not accepted, and where the signed copy was quarantined. */
  signingRefusedAt: Date | null;
  signingRefusedReason: string | null;
  version: number;
  pisScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAfsDocumentInput {
  companyId: string;
  fiscalYear?: number;
  period?: string;
  documentType: DocumentType;
  reportingFramework: ReportingFramework;
}

// ── AfsSection ───────────────────────────────────────────────────────────────

export interface AfsSectionVersionEntry {
  version: number;
  savedAt: string;
  savedBy: string;
  content: NoteContent;
  overrides?: Partial<NoteContent> | null;
  /** Why this snapshot was taken, when it records more than a plain save. */
  note?: string;
}

export interface AfsSection {
  id: string;
  documentId: string;
  companyId: string;
  sectionType: SectionType;
  sortOrder: number;
  status: SectionStatus;
  dataSnapshot: Record<string, unknown> | null;
  content: NoteContent | null;
  overrides: Partial<NoteContent> | null;
  aiNarrative: string | null;
  aiNarrativeAccepted: boolean;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  signedOffBy: string | null;
  signedOffAt: Date | null;
  versionHistory: AfsSectionVersionEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAfsSectionInput {
  documentId: string;
  companyId: string;
  sectionType: SectionType;
  sortOrder: number;
}

export interface UpdateAfsSectionInput {
  status?: SectionStatus;
  dataSnapshot?: Record<string, unknown>;
  content?: NoteContent;
  overrides?: Partial<NoteContent>;
  aiNarrative?: string;
  aiNarrativeAccepted?: boolean;
  reviewedBy?: string;
  signedOffBy?: string;
  /** Who is changing the content. Required to change the content of a reviewed or signed-off section. */
  updatedBy?: string;
}

// ── NoteTemplate ─────────────────────────────────────────────────────────────

export interface NoteTemplate {
  id: string;
  sectionType: SectionType;
  framework: ReportingFramework | 'both';
  title: string;
  dataQueries: Record<string, string>;
  contentSchema: Record<string, unknown>;
  aiPromptTemplate: string | null;
  isMandatory: boolean;
  standardReference: string | null;
  effectiveFrom: Date;
  supersedes: string | null;
  changeSummary: string | null;
}

// ── AfsGenerationJob ─────────────────────────────────────────────────────────

export interface AfsGenerationJob {
  id: string;
  documentId: string;
  companyId: string;
  requestedBy: string | null;
  status: GenerationJobStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

// ── ManagementPackConfig ──────────────────────────────────────────────────────

export interface PackRecipient {
  email: string;
  role: string;
  receives: 'draft' | 'final' | 'both';
}

export interface ManagementPackConfig {
  id: string;
  companyId: string;
  enabled: boolean;
  generationDay: number;
  deliveryDay: number;
  reviewRequired: boolean;
  sectionsEnabled: Record<string, boolean>;
  recipients: PackRecipient[];
  packStyle: PackStyle;
  comparisonMode: 'prior_month' | 'prior_year' | 'budget' | 'all_three';
  currencyDisplay: 'full' | 'thousands' | 'millions';
}

// ── BrandProfile ────────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  companyId: string;
  logoUrl: string | null;
  primaryColour: string;
  secondaryColour: string;
  fontFamily: 'professional' | 'modern' | 'executive' | 'bold';
  coverStyle: 'classic' | 'modern' | 'bold' | 'minimal';
  reportFooterText: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type UpsertBrandProfileInput = Omit<BrandProfile, 'id' | 'companyId' | 'createdAt' | 'updatedAt'>;

// ── AfsUploadedImage ────────────────────────────────────────────────────────

export interface AfsUploadedImage {
  id: string;
  companyId: string;
  filename: string;
  url: string;
  tag: 'cover' | 'section_divider' | 'inline';
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  lowResWarning: boolean;
  uploadedAt: Date | string;
}

export interface CreateImageInput {
  filename: string;
  url: string;
  tag: 'cover' | 'section_divider' | 'inline';
  widthPx?: number;
  heightPx?: number;
  dpi?: number;
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface AfsDocumentWithSections extends AfsDocument {
  sections: AfsSection[];
}

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

// Split out at their own seams; re-exported so every importer keeps one entry point.
export * from './afsKpiTypes';
export * from './afsPortalTypes';
export * from './afsComplianceTypes';
