// src/components/accounting/navSections/afs.ts
import type { Tab } from './types';

export const afsTab: Tab = {
  id: 'afs',
  label: 'AFS',
  items: [
    {
      section: 'Annual Financial Statements',
      items: [
        { label: 'All AFS Documents', href: '/accounting/afs' },
        { label: 'Account Mapping', href: '/accounting/afs/mapping' },
        { label: 'Report Templates', href: '/accounting/afs/report-templates' },
        { label: 'Public Interest Score', href: '/accounting/afs/pis-score' },
      ],
    },
    {
      section: 'Management Packs',
      items: [
        { label: 'Management Packs', href: '/accounting/afs/management-packs' },
        { label: 'Pack Documents', href: '/accounting/afs?type=management_pack' },
      ],
    },
    {
      section: 'Client Portal',
      items: [
        { label: 'Portal Contacts', href: '/accounting/afs/portal-contacts' },
      ],
    },
  ],
};
