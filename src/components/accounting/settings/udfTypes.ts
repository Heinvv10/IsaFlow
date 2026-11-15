/** UDF settings: shared types and constants (split out of UdfTab.tsx, no behaviour change). */

// ── Types ────────────────────────────────────────────────────────────────────

export type UdfEntityType = 'customer' | 'supplier' | 'invoice' | 'item';
export type UdfFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface UdfDefinition {
  id?: string;
  entityType: UdfEntityType;
  fieldNumber: number;
  fieldLabel: string;
  fieldType: UdfFieldType;
  fieldOptions: string | null;
  isRequired: boolean;
  isActive: boolean;
}

export type SectionState = Record<number, UdfDefinition>;

export const ENTITY_SECTIONS: { type: UdfEntityType; label: string }[] = [
  { type: 'customer', label: 'Customer' },
  { type: 'supplier', label: 'Supplier' },
  { type: 'invoice', label: 'Invoice' },
  { type: 'item', label: 'Item' },
];

export const FIELD_TYPES: { value: UdfFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'select', label: 'Select List' },
];

// Build 12 empty slots for an entity section
export function emptySection(entityType: UdfEntityType): SectionState {
  const state: SectionState = {};
  for (let n = 1; n <= 12; n++) {
    state[n] = {
      entityType,
      fieldNumber: n,
      fieldLabel: '',
      fieldType: 'text',
      fieldOptions: null,
      isRequired: false,
      isActive: true,
    };
  }
  return state;
}
