/**
 * #1656: answers checkPermission's one query (company_users LEFT JOIN company_user_permissions)
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
}

export function permissionDb(): PermissionDb {
  return { members: new Map(), rows: new Map(), reads: [] };
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
        role, has_row: row !== undefined,
        can_read: row?.can_read ?? null, can_write: row?.can_write ?? null, can_delete: row?.can_delete ?? null,
        can_export: row?.can_export ?? null, can_approve: row?.can_approve ?? null,
      }]);
    }
    return Promise.resolve(fallback(text, values));
  };
}
