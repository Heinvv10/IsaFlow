import { useState } from 'react';
import { Upload, Download, Trash2, FileText, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  Company, CompanyDocument, Toggle,
  INPUT_CLS, LABEL_CLS, SECTION_CLS,
  DOC_TYPE_LABELS, INDUSTRIES, BUSINESS_STRUCTURES, ENTITY_TYPES,
} from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
  onCompanyChange: (updated: Company) => void;
  documents: CompanyDocument[];
  onDocumentsChange: (docs: CompanyDocument[]) => void;
  onError: (msg: string) => void;
}

export function DetailsTab({ company, onChange, onCompanyChange, documents, onDocumentsChange, onError }: Props) {
  const [physicalSameAsPostal, setPhysicalSameAsPostal] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docType, setDocType] = useState('cipc_certificate');

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { onError('Document must be under 10MB'); return; }
    setUploadingDoc(true);
    onError('');
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await apiFetch('/api/accounting/company-documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, documentType: docType, documentName: file.name, fileData, mimeType: file.type, fileSize: file.size }),
      });
      if (!res.ok) throw new Error('Failed to upload document');
      const updated = await apiFetch(`/api/accounting/company-documents?companyId=${company.id}`);
      const json = await updated.json();
      if (json.data) onDocumentsChange(json.data as CompanyDocument[]);
    } catch {
      onError('Failed to upload document');
    } finally {
      setUploadingDoc(false);
      e.target.value = '';
    }
  };

  const handleDocDownload = async (docId: string, docName: string) => {
    try {
      const res = await apiFetch(`/api/accounting/company-documents?id=${docId}&download=1`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = docName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { onError('Failed to download document'); }
  };

  const handleDocDelete = async (docId: string) => {
    if (!window.confirm('Are you sure you want to delete this document?')) return;
    try {
      const res = await apiFetch(`/api/accounting/company-documents?id=${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      onDocumentsChange(documents.filter(d => d.id !== docId));
    } catch { onError('Failed to delete document'); }
  };

  return (
    <>
      {/* Company Details */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Company Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className={LABEL_CLS}>Company Name *</label><input className={INPUT_CLS} value={company.name} onChange={e => onChange('name', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Trading Name</label><input className={INPUT_CLS} value={company.tradingName || ''} onChange={e => onChange('tradingName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Registered Name</label><input className={INPUT_CLS} value={company.registeredName || ''} onChange={e => onChange('registeredName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Registration Number</label><input className={INPUT_CLS} value={company.registrationNumber || ''} onChange={e => onChange('registrationNumber', e.target.value)} /></div>
          <div>
            <label className={LABEL_CLS}>Entity Type</label>
            <select className={INPUT_CLS} value={company.entityType} onChange={e => onChange('entityType', e.target.value)}>
              {ENTITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Industry</label>
            <select className={INPUT_CLS} value={company.industry || ''} onChange={e => onChange('industry', e.target.value || null)}>
              <option value="">Select industry...</option>
              {INDUSTRIES.map(ind => <option key={ind} value={ind}>{ind}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Business Structure</label>
            <select className={INPUT_CLS} value={company.businessStructure || ''} onChange={e => onChange('businessStructure', e.target.value || null)}>
              <option value="">Select structure...</option>
              {BUSINESS_STRUCTURES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div><label className={LABEL_CLS}>Contact Name</label><input className={INPUT_CLS} value={company.contactName || ''} onChange={e => onChange('contactName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Email</label><input type="email" className={INPUT_CLS} value={company.email || ''} onChange={e => onChange('email', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Phone</label><input className={INPUT_CLS} value={company.phone || ''} onChange={e => onChange('phone', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Mobile</label><input className={INPUT_CLS} value={company.mobile || ''} onChange={e => onChange('mobile', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Fax</label><input className={INPUT_CLS} value={company.fax || ''} onChange={e => onChange('fax', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Website</label><input className={INPUT_CLS} value={company.website || ''} onChange={e => onChange('website', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Country</label><input className={INPUT_CLS} value={company.country || 'South Africa'} onChange={e => onChange('country', e.target.value)} /></div>
        </div>
        <div className="mt-4 space-y-1">
          <Toggle checked={company.emailUseForCommunication} onChange={v => onChange('emailUseForCommunication', v)} label="Use this Email for Communication" />
          <Toggle checked={company.emailAlwaysCc} onChange={v => onChange('emailAlwaysCc', v)} label="Always CC this Email Address" />
        </div>
      </section>

      {/* Postal Address */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Postal Address</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 1</label><input className={INPUT_CLS} value={company.addressLine1 || ''} onChange={e => onChange('addressLine1', e.target.value)} /></div>
          <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 2</label><input className={INPUT_CLS} value={company.addressLine2 || ''} onChange={e => onChange('addressLine2', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>City</label><input className={INPUT_CLS} value={company.city || ''} onChange={e => onChange('city', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Province</label><input className={INPUT_CLS} value={company.province || ''} onChange={e => onChange('province', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Postal Code</label><input className={INPUT_CLS} value={company.postalCode || ''} onChange={e => onChange('postalCode', e.target.value)} /></div>
        </div>
      </section>

      {/* Physical Address */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Physical Address</h2>
        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input type="checkbox" checked={physicalSameAsPostal} onChange={e => {
            const checked = e.target.checked;
            setPhysicalSameAsPostal(checked);
            if (checked) {
              onCompanyChange({ ...company, physicalAddressLine1: company.addressLine1, physicalAddressLine2: company.addressLine2, physicalCity: company.city, physicalProvince: company.province, physicalPostalCode: company.postalCode });
            }
          }} className="h-4 w-4 accent-teal-500" />
          <span className="text-sm text-[var(--ff-text-secondary)]">Same as postal address</span>
        </label>
        {!physicalSameAsPostal ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 1</label><input className={INPUT_CLS} value={company.physicalAddressLine1 || ''} onChange={e => onChange('physicalAddressLine1', e.target.value)} /></div>
            <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 2</label><input className={INPUT_CLS} value={company.physicalAddressLine2 || ''} onChange={e => onChange('physicalAddressLine2', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>City</label><input className={INPUT_CLS} value={company.physicalCity || ''} onChange={e => onChange('physicalCity', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Province</label><input className={INPUT_CLS} value={company.physicalProvince || ''} onChange={e => onChange('physicalProvince', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Postal Code</label><input className={INPUT_CLS} value={company.physicalPostalCode || ''} onChange={e => onChange('physicalPostalCode', e.target.value)} /></div>
          </div>
        ) : (
          <p className="text-sm text-[var(--ff-text-tertiary)]">Physical address will mirror the postal address above.</p>
        )}
      </section>

      {/* Social Media */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Social Media Links</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className={LABEL_CLS}>Facebook URL</label><input className={INPUT_CLS} value={company.socialFacebook || ''} onChange={e => onChange('socialFacebook', e.target.value || null)} placeholder="https://facebook.com/yourpage" /></div>
          <div><label className={LABEL_CLS}>LinkedIn URL</label><input className={INPUT_CLS} value={company.socialLinkedin || ''} onChange={e => onChange('socialLinkedin', e.target.value || null)} placeholder="https://linkedin.com/company/yourcompany" /></div>
          <div><label className={LABEL_CLS}>X (Twitter) URL</label><input className={INPUT_CLS} value={company.socialX || ''} onChange={e => onChange('socialX', e.target.value || null)} placeholder="https://x.com/yourhandle" /></div>
        </div>
      </section>

      {/* Statutory Information */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statutory Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className={LABEL_CLS}>Income Tax Number</label><input className={INPUT_CLS} value={company.taxNumber || ''} onChange={e => onChange('taxNumber', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Tax Office</label><input className={INPUT_CLS} value={company.taxOffice || ''} onChange={e => onChange('taxOffice', e.target.value)} /></div>
        </div>
      </section>

      {/* Tax Practitioner */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Tax Practitioner Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className={LABEL_CLS}>Practitioner Reg Number</label><input className={INPUT_CLS} value={company.taxPractitionerRegNumber || ''} onChange={e => onChange('taxPractitionerRegNumber', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Practitioner Name</label><input className={INPUT_CLS} value={company.taxPractitionerName || ''} onChange={e => onChange('taxPractitionerName', e.target.value)} /></div>
        </div>
      </section>

      {/* SARS Contact */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">SARS Company Contact Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className={LABEL_CLS}>First Name</label><input className={INPUT_CLS} value={company.sarsContactFirstName || ''} onChange={e => onChange('sarsContactFirstName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Last Name</label><input className={INPUT_CLS} value={company.sarsContactLastName || ''} onChange={e => onChange('sarsContactLastName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Capacity</label><input className={INPUT_CLS} value={company.sarsContactCapacity || ''} onChange={e => onChange('sarsContactCapacity', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Contact Number</label><input className={INPUT_CLS} value={company.sarsContactNumber || ''} onChange={e => onChange('sarsContactNumber', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Telephone</label><input className={INPUT_CLS} value={company.sarsContactTelephone || ''} onChange={e => onChange('sarsContactTelephone', e.target.value)} /></div>
        </div>
      </section>

      {/* Banking */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Banking Details</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Used on invoices and statements for payment instructions</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><label className={LABEL_CLS}>Bank Name</label><input className={INPUT_CLS} value={company.bankName || ''} onChange={e => onChange('bankName', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Account Number</label><input className={INPUT_CLS} value={company.bankAccountNumber || ''} onChange={e => onChange('bankAccountNumber', e.target.value)} /></div>
          <div><label className={LABEL_CLS}>Branch Code</label><input className={INPUT_CLS} value={company.bankBranchCode || ''} onChange={e => onChange('bankBranchCode', e.target.value)} /></div>
          <div>
            <label className={LABEL_CLS}>Account Type</label>
            <select className={INPUT_CLS} value={company.bankAccountType || ''} onChange={e => onChange('bankAccountType', e.target.value)}>
              <option value="">Select...</option>
              <option value="Current">Current</option>
              <option value="Savings">Savings</option>
              <option value="Transmission">Transmission</option>
              <option value="Credit Card">Credit Card</option>
            </select>
          </div>
        </div>
      </section>

      {/* Statutory Documents */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statutory Documents</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Upload company registration certificates, tax clearance, and other statutory documents.</p>
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 mb-6">
          <div>
            <label className={LABEL_CLS}>Document Type</label>
            <select className={INPUT_CLS} value={docType} onChange={e => setDocType(e.target.value)}>
              {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer">
            {uploadingDoc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload Document
            <input type="file" accept="image/*,application/pdf" className="hidden" onChange={e => void handleDocUpload(e)} disabled={uploadingDoc} />
          </label>
          <p className="text-xs text-[var(--ff-text-tertiary)]">Images or PDF. Max 10MB.</p>
        </div>
        {documents.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-primary)]">
                <th className="pb-2 font-medium">Type</th><th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Uploaded</th><th className="pb-2 font-medium">Size</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr></thead>
              <tbody>
                {documents.map(doc => (
                  <tr key={doc.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                    <td className="py-3 text-[var(--ff-text-primary)]">{DOC_TYPE_LABELS[doc.documentType] || doc.documentType}</td>
                    <td className="py-3 text-[var(--ff-text-secondary)] flex items-center gap-2"><FileText className="h-4 w-4 text-[var(--ff-text-tertiary)]" />{doc.documentName}</td>
                    <td className="py-3 text-[var(--ff-text-secondary)]">{new Date(doc.createdAt).toLocaleDateString()}</td>
                    <td className="py-3 text-[var(--ff-text-secondary)]">{formatFileSize(doc.fileSize)}</td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => void handleDocDownload(doc.id, doc.documentName)} className="p-1.5 text-teal-500 hover:bg-teal-500/10 rounded-lg transition-colors" title="Download"><Download className="h-4 w-4" /></button>
                        <button onClick={() => void handleDocDelete(doc.id)} className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors" title="Delete"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-6">No documents uploaded yet.</p>}
      </section>
    </>
  );
}
