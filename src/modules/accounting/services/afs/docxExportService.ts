// src/modules/accounting/services/afs/docxExportService.ts
import {
  File,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  SectionType,
} from 'docx';
import { log } from '@/lib/logger';
import { findReportingPeriod } from './afsReportingPeriod';
import { afsDocumentTitle, isPackPeriod, packPeriodLabel, packPeriodPhrase } from './afsDocumentTitle';
import type { AfsDocument, AfsSection, NoteContentBlock, NoteContent } from './afsTypes';
import { renderNoteTable } from './docxTableRenderer';
import { packSectionView } from './managementPackSectionView';
import { normaliseBlocks } from './noteBlockNormalise';
import { orderPackSections } from './managementPackSections';

// ── helpers ──────────────────────────────────────────────────────────────────

function spacer(): Paragraph {
  return new Paragraph({ text: '' });
}

function centeredParagraph(text: string, bold = false, size = 24): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold, size })],
  });
}

/** Resolve effective blocks: overrides.blocks takes precedence, then content.blocks */
function resolveBlocks(section: AfsSection): NoteContentBlock[] | null {
  const overrideContent = section.overrides as Partial<NoteContent> | null;
  if (overrideContent?.blocks) return overrideContent.blocks;
  if (section.content?.blocks) return section.content.blocks;
  return null;
}

/** Resolve effective title */
function resolveTitle(section: AfsSection): string {
  const overrideContent = section.overrides as Partial<NoteContent> | null;
  return overrideContent?.title ?? section.content?.title ?? section.sectionType;
}

// ── block renderers ───────────────────────────────────────────────────────────

type DocxChild = Paragraph | ReturnType<typeof renderNoteTable>;

function renderBlock(block: NoteContentBlock): DocxChild[] {
  switch (block.type) {
    case 'paragraph':
      return [new Paragraph({ text: block.text, style: 'Normal' })];

    case 'heading':
      return [
        new Paragraph({
          text: block.text,
          heading: block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        }),
      ];

    case 'list':
      return block.items.map(
        (item) =>
          new Paragraph({
            text: item,
            bullet: { level: 0 },
          })
      );

    case 'table':
      return [renderNoteTable(block), spacer()];
  }
}

// ── cover page ────────────────────────────────────────────────────────────────

/**
 * What the cover says the statements cover, as the PDF cover does: the financial
 * year's real period ("For the 14 months ended 2027-02-28"), a management pack's
 * own period label, and nothing for a document with neither.
 */
async function coverPeriodText(doc: AfsDocument): Promise<string | null> {
  const isPack = doc.documentType === 'management_pack';
  // A pack is monthly: its valid month wins even when it also carries a fiscal year.
  if (isPack && isPackPeriod(doc.period)) return `For the ${packPeriodPhrase(doc.period)}`;
  if (doc.fiscalYear) {
    const period = await findReportingPeriod(doc.companyId, Number(doc.fiscalYear), 'docxExportService');
    return period ? `For the ${period.current.phrase}` : null;
  }
  return isPack ? null : doc.period;
}

function buildCoverChildren(periodText: string | null, companyName: string, title: string): DocxChild[] {
  return [
    spacer(),
    spacer(),
    spacer(),
    centeredParagraph(companyName, true, 48),
    spacer(),
    centeredParagraph(title, true, 36),
    spacer(),
    periodText ? centeredParagraph(periodText, false, 28) : spacer(),
    spacer(),
    centeredParagraph(`Registration number: —`, false, 22),
  ];
}

// ── TOC placeholder ───────────────────────────────────────────────────────────

function buildTocChildren(): DocxChild[] {
  return [
    new Paragraph({
      text: 'Table of Contents',
      heading: HeadingLevel.HEADING_1,
    }),
    spacer(),
    new Paragraph({
      children: [
        new TextRun({
          text: '[Table of Contents — update fields in Word]',
          italics: true,
          color: '888888',
        }),
      ],
    }),
    spacer(),
  ];
}

// ── section renderers ─────────────────────────────────────────────────────────

function buildSectionChildren(section: AfsSection, isPack: boolean): DocxChild[] {
  // A pack section prints as every pack surface does: vocabulary title, never empty, narrative under it.
  const view = isPack ? packSectionView(section) : null;
  if (isPack && !view) return [];
  const blocks = view
    ? [...view.blocks, ...(view.narrative ? [{ type: 'paragraph' as const, text: view.narrative }] : [])]
    : resolveBlocks(section);
  if (!blocks) return [];

  const title = view ? view.title : resolveTitle(section);
  const children: DocxChild[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
    }),
    spacer(),
  ];

  for (const block of normaliseBlocks(blocks)) {
    children.push(...renderBlock(block));
  }

  return children;
}

// ── document styles ───────────────────────────────────────────────────────────

function buildStyles() {
  return {
    paragraphStyles: [
      {
        id: 'Normal',
        name: 'Normal',
        run: { size: 22, font: 'Calibri' },
        paragraph: { spacing: { line: 276 } },
      },
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 32, bold: true, color: '1A252F', font: 'Calibri' },
        paragraph: {
          spacing: { before: 240, after: 120 },
        },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 26, bold: true, color: '2C3E50', font: 'Calibri' },
        paragraph: {
          spacing: { before: 200, after: 80 },
        },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 24, bold: true, italics: true, color: '4A6274', font: 'Calibri' },
        paragraph: {
          spacing: { before: 160, after: 60 },
        },
      },
    ],
  };
}

// ── public API ────────────────────────────────────────────────────────────────

export async function renderToDocx(
  document: AfsDocument,
  sections: AfsSection[],
  companyName: string
): Promise<Buffer> {
  log.info('docxExportService: rendering document', {
    documentId: document.id,
    sectionCount: sections.length,
  });

  const sorted = document.documentType === 'management_pack'
    ? orderPackSections(sections)
    : [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  const documentTitle = afsDocumentTitle(document.documentType);
  const coverChildren = buildCoverChildren(await coverPeriodText(document), companyName, documentTitle);
  const tocChildren = buildTocChildren();

  const sectionParts = sorted
    .map((s) => buildSectionChildren(s, document.documentType === 'management_pack'))
    .filter((children) => children.length > 0);

  const bodyChildren: DocxChild[] = [
    ...coverChildren,
    ...tocChildren,
    ...sectionParts.flat(),
  ];

  const file = new File({
    creator: 'IsaFlow AFS',
    title: `${companyName} — ${documentTitle}`,
    description: document.documentType === 'management_pack'
      ? (isPackPeriod(document.period) ? `Management pack for ${packPeriodLabel(document.period)}` : 'Management pack')
      : `AFS for fiscal year ${document.fiscalYear ?? ''}`,
    styles: buildStyles(),
    sections: [
      {
        properties: {
          type: SectionType.CONTINUOUS,
          page: {
            margin: {
              top: 1440,
              right: 1080,
              bottom: 1440,
              left: 1080,
            },
          },
        },
        children: bodyChildren,
      },
    ],
  });

  const buffer = await Packer.toBuffer(file);

  log.info('docxExportService: DOCX rendered', {
    documentId: document.id,
    bytes: buffer.length,
  });

  return buffer;
}
