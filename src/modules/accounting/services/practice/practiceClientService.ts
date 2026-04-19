import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface PracticeClient {
  id: string;
  companyId: string;
  legalName: string;
  tradingName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  clientGroupId: string | null;
  assignedPartnerId: string | null;
  assignedManagerId: string | null;
  billingModel: 'hourly' | 'fixed' | 'retainer';
  status: 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
  linkCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeClientInput {
  legalName: string;
  tradingName?: string;
  registrationNo?: string;
  taxNo?: string;
  clientGroupId?: string;
  assignedPartnerId?: string;
  assignedManagerId?: string;
  billingModel: 'hourly' | 'fixed' | 'retainer';
  status: 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
  linkCustomerId?: string;
}

export interface ClientGroup {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientContact {
  id: string;
  companyId: string;
  clientId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
  createdAt: string;
}

function mapClient(r: DbRow): PracticeClient {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    legalName: String(r.legal_name),
    tradingName: r.trading_name ? String(r.trading_name) : null,
    registrationNo: r.registration_no ? String(r.registration_no) : null,
    taxNo: r.tax_no ? String(r.tax_no) : null,
    clientGroupId: r.client_group_id ? String(r.client_group_id) : null,
    assignedPartnerId: r.assigned_partner_id ? String(r.assigned_partner_id) : null,
    assignedManagerId: r.assigned_manager_id ? String(r.assigned_manager_id) : null,
    billingModel: String(r.billing_model) as PracticeClient['billingModel'],
    status: String(r.status) as PracticeClient['status'],
    linkCustomerId: r.link_customer_id ? String(r.link_customer_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapGroup(r: DbRow): ClientGroup {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapContact(r: DbRow): ClientContact {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    clientId: String(r.client_id),
    name: String(r.name),
    email: r.email ? String(r.email) : null,
    phone: r.phone ? String(r.phone) : null,
    role: r.role ? String(r.role) : null,
    isPrimary: Boolean(r.is_primary),
    createdAt: String(r.created_at),
  };
}

export async function listPracticeClients(
  companyId: string,
  filters?: { status?: string; search?: string; groupId?: string; limit?: number; offset?: number },
): Promise<{ clients: PracticeClient[]; total: number }> {
  const lim = filters?.limit ?? 50;
  const off = filters?.offset ?? 0;
  const status = filters?.status ?? null;
  const search = filters?.search ? `%${filters.search}%` : null;
  const groupId = filters?.groupId ?? null;

  const countRows = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_clients
    WHERE company_id = ${companyId}::UUID
      AND (${status}::TEXT IS NULL OR status = ${status}::TEXT)
      AND (${search}::TEXT IS NULL OR legal_name ILIKE ${search}::TEXT OR trading_name ILIKE ${search}::TEXT)
      AND (${groupId}::UUID IS NULL OR client_group_id = ${groupId}::UUID)
  `) as DbRow[];

  const rows = (await sql`
    SELECT * FROM practice_clients
    WHERE company_id = ${companyId}::UUID
      AND (${status}::TEXT IS NULL OR status = ${status}::TEXT)
      AND (${search}::TEXT IS NULL OR legal_name ILIKE ${search}::TEXT OR trading_name ILIKE ${search}::TEXT)
      AND (${groupId}::UUID IS NULL OR client_group_id = ${groupId}::UUID)
    ORDER BY legal_name ASC
    LIMIT ${lim} OFFSET ${off}
  `) as DbRow[];

  return { clients: rows.map(mapClient), total: Number(countRows[0]?.cnt ?? 0) };
}

export async function getPracticeClient(companyId: string, id: string): Promise<PracticeClient | null> {
  const rows = (await sql`
    SELECT * FROM practice_clients
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapClient(rows[0]!) : null;
}

export async function createPracticeClient(
  companyId: string,
  input: PracticeClientInput,
): Promise<PracticeClient> {
  const dupes = (await sql`
    SELECT id FROM practice_clients
    WHERE company_id = ${companyId}::UUID AND legal_name = ${input.legalName}
  `) as DbRow[];
  if (dupes.length) throw new Error('duplicate: client with this legal name already exists');

  const rows = (await sql`
    INSERT INTO practice_clients (
      company_id, legal_name, trading_name, registration_no, tax_no,
      client_group_id, assigned_partner_id, assigned_manager_id,
      billing_model, status, link_customer_id
    ) VALUES (
      ${companyId}::UUID, ${input.legalName},
      ${input.tradingName ?? null}, ${input.registrationNo ?? null}, ${input.taxNo ?? null},
      ${input.clientGroupId ?? null}::UUID, ${input.assignedPartnerId ?? null}::UUID,
      ${input.assignedManagerId ?? null}::UUID,
      ${input.billingModel}, ${input.status}, ${input.linkCustomerId ?? null}::UUID
    ) RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created practice client', { id: rows[0].id, companyId }, 'practice');
  return mapClient(rows[0]);
}

export async function updatePracticeClient(
  companyId: string,
  id: string,
  input: Partial<PracticeClientInput>,
): Promise<PracticeClient> {
  const existing = (await sql`
    SELECT id FROM practice_clients WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_clients SET
      legal_name          = COALESCE(${input.legalName ?? null}, legal_name),
      trading_name        = COALESCE(${input.tradingName ?? null}, trading_name),
      registration_no     = COALESCE(${input.registrationNo ?? null}, registration_no),
      tax_no              = COALESCE(${input.taxNo ?? null}, tax_no),
      client_group_id     = COALESCE(${input.clientGroupId ?? null}::UUID, client_group_id),
      assigned_partner_id = COALESCE(${input.assignedPartnerId ?? null}::UUID, assigned_partner_id),
      assigned_manager_id = COALESCE(${input.assignedManagerId ?? null}::UUID, assigned_manager_id),
      billing_model       = COALESCE(${input.billingModel ?? null}, billing_model),
      status              = COALESCE(${input.status ?? null}, status),
      link_customer_id    = COALESCE(${input.linkCustomerId ?? null}::UUID, link_customer_id),
      updated_at          = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Updated practice client', { id }, 'practice');
  return mapClient(rows[0]);
}

export async function deletePracticeClient(companyId: string, id: string): Promise<void> {
  const existing = (await sql`
    SELECT id FROM practice_clients WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  await sql`
    UPDATE practice_clients SET status = 'archived', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Archived practice client', { id }, 'practice');
}

export async function listClientGroups(companyId: string): Promise<ClientGroup[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_groups
    WHERE company_id = ${companyId}::UUID
    ORDER BY name ASC
  `) as DbRow[];
  return rows.map(mapGroup);
}

export async function createClientGroup(
  companyId: string,
  input: { name: string; description?: string },
): Promise<ClientGroup> {
  const rows = (await sql`
    INSERT INTO practice_client_groups (company_id, name, description)
    VALUES (${companyId}::UUID, ${input.name}, ${input.description ?? null})
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created client group', { id: rows[0].id }, 'practice');
  return mapGroup(rows[0]);
}

export async function listClientContacts(companyId: string, clientId: string): Promise<ClientContact[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_contacts
    WHERE company_id = ${companyId}::UUID AND client_id = ${clientId}::UUID
    ORDER BY is_primary DESC, name ASC
  `) as DbRow[];
  return rows.map(mapContact);
}

export async function createClientContact(
  companyId: string,
  clientId: string,
  input: { name: string; email?: string; phone?: string; role?: string; isPrimary?: boolean },
): Promise<ClientContact> {
  const rows = (await sql`
    INSERT INTO practice_client_contacts (company_id, client_id, name, email, phone, role, is_primary)
    VALUES (
      ${companyId}::UUID, ${clientId}::UUID, ${input.name},
      ${input.email ?? null}, ${input.phone ?? null}, ${input.role ?? null},
      ${input.isPrimary ?? false}
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapContact(rows[0]);
}

export async function deleteClientContact(companyId: string, contactId: string): Promise<void> {
  const rows = (await sql`
    DELETE FROM practice_client_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as DbRow[];
  if (!rows.length) throw new Error('not found');
  log.info('Deleted client contact', { contactId, companyId }, 'practice');
}
