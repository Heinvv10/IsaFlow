/**
 * Clipboard text → a matrix of cells. TSV splitting is ours; each cell's amount
 * is the kit parser's (`parseSaAmount`), which refuses ambiguous input with a
 * reason. A refused cell is reported, never written.
 */
import { describe, it, expect } from 'vitest';
import { MAX_PASTE_CHARS, parseCell, parseClipboard } from '@/modules/accounting/services/budgets/grid/pasteParse';

describe('parseCell', () => {
  it.each([
    ['1234', 123400],
    ['1234.5', 123450],
    ['1234.50', 123450],
    ['-1234.50', -123450],
    ['−1234.50', -123450],
    ['(1,234.50)', -123450],
    ['(1 234,50)', -123450],
    ['R 1 234,50', 123450],
    ['R1 234.50', 123450],
    ['ZAR 1 234.50', 123450],
    ['1 234,50', 123450],
    ['  1234  ', 123400],
    [' 1234 ', 123400],
    ['1,234.50', 123450],
    ['1.234,50', 123450],
    ['12,345,678', 1234567800],
    ['1,5', 150],
    ['1234,50', 123450],
    ['0', 0],
    ['0.00', 0],
    ['-', 0],
    ['–', 0],
    [' - ', 0],
  ])('%j → %s cents', (raw, cents) => {
    expect(parseCell(raw)).toEqual({ kind: 'value', cents });
  });

  it.each(['', '   ', ' '])('%j is blank (not budgeted)', raw => {
    expect(parseCell(raw)).toEqual({ kind: 'blank' });
  });

  it.each([
    ['1,234', /ambiguous/i],
    ['#N/A', /./],
    ['abc', /./],
    ['1234-', /./],
    ['1.2.3,4.5', /./],
    ['12.345', /./],
    ['99999999999999999', /more than/i],
    ['$100', /./],
  ])('%j is refused with a reason', (raw, reason) => {
    const c = parseCell(raw);
    expect(c.kind).toBe('error');
    if (c.kind === 'error') {
      expect(c.raw).toBe(raw);
      expect(c.reason).toMatch(reason);
    }
  });
});

describe('parseClipboard', () => {
  it('splits rows and columns', () => {
    const r = parseClipboard('1\t2\n3\t4');
    expect(r.rows).toEqual([
      [{ kind: 'value', cents: 100 }, { kind: 'value', cents: 200 }],
      [{ kind: 'value', cents: 300 }, { kind: 'value', cents: 400 }],
    ]);
    expect(r.errors).toEqual([]);
  });

  it('drops the one trailing newline Excel adds, and handles CRLF and CR', () => {
    expect(parseClipboard('1\r\n2\r\n').rows).toHaveLength(2);
    expect(parseClipboard('1\r2\r').rows).toHaveLength(2);
    expect(parseClipboard('1\n2\n').rows).toHaveLength(2);
  });

  it('keeps an intentional blank last row (two trailing newlines)', () => {
    expect(parseClipboard('1\n\n').rows).toEqual([[{ kind: 'value', cents: 100 }], [{ kind: 'blank' }]]);
  });

  it('keeps blank cells as blank', () => {
    expect(parseClipboard('1\t\t3').rows[0]).toEqual([
      { kind: 'value', cents: 100 }, { kind: 'blank' }, { kind: 'value', cents: 300 },
    ]);
  });

  it('reads Excel-quoted cells, including doubled quotes and embedded newlines', () => {
    const r = parseClipboard('"1 234,50"\t"R 2,5"\n"a""b"\t"x\ny"');
    expect(r.rows[0]).toEqual([{ kind: 'value', cents: 123450 }, { kind: 'value', cents: 250 }]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]?.[0]).toMatchObject({ kind: 'error', raw: 'a"b' });
    expect(r.rows[1]?.[1]).toMatchObject({ kind: 'error', raw: 'x\ny', reason: expect.stringMatching(/more than one line/) });
  });

  it('a line break inside a quoted cell is refused, never read as one amount', () => {
    expect(parseClipboard('"1\n234"\t5').rows[0]?.[0]).toMatchObject({ kind: 'error', raw: '1\n234' });
  });

  it('an unclosed quote is an ordinary character: it cannot swallow the rows after it', () => {
    const r = parseClipboard('"100\n200\n300');
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]?.[0]).toMatchObject({ kind: 'error', raw: '"100' });
    expect(r.rows.slice(1)).toEqual([[{ kind: 'value', cents: 20000 }], [{ kind: 'value', cents: 30000 }]]);
  });

  it('a quote in the middle of a field is data', () => {
    expect(parseClipboard('a"b\t1').rows[0]?.[0]).toMatchObject({ kind: 'error', raw: 'a"b' });
    // Not a quoted "2" spliced into 1…3: that would read as 123.
    expect(parseClipboard('1"2"3').rows[0]?.[0]).toMatchObject({ kind: 'error', raw: '1"2"3' });
  });

  it('keeps a last row that ends in a blank cell (no trailing newline)', () => {
    expect(parseClipboard('1\t2\n3\t').rows).toEqual([
      [{ kind: 'value', cents: 100 }, { kind: 'value', cents: 200 }],
      [{ kind: 'value', cents: 300 }, { kind: 'blank' }],
    ]);
  });

  it('refuses a clipboard over the size bound without parsing it', () => {
    expect(parseClipboard('1'.repeat(MAX_PASTE_CHARS + 1))).toEqual({ rows: [], errors: [], tooLarge: true });
    expect(parseClipboard('1').tooLarge).toBeUndefined();
  });

  it('lists each refused cell with its row and column', () => {
    const r = parseClipboard('1\t#N/A\n1,234\t4');
    expect(r.errors.map(e => [e.row, e.col])).toEqual([[0, 1], [1, 0]]);
    expect(r.rows[1][1]).toEqual({ kind: 'value', cents: 400 });
  });

  it('empty clipboard is no rows', () => {
    expect(parseClipboard('').rows).toEqual([]);
    expect(parseClipboard('\n').rows).toEqual([[{ kind: 'blank' }]]);
  });
});
