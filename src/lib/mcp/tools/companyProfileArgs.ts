/**
 * update_company_profile argument parsing: shape and vocabulary only (the format rules and everything that depends
 * on the company's state are companyVatProfileService's, shared by the dry run and the live call).
 */
import {
  VAT_ALIGNMENTS, VAT_CATEGORIES, compactNumber, type VatProfileRequest,
} from '@/modules/accounting/services/core/companyVatProfile';
import type { VatAlignment } from '@/modules/bureau/services/vatPeriodHelper';

const FIELD_KEYS = ['vat_number', 'income_tax_number', 'vat_category', 'vat_alignment'] as const;

export interface ProfileArgs { request: VatProfileRequest; acknowledgePeriodChange: boolean; dryRun: boolean }

function text(args: Record<string, unknown>, key: string): string | null | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The parsed arguments, or the refusal text. */
export function parseProfileArgs(args: Record<string, unknown>): ProfileArgs | string {
  if (typeof args.dry_run !== 'boolean') {
    return 'dry_run is required: true runs every check and the write, then rolls it back; false changes the company profile';
  }
  if (args.acknowledge_period_change !== undefined && typeof args.acknowledge_period_change !== 'boolean') {
    return 'acknowledge_period_change must be true or false';
  }
  const request: VatProfileRequest = {};
  for (const key of FIELD_KEYS) {
    if (text(args, key) === null) return `${key} must be a non-empty string (clearing a value is not supported)`;
  }
  const vat = text(args, 'vat_number');
  if (vat) request.vatNumber = compactNumber(vat);
  const tax = text(args, 'income_tax_number');
  if (tax) request.incomeTaxNumber = compactNumber(tax);
  const category = text(args, 'vat_category');
  if (category) {
    const code = category.toUpperCase();
    if (code === 'D' || code === 'E') {
      return `vat_category ${code} (six-monthly / annual) is not supported: IsaFlow's VAT cycle is monthly (C) or bi-monthly (A, B).`;
    }
    if (!(VAT_CATEGORIES as readonly string[]).includes(code)) return `vat_category must be one of: ${VAT_CATEGORIES.join(', ')}`;
    request.category = code as (typeof VAT_CATEGORIES)[number];
  }
  const alignment = text(args, 'vat_alignment');
  if (alignment) {
    const a = alignment.toLowerCase();
    if (!(VAT_ALIGNMENTS as readonly string[]).includes(a)) return `vat_alignment must be one of: ${VAT_ALIGNMENTS.join(', ')}`;
    request.alignment = a as VatAlignment;
  }
  if (Object.keys(request).length === 0) {
    return `Send at least one of: ${FIELD_KEYS.join(', ')}.`;
  }
  return { request, acknowledgePeriodChange: args.acknowledge_period_change === true, dryRun: args.dry_run };
}
