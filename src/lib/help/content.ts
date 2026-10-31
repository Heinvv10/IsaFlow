import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { z } from 'zod';
import { KEBAB_CASE } from '@/lib/blog/frontmatter';
import { DEFAULT_HELP_CONTENT_DIR } from './constants';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function yamlDateToString(value: unknown): unknown {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  return value.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const helpFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  slug: z.string().regex(KEBAB_CASE, 'must be lowercase kebab-case'),
  description: z.string().trim().min(1).max(155, 'must be at most 155 characters'),
  order: z.number().int().nonnegative(),
  updated: z.preprocess(yamlDateToString, z.string().refine(validDate, 'must be an ISO date (YYYY-MM-DD)')),
}).strict();

export type HelpFrontmatter = z.output<typeof helpFrontmatterSchema>;

export interface HelpDocument {
  frontmatter: HelpFrontmatter;
  body: string;
  sourcePath: string;
}

export interface HelpLoadOptions {
  contentDir?: string;
}

export class HelpContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelpContentError';
  }
}

function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

function parseFrontmatter(raw: unknown, sourcePath: string): HelpFrontmatter {
  const result = helpFrontmatterSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
  throw new HelpContentError(`Invalid help frontmatter in ${sourcePath}:\n${issues}`);
}

export function loadHelpDocumentFile(file: string): HelpDocument {
  const sourcePath = relative(file);
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(fs.readFileSync(file, 'utf8'), {});
  } catch (error) {
    throw new HelpContentError(`Cannot parse frontmatter in ${sourcePath}: ${(error as Error).message}`);
  }
  const frontmatter = parseFrontmatter(parsed.data, sourcePath);
  const fileSlug = path.basename(file, '.md');
  if (frontmatter.slug !== fileSlug) {
    throw new HelpContentError(
      `Invalid help frontmatter in ${sourcePath}:\n  - slug: "${frontmatter.slug}" must match the file name "${fileSlug}"`,
    );
  }
  return { frontmatter, body: parsed.content, sourcePath };
}

export function loadAllHelpDocuments(options: HelpLoadOptions = {}): HelpDocument[] {
  const contentDir = options.contentDir ?? DEFAULT_HELP_CONTENT_DIR();
  if (!fs.existsSync(contentDir)) return [];
  return fs.readdirSync(contentDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => loadHelpDocumentFile(path.join(contentDir, entry.name)))
    .sort((a, b) => a.frontmatter.order - b.frontmatter.order || a.frontmatter.title.localeCompare(b.frontmatter.title));
}

export function findHelpDocument(documents: HelpDocument[], slug: string): HelpDocument | undefined {
  return documents.find((document) => document.frontmatter.slug === slug);
}
