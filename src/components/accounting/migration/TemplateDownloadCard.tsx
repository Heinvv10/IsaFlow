/**
 * Step 1 of every migration wizard page: download the template, and read what
 * goes in it. The guidance used to sit inside the CSV as `# ...` rows, which
 * every parser read as data; it is shown here instead.
 */
import { Download } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { getTemplateGuidance, type MigrationStep } from '@/modules/accounting/services/core/migrationTemplateService';
import { downloadStepTemplate } from './downloadTemplate';

interface Props {
  step: MigrationStep;
  /** The session's source system when the page already has it; fetched on click otherwise. */
  sourceSystem?: string | null;
  onError: (message: string) => void;
}

export function TemplateDownloadCard({ step, sourceSystem, onError }: Props) {
  const download = async () => {
    onError('');
    try {
      await downloadStepTemplate(step, sourceSystem);
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not download the template - try again'));
    }
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">1. Download Template</h2>
      <button onClick={() => { void download(); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
        <Download className="h-4 w-4" /> Download CSV Template
      </button>
      <p className="text-xs text-[var(--ff-text-secondary)] mt-3">{getTemplateGuidance(step, sourceSystem)}</p>
    </div>
  );
}
