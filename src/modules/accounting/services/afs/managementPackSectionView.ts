// src/modules/accounting/services/afs/managementPackSectionView.ts
// What one stored management pack section prints, on every surface (PDF, DOCX, the in-app viewer, the
// client portal): its title from the section vocabulary, its blocks, and its AI narrative. Pure.
//
// It also repairs what older packs stored, at render time and without touching the row: a section key
// as the title, a statement saved as one JSON paragraph, an AI failure sentence saved as commentary,
// and a section with nothing in it.
import { formatMoney } from '@/lib/money/formatMoney';
import type { NoteContent, NoteContentBlock, NoteContentTable } from './afsTypes';
import {
  EXECUTIVE_SUMMARY_MISSING, SECTION_NOT_AVAILABLE, isAiPlaceholder, packSectionLabel,
} from './managementPackSections';

export interface PackSectionInput {
  sectionType: string;
  content: { title?: string; blocks?: NoteContentBlock[] } | null;
  overrides?: Partial<NoteContent> | null;
  aiNarrative: string | null;
}

export interface PackSectionView {
  key: string;
  title: string;
  blocks: NoteContentBlock[];
  /** The AI's words for the section, or null when there are none worth printing. */
  narrative: string | null;
}

/** The pack's own cover page stands in for this section on every surface. */
const HIDDEN_SECTIONS: readonly string[] = ['cover'];

/** The generator's first statement shape: `JSON.stringify` of the aggregate, labelled here as it was never printed. */
const LEGACY_FIELDS: Record<string, Array<[string, string]>> = {
  income_statement: [['revenue', 'Revenue'], ['cogs', 'Cost of sales'], ['net_profit', 'Net profit']],
  balance_sheet: [
    ['currentAssets', 'Current assets'], ['inventory', 'Inventory'], ['tradeReceivables', 'Trade receivables'],
    ['currentLiabilities', 'Current liabilities'], ['tradePayables', 'Trade payables'],
    ['totalDebt', 'Total liabilities'], ['totalEquity', 'Total equity'],
  ],
};

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A paragraph that is a stored statement aggregate becomes a two-column table; any other block is returned as it is. */
function repairBlock(sectionType: string, block: NoteContentBlock): NoteContentBlock {
  const fields = LEGACY_FIELDS[sectionType];
  if (!fields || block.type !== 'paragraph') return block;
  const obj = parseObject(block.text);
  if (!obj) return block;
  const rows = fields.filter(([key]) => obj[key] !== undefined).map(([key, label]) => [label, formatMoney(Number(obj[key]))]);
  if (rows.length === 0) return block;
  const table: NoteContentTable = { type: 'table', headers: ['', 'Amount'], rows };
  return table;
}

function storedBlocks(section: PackSectionInput): NoteContentBlock[] {
  const overridden = section.overrides?.blocks;
  const blocks = overridden && overridden.length > 0 ? overridden : section.content?.blocks;
  return Array.isArray(blocks) ? blocks : [];
}

/** The view of a section, or null when the section is not printed at all. */
export function packSectionView(section: PackSectionInput): PackSectionView | null {
  if (HIDDEN_SECTIONS.includes(section.sectionType)) return null;
  const narrative = section.aiNarrative && section.aiNarrative.trim() !== '' && !isAiPlaceholder(section.aiNarrative)
    ? section.aiNarrative : null;
  let blocks = storedBlocks(section).map((b) => repairBlock(section.sectionType, b));
  if (blocks.length === 0 && narrative === null) {
    const text = section.sectionType === 'ai_executive_summary' ? EXECUTIVE_SUMMARY_MISSING : SECTION_NOT_AVAILABLE;
    blocks = [{ type: 'paragraph', text }];
  }
  return {
    key: section.sectionType,
    // The title is the section vocabulary's, never the stored one: older packs stored the bare key there.
    title: section.overrides?.title || packSectionLabel(section.sectionType),
    blocks,
    narrative,
  };
}
