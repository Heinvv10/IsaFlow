/** The "no Recent changes in agent docs" rule: fails on a planted heading, passes without one, freezes archives. */
import { describe, expect, it } from 'vitest';
import { findArchiveAppends, findRecentChangesHeadings, parseNumstat } from '../../../scripts/ci/noRecentChangesRule';

const doc = (path: string, text: string) => findRecentChangesHeadings([{ path, text }]);

describe('Recent changes heading', () => {
  it.each([
    ['src/a/.claude.md', '# A\n\n## Recent changes\n- x\n'],
    ['src/a/.claude.md', '## RECENT CHANGES\n'],
    ['CLAUDE.md', '## recent changes\n'],
    ['src/a/AGENTS.md', '## Recent changes\n'],
    ['src/lib/neon.claude.md', '## Recent changes\n'],
    ['src/a/.claude.md', '### Recent changes (2026)\n'],
  ])('is flagged in %s', (path, text) => {
    expect(doc(path, text)).toHaveLength(1);
  });

  it('reports the line number', () => {
    expect(doc('a/.claude.md', 'x\ny\n## Recent changes\n')[0]).toContain('a/.claude.md:3:');
  });

  it.each([
    ['a body that merely mentions it', 'see Recent changes in bank/.claude.md\n'],
    ['a fenced example', '```\n## Recent changes\n```\n'],
    ['a different heading', '## Business rules\n'],
  ])('is not flagged: %s', (_l, text) => {
    expect(doc('a/.claude.md', text)).toEqual([]);
  });

  it('ignores files that are not agent docs, archives included', () => {
    expect(doc('a/CHANGES-ARCHIVE.md', '## Recent changes\n')).toEqual([]);
    expect(doc('docs/notes.md', '## Recent changes\n')).toEqual([]);
  });
});

describe('frozen archives', () => {
  const rows = parseNumstat('3\t0\tsrc/a/CHANGES-ARCHIVE.md\n0\t5\tsrc/b/CHANGES-ARCHIVE.md\n2\t0\tsrc/c/.claude.md\n-\t-\tsrc/d/CHANGES-ARCHIVE.md\n');

  it('fails on added lines only', () => {
    const errors = findArchiveAppends(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('src/a/CHANGES-ARCHIVE.md');
  });

  it('passes when nothing is modified', () => {
    expect(findArchiveAppends(parseNumstat(''))).toEqual([]);
  });
});
