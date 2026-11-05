// src/modules/accounting/services/afs/noteBlockNormalise.ts
// Section content is free-form JSON (a tenant writes `overrides`), so a renderer that needs real strings
// (the DOCX writer calls .trim() on cells) reads it through this: every text, cell, header and list item
// becomes a string (null/undefined -> ''), and a non-array rows/headers/items becomes an empty one.
import type { NoteContentBlock } from './afsTypes';

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text) : []);

export function normaliseBlocks(blocks: unknown): NoteContentBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((raw): NoteContentBlock[] => {
    if (raw === null || typeof raw !== 'object') return [];
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'paragraph': return [{ type: 'paragraph', text: text(b.text) }];
      case 'heading': return [{ type: 'heading', text: text(b.text), level: b.level === 2 ? 2 : 3 }];
      case 'list': return [{ type: 'list', items: strings(b.items) }];
      case 'table': {
        const rows = Array.isArray(b.rows) ? b.rows.map(strings) : [];
        return [{ type: 'table', headers: strings(b.headers), rows, ...(Array.isArray(b.rowKinds) ? { rowKinds: b.rowKinds as never } : {}) }];
      }
      default: return [];
    }
  });
}
