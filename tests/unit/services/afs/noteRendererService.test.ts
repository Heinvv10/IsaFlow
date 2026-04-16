import { describe, it, expect } from 'vitest';
import { renderNoteContent } from '@/modules/accounting/services/afs/noteRendererService';

describe('noteRendererService', () => {
  describe('renderNoteContent', () => {
    it('produces paragraph block from intro', () => {
      const result = renderNoteContent('Test Note', {}, { intro: 'Opening text.' });
      expect(result.blocks[0]).toEqual({ type: 'paragraph', text: 'Opening text.' });
    });

    it('produces table block from non-empty queryKey', () => {
      const snapshot = { ppe: [{ category: 'Vehicles', cost: 100000 }] };
      const schema = {
        sections: [{
          queryKey: 'ppe',
          headers: ['Category', 'Cost'],
          columns: ['category', 'cost'],
          numberColumns: [1],
        }],
      };
      const result = renderNoteContent('PPE', snapshot, schema);
      const table = result.blocks.find(b => b.type === 'table');
      expect(table).toBeDefined();
      expect((table as { headers: string[] }).headers).toEqual(['Category', 'Cost']);
    });

    it('omits table for empty query result', () => {
      const schema = {
        sections: [{ queryKey: 'ppe', headers: ['X'], columns: ['x'] }],
      };
      const result = renderNoteContent('PPE', { ppe: [] }, schema);
      expect(result.blocks.find(b => b.type === 'table')).toBeUndefined();
    });

    it('appends totals row when totalRow=true', () => {
      const snapshot = { data: [{ name: 'A', amount: 100 }, { name: 'B', amount: 200 }] };
      const schema = {
        sections: [{
          queryKey: 'data',
          headers: ['Name', 'Amount'],
          columns: ['name', 'amount'],
          numberColumns: [1],
          totalRow: true,
        }],
      };
      const result = renderNoteContent('Test', snapshot, schema);
      const table = result.blocks.find(b => b.type === 'table') as { rows: string[][] } | undefined;
      expect(table).toBeDefined();
      const lastRow = table!.rows[table!.rows.length - 1]!;
      expect(lastRow[0]).toBe('Total');
      expect(lastRow[1]).toBe('300,00');
    });

    it('renders heading block when section has heading', () => {
      const snapshot = { items: [{ name: 'X', val: 1 }] };
      const schema = {
        sections: [{ heading: 'Sub-section', queryKey: 'items', headers: ['Name', 'Val'], columns: ['name', 'val'] }],
      };
      const result = renderNoteContent('Test', snapshot, schema);
      const heading = result.blocks.find(b => b.type === 'heading');
      expect(heading).toBeDefined();
      expect((heading as { text: string; level: number }).text).toBe('Sub-section');
      expect((heading as { text: string; level: number }).level).toBe(3);
    });

    it('formats numberColumns with fmt()', () => {
      const snapshot = { d: [{ label: 'A', amount: 1234567.89 }] };
      const schema = {
        sections: [{ queryKey: 'd', headers: ['L', 'A'], columns: ['label', 'amount'], numberColumns: [1] }],
      };
      const result = renderNoteContent('T', snapshot, schema);
      const table = result.blocks.find(b => b.type === 'table') as { rows: string[][] } | undefined;
      expect(table!.rows[0]![1]).toBe(new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234567.89));
    });

    it('does not throw on empty snapshot', () => {
      expect(() => renderNoteContent('T', {}, {})).not.toThrow();
    });

    it('returns at least one block even with empty snapshot and no schema', () => {
      const result = renderNoteContent('My Note', {}, {});
      expect(result.blocks.length).toBeGreaterThan(0);
    });
  });
});
