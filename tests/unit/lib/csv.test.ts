import { describe, it, expect } from 'vitest';
import { csvCell, csvVal, escapeCsv } from '@/lib/csv';

describe('escapeCsv', () => {
  it('quotes a field containing a comma', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"');
  });

  it('quotes a field containing a double quote and escapes it', () => {
    expect(escapeCsv('a"b')).toBe('"a""b"');
  });

  it('quotes a field containing a newline', () => {
    expect(escapeCsv('a\nb')).toBe('"a\nb"');
  });

  it('quotes a field containing a mid-field carriage return', () => {
    expect(escapeCsv('a\rb')).toBe('"a\rb"');
  });

  it('leaves a plain field unquoted', () => {
    expect(escapeCsv('plain')).toBe('plain');
  });

  it('leaves nullish values as empty string', () => {
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });

  it('prefixes and quotes a value starting with a bare CR (formula-injection + CR quoting combined)', () => {
    // Leading CR triggers the formula-injection prefix; the resulting string
    // still contains \r so it must also be quoted (order must not double-handle).
    expect(escapeCsv('\rinjection')).toBe('"\'\rinjection"');
  });

  it('still prefixes leading =, +, -, @ triggers (existing behavior preserved)', () => {
    expect(escapeCsv('=cmd()')).toBe("'=cmd()");
    expect(escapeCsv('+1')).toBe("'+1");
    expect(escapeCsv('-1')).toBe("'-1");
    expect(escapeCsv('@x')).toBe("'@x");
  });
});

describe('csvCell / csvVal (always-quote variants, unaffected by the escapeCsv change)', () => {
  it('always wraps in quotes regardless of content', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvVal('plain')).toBe('"plain"');
  });

  it('quotes and escapes a mid-field carriage return', () => {
    expect(csvCell('a\rb')).toBe('"a\rb"');
  });
});
