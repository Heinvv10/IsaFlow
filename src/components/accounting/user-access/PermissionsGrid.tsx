/**
 * PermissionsGrid — module-level toggle grid for a single user.
 * Shown in an expandable panel inside the User Access page.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface ModulePermission {
  moduleKey: string;
  moduleName: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canExport: boolean;
  canApprove: boolean;
  accountRangeFrom: string | null;
  accountRangeTo: string | null;
}

interface PermissionsGridProps {
  userId: string;
  userRole: string;
  onFeedback: (msg: string) => void;
}

const ACTIONS: Array<{ key: keyof ModulePermission; label: string }> = [
  { key: 'canRead',    label: 'Read'    },
  { key: 'canWrite',   label: 'Write'   },
  { key: 'canDelete',  label: 'Delete'  },
  { key: 'canExport',  label: 'Export'  },
  { key: 'canApprove', label: 'Approve' },
];

const FULL_ACCESS_ROLES = ['owner', 'admin'];

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1 focus:ring-offset-gray-900 ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${checked ? 'bg-teal-600' : 'bg-gray-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

export function PermissionsGrid({ userId, userRole, onFeedback }: PermissionsGridProps) {
  const [perms, setPerms] = useState<ModulePermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const isFullAccess = FULL_ACCESS_ROLES.includes(userRole);

  // Debounce map: moduleKey → timeout id
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const loadPerms = useCallback(async () => {
    setLoading(true);
    try {
      const res = await (await apiFetch(`/api/accounting/permissions?userId=${userId}`)).json();
      setPerms((res.data?.permissions as ModulePermission[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void loadPerms(); }, [loadPerms]);

  async function savePermission(mod: ModulePermission) {
    try {
      await apiFetch('/api/accounting/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          moduleKey: mod.moduleKey,
          canRead: mod.canRead,
          canWrite: mod.canWrite,
          canDelete: mod.canDelete,
          canExport: mod.canExport,
          canApprove: mod.canApprove,
          accountRangeFrom: mod.accountRangeFrom ?? undefined,
          accountRangeTo: mod.accountRangeTo ?? undefined,
        }),
      });
    } catch {
      onFeedback('Failed to save permission. Please try again.');
      void loadPerms();
    }
  }

  function handleToggle(moduleKey: string, field: keyof ModulePermission, value: boolean) {
    setPerms((prev) =>
      prev.map((p) => (p.moduleKey === moduleKey ? { ...p, [field]: value } : p))
    );

    // Debounce the API call — 600 ms
    const existing = debounceRef.current.get(moduleKey);
    if (existing) clearTimeout(existing);

    const id = setTimeout(() => {
      const updated = perms.find((p) => p.moduleKey === moduleKey);
      if (updated) void savePermission({ ...updated, [field]: value });
      debounceRef.current.delete(moduleKey);
    }, 600);
    debounceRef.current.set(moduleKey, id);
  }

  function handleRangeChange(moduleKey: string, field: 'accountRangeFrom' | 'accountRangeTo', value: string) {
    setPerms((prev) =>
      prev.map((p) => (p.moduleKey === moduleKey ? { ...p, [field]: value || null } : p))
    );
    const existing = debounceRef.current.get(`${moduleKey}_range`);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      const updated = perms.find((p) => p.moduleKey === moduleKey);
      if (updated) void savePermission({ ...updated, [field]: value || null });
      debounceRef.current.delete(`${moduleKey}_range`);
    }, 800);
    debounceRef.current.set(`${moduleKey}_range`, id);
  }

  async function handleReset() {
    setResetting(true);
    try {
      await apiFetch(`/api/accounting/permissions?userId=${userId}`, { method: 'DELETE' });
      onFeedback('Permissions reset to role defaults.');
      void loadPerms();
    } catch {
      onFeedback('Failed to reset permissions.');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return <div className="px-6 py-6 text-center text-sm text-gray-500">Loading permissions...</div>;
  }

  if (isFullAccess) {
    return (
      <div className="px-6 py-5">
        <span className="inline-flex items-center gap-2 rounded-full bg-teal-900/50 px-3 py-1 text-sm font-medium text-teal-300">
          Full Access — {userRole} role cannot be restricted
        </span>
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-gray-500">Custom permissions override role defaults. Toggles save automatically.</p>
        <button
          onClick={() => void handleReset()}
          disabled={resetting}
          className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-red-600 hover:text-red-400 disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />
          {resetting ? 'Resetting...' : 'Reset to Defaults'}
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-800/50 text-left text-xs text-gray-500">
              <th className="px-4 py-2 font-medium">Module</th>
              {ACTIONS.map((a) => (
                <th key={a.key} className="px-3 py-2 text-center font-medium">{a.label}</th>
              ))}
              <th className="px-3 py-2 font-medium text-gray-500">Account Range</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {perms.map((mod) => (
              <tr key={mod.moduleKey} className="hover:bg-gray-800/30">
                <td className="px-4 py-2.5 text-gray-300 font-medium">{mod.moduleName}</td>
                {ACTIONS.map((a) => (
                  <td key={a.key} className="px-3 py-2.5 text-center">
                    <Toggle
                      checked={Boolean(mod[a.key])}
                      onChange={(v) => handleToggle(mod.moduleKey, a.key, v)}
                    />
                  </td>
                ))}
                <td className="px-3 py-2">
                  {mod.moduleKey === 'accounts' ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="From"
                        value={mod.accountRangeFrom ?? ''}
                        onChange={(e) => handleRangeChange(mod.moduleKey, 'accountRangeFrom', e.target.value)}
                        className="w-16 rounded border border-gray-700 bg-gray-800 px-1.5 py-1 text-xs text-white placeholder-gray-600 focus:border-teal-500 focus:outline-none"
                      />
                      <span className="text-gray-600">–</span>
                      <input
                        type="text"
                        placeholder="To"
                        value={mod.accountRangeTo ?? ''}
                        onChange={(e) => handleRangeChange(mod.moduleKey, 'accountRangeTo', e.target.value)}
                        className="w-16 rounded border border-gray-700 bg-gray-800 px-1.5 py-1 text-xs text-white placeholder-gray-600 focus:border-teal-500 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <span className="text-gray-700">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
