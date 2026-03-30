/**
 * Announcement Service
 * CRUD for system_announcements table — admin-managed platform messages.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { Announcement, PaginatedResult } from '../types/admin.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v as string;
}

function rowToAnnouncement(r: Row): Announcement {
  return {
    id: r.id as string,
    title: r.title as string,
    message: r.message as string,
    type: r.type as string,
    target: r.target as string,
    target_ids: (r.target_ids ?? []) as string[],
    starts_at: toIso(r.starts_at) as string,
    ends_at: toIso(r.ends_at),
    is_dismissible: r.is_dismissible as boolean,
    created_by: r.created_by as string,
    created_at: toIso(r.created_at) as string,
  };
}

interface ListFilters {
  active_only?: boolean;
  page?: number;
  limit?: number;
}

export async function listAnnouncements(
  filters: ListFilters = {}
): Promise<PaginatedResult<Announcement>> {
  const page  = Math.max(1, filters.page  ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;

  try {
    const rows = await sql`
      SELECT *
      FROM system_announcements
      WHERE (
        ${filters.active_only
          ? sql`starts_at <= NOW() AND (ends_at IS NULL OR ends_at >= NOW())`
          : sql`TRUE`}
      )
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countRow] = await sql`
      SELECT COUNT(*)::int AS total
      FROM system_announcements
      WHERE (
        ${filters.active_only
          ? sql`starts_at <= NOW() AND (ends_at IS NULL OR ends_at >= NOW())`
          : sql`TRUE`}
      )
    `;

    const total = countRow?.total ?? 0;

    return {
      items: rows.map(rowToAnnouncement),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  } catch (err) {
    log.error('listAnnouncements failed', { error: err }, 'announcementService');
    throw err;
  }
}

export async function getAnnouncement(id: string): Promise<Announcement | null> {
  try {
    const [row] = await sql`
      SELECT * FROM system_announcements WHERE id = ${id}
    `;
    if (!row) return null;
    return rowToAnnouncement(row);
  } catch (err) {
    log.error('getAnnouncement failed', { id, error: err }, 'announcementService');
    throw err;
  }
}

export interface CreateAnnouncementData {
  title: string;
  message: string;
  type?: string;
  target?: string;
  target_ids?: string[];
  starts_at: string;
  ends_at?: string;
  is_dismissible?: boolean;
  created_by: string;
}

export async function createAnnouncement(data: CreateAnnouncementData): Promise<string> {
  const type         = data.type         ?? 'info';
  const target       = data.target       ?? 'all';
  const target_ids   = data.target_ids   ?? [];
  const is_dismissible = data.is_dismissible ?? true;

  try {
    const rows = await sql`
      INSERT INTO system_announcements (
        title, message, type, target, target_ids,
        starts_at, ends_at, is_dismissible, created_by, created_at
      ) VALUES (
        ${data.title},
        ${data.message},
        ${type},
        ${target},
        ${target_ids},
        ${data.starts_at}::timestamptz,
        ${data.ends_at ?? null}::timestamptz,
        ${is_dismissible},
        ${data.created_by},
        NOW()
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error('Insert returned no row');
    return rows[0].id as string;
  } catch (err) {
    log.error('createAnnouncement failed', { error: err }, 'announcementService');
    throw err;
  }
}

export async function updateAnnouncement(
  id: string,
  data: Partial<Omit<Announcement, 'id' | 'created_at' | 'created_by'>>
): Promise<void> {
  try {
    const startsAt = data.starts_at ?? null;
    const endsAt   = data.ends_at   ?? null;

    await sql`
      UPDATE system_announcements SET
        title          = COALESCE(${data.title          ?? null}, title),
        message        = COALESCE(${data.message        ?? null}, message),
        type           = COALESCE(${data.type           ?? null}, type),
        target         = COALESCE(${data.target         ?? null}, target),
        target_ids     = COALESCE(${data.target_ids     ?? null}, target_ids),
        starts_at      = CASE WHEN ${startsAt}::text IS NOT NULL
                              THEN ${startsAt}::timestamptz
                              ELSE starts_at END,
        ends_at        = CASE WHEN ${endsAt}::text IS NOT NULL
                              THEN ${endsAt}::timestamptz
                              ELSE ends_at END,
        is_dismissible = COALESCE(${data.is_dismissible ?? null}, is_dismissible)
      WHERE id = ${id}
    `;
  } catch (err) {
    log.error('updateAnnouncement failed', { id, error: err }, 'announcementService');
    throw err;
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  try {
    await sql`DELETE FROM system_announcements WHERE id = ${id}`;
  } catch (err) {
    log.error('deleteAnnouncement failed', { id, error: err }, 'announcementService');
    throw err;
  }
}
