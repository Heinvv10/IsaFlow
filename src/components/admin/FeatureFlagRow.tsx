/**
 * FeatureFlagRow — single row (edit or read-only) for the Feature Flags table.
 * Extracted to keep features.tsx within 300 lines.
 */
import { Globe, Lock, Loader2, Check, X, Pencil } from 'lucide-react';

export interface FeatureFlag {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: string;
}

export interface EditState {
  name: string;
  description: string;
  is_global: boolean;
}

interface Props {
  flag: FeatureFlag;
  isEditing: boolean;
  editState: EditState;
  saving: boolean;
  saveError: string;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpenEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEditChange: (patch: Partial<EditState>) => void;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-ZA');
}

export function FeatureFlagRow({
  flag, isEditing, editState, saving, saveError,
  isSelected, onToggleSelect, onOpenEdit, onCancelEdit, onSaveEdit, onEditChange,
}: Props) {
  if (isEditing) {
    return (
      <tr className="border-b border-gray-100 dark:border-gray-800 last:border-0 bg-teal-50/40 dark:bg-teal-900/10">
        <td className="px-4 py-3">
          <input type="checkbox" checked={isSelected} onChange={onToggleSelect} className="rounded" />
        </td>
        <td className="px-4 py-3">
          <code className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
            {flag.code}
          </code>
        </td>
        <td className="px-4 py-3">
          <input
            type="text"
            value={editState.name}
            onChange={(e) => onEditChange({ name: e.target.value })}
            className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
            placeholder="Feature name"
          />
        </td>
        <td className="px-4 py-3">
          <input
            type="text"
            value={editState.description}
            onChange={(e) => onEditChange({ description: e.target.value })}
            className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
            placeholder="Description"
          />
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={() => onEditChange({ is_global: !editState.is_global })}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${ editState.is_global ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' }`}
          >
            {editState.is_global
              ? <><Globe className="w-3 h-3" /> Global</>
              : <><Lock className="w-3 h-3" /> Plan only</>
            }
          </button>
        </td>
        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{fmtDate(flag.created_at)}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1">
            {saveError && <span className="text-xs text-red-500 mr-1">{saveError}</span>}
            <button
              onClick={onSaveEdit}
              disabled={saving}
              className="p-1.5 rounded text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20 disabled:opacity-40 transition-colors"
              title="Save"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={saving}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
      <td className="px-4 py-3">
        <input type="checkbox" checked={isSelected} onChange={onToggleSelect} className="rounded" />
      </td>
      <td className="px-4 py-3">
        <code className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
          {flag.code}
        </code>
      </td>
      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{flag.name}</td>
      <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate">
        {flag.description || <span className="italic text-gray-700 dark:text-gray-300 dark:text-gray-600">No description</span>}
      </td>
      <td className="px-4 py-3">
        {flag.is_global ? (
          <span className="flex items-center gap-1 text-xs text-teal-600 dark:text-teal-400">
            <Globe className="w-3.5 h-3.5" /> Global
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <Lock className="w-3.5 h-3.5" /> Plan only
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs whitespace-nowrap">{fmtDate(flag.created_at)}</td>
      <td className="px-4 py-3">
        <button
          onClick={onOpenEdit}
          className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Edit feature flag"
        >
          <Pencil className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}
