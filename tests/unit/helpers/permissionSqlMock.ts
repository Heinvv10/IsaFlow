/**
 * #1656: answers checkPermission's one query (and checkGroupPermission's, over `groups`) (company_users LEFT JOIN company_user_permissions)
 * from an in-memory table, so a test sets who holds which role and which rows, and can read back
 * which company / user / module each permission read named. Any other statement gets `fallback`.
 */
export interface PermissionRow { can_read?: boolean; can_write?: boolean; can_delete?: boolean; can_export?: boolean; can_approve?: boolean }

export interface PermissionDb {
  /** `${companyId}:${userId}` → stored company_users.role */
  members: Map<string, string>;
  /** `${companyId}:${userId}:${moduleKey}` → the user's row */
  rows: Map<string, PermissionRow>;
  /** Each permission read, as { companyId, userId, moduleKey }. */
  reads: Array<{ companyId: string; userId: string; moduleKey: string }>;
  /** `${companyId}:${userId}` of a membership whose company_users.approve_withheld is true (migration 1010c). */
  withheld: Set<string>;
  /** groupId -> the CURRENT member companies of the group (left_date IS NULL). */
  groups: Map<string, string[]>;
}

export function permissionDb(): PermissionDb {
  return { members: new Map(), rows: new Map(), reads: [], withheld: new Set(), groups: new Map() };
}

export function permissionSql(db: PermissionDb, fallback: (text: string, values: unknown[]) => unknown = () => []) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM company_users cu') && text.includes('LEFT JOIN company_user_permissions p')) {
      const [moduleKey, companyId, userId] = values as [string, string, string];
      db.reads.push({ companyId, userId, moduleKey });
      const role = db.members.get(`${companyId}:${userId}`);
      if (role === undefined) return Promise.resolve([]);
      const row = db.rows.get(`${companyId}:${userId}:${moduleKey}`);
      return Promise.resolve([{
        role, approve_withheld: db.withheld.has(`${companyId}:${userId}`), has_row: row !== undefined,
        can_read: row?.can_read ?? null, can_write: row?.can_write ?? null, can_delete: row?.can_delete ?? null,
        can_export: row?.can_export ?? null, can_approve: row?.can_approve ?? null,
      }]);
    }
    if (text.includes('FROM company_group_members cgm') && text.includes('LEFT JOIN company_user_permissions p')) {
      const [moduleKey, groupId, userId] = values as [string, string, string];
      return Promise.resolve((db.groups.get(groupId) ?? []).filter((c) => db.members.has(`${c}:${userId}`)).map((c) => {
        const row = db.rows.get(`${c}:${userId}:${moduleKey}`);
        return {
          role: db.members.get(`${c}:${userId}`), approve_withheld: db.withheld.has(`${c}:${userId}`), has_row: row !== undefined,
          can_read: row?.can_read ?? null, can_write: row?.can_write ?? null, can_delete: row?.can_delete ?? null,
          can_export: row?.can_export ?? null, can_approve: row?.can_approve ?? null,
        };
      }));
    }
    return Promise.resolve(fallback(text, values));
  };
}
