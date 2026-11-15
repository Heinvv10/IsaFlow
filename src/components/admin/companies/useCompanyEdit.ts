/**
 * Company detail: the Info tab's edit form. Kept in the page (not the tab), so an edit in progress survives a
 * switch to another tab and back.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { adminFetch } from '@/lib/admin/adminFetch';
import { EDITABLE_KEYS, toEditForm, type CompanyDetail, type EditableKey, type EditForm } from './companyDetailModel';

export interface CompanyEdit {
  editMode: boolean;
  editForm: EditForm | null;
  setEditForm: Dispatch<SetStateAction<EditForm | null>>;
  editSaving: boolean;
  editError: string;
  startEdit: () => void;
  cancelEdit: () => void;
  save: () => Promise<void>;
}

export function useCompanyEdit(
  id: string | string[] | undefined,
  company: CompanyDetail | null,
  setCompany: (c: CompanyDetail) => void,
): CompanyEdit {
  const [editMode, setEditMode]           = useState(false);
  const [editForm, setEditForm]           = useState<EditForm | null>(null);
  const [editSaving, setEditSaving]       = useState(false);
  const [editError, setEditError]         = useState('');

  function startEdit() {
    if (!company) return;
    setEditForm(toEditForm(company));
    setEditError('');
    setEditMode(true);
  }

  function cancelEdit() {
    setEditMode(false);
    setEditForm(null);
    setEditError('');
  }

  async function save() {
    if (!id || typeof id !== 'string' || !editForm) return;
    const name = editForm.name.trim();
    if (!name) { setEditError('Name is required'); return; }

    // A blanked field is sent as null, which clears it (audit 4.17); dropping it kept the old value.
    const body: Partial<Record<EditableKey, string | null>> = {};
    for (const key of EDITABLE_KEYS) {
      const v = editForm[key].trim();
      body[key] = v === '' ? null : v; // name is never blank here (checked above)
    }

    setEditSaving(true); setEditError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await assertOk(res, 'Could not save the company - try again');
      const json = await res.json();
      setCompany(json.data as CompanyDetail);
      setEditMode(false);
      setEditForm(null);
    } catch (err) {
      setEditError(apiErrorMessage(err, 'Could not save the company - try again'));
    } finally {
      setEditSaving(false);
    }
  }

  return { editMode, editForm, setEditForm, editSaving, editError, startEdit, cancelEdit, save };
}
