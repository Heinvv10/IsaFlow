/**
 * Company detail, Info tab: the company's fields (read, or the edit form) and its subscription.
 * The edit state lives in the page (useCompanyEdit), so it survives a tab switch.
 */
import { AlertCircle, Loader2, Pencil, Check, X } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { formatLastSeen } from '@/components/admin/formatLastSeen';
import type { CompanyDetail } from './companyDetailModel';
import type { CompanyEdit } from './useCompanyEdit';

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 dark:text-white">{value || '\u2014'}</p>
    </div>
  );
}

export function CompanyInfoTab({ company, edit }: { company: CompanyDetail; edit: CompanyEdit }) {
  const { editMode, editForm, setEditForm, editSaving, editError, startEdit, cancelEdit, save } = edit;
  const address = [company.address_line1, company.city, company.province, company.postal_code].filter(Boolean).join(', ');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Company Information</h3>
          {!editMode && (
            <button
              onClick={startEdit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          )}
        </div>

        {editMode && editForm ? (
          <>
            {editError && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-xs mb-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0" /> {editError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {([
                ['name',            'Name'],
                ['trading_name',    'Trading Name'],
                ['email',           'Email'],
                ['phone',           'Phone'],
                ['website',         'Website'],
                ['billing_email',   'Billing Email'],
                ['billing_contact', 'Billing Contact'],
                ['address_line1',   'Address Line 1'],
                ['city',            'City'],
                ['province',        'Province'],
                ['postal_code',     'Postal Code'],
              ] as const).map(([key, label]) => (
                <div key={key} className={key === 'address_line1' ? 'col-span-2' : ''}>
                  <label htmlFor={`company-edit-${key}`} className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</label>
                  <input
                    id={`company-edit-${key}`}
                    type={key === 'email' || key === 'billing_email' ? 'email' : key === 'website' ? 'url' : 'text'}
                    value={editForm[key]}
                    onChange={e => setEditForm(f => f ? { ...f, [key]: e.target.value } : f)}
                    disabled={editSaving}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                onClick={cancelEdit}
                disabled={editSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={editSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-60"
              >
                {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Save Changes
              </button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Registration #"  value={company.registration_number} />
            <Field label="VAT Number"       value={company.vat_number} />
            <Field label="Trading Name"     value={company.trading_name} />
            <Field label="Website"          value={company.website} />
            <Field label="Email"            value={company.email} />
            <Field label="Phone"            value={company.phone} />
            <Field label="Billing Email"    value={company.billing_email} />
            <Field label="Billing Contact"  value={company.billing_contact} />
            <Field label="Created"          value={formatDate(company.created_at)} />
            <Field label="Last Active"      value={formatLastSeen(company.last_active)} />
            <div className="col-span-2"><Field label="Address" value={address} /></div>
          </div>
        )}
      </div>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Subscription</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Plan"          value={company.plan_name} />
          <Field label="Billing Cycle" value={company.billing_cycle} />
          <Field label="Status"        value={company.status} />
        </div>
      </div>
    </div>
  );
}
