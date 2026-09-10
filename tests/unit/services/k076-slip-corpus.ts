/**
 * Every slip K-076 has been beaten by, rounds 5 to 9, in one place.
 *
 * Each round of this item fixed the slips it was shown and was beaten by one it
 * was not, so the corpus is data rather than scattered `it` bodies: a new
 * counter-example is one row here, and `k076-unattended-posting-gate.test.ts`
 * runs every row through the real extraction and the real auto-post gate.
 *
 * `payable` is what the slip actually asks to be paid — null where posting it
 * as a purchase would be wrong at any amount (a credit note). `outcome` pins
 * what the gate does with it, so an over-refusal is as visible as an
 * under-refusal. The invariant the test asserts on EVERY row is the one that
 * matters: a slip either refuses, or posts exactly its payable.
 */

export interface Slip {
  name: string;
  text: string;
  payable: number | null;
  outcome: 'post' | 'refuse';
}

const CHECKERS = 'Checkers Hyper Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\n';
const BASKET = 'Chicken Braai Pack 1 200.00 200.00\nWhite Bread 1 23.00 23.00\n';
const OCEAN = 'Ocean Basket Sandton\nTAX INVOICE\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\n';
const CREDIT = 'Acme Supplies\nCREDIT NOTE\nDate: 2026-09-01\nInvoice No: CN00123\nWidget 1 100.00 100.00\n';
const WALTONS = 'Waltons Stationery\nTAX INVOICE\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\n';

const SECTION_NOUNS = [
  'Beverage', 'Kitchen', 'Pharmacy', 'Workshop', 'Trolley',
  'Goods', 'Items', 'Line', 'Order', 'Deposit', 'Previous',
];

export const SLIPS: Slip[] = [
  // Round 5 — a section total above the payable.
  { name: 'r5 Tashas multi-section', text: 'Tashas Cafe\nDate: 2026-09-01\nInvoice No: 77001\nFood Total 200.00\nDrinks Total 50.00\nVAT 32.61\nTOTAL 287.50', payable: 287.5, outcome: 'refuse' },
  ...SECTION_NOUNS.map((noun): Slip => ({
    name: `r5 "${noun} Total" above the payable`,
    text: `${WALTONS}${noun} Total 250.00\nVAT 150.00\nTotal Due 1150.00`,
    payable: 1150, outcome: 'refuse',
  })),

  // Round 7 — an extra printed BELOW the Sub Total / VAT / Total block.
  { name: 'r7 gratuity below the block', text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\nTotal Due 253.00`, payable: 253, outcome: 'refuse' },
  { name: 'r7 delivery below the block', text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nDelivery 57.50\nTotal Due 287.50`, payable: 287.5, outcome: 'refuse' },
  { name: 'r7 rounding below the block', text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nRounding 0.05\nTotal Due 230.05`, payable: 230.05, outcome: 'refuse' },

  // Round 8 — the fixer's own pinned cases.
  { name: 'r8 Delivery Total above Sub Total', text: `${WALTONS}Delivery Total 250.00\nSub Total 1000.00\nVAT 150.00\nTotal Due 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'r8 one total printed twice', text: `${WALTONS}Sub Total 1000.00\nVAT 150.00\nTOTAL (VAT INCL) 1150.00\nTotal Due 1150.00`, payable: 1150, outcome: 'post' },
  { name: 'r8 ordinary single total', text: `${WALTONS}Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00`, payable: 1150, outcome: 'post' },
  { name: 'r8 Cash Total below the payable', text: `${WALTONS}Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00\nCash Total 1200.00`, payable: 1150, outcome: 'refuse' },

  // Round 9 review — the VAT analysis printed AFTER the tender (mixed basket).
  { name: 'A1 tender, then VAT analysis Sub/VAT/Total', text: `${CHECKERS}${BASKET}TOTAL 253.00\nCASH 300.00\nCHANGE 47.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nZero Rated 23.00`, payable: 253, outcome: 'refuse' },
  { name: 'A2 VAT summary Excl/VAT/Standard Total', text: `${CHECKERS}${BASKET}TOTAL DUE 253.00\nCARD 253.00\nVAT SUMMARY\nZero Rated Total 23.00\nStandard Excl VAT 200.00\nVAT 30.00\nStandard Total 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'A3 service charge above, VAT summary below', text: `${OCEAN}Sub Total 200.00\nService Charge 23.00\nVAT 30.00\nTotal Due 253.00\nVAT SUMMARY\nSub Total 200.00\nVAT 30.00\nTotal 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'A4 analysis below, no tender', text: `${CHECKERS}${BASKET}TOTAL 253.00\nVAT 15% Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'A6 statement with a previous balance', text: `${OCEAN}Sub Total 1000.00\nVAT 150.00\nTotal 1150.00\nPrevious Balance 3000.00\nTotal Due 4150.00`, payable: 4150, outcome: 'refuse' },

  // Round 9 review — ordinary tender lines and card slips must still post.
  { name: 'O2 cash tendered and change', text: `${OCEAN}Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00\nCash Tendered 1200.00\nChange 50.00`, payable: 1150, outcome: 'post' },
  { name: 'O3 card slip with its own Total', text: `${OCEAN}Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00\nCARD SLIP\nPurchase R1150.00\nTotal R1150.00`, payable: 1150, outcome: 'post' },
  { name: 'A1 tender only, no analysis', text: `${CHECKERS}${BASKET}Sub Total 223.00\nVAT 0.00\nTOTAL 223.00\nCASH 300.00\nCHANGE 77.00`, payable: 223, outcome: 'post' },

  // Round 9 review — credit notes in every spelling. None may post as a purchase.
  { name: 'C1 credit note, positive figures', text: `${CREDIT}Sub Total 100.00\nVAT 15% 15.00\nTotal 115.00`, payable: null, outcome: 'refuse' },
  { name: 'C2 credit note, spaced dash', text: `${CREDIT}Sub Total - 100.00\nVAT 15% - 15.00\nTotal - 115.00`, payable: null, outcome: 'refuse' },
  { name: 'C3 credit note, trailing minus', text: `${CREDIT}Sub Total 100.00-\nVAT 15% 15.00-\nTotal 115.00-`, payable: null, outcome: 'refuse' },
  { name: 'C4 credit note, parentheses', text: `${CREDIT}Sub Total (100.00)\nVAT 15% (15.00)\nTotal (115.00)`, payable: null, outcome: 'refuse' },
  { name: 'C5 credit note, -R115.00', text: `${CREDIT}Sub Total -R100.00\nVAT 15% -R15.00\nTotal -R115.00`, payable: null, outcome: 'refuse' },
  { name: 'C6 credit note, R -115.00', text: `${CREDIT}Sub Total R -100.00\nVAT 15% R -15.00\nTotal R -115.00`, payable: null, outcome: 'refuse' },
  { name: 'C7 credit note, glued minus', text: `${CREDIT}Sub Total -100.00\nVAT 15% -15.00\nTotal -115.00`, payable: null, outcome: 'refuse' },
  { name: 'C8 credit note, colon glued', text: `${CREDIT}Sub Total:-100.00\nVAT:-15.00\nTotal:-115.00`, payable: null, outcome: 'refuse' },
  { name: 'C9 credit note, en-dash', text: `${CREDIT}Sub Total –115.00\nVAT 15% –15.00\nTotal –115.00`, payable: null, outcome: 'refuse' },

  // Round 9 review — a dash glued to the figure.
  { name: 'D1 VAT-150.00 glued dash', text: `${OCEAN}Sub Total 1000.00\nVAT-150.00\nTotal Due 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'D2 every figure glued to a dash', text: `${OCEAN}Sub Total-1000.00\nVAT-150.00\nTotal-1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'D3 discount line below the net', text: `${OCEAN}Sub Total 1000.00\nDiscount -50.00\nVAT 142.50\nTotal 1092.50`, payable: 1092.5, outcome: 'refuse' },
  { name: 'D4 VAT:-150.00', text: `${OCEAN}Sub Total 1000.00\nVAT:-150.00\nTotal Due 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'D5 zero-rated, VAT-0.00', text: `${OCEAN}Sub Total 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'D6 zero-rated, VAT - 0.00', text: `${OCEAN}Sub Total 100.00\nVAT - 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'D7 zero-rated, VAT: 0.00', text: `${OCEAN}Sub Total 100.00\nVAT: 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E1 retail, VAT-150.00', text: `${CHECKERS}Widget 1 1000.00 1000.00\nSub Total 1000.00\nVAT-150.00\nTotal 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'E2 retail zero-rated, VAT-0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nSub Total 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E3 retail zero-rated, no subtotal, VAT-0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E4 retail zero-rated, VAT: 0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nSub Total 100.00\nVAT: 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },

  // Round 10 — constructed against this gate, in both directions.
  { name: 'X1 registration number glued to a dash', text: `Waltons Stationery\nVAT-4123456789\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00`, payable: 1150, outcome: 'post' },
  { name: 'X2 no VAT line at all (the builder would invent 15%)', text: `${WALTONS}Total 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'X3 a TOTAL column header (honest slip, refused)', text: 'Spar Rivonia\nDate: 2026-09-01\nReceipt No: 88001\nQTY ITEM TOTAL\n1 Bread 23.00\nSub Total 20.00\nVAT 3.00\nTotal 23.00', payable: 23, outcome: 'refuse' },
];
