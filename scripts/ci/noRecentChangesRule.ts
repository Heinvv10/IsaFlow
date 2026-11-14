/**
 * Agent docs hold rules only. Change history lives in commit messages and PR bodies: an append-only
 * "## Recent changes" list in a `.claude.md` made every PR add a line at the same spot, and parallel PRs conflicted
 * (41 merge-queue ejections, 12-14 Nov 2026). The sections that existed were moved into frozen `CHANGES-ARCHIVE.md` files.
 */

const HEADING = /^#{1,6}[ \t]+recent changes\b/i;
const DOC_NAME = /(^|\/)(\.claude\.md|[^/]*\.claude\.md|CLAUDE\.md|AGENTS\.md)$/;
const ARCHIVE_NAME = /(^|\/)CHANGES-ARCHIVE\.md$/;

export interface DocFile {
  path: string;
  text: string;
}

export function isAgentDoc(path: string): boolean {
  return DOC_NAME.test(path);
}

export function isArchive(path: string): boolean {
  return ARCHIVE_NAME.test(path);
}

/** One message per "Recent changes" heading found in an agent doc. Fenced code blocks are skipped. */
export function findRecentChangesHeadings(files: DocFile[]): string[] {
  const errors: string[] = [];
  for (const { path, text } of files) {
    if (!isAgentDoc(path)) continue;
    let fenced = false;
    text.split('\n').forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (!fenced && HEADING.test(line)) {
        errors.push(`${path}:${i + 1}: "${line.trim()}" — agent docs hold rules only; put change history in the commit message / PR body`);
      }
    });
  }
  return errors;
}

export interface NumstatRow {
  path: string;
  added: number;
  deleted: number;
}

/** Parse `git diff --numstat` output. A binary file reports `-` and is read as 0/0. */
export function parseNumstat(output: string): NumstatRow[] {
  return output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [a = '', d = '', ...rest] = l.split('\t');
      return { path: rest.join('\t'), added: Number(a) || 0, deleted: Number(d) || 0 };
    });
}

/** Archives that already exist on the base are frozen: any added line fails. Deleting lines is allowed. */
export function findArchiveAppends(modified: NumstatRow[]): string[] {
  return modified
    .filter((r) => isArchive(r.path) && r.added > 0)
    .map((r) => `${r.path}: ${r.added} line(s) added to a frozen archive — history goes in the commit message / PR body`);
}
