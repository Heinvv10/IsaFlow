/**
 * The raw-muted-text-stop gate: bare text-gray/slate-400/500 may only fall in number, so the
 * themeContrast.css stopgap shrinks instead of growing.
 */
import { describe, expect, it } from 'vitest';
import { countRawMutedTextStops, judge } from '../../../scripts/ci/rawMutedTextRule';

describe('countRawMutedTextStops', () => {
  it('counts a bare token in any quoting', () => {
    expect(countRawMutedTextStops('<p className="text-slate-500">')).toBe(1);
    expect(countRawMutedTextStops("cn('text-gray-400', x)")).toBe(1);
    expect(countRawMutedTextStops('className={`mt-1 text-zinc-500 ${x}`}')).toBe(1);
    expect(countRawMutedTextStops('a text-slate-500 b text-gray-400 c')).toBe(2);
  });

  it('does not count a variant (the intended dark-theme grey) or another stop', () => {
    expect(countRawMutedTextStops('dark:text-slate-400 hover:text-slate-500 group-hover:text-gray-400')).toBe(0);
    expect(countRawMutedTextStops('text-slate-600 text-gray-300 text-slate-50 text-slate-5000')).toBe(0);
    expect(countRawMutedTextStops('text-slate-500/80')).toBe(0);
  });

  it('counts the bare token beside its dark twin', () => {
    expect(countRawMutedTextStops('text-slate-500 dark:text-slate-400')).toBe(1);
  });
});

describe('judge', () => {
  it('passes when nothing changed', () => {
    expect(judge({ 'a.tsx': 2 }, { 'a.tsx': 2 })).toEqual({ grew: [], shrank: [] });
  });

  it('refuses a new file and a larger count', () => {
    expect(judge({ 'new.tsx': 1 }, {}).grew).toEqual(['new.tsx: 1 > 0']);
    expect(judge({ 'a.tsx': 3 }, { 'a.tsx': 2 }).grew).toEqual(['a.tsx: 3 > 2']);
  });

  it('makes a fall lower the baseline, so it cannot be spent again', () => {
    expect(judge({ 'a.tsx': 1 }, { 'a.tsx': 2 }).shrank).toEqual(['a.tsx: 1 < 2']);
    expect(judge({}, { 'gone.tsx': 2 }).shrank).toEqual(['gone.tsx: 0 < 2']);
  });
});
