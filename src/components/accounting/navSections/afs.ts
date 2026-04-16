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
      ],
    },
    {
      section: 'Management Packs',
      items: [
        { label: 'Management Packs', href: '/accounting/afs/management-packs' },
        { label: 'Pack Documents', href: '/accounting/afs?type=management_pack' },
      ],
    },
  ],
};
