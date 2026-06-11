/**
 * Settings navigation structure — defines the 6 category groups and their items.
 * Also exports TabId so SettingsSidebar and the settings page share one definition.
 */

export type TabId =
  | 'details'
  | 'general'
  | 'vat'
  | 'compliance'
  | 'documents'
  | 'branding'
  | 'dimensions'
  | 'aging'
  | 'doc-messages'
  | 'email-templates'
  | 'udf'
  | 'regional'
  | 'customer-zone'
  | 'netcash';

export interface SettingsNavItem {
  id: TabId;
  label: string;
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    id: 'company-profile',
    label: 'Company Profile',
    items: [
      { id: 'details', label: 'Company Details' },
      { id: 'general', label: 'General Settings' },
      { id: 'regional', label: 'Regional' },
    ],
  },
  {
    id: 'accounting-tax',
    label: 'Accounting & Tax',
    items: [
      { id: 'vat', label: 'VAT Settings' },
      { id: 'compliance', label: 'Compliance' },
      { id: 'aging', label: 'Aging' },
    ],
  },
  {
    id: 'documents-branding',
    label: 'Documents & Branding',
    items: [
      { id: 'documents', label: 'Documents & Statements' },
      { id: 'doc-messages', label: 'Document Messages' },
      { id: 'email-templates', label: 'Email Templates' },
      { id: 'branding', label: 'Branding' },
    ],
  },
  {
    id: 'customers-communication',
    label: 'Customers & Communication',
    items: [
      { id: 'customer-zone', label: 'Customer Zone' },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [
      { id: 'netcash', label: 'Netcash' },
    ],
  },
  {
    id: 'advanced-fields',
    label: 'Advanced Fields',
    items: [
      { id: 'dimensions', label: 'Dimensions' },
      { id: 'udf', label: 'User Fields' },
    ],
  },
];
