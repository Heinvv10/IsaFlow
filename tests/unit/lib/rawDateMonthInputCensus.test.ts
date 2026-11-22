/**
 * Raw date and month inputs are retired (date rework 3/4). Every date goes through DateField / DateRangeField and every
 * month through MonthField: typed first, one display ("15 Mar 2026" / "Mar 2026"), one parser, a picker that opens
 * only on request. A native `<input type="date|month|week|time">` brings back the phone's own picker and the browser's
 * own format, so this reads the working tree (tracked and untracked, so a new file cannot slip past before it is added)
 * and fails on one in src/ or pages/. The one exception is listed with its reason: it only shrinks.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = process.cwd();
const FILES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => /\.(tsx|jsx)$/.test(f));

/** file -> why a native input is still there. Do not add to this: use DateField / MonthField. */
export const ALLOWED: Readonly<Record<string, string>> = {
  'src/components/admin/AnnouncementModal.tsx': 'platform-admin datetime-local (wall-clock + zone) with its own SAST conversion; not a date entry',
};

const FORBIDDEN = 'date|month|week|time|datetime-local';
/** type="month", type='month', type={'month'}, type={"month"}, type: 'month', createElement('input', { type: `month` }). */
export const RAW_INPUT_TYPE = new RegExp(`\\btype\\s*[=:]\\s*\\{?\\s*['"\`](?:${FORBIDDEN})['"\`]`);

export function rawInputLines(source: string): number[] {
  return source.split('\n').flatMap((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
    return RAW_INPUT_TYPE.test(line) ? [i + 1] : [];
  });
}

describe('raw date / month inputs', () => {
  it('the detector sees every spelling and ignores comments and text inputs', () => {
    expect(rawInputLines('<input type="month" />')).toEqual([1]);
    expect(rawInputLines("<input type='date' />")).toEqual([1]);
    expect(rawInputLines("<input type={'month'} />")).toEqual([1]);
    expect(rawInputLines('<input type={"week"} />')).toEqual([1]);
    expect(rawInputLines("createElement('input', { type: `time` })")).toEqual([1]);
    expect(rawInputLines('<input type="datetime-local" />')).toEqual([1]);
    expect(rawInputLines('a\n<input\n  type="month"\n/>')).toEqual([3]);
    expect(rawInputLines(' * an `<input type="date">` renders')).toEqual([]);
    expect(rawInputLines('// <input type="month">')).toEqual([]);
    expect(rawInputLines('<input type="text" /><input type="number" />')).toEqual([]);
    expect(rawInputLines('<MonthField label="x" />')).toEqual([]);
  });

  it('src/ and pages/ hold none (only the listed exception)', () => {
    expect(FILES.length).toBeGreaterThan(500);
    const hits = FILES.flatMap((f) => (f in ALLOWED ? [] : rawInputLines(readFileSync(`${ROOT}/${f}`, 'utf8')).map((n) => `${f}:${n}`)));
    expect(hits, 'use DateField / DateRangeField / MonthField instead of a native date or month input').toEqual([]);
  });

  it('the listed exception is still needed (it only shrinks)', () => {
    for (const f of Object.keys(ALLOWED)) {
      expect(FILES, f).toContain(f);
      expect(rawInputLines(readFileSync(`${ROOT}/${f}`, 'utf8')).length, `${f} no longer has a native input: delete its entry`).toBeGreaterThan(0);
    }
  });
});
