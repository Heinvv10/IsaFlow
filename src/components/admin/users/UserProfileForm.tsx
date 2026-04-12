/**
 * UserProfileForm
 * Read/edit view of a user's profile fields in the admin user detail page.
 */

import { Loader2, Check, X } from 'lucide-react';
import { formatDate } from '@/utils/formatters';

const ROLES = ['super_admin', 'admin', 'manager', 'storeman', 'technician', 'viewer'];

interface UserSnapshot {
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  last_login: string | null;
  login_count: number;
  created_at: string;
}

interface EditState {
  firstName: string;
  lastName: string;
  phone: string;
  role: string;
}

interface Props {
  user: UserSnapshot;
  editing: boolean;
  editState: EditState;
  actionLoading: boolean;
  onSave: () => void;
  onCancel: () => void;
  onEditChange: (patch: Partial<EditState>) => void;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 dark:text-white">{value || '\u2014'}</p>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';

export function UserProfileForm({ user, editing, editState, actionLoading, onSave, onCancel, onEditChange }: Props) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Profile Information</h3>
        {editing && (
          <div className="flex gap-2">
            <button onClick={onSave} disabled={actionLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-50 transition-colors">
              {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
            </button>
            <button onClick={onCancel}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">First Name</label>
            <input value={editState.firstName} onChange={e => onEditChange({ firstName: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Last Name</label>
            <input value={editState.lastName} onChange={e => onEditChange({ lastName: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Phone</label>
            <input value={editState.phone} onChange={e => onEditChange({ phone: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Role</label>
            <select value={editState.role} onChange={e => onEditChange({ role: e.target.value })} className={inputCls}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="First Name"  value={user.first_name} />
          <Field label="Last Name"   value={user.last_name} />
          <Field label="Email"       value={user.email} />
          <Field label="Phone"       value={user.phone} />
          <Field label="Role"        value={user.role} />
          <Field label="Status"      value={user.status} />
          <Field label="Last Login"  value={formatDate(user.last_login)} />
          <Field label="Login Count" value={String(user.login_count)} />
          <Field label="Created"     value={formatDate(user.created_at)} />
        </div>
      )}
    </div>
  );
}
