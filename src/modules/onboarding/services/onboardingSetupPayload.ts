/**
 * The request body of POST /api/onboarding/complete-setup, parsed and checked
 * before anything is written: shape, the idempotency key, text lengths, the VAT
 * pair (stored normalised), the logo (as /api/accounting/company-logo checks
 * it), and every uploaded file (MIME allowlist, a data-URL prefix that agrees
 * with the claimed type, magic bytes, 1 KB minimum, 20 MB maximum, 30 MB per
 * request; uploadLimits.ts). The per-entity rules
 * (entityOnboardingRules.setupIssues) run on the result in the route.
 *
 * Server only: decodes files with Buffer.
 */

import { isEntityTypeCode, type EntityTypeCode } from '@/lib/entityTypes';
import { decodeUploadPayload, magicBytesMatchMime } from '@/lib/fileMagic';
import type { CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  isValidVatPeriod, isValidVatSystemType, normaliseVatSetting,
} from '@/modules/accounting/services/core/vatSettingValidation';
import {
  ALLOWED_UPLOAD_MIMES, LOGO_DATA_URL_RE, MAX_LOGO_DATA_URL_CHARS, MAX_TEXT_CHARS, MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES, MIN_UPLOAD_BYTES, TOTAL_TOO_LARGE, decodedBytes,
} from '../uploadLimits';
import type { SetupFacts } from './entityOnboardingRules';

export const COA_TEMPLATES: readonly CoaTemplate[] = ['isaflow_standard', 'xero_compatible', 'sage_compatible', 'blank'];
export const MAX_DOCUMENTS = 20;
export const MAX_PEOPLE = 50;

const COMPANY_TEXT_FIELDS = [
  'tradingName', 'registrationNumber', 'vatNumber', 'taxNumber', 'email', 'phone', 'website',
  'addressLine1', 'addressLine2', 'city', 'province', 'postalCode', 'country',
  'bankName', 'bankAccountNumber', 'bankBranchCode', 'bankAccountType',
  'vatPeriod', 'vatSystemType', 'defaultCurrency',
] as const;
type CompanyTextField = typeof COMPANY_TEXT_FIELDS[number];

export type SetupCompany = { name: string; financialYearStart?: number; logoData?: string } & { [K in CompanyTextField]?: string };

export interface SetupUpload { name: string; data: string; mimeType: string }
export interface SetupPerson { name: string; idNumber: string | null; idDocument: SetupUpload | null }
export interface SetupDocument extends SetupUpload { type: string; size: number }

export interface SetupRequest {
  requestKey: string;
  entityType: EntityTypeCode;
  coaTemplate: CoaTemplate;
  company: SetupCompany;
  people: SetupPerson[];
  documents: SetupDocument[];
}

export type ParseResult = { ok: true; value: SetupRequest } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const tooLong = (label: string) => `${label} is longer than ${MAX_TEXT_CHARS} characters`;
const prefixMime = (data: string) => /^data:([^;,]+)[;,]/.exec(data)?.[1] ?? null;

/** null when the file is acceptable, else the reason it is not. */
function uploadProblem(label: string, data: string, mimeType: string): string | null {
  if (!ALLOWED_UPLOAD_MIMES.includes(mimeType)) return `${label}: file type ${mimeType || '(missing)'} not allowed`;
  const buf = decodeUploadPayload(data);
  if (!buf) return `${label}: invalid or empty file data`;
  if (buf.length > MAX_UPLOAD_BYTES) return `${label} exceeds the 20 MB limit`;
  if (!magicBytesMatchMime(buf, mimeType)) return `${label}: contents do not match ${mimeType}`;
  if (buf.length < MIN_UPLOAD_BYTES) return `${label} is too small to be a real document (under 1 KB)`;
  return null;
}

function parseCompany(raw: unknown): SetupCompany | string {
  if (!isObject(raw)) return 'company is required';
  const company: SetupCompany = { name: text(raw.name).trim() };
  if (company.name.length > MAX_TEXT_CHARS) return tooLong('company.name');
  for (const field of COMPANY_TEXT_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return `company.${field} must be text`;
    if (v.length > MAX_TEXT_CHARS) return tooLong(`company.${field}`);
    company[field] = v;
  }
  if (!isValidVatPeriod(company.vatPeriod)) return "vatPeriod must be 'monthly', 'bi-monthly' or 'none'";
  if (!isValidVatSystemType(company.vatSystemType)) return "vatSystemType must be 'invoice', 'payment' or 'none'";
  company.vatPeriod = normaliseVatSetting(company.vatPeriod);
  company.vatSystemType = normaliseVatSetting(company.vatSystemType);
  if (raw.logoData !== undefined && raw.logoData !== null && raw.logoData !== '') {
    const logo = raw.logoData;
    if (typeof logo !== 'string' || logo.length > MAX_LOGO_DATA_URL_CHARS || !LOGO_DATA_URL_RE.test(logo)) {
      return 'Logo must be a base64 PNG, JPEG, GIF, or WebP data URL smaller than 5MB';
    }
    const buf = decodeUploadPayload(logo);
    if (!buf || !magicBytesMatchMime(buf, prefixMime(logo) ?? '')) return 'Logo file content does not match declared type';
    company.logoData = logo;
  }
  if (raw.financialYearStart !== undefined && raw.financialYearStart !== null) {
    const m = raw.financialYearStart;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 12) return 'company.financialYearStart must be a month 1-12';
    company.financialYearStart = m;
  }
  return company;
}

function parsePerson(raw: unknown, i: number): SetupPerson | string {
  if (!isObject(raw)) return `people[${i}] must be an object`;
  const name = text(raw.name).trim();
  const idNumber = text(raw.idNumber).trim() || null;
  if (name.length > MAX_TEXT_CHARS) return tooLong(`people[${i}].name`);
  if (idNumber && idNumber.length > MAX_TEXT_CHARS) return tooLong(`people[${i}].idNumber`);
  if (raw.idDocument === undefined || raw.idDocument === null) return { name, idNumber, idDocument: null };
  if (!isObject(raw.idDocument)) return `people[${i}].idDocument must be an object`;
  const data = text(raw.idDocument.data);
  // The data-URL prefix names the type; the magic bytes must agree with it.
  const mimeType = /^data:([^;]+);base64,/.exec(data)?.[1] ?? '';
  const docName = text(raw.idDocument.name) || 'id-document';
  if (docName.length > MAX_TEXT_CHARS) return tooLong(`people[${i}].idDocument.name`);
  const problem = uploadProblem(`ID document of ${name || `person ${i + 1}`}`, data, mimeType);
  if (problem) return problem;
  return { name, idNumber, idDocument: { name: docName, data, mimeType } };
}

function parseDocument(raw: unknown, i: number): SetupDocument | string {
  if (!isObject(raw)) return `documents[${i}] must be an object`;
  const type = text(raw.type);
  const name = text(raw.name) || type;
  const data = text(raw.data);
  const mimeType = text(raw.mimeType);
  if (!type) return `documents[${i}].type is required`;
  if (type.length > MAX_TEXT_CHARS || name.length > MAX_TEXT_CHARS) return tooLong(`documents[${i}].name`);
  const declared = prefixMime(data);
  if (declared !== null && declared !== mimeType) return `Document "${name}": the file says ${declared}, not ${mimeType || '(missing)'}`;
  const problem = uploadProblem(`Document "${name}"`, data, mimeType);
  if (problem) return problem;
  return { type, name, data, mimeType, size: decodeUploadPayload(data)!.length };
}

/** Decoded bytes of every file in the body, estimated from the base64 length (no decode). */
function totalUploadBytes(people: unknown[], docs: unknown[], company: unknown): number {
  const of = (v: unknown) => (typeof v === 'string' ? decodedBytes(v) : 0);
  const idDoc = (p: unknown) => (isObject(p) && isObject(p.idDocument) ? of(p.idDocument.data) : 0);
  return people.reduce<number>((n, p) => n + idDoc(p), 0)
    + docs.reduce<number>((n, d) => n + (isObject(d) ? of(d.data) : 0), 0)
    + (isObject(company) ? of(company.logoData) : 0);
}

export function parseSetupRequest(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, error: 'A JSON body is required' };
  if (typeof body.requestKey !== 'string' || !UUID.test(body.requestKey)) return { ok: false, error: 'requestKey must be a UUID' };
  if (!isEntityTypeCode(body.entityType)) return { ok: false, error: 'Choose the type of business' };
  const coaTemplate = (body.coaTemplate ?? 'isaflow_standard') as CoaTemplate;
  if (!COA_TEMPLATES.includes(coaTemplate)) return { ok: false, error: `coaTemplate must be one of ${COA_TEMPLATES.join(', ')}` };

  const rawPeople = body.people ?? [];
  const rawDocs = body.documents ?? [];
  if (!Array.isArray(rawPeople)) return { ok: false, error: 'people must be an array' };
  if (!Array.isArray(rawDocs)) return { ok: false, error: 'documents must be an array' };
  if (rawPeople.length > MAX_PEOPLE) return { ok: false, error: `Maximum ${MAX_PEOPLE} people` };
  if (rawDocs.length > MAX_DOCUMENTS) return { ok: false, error: `Maximum ${MAX_DOCUMENTS} documents` };
  if (totalUploadBytes(rawPeople, rawDocs, body.company) > MAX_TOTAL_UPLOAD_BYTES) return { ok: false, error: TOTAL_TOO_LARGE };

  const company = parseCompany(body.company);
  if (typeof company === 'string') return { ok: false, error: company };

  const people: SetupPerson[] = [];
  for (const [i, raw] of rawPeople.entries()) {
    const p = parsePerson(raw, i);
    if (typeof p === 'string') return { ok: false, error: p };
    if (p.name) people.push(p); // a blank row is dropped, as the directors route always has
  }
  const documents: SetupDocument[] = [];
  for (const [i, raw] of rawDocs.entries()) {
    const d = parseDocument(raw, i);
    if (typeof d === 'string') return { ok: false, error: d };
    documents.push(d);
  }
  return {
    ok: true,
    value: { requestKey: body.requestKey.toLowerCase(), entityType: body.entityType, coaTemplate, company, people, documents },
  };
}

/** The facts the per-entity rules judge. */
export function setupFactsOf(req: SetupRequest): SetupFacts {
  return {
    entityType: req.entityType,
    name: req.company.name,
    registrationNumber: req.company.registrationNumber ?? null,
    people: req.people.map(p => ({
      name: p.name, hasIdDocument: p.idDocument !== null, idNumber: p.idNumber, idDocumentData: p.idDocument?.data ?? null,
    })),
    documentTypes: req.documents.map(d => d.type),
  };
}
