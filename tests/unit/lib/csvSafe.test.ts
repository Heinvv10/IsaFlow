import { describe, it, expect } from 'vitest';
import { neutralizeCsvCell } from '@/lib/csvSafe';

describe('neutralizeCsvCell', () => {
  it('prefixes = (equals) trigger', () => {
    expect(neutralizeCsvCell('=cmd()')).toBe("'=cmd()");
  });

  it('prefixes + (plus) trigger', () => {
    expect(neutralizeCsvCell('+1')).toBe("'+1");
  });

  it('prefixes - (minus) trigger', () => {
    expect(neutralizeCsvCell('-1')).toBe("'-1");
  });

  it('prefixes @ (at) trigger', () => {
    expect(neutralizeCsvCell('@x')).toBe("'@x");
  });

  it('prefixes tab-leading string', () => {
    expect(neutralizeCsvCell('\tinjection')).toBe("'\tinjection");
  });

  it('prefixes CR-leading string', () => {
    expect(neutralizeCsvCell('\rinjection')).toBe("'\rinjection");
  });

  it('leaves normal company name unchanged', () => {
    expect(neutralizeCsvCell('Acme Ltd')).toBe('Acme Ltd');
  });

  it('leaves numeric string unchanged', () => {
    expect(neutralizeCsvCell('123')).toBe('123');
  });

  it('leaves empty string unchanged', () => {
    expect(neutralizeCsvCell('')).toBe('');
  });

  it('leaves string starting with a letter unchanged', () => {
    expect(neutralizeCsvCell('Revenue')).toBe('Revenue');
  });
});
