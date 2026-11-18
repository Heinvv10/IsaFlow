/**
 * Company Settings' error banner. With `onReload` (the company save answered
 * 409: the settings changed since the page loaded them) it offers to reload
 * them; reloading discards the unsaved edits, which is what the 409 asks for.
 */
import { AlertCircle, RefreshCw } from 'lucide-react';

export function SettingsErrorBanner({ message, onReload }: { message: string; onReload?: () => void }) {
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" /> <span className="flex-1">{message}</span>
      {onReload && (
        <button
          type="button" onClick={onReload}
          className="flex items-center gap-1 px-3 py-1 rounded-md border border-red-500/40 hover:bg-red-500/10 font-medium"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Reload settings
        </button>
      )}
    </div>
  );
}
