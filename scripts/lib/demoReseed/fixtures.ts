/**
 * Fictional customers, suppliers, items, assets and practice clients for the
 * IsaFlow Demo company. Every name was web-checked (see the PR's REPORT) and is
 * covered by the denylist test. Contacts use example.co.za addresses and
 * 0XX 555 XXXX numbers; no registration, VAT or bank number is invented.
 */

export interface CustomerFixture {
  id: string;
  name: string;
  slug: string;
  contact: string;
  areaCode: string;
  address: string;
}

export const CUSTOMERS: readonly CustomerFixture[] = [
  { id: 'c1000000-0000-0000-0000-000000000001', name: 'Jacaranda Lane Dental (Pty) Ltd', slug: 'jacarandalane', contact: 'Lerato Dube', areaCode: '012', address: '14 Wildeperske Street, Pretoria, 0181' },
  { id: 'c1000000-0000-0000-0000-000000000002', name: 'Klipspringer Logistics CC', slug: 'klipspringerlog', contact: 'Hennie Swart', areaCode: '011', address: '8 Stoepkoffie Road, Germiston, 1401' },
  { id: 'c1000000-0000-0000-0000-000000000003', name: 'Fynbos & Finch Interiors (Pty) Ltd', slug: 'fynbosfinch', contact: 'Megan Adams', areaCode: '021', address: '22 Suikerbos Lane, Cape Town, 7700' },
  { id: 'c1000000-0000-0000-0000-000000000004', name: 'Marula Ridge Guest Lodge', slug: 'marularidge', contact: 'Sipho Nkosi', areaCode: '013', address: '3 Tambotie Drive, Mbombela, 1201' },
  { id: 'c1000000-0000-0000-0000-000000000005', name: 'Highveld Hops Brewing Co (Pty) Ltd', slug: 'highveldhops', contact: 'Annelie Botha', areaCode: '016', address: '41 Moutkoring Avenue, Vereeniging, 1939' },
  { id: 'c1000000-0000-0000-0000-000000000006', name: 'Protea Point Physio Inc', slug: 'proteapoint', contact: 'Yusuf Patel', areaCode: '031', address: '9 Kiepersol Crescent, Durban, 4001' },
  { id: 'c1000000-0000-0000-0000-000000000007', name: 'Tallgrass Ridge Engineering (Pty) Ltd', slug: 'tallgrassridge', contact: 'Johan Pretorius', areaCode: '051', address: '17 Doringboom Street, Bloemfontein, 9301' },
  { id: 'c1000000-0000-0000-0000-000000000008', name: 'Silver Oak Tutoring CC', slug: 'silveroak', contact: 'Zanele Khumalo', areaCode: '041', address: '5 Bloekom Close, Gqeberha, 6001' },
];

export interface SupplierFixture {
  id: string;
  name: string;
  initials: string;
  slug: string;
  contact: string;
  areaCode: string;
  /** Expense account code the bill is coded to. */
  expenseCode: string;
  /** Monthly band, ex VAT, in rand. */
  bandLo: number;
  bandHi: number;
  /** What the bill is for (line description). */
  line: string;
}

export const SUPPLIERS: readonly SupplierFixture[] = [
  { id: 'd1000000-0000-0000-0000-000000000001', name: 'Bushbuck Office Supplies', initials: 'BOS', slug: 'bushbuckoffice', contact: 'Petra Smit', areaCode: '011', expenseCode: '5600', bandLo: 1500, bandHi: 6000, line: 'Stationery and printer consumables' },
  { id: 'd1000000-0000-0000-0000-000000000002', name: 'Red Clay Couriers', initials: 'RCC', slug: 'redclaycouriers', contact: 'Themba Zulu', areaCode: '011', expenseCode: '5400', bandLo: 2000, bandHi: 7000, line: 'Courier and delivery services' },
  { id: 'd1000000-0000-0000-0000-000000000003', name: 'Tamboti IT Services', initials: 'TIT', slug: 'tambotiit', contact: 'Ravi Naidoo', areaCode: '012', expenseCode: '5600', bandLo: 4000, bandHi: 12000, line: 'Managed IT support' },
  { id: 'd1000000-0000-0000-0000-000000000004', name: 'Sunbird Cleaning Co', initials: 'SCC', slug: 'sunbirdcleaning', contact: 'Grace Molefe', areaCode: '011', expenseCode: '5600', bandLo: 3500, bandHi: 5500, line: 'Office cleaning' },
  { id: 'd1000000-0000-0000-0000-000000000005', name: 'Karee Fuel & Fleet', initials: 'KFF', slug: 'kareefleet', contact: 'Danie Coetzee', areaCode: '016', expenseCode: '5400', bandLo: 6000, bandHi: 14000, line: 'Fleet fuel and servicing' },
  { id: 'd1000000-0000-0000-0000-000000000006', name: 'Sandgrouse Cover Brokers', initials: 'SCB', slug: 'sandgrousecover', contact: 'Lindiwe Mthembu', areaCode: '021', expenseCode: '5600', bandLo: 4500, bandHi: 6500, line: 'Business insurance premium' },
  { id: 'd1000000-0000-0000-0000-000000000007', name: 'Halfmoon Kloof Property Rentals', initials: 'HKP', slug: 'halfmoonkloof', contact: 'Marius Venter', areaCode: '012', expenseCode: '5600', bandLo: 22000, bandHi: 24000, line: 'Office rental' },
  { id: 'd1000000-0000-0000-0000-000000000008', name: 'Weaverbird Network Wholesale', initials: 'WNW', slug: 'weaverbirdnetwork', contact: 'Nadia Jacobs', areaCode: '011', expenseCode: '5100', bandLo: 15000, bandHi: 60000, line: 'Network cabling and hardware stock' },
  { id: 'd1000000-0000-0000-0000-000000000009', name: 'Kestrel Connect Telecoms', initials: 'KCT', slug: 'kestrelconnect', contact: 'Bongani Dlamini', areaCode: '031', expenseCode: '5600', bandLo: 2500, bandHi: 4500, line: 'Office phones and internet' },
  { id: 'd1000000-0000-0000-0000-000000000010', name: 'Ledgerleaf Software', initials: 'LLS', slug: 'ledgerleaf', contact: 'Carla Fourie', areaCode: '021', expenseCode: '5600', bandLo: 1800, bandHi: 2400, line: 'Software subscriptions' },
];

/** What the Demo business sells (a small office IT and network installer). `support` lines go to 4200. */
export const SALES_LINES: ReadonlyArray<{ description: string; support: boolean; unitLo: number; unitHi: number; qtyMax: number }> = [
  { description: 'Network cabling installation', support: false, unitLo: 450, unitHi: 950, qtyMax: 40 },
  { description: 'Wi-Fi access point supply and setup', support: false, unitLo: 2800, unitHi: 4200, qtyMax: 12 },
  { description: 'Monthly support and maintenance', support: true, unitLo: 3500, unitHi: 9500, qtyMax: 1 },
  { description: 'Hardware supply and configuration', support: false, unitLo: 1500, unitHi: 6500, qtyMax: 10 },
  { description: 'Site survey and planning', support: true, unitLo: 2500, unitHi: 6000, qtyMax: 1 },
  { description: 'Server room tidy and labelling', support: true, unitLo: 650, unitHi: 850, qtyMax: 12 },
  { description: 'On-site support call-out', support: true, unitLo: 750, unitHi: 1200, qtyMax: 4 },
];

export const ITEMS: ReadonlyArray<{ code: string; description: string; type: 'physical' | 'service'; unit: string; cost: number; price: number }> = [
  { code: 'CAB-305', description: 'Cat6 cable (305 m box)', type: 'physical', unit: 'box', cost: 1650, price: 2450 },
  { code: 'WAP-01', description: 'Wi-Fi access point', type: 'physical', unit: 'each', cost: 1900, price: 2950 },
  { code: 'SW-24', description: '24-port network switch', type: 'physical', unit: 'each', cost: 3200, price: 4650 },
  { code: 'PP-24', description: 'Patch panel', type: 'physical', unit: 'each', cost: 520, price: 840 },
  { code: 'LAB-HR', description: 'Installation labour (hour)', type: 'service', unit: 'hour', cost: 0, price: 650 },
  { code: 'SUP-MO', description: 'Support retainer (month)', type: 'service', unit: 'month', cost: 0, price: 5500 },
];

export interface AssetFixture {
  number: string;
  name: string;
  /** 'vehicles' -> account 1220, else 1210. */
  kind: 'vehicles' | 'equipment';
  supplierIndex: number;
  priceLo: number;
  priceHi: number;
  lifeYears: number;
  /** Month offset into the window when it was bought (0..13). */
  monthOffset: number;
}

export const ASSETS: readonly AssetFixture[] = [
  { number: 'FA-0001', name: 'Delivery vehicle', kind: 'vehicles', supplierIndex: 4, priceLo: 280000, priceHi: 320000, lifeYears: 5, monthOffset: 1 },
  { number: 'FA-0002', name: 'Cable tester', kind: 'equipment', supplierIndex: 7, priceLo: 18000, priceHi: 24000, lifeYears: 3, monthOffset: 3 },
  { number: 'FA-0003', name: 'Fusion splicer', kind: 'equipment', supplierIndex: 7, priceLo: 65000, priceHi: 85000, lifeYears: 5, monthOffset: 5 },
  { number: 'FA-0004', name: 'Office laptops (set of 4)', kind: 'equipment', supplierIndex: 2, priceLo: 64000, priceHi: 76000, lifeYears: 3, monthOffset: 7 },
  { number: 'FA-0005', name: 'Server rack and UPS', kind: 'equipment', supplierIndex: 2, priceLo: 38000, priceHi: 46000, lifeYears: 5, monthOffset: 10 },
  { number: 'FA-0006', name: 'Office furniture', kind: 'equipment', supplierIndex: 0, priceLo: 42000, priceHi: 52000, lifeYears: 6, monthOffset: 13 },
];

export const PRACTICE_CLIENTS: ReadonlyArray<{ id: string; legal: string; trading: string; billing: 'hourly' | 'fixed' | 'retainer'; contact: string; slug: string }> = [
  { id: 'ac100000-0000-0000-0000-000000000001', legal: 'Kettle Kloof Bakery (Pty) Ltd', trading: 'Kettle Kloof Bakery', billing: 'fixed', contact: 'Ilse Kruger', slug: 'kettlekloof' },
  { id: 'ac100000-0000-0000-0000-000000000002', legal: 'Ridgeback Lane Physiotherapy Inc', trading: 'Ridgeback Lane Physio', billing: 'hourly', contact: 'Ayanda Mkhize', slug: 'ridgebacklane' },
  { id: 'ac100000-0000-0000-0000-000000000003', legal: 'Riverstone Landscaping CC', trading: 'Riverstone Landscaping', billing: 'retainer', contact: 'Pieter Nel', slug: 'riverstone' },
  { id: 'ac100000-0000-0000-0000-000000000004', legal: 'Saltpan Studio (Pty) Ltd', trading: 'Saltpan Studio', billing: 'hourly', contact: 'Kgomotso Moloi', slug: 'saltpan' },
];

/** `0XX 555 XXXX`: the 555 exchange is a fictional-number convention; the last four digits are fixed per index. */
export function demoPhone(areaCode: string, index: number): string {
  return `${areaCode} 555 ${String(1000 + ((index * 379) % 9000)).padStart(4, '0')}`;
}
