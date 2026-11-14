/**
 * What a tenant sees of a system announcement (GET /api/announcements/active), and the key under which a
 * user's dismissal is kept in user_preferences. Shared by the two routes and the banner.
 *
 * The shape is deliberately narrower than the admin's Announcement: `target_ids` (other companies' ids) and
 * `created_by` (an admin user id) are never sent to a tenant.
 */
export const DISMISS_KEY_PREFIX = 'announcement_dismissed:';

export interface TenantAnnouncement {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'maintenance' | 'feature';
  starts_at: string;
  ends_at: string | null;
  is_dismissible: boolean;
}
