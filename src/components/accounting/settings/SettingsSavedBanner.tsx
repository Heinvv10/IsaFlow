/** Company Settings' confirmation that the last save succeeded. */
import { CheckCircle2 } from 'lucide-react';

export function SettingsSavedBanner() {
  return (
    <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3 flex items-center gap-2 text-teal-500 text-sm">
      <CheckCircle2 className="h-4 w-4" /> Changes saved successfully
    </div>
  );
}
