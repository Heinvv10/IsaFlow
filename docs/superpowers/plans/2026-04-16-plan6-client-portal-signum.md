# Plan 6 — Client Portal + Signum Integration
**Date:** 2026-04-16  
**Status:** Ready for implementation  
**Depends on:** Plans 1–5 complete — types at `@/modules/accounting/services/afs/afsTypes.ts`  
**Scope:** Portal contacts, magic-link auth, client portal pages, Signum e-signature integration, webhook handler

---

## Overview

Plan 6 adds the client-facing layer on top of the AFS document engine built in Plans 1–5. It delivers:

- A portal contacts CRUD system (directors, CFOs, shareholders, auditors) with role-based access rules
- Magic-link authentication for portal contacts (no passwords, 15-minute single-use tokens)
- A `withPortalAuth` middleware for portal API routes, separate from staff `withCompany`
- Signum integration — upload AFS PDF to Signum, distribute signing emails, receive webhook on completion
- A signing page that embeds Signum in an iframe with full ISaFlow branding
- Client portal pages: login, dashboard, document viewer, annotation
- Portal notification service (email + in-app) for key lifecycle events

**What is NOT in scope:** Management pack delivery (Plan 7), compliance checker (Plan 8), DOCX/Caseware export (Plan 4), review workflow internal UI (Plan 5).

---

## Prerequisites — Signum Changes Required

Before this plan can go live, Signum must be updated (tracked separately). Four changes are needed:

1. **Replace Puppeteer with WeasyPrint** in `lib/html-to-pdf.ts` — same function signature, better output.
2. **Add embed mode** (`?embed=true`) to `/sign/[token]` — removes Signum's own nav, fires `postMessage({ type: 'signum:signed' })` on completion.
3. **Configurable `callbackBaseUrl`** per document — ISaFlow passes `https://app.isaflow.co.za/accounting/afs/sign` so signing email links stay on ISaFlow's domain.
4. **Configurable `expiresInDays`** per document — ISaFlow passes 30 days (default 7 is too short for AFS).

---

## Environment Variables Required

```
SIGNUM_URL=http://signum:3001
SIGNUM_API_KEY=<key>
SIGNUM_WEBHOOK_SECRET=<hmac-secret>   # used to verify X-Signum-Signature header
PORTAL_JWT_SECRET=<32-byte-hex>        # signs portal_session cookies
```

Add all four to `.env.local` (dev) and the production systemd environment drop-in.

---

## 1. Migrations

### `scripts/migrations/sql/342_portal_contacts.sql`

```sql
-- Migration 342: Portal contacts for client portal access
-- Stores directors, CFOs, shareholders, and auditors who access the client portal.

CREATE TABLE IF NOT EXISTS portal_contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  name        text        NOT NULL,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('director', 'cfo', 'shareholder_readonly', 'external_auditor')),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_company_id
  ON portal_contacts(company_id);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_email
  ON portal_contacts(email);
```

**Notes:**
- `UNIQUE (company_id, email)` prevents duplicate contacts per tenant.
- `role` is an inline CHECK rather than a separate enum — easier to add roles later without a migration.
- `active = false` soft-deletes a contact without breaking foreign keys in `portal_magic_links`.

---

### `scripts/migrations/sql/343_portal_magic_links.sql`

```sql
-- Migration 343: Magic link tokens for portal authentication
-- Single-use, 15-minute expiry tokens sent to portal contacts by email.

CREATE TABLE IF NOT EXISTS portal_magic_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  contact_id  uuid        NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_token
  ON portal_magic_links(token);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_contact_id
  ON portal_magic_links(contact_id);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_company_id
  ON portal_magic_links(company_id);
```

**Notes:**
- `ON DELETE CASCADE` on `contact_id` — deactivating + deleting a contact revokes all outstanding tokens.
- `token` has a `UNIQUE` index for fast O(1) lookup at verification time.
- `used_at` is set atomically on first use; subsequent uses are rejected.

---

## 2. Type Definitions

All new types live in `src/modules/accounting/services/afs/afsTypes.ts` (augment the existing file from Plan 1). Append to the end of that file:

```typescript
// ── Client Portal Types ────────────────────────────────────────────────────────

export type PortalRole = 'director' | 'cfo' | 'shareholder_readonly' | 'external_auditor';

export interface PortalContact {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: PortalRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MagicLink {
  id: string;
  companyId: string;
  contactId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface PortalSession {
  contactId: string;
  companyId: string;
  role: PortalRole;
  expiresAt: string; // ISO string — stored in signed cookie
}

export interface SignumUploadResult {
  signumDocumentId: string;
  signingUrl: string;
}

export interface PortalDocumentView {
  id: string;
  companyId: string;
  fiscalYear: number | null;
  period: string | null;
  documentType: 'afs' | 'management_pack';
  status: string;
  signedPdfPath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Document access rules by portal role
export const PORTAL_ACCESS_RULES: Record<PortalRole, {
  documentTypes: Array<'afs' | 'management_pack'>;
  statuses: string[]; // empty array = all statuses
  canAnnotate: boolean;
}> = {
  director: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  cfo: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  shareholder_readonly: {
    documentTypes: ['afs'],
    statuses: ['signed_off', 'filed'],
    canAnnotate: false,
  },
  external_auditor: {
    documentTypes: ['afs'],
    statuses: [], // all
    canAnnotate: false,
  },
};
```

---

## 3. Services

### 3.1 `src/modules/accounting/services/afs/portalContactService.ts`

CRUD for portal contacts. All queries tenant-scoped by `company_id`.

**Exports:**

```typescript
export async function listPortalContacts(companyId: string): Promise<PortalContact[]>
export async function createPortalContact(
  companyId: string,
  input: { name: string; email: string; role: PortalRole }
): Promise<PortalContact>
export async function updatePortalContact(
  companyId: string,
  contactId: string,
  input: Partial<{ name: string; role: PortalRole; active: boolean }>
): Promise<PortalContact>
export async function deletePortalContact(companyId: string, contactId: string): Promise<void>
export async function getPortalContactByEmail(email: string): Promise<PortalContact | null>
```

**Implementation notes:**
- `listPortalContacts` filters `WHERE company_id = $companyId AND active = true` by default. Include inactive contacts only when explicitly requested.
- `createPortalContact` validates that `role` is one of the four valid enum values before inserting. Throws `Error('DUPLICATE_EMAIL')` if the unique constraint fires — callers catch and return `apiResponse.badRequest`.
- `updatePortalContact` fetches first, confirms `company_id` matches (IDOR guard), then updates. Returns updated record.
- `deletePortalContact` performs a soft delete: `UPDATE portal_contacts SET active = false WHERE id = $id AND company_id = $companyId`. Does not physically delete (preserves audit trail and magic link history).
- `getPortalContactByEmail` is used during magic link verification — does NOT scope by `company_id` because the token's `company_id` comes from the magic link record itself, not the URL. This is safe: the lookup is immediately cross-checked against the magic link's `contact_id`.

**Pattern:**
```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalContact, PortalRole } from './afsTypes';

export async function listPortalContacts(companyId: string): Promise<PortalContact[]> {
  const rows = await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE company_id = ${companyId}::UUID AND active = true
    ORDER BY name ASC
  `;
  return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): PortalContact {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as PortalRole,
    active: Boolean(row.active),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}
```

---

### 3.2 `src/modules/accounting/services/afs/magicLinkService.ts`

Generate and verify single-use magic link tokens for portal contacts.

**Exports:**

```typescript
export async function generateMagicLink(
  companyId: string,
  contactId: string
): Promise<{ token: string; expiresAt: Date }>

export async function verifyMagicLink(
  token: string
): Promise<{ contact: PortalContact; companyId: string } | null>

export async function cleanupExpiredMagicLinks(): Promise<void>
```

**Implementation notes:**
- Token generation: `crypto.randomBytes(32).toString('hex')` — 64 hex chars, 256 bits entropy.
- `expiresAt`: `new Date(Date.now() + 15 * 60 * 1000)` (15 minutes from now).
- Before inserting, invalidate any existing unused tokens for the same `contact_id` (`UPDATE portal_magic_links SET used_at = now() WHERE contact_id = $contactId AND used_at IS NULL AND expires_at > now()`). This prevents token accumulation if a user requests multiple links.
- `verifyMagicLink` runs atomically:
  1. `SELECT ... WHERE token = $token AND used_at IS NULL AND expires_at > now()` — returns null if not found.
  2. `UPDATE portal_magic_links SET used_at = now() WHERE id = $id AND used_at IS NULL` — check `rowCount === 1` to guard against race conditions (two simultaneous verifications).
  3. If `rowCount !== 1`, return null (token was consumed by a concurrent request).
  4. Load the `PortalContact` from `portal_contacts` and return.
- `cleanupExpiredMagicLinks`: `DELETE FROM portal_magic_links WHERE expires_at < now() - INTERVAL '7 days'` — keeps the table tidy. Called from a maintenance job (not in-request).

---

### 3.3 `src/modules/accounting/services/afs/signumIntegrationService.ts`

Calls the Signum API to upload PDFs, track signing status, and download signed copies.

**Exports:**

```typescript
export async function sendForSigning(
  documentId: string,
  companyId: string,
  pdfBuffer: Buffer,
  signers: Array<{ email: string; name: string; order: number }>,
  callbackBaseUrl: string,
): Promise<{ signumDocumentId: string }>

export async function downloadSignedPdf(signumDocumentId: string): Promise<Buffer>

export async function registerSignumWebhook(callbackUrl: string): Promise<void>

export function verifySignumWebhookSignature(
  payload: string,
  receivedSignature: string,
): boolean
```

**`sendForSigning` implementation:**

```typescript
export async function sendForSigning(
  documentId: string,
  companyId: string,
  pdfBuffer: Buffer,
  signers: Array<{ email: string; name: string; order: number }>,
  callbackBaseUrl: string,
): Promise<{ signumDocumentId: string }> {
  const signumUrl = process.env.SIGNUM_URL;
  const apiKey = process.env.SIGNUM_API_KEY;
  if (!signumUrl || !apiKey) throw new Error('SIGNUM_URL or SIGNUM_API_KEY not configured');

  // 1. Build multipart form — PDF + signer list + metadata
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `${documentId}.pdf`);
  form.append('signers', JSON.stringify(signers));
  form.append('callbackBaseUrl', callbackBaseUrl);
  form.append('expiresInDays', '30');
  form.append('metadata', JSON.stringify({ isaflowDocumentId: documentId, companyId }));

  // 2. POST to Signum
  const res = await fetch(`${signumUrl}/api/v1/documents`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signum upload failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { id: string; signingUrl: string };

  // 3. Store signumDocumentId on the afs_document record
  await sql`
    UPDATE afs_documents
    SET signum_document_id = ${json.id}, updated_at = now()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;

  // 4. Register webhook (idempotent — Signum deduplicates by URL)
  const webhookUrl = 'https://app.isaflow.co.za/api/accounting/afs/webhook/signum';
  await registerSignumWebhook(webhookUrl);

  log.info('Signum document created', { documentId, signumDocumentId: json.id }, 'signumIntegrationService');
  return { signumDocumentId: json.id };
}
```

**`downloadSignedPdf` implementation:**

```typescript
export async function downloadSignedPdf(signumDocumentId: string): Promise<Buffer> {
  const signumUrl = process.env.SIGNUM_URL;
  const apiKey = process.env.SIGNUM_API_KEY;
  if (!signumUrl || !apiKey) throw new Error('SIGNUM_URL or SIGNUM_API_KEY not configured');

  const res = await fetch(`${signumUrl}/api/v1/documents/${signumDocumentId}/download`, {
    headers: { 'X-Api-Key': apiKey },
  });
  if (!res.ok) throw new Error(`Signum download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

**`verifySignumWebhookSignature` implementation:**

```typescript
import crypto from 'crypto';

export function verifySignumWebhookSignature(
  payload: string,
  receivedSignature: string,
): boolean {
  const secret = process.env.SIGNUM_WEBHOOK_SECRET;
  if (!secret) throw new Error('SIGNUM_WEBHOOK_SECRET not configured');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSignature));
}
```

**Notes:**
- `afs_documents` table must have a `signum_document_id text` column. Add this column in Plan 1's migration (or add a `344_afs_signum_column.sql` migration if Plan 1 is already shipped):
  ```sql
  ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signum_document_id text;
  ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signed_pdf_path text;
  ```
- `registerSignumWebhook` uses `POST /api/v1/webhooks` with `{ url, events: ['document.signed'] }`.

---

### 3.4 `src/modules/accounting/services/afs/portalNotificationService.ts`

Sends portal notifications — email and in-app — for key events.

**Exports:**

```typescript
export async function notifySigningRequested(
  contact: PortalContact,
  documentId: string,
  signingUrl: string,
): Promise<void>

export async function notifyDocumentSignedOff(
  companyId: string,
  documentId: string,
): Promise<void>

export async function notifyAnnotationReceived(
  companyId: string,
  sectionId: string,
  authorName: string,
): Promise<void>
```

**Implementation notes:**
- Use the existing email infrastructure (pattern from `statementEmailService` / `sendStatementEmail`). Import the transactional email sender from `@/lib/email-templates.ts` or the mailer utility already used elsewhere in the project.
- `notifySigningRequested` sends the signing link email directly to the contact's email. Subject: `"[CompanyName] — Annual Financial Statements ready for your signature"`. Body includes the signing URL and a 30-day expiry notice.
- `notifyDocumentSignedOff` fetches all active `director` and `cfo` portal contacts for the company and sends a completion email to each.
- Log all notification attempts with `log.info` / `log.error` using the `'portalNotificationService'` context tag.
- Never throw on email failure — catch, log error, and return. Notification failure must not break the signing flow.

---

## 4. Portal Auth Middleware

### `src/lib/portalAuth.ts`

HTTP-only cookie-based session, signed with `PORTAL_JWT_SECRET`. Entirely separate from staff `withCompany` — portal contacts are not staff users and must never gain access to staff APIs.

```typescript
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { signToken, verifyToken } from '@/lib/auth/jwt';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

export const PORTAL_COOKIE_NAME = 'portal_session';
export const PORTAL_SESSION_TTL_HOURS = 8;

export interface PortalApiRequest extends NextApiRequest {
  portalSession: PortalSession;
}

export type PortalApiHandler = (
  req: PortalApiRequest,
  res: NextApiResponse,
) => Promise<void> | void;

export function withPortalAuth(handler: PortalApiHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const cookie = req.cookies[PORTAL_COOKIE_NAME];
    if (!cookie) {
      return apiResponse.unauthorized(res, 'Portal session required');
    }

    let session: PortalSession;
    try {
      session = verifyToken<PortalSession>(cookie, process.env.PORTAL_JWT_SECRET!);
    } catch {
      log.warn('Invalid portal session token', {}, 'portalAuth');
      return apiResponse.unauthorized(res, 'Invalid or expired portal session');
    }

    if (new Date(session.expiresAt) < new Date()) {
      return apiResponse.unauthorized(res, 'Portal session expired');
    }

    (req as PortalApiRequest).portalSession = session;
    return handler(req as PortalApiRequest, res);
  };
}

export function createPortalSessionCookie(
  res: NextApiResponse,
  session: PortalSession,
): void {
  const token = signToken(session, process.env.PORTAL_JWT_SECRET!, `${PORTAL_SESSION_TTL_HOURS}h`);
  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${PORTAL_SESSION_TTL_HOURS * 3600}`,
  ]);
}

export function clearPortalSessionCookie(res: NextApiResponse): void {
  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}
```

**Notes:**
- Reuses `signToken` / `verifyToken` from `@/lib/auth/jwt` but with `PORTAL_JWT_SECRET` (not the staff `JWT_SECRET`). This guarantees a portal token can never be used on a staff API.
- `PortalApiRequest` exposes `portalSession` — no `companyId` on the request object. Handlers must read `req.portalSession.companyId` for all DB queries.
- `Secure` flag requires HTTPS in production. In dev, Next.js dev server is HTTP — remove `Secure` when `NODE_ENV === 'development'` (handled in the cookie string builder).

---

## 5. API Routes

### 5.1 `pages/api/accounting/afs/portal-contacts.ts` — GET / POST

**Auth:** `withCompany` (staff-only)

```
GET  /api/accounting/afs/portal-contacts
     → list all active portal contacts for company
POST /api/accounting/afs/portal-contacts
     Body: { name, email, role }
     → create new portal contact
```

**GET handler:**
- Call `listPortalContacts(companyId)`.
- Return `apiResponse.success(res, { contacts })`.

**POST handler:**
- Validate `name` (non-empty string), `email` (valid email format), `role` (one of four values).
- Call `createPortalContact(companyId, { name, email, role })`.
- Catch `DUPLICATE_EMAIL` error → `apiResponse.badRequest(res, 'A contact with this email already exists')`.
- Return `apiResponse.created(res, contact)` on success.

**Wrap:** `export default withCompany(withErrorHandler(handler as any))`

---

### 5.2 `pages/api/accounting/afs/portal-contacts/[contactId].ts` — PUT / DELETE

**Auth:** `withCompany` (staff-only)

```
PUT    /api/accounting/afs/portal-contacts/[contactId]
       Body: { name?, role?, active? }
       → update portal contact
DELETE /api/accounting/afs/portal-contacts/[contactId]
       → soft-delete portal contact
```

**PUT handler:**
- Extract `contactId` from `req.query` — validate it's a non-empty string.
- Call `updatePortalContact(companyId, contactId, body)`.
- Return `apiResponse.success(res, contact)`.

**DELETE handler:**
- Call `deletePortalContact(companyId, contactId)`.
- Return `apiResponse.noContent(res)`.

**Wrap:** `export default withCompany(withErrorHandler(handler as any))`

---

### 5.3 `pages/api/accounting/afs/[documentId]/send-for-signing.ts` — POST

**Auth:** `withCompany` (staff-only)

```
POST /api/accounting/afs/[documentId]/send-for-signing
     Body: { signerContactIds: string[] }
     → upload PDF to Signum, send magic links to each signer, update document status
```

**Handler flow:**
1. Extract and validate `documentId` from `req.query`.
2. Validate `signerContactIds` is a non-empty string array.
3. Load `afs_document` — verify it belongs to `companyId`, reject with `notFound` if not.
4. Confirm document `status` is `'partner_review'` — reject if not (can only send for signing after partner review).
5. Load `PortalContact` records for each `signerContactIds` — verify all belong to `companyId` and have `role` of `'director'` or `'cfo'`.
6. Load the signed PDF from storage OR generate it via the WeasyPrint sidecar (Plan 4). For Plan 6 scope, assume the PDF Buffer is fetched from `storage/afs-drafts/{companyId}/{documentId}.pdf`.
7. Call `sendForSigning(documentId, companyId, pdfBuffer, signers, callbackBaseUrl)`.
8. Update `afs_document.status` → `'in_review'` (specifically "awaiting_signatures" — use this sub-status or store a separate `signing_requested_at` timestamp).
9. Call `notifySigningRequested` for each signer contact.
10. Return `apiResponse.success(res, { signumDocumentId, message: 'Signing requests sent' })`.

**Wrap:** `export default withCompany(withErrorHandler(handler as any))`

---

### 5.4 `pages/api/accounting/afs/webhook/signum.ts` — POST

**Auth:** None (webhook endpoint) — secured by HMAC signature verification

```
POST /api/accounting/afs/webhook/signum
     Headers: X-Signum-Signature: sha256=<hmac>
     Body: { documentId: string, event: 'document.signed', signedAt: string }
```

**Handler flow:**

```typescript
export const config = { api: { bodyParser: false } }; // must read raw body for HMAC

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  // 1. Read raw body for HMAC verification
  const rawBody = await readRawBody(req); // utility that buffers req stream
  const signature = req.headers['x-signum-signature'];
  if (typeof signature !== 'string' || !verifySignumWebhookSignature(rawBody, signature.replace('sha256=', ''))) {
    log.warn('Signum webhook HMAC verification failed', {}, 'signum-webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse body
  const body = JSON.parse(rawBody) as { documentId: string; event: string; signedAt: string };
  if (body.event !== 'document.signed') {
    return res.status(200).json({ received: true }); // acknowledge unknown events
  }

  // 3. Look up afs_document by signum_document_id
  const rows = await sql`
    SELECT id, company_id FROM afs_documents
    WHERE signum_document_id = ${body.documentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    log.warn('Signum webhook: no afs_document for signum_document_id', { signumDocumentId: body.documentId }, 'signum-webhook');
    return res.status(200).json({ received: true }); // don't retry
  }
  const doc = rows[0] as { id: string; company_id: string };

  // 4. Download signed PDF from Signum
  const pdfBuffer = await downloadSignedPdf(body.documentId);

  // 5. Store to /storage/afs-signed/{companyId}/{documentId}.pdf
  const storagePath = `/storage/afs-signed/${doc.company_id}/${doc.id}.pdf`;
  await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.promises.writeFile(storagePath, pdfBuffer);

  // 6. Update afs_document: status → 'signed_off', locked_at = now(), signed_pdf_path
  await sql`
    UPDATE afs_documents
    SET status = 'signed_off',
        locked_at = now(),
        signed_pdf_path = ${storagePath},
        updated_at = now()
    WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
  `;

  // 7. Notify portal contacts
  await notifyDocumentSignedOff(doc.company_id, doc.id);

  log.info('Document signed off via Signum webhook', { documentId: doc.id, signumDocumentId: body.documentId }, 'signum-webhook');
  return res.status(200).json({ received: true });
}

export default withErrorHandler(handler);
```

**Notes:**
- `bodyParser: false` is mandatory. HMAC must be computed over the raw bytes before any JSON parsing.
- `withErrorHandler` wraps the handler but `withCompany` is NOT used — webhooks have no company context in the request headers.
- File storage is local `/storage/` for now. Plan 4 may introduce object storage — update `storagePath` at that point.

---

### 5.5 `pages/api/accounting/portal/auth.ts` — POST / GET

**Auth:** None (public endpoint — issues the session)

```
POST /api/accounting/portal/auth
     Body: { email: string }
     → generate magic link, send email, return { sent: true }

GET  /api/accounting/portal/auth?token=<hex>
     → verify token, set portal_session cookie, redirect to /accounting/afs/portal/dashboard
```

**POST handler:**
1. Validate `email` — non-empty string, valid email format.
2. `getPortalContactByEmail(email)` — if not found OR `active = false`, return `{ sent: true }` regardless (prevent email enumeration).
3. `generateMagicLink(contact.companyId, contact.id)`.
4. Send magic link email via `portalNotificationService` (or direct email utility).
   - Email subject: `"ISaFlow Portal — Your sign-in link"`
   - Email body: `"Click here to access your financial documents: https://app.isaflow.co.za/accounting/portal/auth?token=<token>"` (expires in 15 minutes)
5. Return `apiResponse.success(res, { sent: true })`.

**GET handler:**
1. Extract `token` from `req.query`.
2. `verifyMagicLink(token)` — if null, redirect to `/accounting/afs/portal/login?error=expired`.
3. Build `PortalSession`: `{ contactId: contact.id, companyId: contact.companyId, role: contact.role, expiresAt: ... }`.
4. `createPortalSessionCookie(res, session)`.
5. `res.redirect(302, '/accounting/afs/portal/dashboard')`.

**Wrap:** `export default withErrorHandler(handler)`

---

### 5.6 `pages/api/accounting/portal/documents.ts` — GET

**Auth:** `withPortalAuth`

```
GET /api/accounting/portal/documents
    → list documents accessible to the authenticated portal contact
```

**Handler:**
1. Read `req.portalSession.companyId` and `req.portalSession.role`.
2. Look up `PORTAL_ACCESS_RULES[role]` to get allowed `documentTypes` and `statuses`.
3. Build SQL with dynamic filters:
   ```sql
   SELECT id, fiscal_year, period, document_type, status, created_at, updated_at
   FROM afs_documents
   WHERE company_id = ${companyId}::UUID
     AND document_type = ANY(${documentTypes}::text[])
     AND (${statuses.length === 0} OR status = ANY(${statuses}::text[]))
   ORDER BY created_at DESC
   ```
4. Return `apiResponse.success(res, { documents })`.

**Wrap:** `export default withPortalAuth(withErrorHandler(handler as any))`

---

### 5.7 `pages/api/accounting/portal/documents/[documentId].ts` — GET

**Auth:** `withPortalAuth`

```
GET /api/accounting/portal/documents/[documentId]
    → document header + all sections for the portal document viewer
```

**Handler:**
1. Extract `documentId` from `req.query`.
2. Load `afs_document` scoped to `req.portalSession.companyId`.
3. Verify the document's `status` and `document_type` are accessible under `PORTAL_ACCESS_RULES[role]` — return `apiResponse.forbidden` if not.
4. Load all `afs_sections` for the document (excluding `version_history` to reduce payload size).
5. Return `apiResponse.success(res, { document, sections })`.

**Wrap:** `export default withPortalAuth(withErrorHandler(handler as any))`

---

### 5.8 `pages/api/accounting/portal/documents/[documentId]/annotate.ts` — POST

**Auth:** `withPortalAuth`

```
POST /api/accounting/portal/documents/[documentId]/annotate
     Body: { sectionId: string, body: string }
     → add annotation from client contact to a draft section
```

**Handler:**
1. Read `role` from `req.portalSession` — if `canAnnotate === false` for this role, return `apiResponse.forbidden`.
2. Load `afs_document` — verify it belongs to `companyId` and `status !== 'signed_off'` (annotations disabled on signed documents).
3. Validate `sectionId` belongs to this document and `companyId`.
4. Insert into `afs_section_comments` (created in Plan 5's migration 338):
   ```sql
   INSERT INTO afs_section_comments (section_id, company_id, author_id, body)
   VALUES (${sectionId}::UUID, ${companyId}::UUID, ${contactId}::UUID, ${body})
   ```
   Note: `author_id` = `req.portalSession.contactId` (portal contact ID, not staff user ID). The comment schema should accommodate both staff users and portal contacts. If `afs_section_comments.author_id` references a staff user table, add a separate `portal_author_id` column pointing to `portal_contacts.id`, and set `author_id = null` for portal annotations.
5. Call `notifyAnnotationReceived(companyId, sectionId, contact.name)`.
6. Return `apiResponse.created(res, { commentId })`.

**Wrap:** `export default withPortalAuth(withErrorHandler(handler as any))`

---

## 6. Pages

### 6.1 `pages/accounting/afs/portal/login.tsx` — Magic Link Request Form

**Route:** `/accounting/afs/portal/login`  
**Auth:** None (public)

```tsx
// No ISaFlow staff nav — full-page portal branding
// Components:
// - ISaFlow logo + "Client Portal" label
// - Email input field
// - "Send sign-in link" button
// - "Check your email" confirmation state after submission
// - Error state for bad requests

// On submit: POST /api/accounting/portal/auth { email }
// On success: show confirmation message (do not reveal whether email exists)
// On API error: show generic "Something went wrong" message (never "email not found")
```

**State machine:**
- `idle` → `loading` (on submit) → `sent` (on success) or `error` (on failure)

**Styling notes:**
- Centred card layout — no sidebar nav.
- ISaFlow branding: logo top-centre, portal tagline below.
- Mobile-first responsive.

---

### 6.2 `pages/accounting/afs/portal/dashboard.tsx` — Client Portal Dashboard

**Route:** `/accounting/afs/portal/dashboard`  
**Auth:** Portal session required (redirect to login if missing)

**Sections:**
1. **Latest AFS** — most recent `afs` document, status badge, year, download button (if `signed_off`).
2. **Recent Management Packs** — last 6 `management_pack` documents, month, status, download.
3. **Pending Actions** — signing requests (links to `/accounting/afs/sign/[token]`), annotation replies needed.
4. **Filing Deadlines** — CIPC annual return date, provisional tax dates (read from `afs_documents.filing_deadline_at` when available).
5. **Firm Contact** — company accounting firm name, contact email/phone (from `companies` table).

**Data fetching:**
- `GET /api/accounting/portal/documents` — all accessible documents.
- Filter client-side into AFS vs management packs.
- Use `getServerSideProps` with portal session cookie validation to avoid flash-of-unauthenticated-content.

```typescript
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const cookie = context.req.cookies['portal_session'];
  if (!cookie) return { redirect: { destination: '/accounting/afs/portal/login', permanent: false } };
  // Verify cookie server-side; if invalid, redirect
  // Pass session to page as prop
}
```

---

### 6.3 `pages/accounting/afs/portal/documents/[documentId].tsx` — Document Viewer

**Route:** `/accounting/afs/portal/documents/[documentId]`  
**Auth:** Portal session required

**Layout:**
- Left sidebar: section list with status badges, scroll-spy highlighting active section.
- Right main area: full-width rendered document sections (HTML/CSS — same `NoteContent` model as staff UI).
- Top bar: document title, fiscal year, status badge, download button (if `signed_off`).

**Annotation layer (directors + CFOs only):**
- Each section has a "Comment" button.
- On click: inline textarea appears below the section.
- On submit: `POST /api/accounting/portal/documents/[documentId]/annotate`.
- Existing annotations shown as comment threads below each section.
- `shareholder_readonly` and `external_auditor` see no comment UI.

**Data fetching:**
- `GET /api/accounting/portal/documents/[documentId]` — document + sections.

---

### 6.4 `pages/accounting/afs/sign/[token].tsx` — Signing Page

**Route:** `/accounting/afs/sign/[token]`  
**Auth:** None — the token IS the auth. Signum validates it.

**Layout:**
- ISaFlow header with logo (no nav links — signing context only).
- Full-height iframe: `src={`${SIGNUM_URL}/sign/${token}?embed=true`}`.
- `postMessage` listener:
  ```typescript
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'signum:signed') {
        setSigningComplete(true);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
  ```
- On `signingComplete = true`: replace iframe with a success screen:
  - "Thank you — your signature has been recorded."
  - "You will receive a copy of the signed document by email."
  - Link to portal dashboard (if the contact has an active session) or close-window instruction.

**Environment variable:**
- `NEXT_PUBLIC_SIGNUM_URL` — needed client-side for iframe `src`. This is safe to expose publicly (it's just the URL, not the API key).

---

## 7. Tests

### 7.1 `tests/unit/services/afs/portalContactService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  listPortalContacts,
  createPortalContact,
  updatePortalContact,
  deletePortalContact,
} from '@/modules/accounting/services/afs/portalContactService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const CONTACT_ROW = {
  id: 'c1c1c1c1-0000-0000-0000-000000000001',
  company_id: COMPANY_ID,
  name: 'Alice Director',
  email: 'alice@example.com',
  role: 'director',
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('portalContactService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listPortalContacts maps DB rows to PortalContact objects', async () => {
    mockSql.mockResolvedValueOnce([CONTACT_ROW]);
    const contacts = await listPortalContacts(COMPANY_ID);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.name).toBe('Alice Director');
    expect(contacts[0]!.role).toBe('director');
    expect(contacts[0]!.companyId).toBe(COMPANY_ID);
  });

  it('listPortalContacts returns empty array when no contacts', async () => {
    mockSql.mockResolvedValueOnce([]);
    const contacts = await listPortalContacts(COMPANY_ID);
    expect(contacts).toHaveLength(0);
  });

  it('createPortalContact inserts and returns new contact', async () => {
    mockSql.mockResolvedValueOnce([CONTACT_ROW]);
    const contact = await createPortalContact(COMPANY_ID, {
      name: 'Alice Director',
      email: 'alice@example.com',
      role: 'director',
    });
    expect(contact.id).toBe(CONTACT_ROW.id);
    expect(contact.email).toBe('alice@example.com');
  });

  it('updatePortalContact verifies company ownership before updating', async () => {
    // First call: ownership check; second call: update
    mockSql
      .mockResolvedValueOnce([CONTACT_ROW])
      .mockResolvedValueOnce([{ ...CONTACT_ROW, name: 'Alice Updated' }]);
    const contact = await updatePortalContact(COMPANY_ID, CONTACT_ROW.id, { name: 'Alice Updated' });
    expect(contact.name).toBe('Alice Updated');
  });

  it('updatePortalContact throws when contact does not belong to company', async () => {
    mockSql.mockResolvedValueOnce([]); // ownership check returns nothing
    await expect(
      updatePortalContact('other-company', CONTACT_ROW.id, { name: 'Evil' })
    ).rejects.toThrow();
  });

  it('deletePortalContact soft-deletes by setting active = false', async () => {
    mockSql.mockResolvedValueOnce([{ id: CONTACT_ROW.id }]); // update returns affected row
    await deletePortalContact(COMPANY_ID, CONTACT_ROW.id);
    // Verify sql was called with active = false (check call args)
    const callArgs = mockSql.mock.calls[0];
    expect(JSON.stringify(callArgs)).toContain('active');
  });
});
```

---

### 7.2 `tests/unit/services/afs/magicLinkService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomBytes: vi.fn(() => Buffer.from('a'.repeat(32))) };
});

import { sql } from '@/lib/neon';
import { generateMagicLink, verifyMagicLink } from '@/modules/accounting/services/afs/magicLinkService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const CONTACT_ID = 'c1c1c1c1-0000-0000-0000-000000000001';
const MOCK_TOKEN = 'a'.repeat(64); // hex of 32 'a' bytes

const CONTACT_ROW = {
  id: CONTACT_ID,
  company_id: COMPANY_ID,
  name: 'Alice Director',
  email: 'alice@example.com',
  role: 'director',
  active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const LINK_ROW = {
  id: 'link-id-1',
  company_id: COMPANY_ID,
  contact_id: CONTACT_ID,
  token: MOCK_TOKEN,
  expires_at: new Date(Date.now() + 15 * 60 * 1000),
  used_at: null,
  created_at: new Date(),
};

describe('magicLinkService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateMagicLink returns token and expiresAt', async () => {
    mockSql
      .mockResolvedValueOnce([]) // invalidate old tokens
      .mockResolvedValueOnce([LINK_ROW]); // insert new
    const { token, expiresAt } = await generateMagicLink(COMPANY_ID, CONTACT_ID);
    expect(token).toBe(MOCK_TOKEN);
    expect(expiresAt).toBeInstanceOf(Date);
  });

  it('generateMagicLink sets expiry 15 minutes from now', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([LINK_ROW]);
    const before = Date.now();
    const { expiresAt } = await generateMagicLink(COMPANY_ID, CONTACT_ID);
    const after = Date.now();
    const diffMs = expiresAt.getTime() - before;
    expect(diffMs).toBeGreaterThan(14 * 60 * 1000);
    expect(diffMs).toBeLessThan(15 * 60 * 1000 + (after - before));
  });

  it('verifyMagicLink returns contact for valid unused token', async () => {
    mockSql
      .mockResolvedValueOnce([LINK_ROW])          // SELECT token
      .mockResolvedValueOnce([{ rowCount: 1 }])   // UPDATE used_at (simulate rowCount check)
      .mockResolvedValueOnce([CONTACT_ROW]);       // SELECT contact
    const result = await verifyMagicLink(MOCK_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.contact.id).toBe(CONTACT_ID);
    expect(result?.companyId).toBe(COMPANY_ID);
  });

  it('verifyMagicLink returns null for expired token', async () => {
    mockSql.mockResolvedValueOnce([]); // no rows = expired or already used
    const result = await verifyMagicLink('bad-token');
    expect(result).toBeNull();
  });

  it('verifyMagicLink returns null when concurrent request already consumed token', async () => {
    mockSql
      .mockResolvedValueOnce([LINK_ROW]) // SELECT finds the token
      .mockResolvedValueOnce([]);         // UPDATE rowCount = 0 (race condition)
    const result = await verifyMagicLink(MOCK_TOKEN);
    expect(result).toBeNull();
  });
});
```

---

### 7.3 `tests/unit/services/afs/signumIntegrationService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { sql } from '@/lib/neon';
import {
  downloadSignedPdf,
  verifySignumWebhookSignature,
} from '@/modules/accounting/services/afs/signumIntegrationService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

describe('signumIntegrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIGNUM_URL = 'http://signum:3001';
    process.env.SIGNUM_API_KEY = 'test-api-key';
    process.env.SIGNUM_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  describe('downloadSignedPdf', () => {
    it('returns Buffer from Signum download endpoint', async () => {
      const pdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });
      const buffer = await downloadSignedPdf('signum-doc-id-1');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer[0]).toBe(37); // %
    });

    it('throws when Signum returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(downloadSignedPdf('missing-id')).rejects.toThrow('Signum download failed: 404');
    });
  });

  describe('verifySignumWebhookSignature', () => {
    it('returns true for valid HMAC', () => {
      const crypto = require('crypto');
      const payload = '{"event":"document.signed"}';
      const secret = 'test-webhook-secret';
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      expect(verifySignumWebhookSignature(payload, sig)).toBe(true);
    });

    it('returns false for tampered payload', () => {
      const payload = '{"event":"document.signed"}';
      const fakeSig = 'a'.repeat(64);
      expect(verifySignumWebhookSignature(payload, fakeSig)).toBe(false);
    });

    it('throws when SIGNUM_WEBHOOK_SECRET is not set', () => {
      delete process.env.SIGNUM_WEBHOOK_SECRET;
      expect(() => verifySignumWebhookSignature('payload', 'sig')).toThrow('SIGNUM_WEBHOOK_SECRET not configured');
    });
  });

  describe('sendForSigning', () => {
    it('calls Signum API, stores signumDocumentId, and returns it', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'signum-123', signingUrl: 'https://signum/sign/abc' }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // webhook registration

      mockSql.mockResolvedValue([]); // UPDATE afs_documents

      const { sendForSigning } = await import('@/modules/accounting/services/afs/signumIntegrationService');
      const result = await sendForSigning(
        'doc-id-1',
        'd27bac33-cdc0-4e58-bf6b-709c1597d41c',
        Buffer.from('%PDF-test'),
        [{ email: 'alice@example.com', name: 'Alice', order: 1 }],
        'https://app.isaflow.co.za/accounting/afs/sign',
      );

      expect(result.signumDocumentId).toBe('signum-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://signum:3001/api/v1/documents',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws when Signum upload returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Error' });
      const { sendForSigning } = await import('@/modules/accounting/services/afs/signumIntegrationService');
      await expect(
        sendForSigning('doc-id-1', 'comp-id', Buffer.from('pdf'), [], 'https://base')
      ).rejects.toThrow('Signum upload failed: 500');
    });
  });
});
```

---

## 8. Implementation Order

Execute in this order. Each step is independently deployable.

```
Step 1 — Migrations
  Run 342_portal_contacts.sql
  Run 343_portal_magic_links.sql
  If needed: 344_afs_signum_columns.sql (signum_document_id, signed_pdf_path on afs_documents)

Step 2 — Type definitions
  Append portal types to afsTypes.ts

Step 3 — Services (write tests first — TDD)
  portalContactService.ts + test
  magicLinkService.ts + test
  signumIntegrationService.ts + test
  portalNotificationService.ts (no unit test needed — email sends are integration-tested manually)

Step 4 — Portal auth middleware
  src/lib/portalAuth.ts
  Verify signToken/verifyToken from auth/jwt accepts a custom secret parameter

Step 5 — Internal staff API routes
  portal-contacts.ts (GET/POST)
  portal-contacts/[contactId].ts (PUT/DELETE)
  afs/[documentId]/send-for-signing.ts (POST)

Step 6 — Webhook
  afs/webhook/signum.ts (POST)
  Test with: curl -X POST -H "X-Signum-Signature: sha256=<hmac>" localhost:3101/api/accounting/afs/webhook/signum

Step 7 — Portal API routes
  portal/auth.ts (POST + GET)
  portal/documents.ts (GET)
  portal/documents/[documentId].ts (GET)
  portal/documents/[documentId]/annotate.ts (POST)

Step 8 — Pages
  portal/login.tsx
  portal/dashboard.tsx
  portal/documents/[documentId].tsx
  sign/[token].tsx

Step 9 — Nav config
  Add portal management link to accountingNavConfig.ts:
  { label: 'Portal Contacts', href: '/accounting/afs/portal-contacts', icon: <UsersIcon /> }

Step 10 — Run tests
  bun run test:unit
  bunx tsc --noEmit
```

---

## 9. Security Checklist

| Concern | Mitigation |
|---------|-----------|
| Portal contacts accessing wrong tenant data | All portal DB queries use `req.portalSession.companyId` — no URL-provided company IDs |
| Magic link token brute force | 256-bit entropy token; rate-limit `POST /api/accounting/portal/auth` to 5 req/min per IP |
| Token replay | Single-use `used_at` set atomically; race condition guarded by `rowCount` check |
| Forged portal session cookie | JWT signed with `PORTAL_JWT_SECRET` (separate from staff `JWT_SECRET`); `HttpOnly; Secure; SameSite=Strict` |
| Staff JWT used on portal routes | `withPortalAuth` uses `PORTAL_JWT_SECRET` — a staff token signed with `JWT_SECRET` will fail verification |
| Signum webhook spoofing | HMAC-SHA256 verification with `SIGNUM_WEBHOOK_SECRET` before any processing |
| PDF download IDOR | Webhook handler looks up `afs_document` by `signum_document_id` only — no user-controlled document ID |
| Annotation on signed documents | Handler checks `status !== 'signed_off'` before inserting comment |
| External auditor annotating | `PORTAL_ACCESS_RULES.external_auditor.canAnnotate = false` enforced in annotate handler |
| Email enumeration on login | `POST /api/accounting/portal/auth` always returns `{ sent: true }` regardless of email existence |

---

## 10. File Checklist

| # | File | Type | New / Modified |
|---|------|------|----------------|
| 1 | `scripts/migrations/sql/342_portal_contacts.sql` | Migration | New |
| 2 | `scripts/migrations/sql/343_portal_magic_links.sql` | Migration | New |
| 3 | `src/modules/accounting/services/afs/afsTypes.ts` | Types | Modified (append) |
| 4 | `src/modules/accounting/services/afs/portalContactService.ts` | Service | New |
| 5 | `src/modules/accounting/services/afs/magicLinkService.ts` | Service | New |
| 6 | `src/modules/accounting/services/afs/signumIntegrationService.ts` | Service | New |
| 7 | `src/modules/accounting/services/afs/portalNotificationService.ts` | Service | New |
| 8 | `src/lib/portalAuth.ts` | Middleware | New |
| 9 | `pages/api/accounting/afs/portal-contacts.ts` | API | New |
| 10 | `pages/api/accounting/afs/portal-contacts/[contactId].ts` | API | New |
| 11 | `pages/api/accounting/afs/[documentId]/send-for-signing.ts` | API | New |
| 12 | `pages/api/accounting/afs/webhook/signum.ts` | API | New |
| 13 | `pages/api/accounting/portal/auth.ts` | API | New |
| 14 | `pages/api/accounting/portal/documents.ts` | API | New |
| 15 | `pages/api/accounting/portal/documents/[documentId].ts` | API | New |
| 16 | `pages/api/accounting/portal/documents/[documentId]/annotate.ts` | API | New |
| 17 | `pages/accounting/afs/portal/login.tsx` | Page | New |
| 18 | `pages/accounting/afs/portal/dashboard.tsx` | Page | New |
| 19 | `pages/accounting/afs/portal/documents/[documentId].tsx` | Page | New |
| 20 | `pages/accounting/afs/sign/[token].tsx` | Page | New |
| 21 | `tests/unit/services/afs/portalContactService.test.ts` | Test | New |
| 22 | `tests/unit/services/afs/magicLinkService.test.ts` | Test | New |
| 23 | `tests/unit/services/afs/signumIntegrationService.test.ts` | Test | New |
| 24 | `src/components/layout/accountingNavConfig.ts` | Config | Modified |

---

*Plan written: 2026-04-16 | Scope: Plan 6 of 8 | Depends on: Plans 1–5*
