import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteTemplate, ReportingFramework, SectionType } from './afsTypes';

type TemplateFramework = ReportingFramework | 'both';

interface NoteTemplateDefinition {
  sectionType: SectionType;
  framework: TemplateFramework;
  title: string;
  isMandatory: boolean;
  standardReference: string | null;
  dataQueries: Record<string, string>;
  contentSchema: Record<string, unknown>;
  aiPromptTemplate: string | null;
}

export const ALL_NOTE_TEMPLATES: NoteTemplateDefinition[] = [
  {
    sectionType: 'note_1', framework: 'both', title: 'Accounting Policies', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 8 / IAS 8',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { policies: { type: 'array' } } },
    aiPromptTemplate: "Summarise the entity's accounting policies in plain language.",
  },
  {
    sectionType: 'note_2', framework: 'both', title: 'Significant Estimates and Judgements', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 8 / IAS 8',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { estimates: { type: 'array' } } },
    aiPromptTemplate: 'List key estimates and judgements applied in these financial statements.',
  },
  {
    sectionType: 'note_3', framework: 'both', title: 'Property, Plant and Equipment', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 17 / IAS 16',
    dataQueries: { ppe: 'SELECT * FROM ppe_schedule WHERE company_id = $1' },
    contentSchema: { type: 'object', properties: { movements: { type: 'array' } } },
    aiPromptTemplate: 'Generate a PPE movement schedule narrative.',
  },
  {
    sectionType: 'note_4', framework: 'full_ifrs', title: 'Right-of-Use Assets', isMandatory: true,
    standardReference: 'IFRS 16',
    dataQueries: { rou: 'SELECT * FROM rou_assets WHERE company_id = $1' },
    contentSchema: { type: 'object', properties: { movements: { type: 'array' } } },
    aiPromptTemplate: 'Generate a right-of-use assets movement schedule narrative.',
  },
  {
    sectionType: 'note_5', framework: 'both', title: 'Intangible Assets', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 18 / IAS 38',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { movements: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_6', framework: 'both', title: 'Investment Property', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 16 / IAS 40',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { properties: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_7', framework: 'both', title: 'Investments in Associates', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 14 / IAS 28',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { investments: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_8', framework: 'both', title: 'Financial Assets', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { assets: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_9', framework: 'both', title: 'Inventories', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 13 / IAS 2',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { categories: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_10', framework: 'both', title: 'Trade and Other Receivables', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { breakdown: { type: 'array' } } },
    aiPromptTemplate: 'Describe the trade receivables ageing and expected credit losses.',
  },
  {
    sectionType: 'note_11', framework: 'both', title: 'Cash and Cash Equivalents', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 7 / IAS 7',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { accounts: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_12', framework: 'both', title: 'Share Capital and Reserves', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 22 / IAS 1',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { movements: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_13', framework: 'both', title: 'Borrowings', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { facilities: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_14', framework: 'full_ifrs', title: 'Lease Liabilities (IFRS 16)', isMandatory: true,
    standardReference: 'IFRS 16',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { leases: { type: 'array' } } },
    aiPromptTemplate: 'Generate lease liability maturity analysis narrative.',
  },
  {
    sectionType: 'note_15', framework: 'both', title: 'Provisions', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 21 / IAS 37',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { provisions: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_16', framework: 'both', title: 'Trade and Other Payables', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { breakdown: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_17', framework: 'both', title: 'Income Tax and Deferred Tax', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 29 / IAS 12',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { current: { type: 'number' }, deferred: { type: 'number' } } },
    aiPromptTemplate: 'Reconcile accounting profit to tax expense.',
  },
  {
    sectionType: 'note_18', framework: 'both', title: 'Revenue Disaggregation', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 23 / IFRS 15',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { streams: { type: 'array' } } },
    aiPromptTemplate: 'Disaggregate revenue by category and timing of recognition.',
  },
  {
    sectionType: 'note_19', framework: 'both', title: 'Other Income and Finance Income', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 5 / IAS 1',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { items: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_20', framework: 'both', title: 'Operating Expenses by Nature', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 5 / IAS 1',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { categories: { type: 'array' } } },
    aiPromptTemplate: 'List operating expenses by nature.',
  },
  {
    sectionType: 'note_21', framework: 'both', title: 'Finance Costs', isMandatory: false,
    standardReference: 'IFRS for SMEs Section 25 / IAS 23',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { items: { type: 'array' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_22', framework: 'both', title: 'Employee Benefits', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 28 / IAS 19',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { headcount: { type: 'number' }, costs: { type: 'number' } } },
    aiPromptTemplate: 'Summarise employee headcount and cost breakdown.',
  },
  {
    sectionType: 'note_23', framework: 'both', title: 'Related Party Disclosures', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 33 / IAS 24',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { parties: { type: 'array' } } },
    aiPromptTemplate: "Disclose all related party transactions at arm's length.",
  },
  {
    sectionType: 'note_24', framework: 'both', title: 'Auditor\'s Remuneration', isMandatory: true,
    standardReference: 'Companies Act 71 of 2008',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { audit: { type: 'number' }, other: { type: 'number' } } },
    aiPromptTemplate: null,
  },
  {
    sectionType: 'note_25', framework: 'both', title: 'Contingencies and Commitments', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 21 / IAS 37',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { items: { type: 'array' } } },
    aiPromptTemplate: 'Disclose all contingent liabilities and capital commitments.',
  },
  {
    sectionType: 'note_26', framework: 'both', title: 'Events After the Reporting Date', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 32 / IAS 10',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { events: { type: 'array' } } },
    aiPromptTemplate: 'Describe any material post-balance sheet events.',
  },
  {
    sectionType: 'note_27', framework: 'both', title: 'Going Concern', isMandatory: true,
    standardReference: 'IFRS for SMEs Section 3 / IAS 1',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { assessment: { type: 'string' } } },
    aiPromptTemplate: 'Provide a going concern assessment based on the financial position.',
  },
  {
    sectionType: 'note_28', framework: 'full_ifrs', title: 'Segment Information', isMandatory: true,
    standardReference: 'IFRS 8',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { segments: { type: 'array' } } },
    aiPromptTemplate: 'Present operating segment results.',
  },
  {
    sectionType: 'note_29', framework: 'full_ifrs', title: 'Financial Instruments Risk', isMandatory: true,
    standardReference: 'IFRS 7',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { risks: { type: 'array' } } },
    aiPromptTemplate: 'Disclose credit, liquidity, and market risk exposures.',
  },
  {
    sectionType: 'note_30', framework: 'both', title: 'Standards Issued But Not Yet Effective', isMandatory: true,
    standardReference: 'IAS 8',
    dataQueries: {},
    contentSchema: { type: 'object', properties: { standards: { type: 'array' } } },
    aiPromptTemplate: 'List IFRS standards issued but not yet effective as at year-end.',
  },
];

export function getNoteTemplatesForFramework(framework: ReportingFramework): NoteTemplateDefinition[] {
  return ALL_NOTE_TEMPLATES.filter(t => t.framework === 'both' || t.framework === framework);
}

export async function seedNoteTemplates(): Promise<void> {
  log.info('Seeding note templates', { count: ALL_NOTE_TEMPLATES.length }, 'noteTemplateRegistry');

  for (const t of ALL_NOTE_TEMPLATES) {
    await sql`
      INSERT INTO note_templates (section_type, framework, title, data_queries, content_schema, ai_prompt_template, is_mandatory, standard_reference, effective_from)
      VALUES (${t.sectionType}, ${t.framework}, ${t.title}, ${JSON.stringify(t.dataQueries)}::JSONB, ${JSON.stringify(t.contentSchema)}::JSONB, ${t.aiPromptTemplate ?? null}, ${t.isMandatory}, ${t.standardReference ?? null}, CURRENT_DATE)
      ON CONFLICT (section_type, framework) DO UPDATE SET
        title = EXCLUDED.title, data_queries = EXCLUDED.data_queries, content_schema = EXCLUDED.content_schema,
        ai_prompt_template = EXCLUDED.ai_prompt_template, is_mandatory = EXCLUDED.is_mandatory,
        standard_reference = EXCLUDED.standard_reference, updated_at = now()
    `;
  }
}

// Re-export NoteTemplate type for consumers who import from this module
export type { NoteTemplate };
