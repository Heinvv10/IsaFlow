/**
 * The brand is spelled "IsaFlow" in every user-visible string, alt text, email and comment under src/, pages/ and
 * public/. "ISAFlow" survives only where it is data or a wire identifier (see KEEP) and in the files below that
 * belong to other open work (ALLOWED), which only ever shrinks.
 *
 * Reads the working tree (tracked and untracked files), so a new file cannot slip past before it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';

const ROOT = process.cwd();
const listFiles = (): string[] => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages', 'public'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => /\.(tsx?|js|mjs|html|txt|json|webmanifest)$/.test(f));

/** Spellings that stay: a company literally named "ISAFlow Demo", the OAuth realm, and the search alias in llms.txt. */
const KEEP = /ISAFlow Demo|realm="ISAFlow"|also written ISAFlow/g;

/** Files left for follow-up because other open PRs or review own them. Remove an entry once its file is fixed. */
const ALLOWED = new Set([
  'src/components/accounting/sars/emp201/Emp201SubmitModal.tsx',
  'src/components/accounting/sars/VAT201SubmitModal.tsx',
  'pages/accounting/journal-entries/new.tsx',
  'pages/accounting/credit-notes/new.tsx',
  'pages/accounting/supplier-payments/new.tsx',
  'src/lib/mcp/tools/writePayrollRun.ts',
  'src/lib/mcp/tools/writePayroll.ts',
  'src/modules/accounting/services/gl/chartOfAccountsImportService.ts',
  'src/modules/bureau/services/sharingConsentCopy.ts',
]);

const stripKept = (text: string): string => text.replace(KEEP, '');
const hits = (files: string[]): string[] => files.filter((f) => !ALLOWED.has(f)).flatMap((f) =>
  readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')
    .map((line, i) => (stripKept(line).includes('ISAFlow') ? `${f}:${i + 1}` : ''))
    .filter(Boolean));

describe('brand spelling', () => {
  it('has no "ISAFlow" under src/, pages/ or public/ outside the allowlist', () => {
    expect(hits(listFiles())).toEqual([]);
  });

  it('keeps the allowlist honest: every entry exists and still needs it', () => {
    for (const f of ALLOWED) {
      expect(existsSync(`${ROOT}/${f}`), `${f} exists`).toBe(true);
      expect(stripKept(readFileSync(`${ROOT}/${f}`, 'utf8')), `${f} still has ISAFlow, drop it from ALLOWED`).toContain('ISAFlow');
    }
  });

  it('flags the shapes it is meant to flag', () => {
    expect(stripKept('<img alt="ISAFlow" />')).toContain('ISAFlow');
    expect(stripKept("'Sign in to your ISAFlow account'")).toContain('ISAFlow');
    expect(stripKept('ISAFlow Demo')).not.toContain('ISAFlow');
    expect(stripKept('Sign in to your IsaFlow account')).not.toContain('ISAFlow');
  });

  it('finds a new file that uses the old spelling (written, scanned, removed)', () => {
    const probe = 'pages/zzBrandProbe.tsx';
    try {
      writeFileSync(`${ROOT}/${probe}`, "export const x = 'ISAFlow';\n");
      expect(hits(listFiles())).toContain(`${probe}:1`);
    } finally {
      rmSync(`${ROOT}/${probe}`, { force: true });
    }
  });
});
