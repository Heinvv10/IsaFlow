import { Upload, Trash2, Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { Company, Toggle, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
  onCompanyChange: (updated: Company) => void;
  onError: (msg: string) => void;
}

export function BrandingTab({ company, onChange, onCompanyChange, onError }: Props) {
  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { onError('Logo must be under 2MB'); return; }
    onError('');
    try {
      const logoData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await apiFetch('/api/accounting/company-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, logoData }),
      });
      if (!res.ok) throw new Error('Failed to upload logo');
      onCompanyChange({ ...company, logoData });
    } catch {
      onError('Failed to upload logo');
    }
  };

  const handleRemoveLogo = async () => {
    onError('');
    try {
      const res = await apiFetch('/api/accounting/company-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, logoData: null }),
      });
      if (!res.ok) throw new Error('Failed to remove logo');
      onCompanyChange({ ...company, logoData: null });
    } catch {
      onError('Failed to remove logo');
    }
  };

  return (
    <>
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Company Logo</h2>
        <div className="flex items-center gap-6 mb-6">
          {company.logoData ? (
            <img src={company.logoData} className="h-20 w-20 object-contain rounded-lg border border-gray-700" alt="Company logo" />
          ) : (
            <div className="h-20 w-20 rounded-lg border border-dashed border-[var(--ff-border-primary)] flex items-center justify-center">
              <Building2 className="h-8 w-8 text-[var(--ff-text-tertiary)]" />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer">
              <Upload className="h-4 w-4" /> Upload Logo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,.gif,.bmp,.tiff"
                className="hidden"
                onChange={e => void handleLogoUpload(e)}
              />
            </label>
            {company.logoData && (
              <button
                onClick={() => void handleRemoveLogo()}
                className="flex items-center gap-2 px-4 py-2 text-red-500 hover:bg-red-500/10 rounded-lg text-sm font-medium transition-colors"
              >
                <Trash2 className="h-4 w-4" /> Remove Logo
              </button>
            )}
            <p className="text-xs text-[var(--ff-text-tertiary)]">JPEG, PNG, WebP, GIF, BMP, TIFF. Max 2MB.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Position of Logo on Invoices and Statements</label>
            <select className={INPUT_CLS} value={company.logoPosition} onChange={e => onChange('logoPosition', e.target.value)}>
              <option value="top-left">Top Left</option>
              <option value="top-center">Top Center</option>
              <option value="top-right">Top Right</option>
            </select>
          </div>
        </div>

        <div className="mt-4 space-y-1">
          <Toggle checked={company.logoOnEmails} onChange={v => onChange('logoOnEmails', v)} label="Show Logo on Invoice and Statement Emails" />
          <Toggle checked={company.logoOnPortal} onChange={v => onChange('logoOnPortal', v)} label="Show Logo on Customer Portal" />
        </div>
      </section>
    </>
  );
}

