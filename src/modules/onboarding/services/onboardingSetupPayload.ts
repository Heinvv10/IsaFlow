/**
 * The request body of POST /api/onboarding/complete-setup, parsed and checked
 * before anything is written: shape, the idempotency key, and every uploaded
 * file (MIME allowlist + magic bytes + 20 MB cap, as /api/onboarding/documents
 * and /api/accounting/company-directors check them). The per-entity rules
 * (entityOnboardingRules.setupIssues) run on the result in the route.
 *
 * Server only: decodes files with Buffer.
 */

import { isEntityTypeCode, type EntityTypeCode } from '@/lib/entityTypes';
import { decodeUploadPayload, magicBytesMatchMime } from '@/lib/fileMagic';
import type { CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { SetupFacts } from './entityOnboardingRules';

export const COA_TEMPLATES: readonly CoaTemplate[] = ['isaflow_standard', 'xero_compatible', 'sage_compatible', 'blank'];
export const ALLOWED_UPLOAD_MIMES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENTS = 20;
export const MAX_PEOPLE = 50;

const COMPANY_TEXT_FIELDS = [
  'tradingName', 'registrationNumber', 'vatNumber', 'taxNumber', 'email', 'phone', 'website',
  'addressLine1', 'addressLine2', 'city', 'province', 'postalCode', 'country', 'logoData',
  'bankName', 'bankAccountNumber', 'bankBranchCode', 'bankAccountType',
  'vatPeriod', 'vatSystemType', 'defaultCurrency',
] as const;
type CompanyTextField = typeof COMPANY_TEXT_FIELDS[number];

export type SetupCompany = { name: string; financialYearStart?: number } & { [K in CompanyTextField]?: string };

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

/** null when the file is acceptable, else the reason it is not. */
function uploadProblem(label: string, data: string, mimeType: string): string | null {
  if (!ALLOWED_UPLOAD_MIMES.includes(mimeType)) return `${label}: file type ${mimeType || '(missing)'} not allowed`;
  const buf = decodeUploadPayload(data);
  if (!buf) return `${label}: invalid or empty file data`;
  if (buf.length > MAX_UPLOAD_BYTES) return `${label} exceeds the 20 MB limit`;
  if (!magicBytesMatchMime(buf, mimeType)) return `${label}: contents do not match ${mimeType}`;
  return null;
}

function parseCompany(raw: unknown): SetupCompany | string {
  if (!isObject(raw)) return 'company is required';
  const company: SetupCompany = { name: text(raw.name).trim() };
  for (const field of COMPANY_TEXT_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return `company.${field} must be text`;
    company[field] = v;
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
  if (raw.idDocument === undefined || raw.idDocument === null) return { name, idNumber, idDocument: null };
  if (!isObject(raw.idDocument)) return `people[${i}].idDocument must be an object`;
  const data = text(raw.idDocument.data);
  // The data-URL prefix names the type; the magic bytes must agree with it.
  const mimeType = /^data:([^;]+);base64,/.exec(data)?.[1] ?? '';
  const label = `ID document of ${name || `person ${i + 1}`}`;
  const problem = uploadProblem(label, data, mimeType);
  if (problem) return problem;
  return { name, idNumber, idDocument: { name: text(raw.idDocument.name) || 'id-document', data, mimeType } };
}

function parseDocument(raw: unknown, i: number): SetupDocument | string {
  if (!isObject(raw)) return `documents[${i}] must be an object`;
  const type = text(raw.type);
  const name = text(raw.name) || type;
  const data = text(raw.data);
  const mimeType = text(raw.mimeType);
  if (!type) return `documents[${i}].type is required`;
  const problem = uploadProblem(`Document "${name}"`, data, mimeType);
  if (problem) return problem;
  return { type, name, data, mimeType, size: decodeUploadPayload(data)!.length };
}

export function parseSetupRequest(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, error: 'A JSON body is required' };
  if (typeof body.requestKey !== 'string' || !UUID.test(body.requestKey)) return { ok: false, error: 'requestKey must be a UUID' };
  if (!isEntityTypeCode(body.entityType)) return { ok: false, error: 'Choose the type of business' };
  const coaTemplate = (body.coaTemplate ?? 'isaflow_standard') as CoaTemplate;
  if (!COA_TEMPLATES.includes(coaTemplate)) return { ok: false, error: `coaTemplate must be one of ${COA_TEMPLATES.join(', ')}` };

  const company = parseCompany(body.company);
  if (typeof company === 'string') return { ok: false, error: company };

  const rawPeople = body.people ?? [];
  const rawDocs = body.documents ?? [];
  if (!Array.isArray(rawPeople)) return { ok: false, error: 'people must be an array' };
  if (!Array.isArray(rawDocs)) return { ok: false, error: 'documents must be an array' };
  if (rawPeople.length > MAX_PEOPLE) return { ok: false, error: `Maximum ${MAX_PEOPLE} people` };
  if (rawDocs.length > MAX_DOCUMENTS) return { ok: false, error: `Maximum ${MAX_DOCUMENTS} documents` };

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
    people: req.people.map(p => ({ name: p.name, hasIdDocument: p.idDocument !== null })),
    documentTypes: req.documents.map(d => d.type),
  };
}
