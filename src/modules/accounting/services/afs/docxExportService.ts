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
import type { AfsDocument, AfsSection, NoteContentBlock, NoteContent } from './afsTypes';
import { renderNoteTable } from './docxTableRenderer';

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

function buildCoverChildren(doc: AfsDocument, companyName: string): DocxChild[] {
  const year = doc.fiscalYear ?? new Date().getFullYear();
  const period = doc.period ?? `Year ended 28 February ${year}`;

  return [
    spacer(),
    spacer(),
    spacer(),
    centeredParagraph(companyName, true, 48),
    spacer(),
    centeredParagraph('Annual Financial Statements', true, 36),
    spacer(),
    centeredParagraph(period, false, 28),
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

function buildSectionChildren(section: AfsSection): DocxChild[] {
  const blocks = resolveBlocks(section);
  if (!blocks) return [];

  const title = resolveTitle(section);
  const children: DocxChild[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
    }),
    spacer(),
  ];

  for (const block of blocks) {
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

  const sorted = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  const coverChildren = buildCoverChildren(document, companyName);
  const tocChildren = buildTocChildren();

  const sectionParts = sorted
    .map((s) => buildSectionChildren(s))
    .filter((children) => children.length > 0);

  const bodyChildren: DocxChild[] = [
    ...coverChildren,
    ...tocChildren,
    ...sectionParts.flat(),
  ];

  const file = new File({
    creator: 'IsaFlow AFS',
    title: `${companyName} — Annual Financial Statements`,
    description: `AFS for fiscal year ${document.fiscalYear ?? ''}`,
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
