/**
 * One notes file per folder: `AGENTS.md`. A tracked `.claude.md` (or `<file>.claude.md`) is the old second copy that
 * doubled every note and every merge conflict, so it must not come back.
 */
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

export const findClaudeMdNotes = (files: string[]): string[] =>
  files.filter((f) => /(^|\/)(\.|[^/]+\.)claude\.md$/.test(f)).sort();

describe('findClaudeMdNotes', () => {
  it('flags folder and per-file .claude.md notes', () => {
    expect(findClaudeMdNotes(['a/.claude.md', 'src/lib/x.claude.md', 'a/AGENTS.md', 'CLAUDE.md', 'a/x.AGENTS.md']))
      .toEqual(['a/.claude.md', 'src/lib/x.claude.md']);
  });
});

describe('tracked notes files', () => {
  it('has no .claude.md tracked', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
    expect(findClaudeMdNotes(tracked)).toEqual([]);
  });
});
