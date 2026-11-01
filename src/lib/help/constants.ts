import path from 'path';
import { SITE_URL } from '@/lib/blog/constants';

export const HELP_PATH = '/help';
export const HELP_URL = `${SITE_URL}${HELP_PATH}`;
export const HELP_DESCRIPTION =
  'Help with ISAFlow accounts, bureaus, payroll, migration, SARS return preparation, billing and security.';
export const DEFAULT_HELP_CONTENT_DIR = (): string => path.join(process.cwd(), 'content', 'help');
