/**
 * Per-user in-app notifications (migration 954 `user_notifications`; budgets P5 spec §4/§5, T8).
 * The header bell reads the latest 20 and the unread count; a member marks their own rows read.
 *
 * Scope: every query names the company AND the user. RLS also limits app_user to its own rows
 * (read/update policy `user_id = auth.uid()`), but the service pool's mirrors are USING (true),
 * so the query must hold on its own.
 *
 * Writers (`notifyUsers`) notify other members (an evaluator notifies owners and admins): the
 * insert is ON CONFLICT DO NOTHING, so a rerun writes nothing (the unique key is company, user,
 * dedupe key). It names NO conflict target and uses no RETURNING: either one makes Postgres check
 * the new row against the read policy (a conflict target needs SELECT on its columns), which a row
 * for another user fails as app_user (42501, proven in budgets-p5-notifications.int.test.ts).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isInAppPath } from '@/lib/inAppPath';

export type NotificationKind = 'budget_alert' | 'budget_slice' | 'budget_reminder';

export interface UserNotification {
  id: string;
  kind: NotificationKind;
  refId: string | null;
  title: string;
  body: string | null;
  /** An in-app path ('/accounting/...'), or null. */
  href: string | null;
  /** ISO timestamp. */
  createdAt: string;
  readAt: string | null;
}

export interface NotificationFeed {
  items: UserNotification[];
  unread: number;
}

export interface NewNotification {
  kind: NotificationKind;
  refId: string | null;
  title: string;
  body: string | null;
  href: string | null;
  dedupeKey: string;
}

/** The bell shows this many. */
export const NOTIFICATION_FEED_LIMIT = 20;
/** One mark-read request names at most this many ids. */
export const MAX_MARK_READ_IDS = 100;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function listNotifications(companyId: string, userId: string): Promise<NotificationFeed> {
  const rows = (await sql`
    SELECT id::TEXT AS id, kind, ref_id::TEXT AS ref_id, title, body, href, created_at, read_at
      FROM user_notifications
     WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
     ORDER BY created_at DESC, id DESC
     LIMIT ${NOTIFICATION_FEED_LIMIT}
  `) as DbRow[];
  const count = (await sql`
    SELECT COUNT(*)::INT AS n FROM user_notifications
     WHERE company_id = ${companyId}::UUID AND user_id = ${userId} AND read_at IS NULL
  `) as DbRow[];
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as NotificationKind,
      refId: r.ref_id == null ? null : String(r.ref_id),
      title: String(r.title),
      body: r.body == null ? null : String(r.body),
      href: r.href == null ? null : String(r.href),
      createdAt: iso(r.created_at) ?? '',
      readAt: iso(r.read_at),
    })),
    unread: Number(count[0]?.n ?? 0),
  };
}

/** Marks the caller's own unread rows read: the named ids, or every one with `all`. Others' ids are ignored. */
export async function markRead(
  companyId: string, userId: string, sel: { ids: readonly string[] } | { all: true },
): Promise<{ updated: number }> {
  const all = 'all' in sel;
  const ids = all ? [] : sel.ids.map((id) => id.toLowerCase());
  if (!all && ids.length === 0) return { updated: 0 };
  const rows = (await sql`
    UPDATE user_notifications SET read_at = now()
     WHERE company_id = ${companyId}::UUID AND user_id = ${userId} AND read_at IS NULL
       AND (${all}::BOOLEAN OR id = ANY(${ids}::UUID[]))
    RETURNING id
  `) as DbRow[];
  return { updated: rows.length };
}

/**
 * One notification to each user (duplicates collapse; an existing dedupe key is left alone). Returns
 * nothing: the rows written for OTHER users are not readable here (no RETURNING, no count), and a
 * producer that must know whether it is new decides that on its own row (e.g. the alert's insert).
 */
export async function notifyUsers(companyId: string, userIds: readonly string[], n: NewNotification): Promise<void> {
  if (n.href !== null && !isInAppPath(n.href)) throw new Error(`notifyUsers: href must be an in-app path, got ${n.href}`);
  const users = [...new Set(userIds)];
  if (users.length === 0) return;
  await sql`
    INSERT INTO user_notifications (company_id, user_id, kind, ref_id, title, body, href, dedupe_key)
    SELECT ${companyId}::UUID, u, ${n.kind}, ${n.refId}::UUID, ${n.title}, ${n.body}, ${n.href}, ${n.dedupeKey}
      FROM unnest(${users}::TEXT[]) AS u
    ON CONFLICT DO NOTHING
  `;
}
