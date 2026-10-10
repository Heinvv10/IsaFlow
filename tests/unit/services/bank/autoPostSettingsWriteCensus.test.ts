/**
 * Forensic-controls step 2, D (Hein, decision 5): the census of what writes the auto-post settings.
 *
 * Every change to bank_auto_post_settings is audited and a weakening one is judged, both inside
 * autoPostSettingsService.updateAutoPostSettings — so a second writer of the table, or a second caller of the
 * writer that is not a person's route, would change what the sweep may post with no record and no check. Walked on
 * DISK (not `git ls-files`), so an untracked new writer fails too; comments are stripped first.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
const SOURCES = (() => {
  const files: string[] = [];
  for (const root of ['src', 'pages']) walk(path.join(ROOT, root), files);
  return files.map((f) => ({ file: path.relative(ROOT, f), text: strip(readFileSync(f, 'utf8')) }));
})();
const filesMatching = (re: RegExp) => SOURCES.filter((s) => re.test(s.text)).map((s) => s.file).sort();
const SERVICE = 'src/modules/accounting/services/bank/autoPostSettingsService.ts';

describe('the auto-post settings writers', () => {
  it('only the settings service writes bank_auto_post_settings — one UPDATE and one INSERT, nothing deletes', () => {
    expect(filesMatching(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+bank_auto_post_settings\b/i)).toEqual([SERVICE]);
    const text = SOURCES.find((s) => s.file === SERVICE)!.text;
    expect(text.match(/\bUPDATE\s+bank_auto_post_settings\b/gi)).toHaveLength(1);
    expect(text.match(/\bINSERT\s+INTO\s+bank_auto_post_settings\b/gi)).toHaveLength(1);
    expect(text).not.toMatch(/\bDELETE\s+FROM\s+bank_auto_post_settings\b/i);
  });

  it('the writer judges and audits before it returns: the weakening check precedes both writes, the audit follows them', () => {
    const text = SOURCES.find((s) => s.file === SERVICE)!.text;
    const check = text.indexOf('await assertMayWeaken(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(text.indexOf('UPDATE bank_auto_post_settings'));
    expect(check).toBeLessThan(text.indexOf('INSERT INTO bank_auto_post_settings'));
    expect(text.indexOf('await logAuditOrThrow(')).toBeGreaterThan(text.indexOf('INSERT INTO bank_auto_post_settings'));
  });

  it('only the PUT of bank-auto-post calls updateAutoPostSettings (the gate re-exports it)', () => {
    expect(filesMatching(/(?<!function )\bupdateAutoPostSettings\(/)).toEqual(['pages/api/accounting/bank-auto-post.ts']);
    expect(filesMatching(/\bupdateAutoPostSettings\b/)).toEqual([
      'pages/api/accounting/bank-auto-post.ts',
      'src/modules/accounting/services/bank/autoPostGateService.ts',
      SERVICE,
    ]);
  });
});
