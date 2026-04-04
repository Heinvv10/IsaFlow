import type { Tab } from './types';

export const itemsTab: Tab = {
  id: 'items', label: 'Items',
  topItems: [
    { label: 'Add an Item', href: '/accounting/items/new' },
  ],
  items: [
    {
      section: 'Lists',
      items: [
        { label: 'List of Items', href: '/accounting/items' },
        { label: 'Item Categories', href: '/accounting/item-categories' },
      ],
    },
    {
      section: 'Transactions',
      items: [
        { label: 'Item Adjustments', href: '/accounting/item-adjustments' },
        { label: 'Adjust Selling Prices', href: '/accounting/item-pricing' },
      ],
    },
    {
      section: 'Special',
      items: [
        { label: 'Item Opening Balances', href: '/accounting/item-opening-balances' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'Item Listing', href: '/accounting/reports/item-listing' },
        { label: 'Sales by Item', href: '/accounting/reports/sales-by-item' },
        { label: 'Purchases by Item', href: '/accounting/reports/purchases-by-item' },
        { label: 'Item Movement', href: '/accounting/reports/item-movement' },
        { label: 'Item Valuation', href: '/accounting/reports/item-valuation' },
        { label: 'Item Quantities', href: '/accounting/reports/item-quantities' },
      ],
    },
  ],
};
