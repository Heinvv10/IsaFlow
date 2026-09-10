/**
 * Every slip K-076 has been beaten by, rounds 5 to 14, in one place.
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
const OCEAN_100 = 'Ocean Basket Sandton\nTAX INVOICE\nDate: 2026-09-01\nInvoice No: 88123\nKids Hake 1 100.00 100.00\n';
const RECEIPT = (vendor: string, no: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: ${no}\n`;
const INVOICE = (vendor: string, no: string) => `${vendor}\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: ${no}\n`;
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
  // D5–D7 print OCEAN's R200.00 line item on a R100.00 slip, and since round 13
  // a figure larger than the total refuses. The D5b–D7b twins print a
  // consistent item and still pin that each VAT-0.00 spelling posts.
  { name: 'D5 zero-rated, VAT-0.00', text: `${OCEAN}Sub Total 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'refuse' },
  { name: 'D6 zero-rated, VAT - 0.00', text: `${OCEAN}Sub Total 100.00\nVAT - 0.00\nTotal 100.00`, payable: 100, outcome: 'refuse' },
  { name: 'D7 zero-rated, VAT: 0.00', text: `${OCEAN}Sub Total 100.00\nVAT: 0.00\nTotal 100.00`, payable: 100, outcome: 'refuse' },
  { name: 'D5b zero-rated, VAT-0.00', text: `${OCEAN_100}Sub Total 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'D6b zero-rated, VAT - 0.00', text: `${OCEAN_100}Sub Total 100.00\nVAT - 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'D7b zero-rated, VAT: 0.00', text: `${OCEAN_100}Sub Total 100.00\nVAT: 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E1 retail, VAT-150.00', text: `${CHECKERS}Widget 1 1000.00 1000.00\nSub Total 1000.00\nVAT-150.00\nTotal 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'E2 retail zero-rated, VAT-0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nSub Total 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E3 retail zero-rated, no subtotal, VAT-0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nVAT-0.00\nTotal 100.00`, payable: 100, outcome: 'post' },
  { name: 'E4 retail zero-rated, VAT: 0.00', text: `${CHECKERS}Maize Meal 1 100.00 100.00\nSub Total 100.00\nVAT: 0.00\nTotal 100.00`, payable: 100, outcome: 'post' },

  // Round 10 — constructed against this gate, in both directions.
  { name: 'X1 registration number glued to a dash', text: `Waltons Stationery\nVAT-4123456789\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00`, payable: 1150, outcome: 'post' },
  { name: 'X2 no VAT line at all (the builder would invent 15%)', text: `${WALTONS}Total 1150.00`, payable: 1150, outcome: 'refuse' },
  { name: 'X3 a TOTAL column header (honest slip, refused)', text: 'Spar Rivonia\nDate: 2026-09-01\nReceipt No: 88001\nQTY ITEM TOTAL\n1 Bread 23.00\nSub Total 20.00\nVAT 3.00\nTotal 23.00', payable: 23, outcome: 'refuse' },

  // Round 10 review — the payable printed under a SECOND total label.
  //
  // Every row above came from a previous reviewer, so none of them printed its
  // payable under a label other than `Total`, and the whole class passed the
  // corpus silently: `extractTotalCandidates` returned on the first productive
  // pattern, so `Amount Due` and `Amount Incl VAT` — labels the vocabulary has
  // always known — were never even consulted once a plain `Total` had matched.
  // Measured, each of these posted R230.00 against its printed payable.
  ...([
    ['Amount Due', 253], ['Balance Due', 253], ['Amount Payable', 253],
    ['Amount Incl VAT', 253], ['Grand Total', 253], ['TOTAAL', 253],
    ['TO PAY', 253], ['TE BETAAL', 253], ['Balance', 253], ['TTL', 253],
    ['NETT PAYABLE', 253],
  ] as Array<[string, number]>).map(([label, payable]): Slip => ({
    name: `U "${label}" below a plain Total`,
    text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\n${label} 253.00`,
    payable, outcome: 'refuse',
  })),
  { name: 'U AMOUNT DUE above a VAT-analysis block', text: `${CHECKERS}${BASKET}AMOUNT DUE 253.00\nCASH 300.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'U Payable below a delivery line', text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nDelivery 57.50\nPayable 287.50`, payable: 287.5, outcome: 'refuse' },

  // Round 10 review — ORDINARY receipts, in the proportion a real till roll
  // prints them. A corpus of nothing but counter-examples cannot show an
  // over-refusal, and the rows above only ever move a slip towards one.
  { name: 'N1 Woolworths, VAT under a label the reader cannot read', text: 'Woolworths Sandton City\nTAX INVOICE\nVAT Reg 4930118273\nDate: 2026-09-01\nSlip 004512\nMilk 2L 1 32.99 32.99\nChicken Breasts 1 109.99 109.99\nTOTAL 142.98\nVAT INCLUDED 18.65\nCARD 142.98', payable: 142.98, outcome: 'refuse' },
  { name: 'N2 Engen fuel', text: 'Engen Rivonia\nTAX INVOICE\nVAT No 4001234567\nDate: 2026-09-01\nUnleaded 95 45.00L 22.50 1012.50\nSub Total 880.43\nVAT 132.07\nTotal 1012.50\nCARD 1012.50', payable: 1012.5, outcome: 'refuse' },
  { name: 'N3 Uber trip', text: 'Uber SA\nTAX INVOICE\nDate: 2026-09-01\nTrip 1 120.00 120.00\nSub Total 104.35\nVAT 15.65\nTotal 120.00', payable: 120, outcome: 'post' },
  { name: 'N4 Mugg and Bean', text: 'Mugg and Bean Fourways\nTAX INVOICE\nDate: 2026-09-01\nBottomless Coffee 2 39.00 78.00\nSub Total 67.83\nVAT 15% 10.17\nTotal 78.00', payable: 78, outcome: 'post' },
  { name: 'N5 Spar with cash and change', text: 'Spar Rivonia\nTAX INVOICE\nVAT No 4111222333\nDate: 2026-09-01\nBread 1 23.00 23.00\nSub Total 20.00\nVAT 3.00\nTOTAL 23.00\nCASH 50.00\nCHANGE 27.00', payable: 23, outcome: 'post' },
  { name: 'N6 Takealot, description-first column header', text: 'Takealot\nTAX INVOICE\nDate: 2026-09-01\nDescription Qty Unit Price Total\nUSB Cable 1 149.00 149.00\nSub Total 129.57\nVAT 19.43\nTotal 149.00', payable: 149, outcome: 'post' },
  { name: 'N7 Pick n Pay zero-rated basket', text: 'Pick n Pay Bryanston\nTAX INVOICE\nVAT No 4123456780\nDate: 2026-09-01\nMaize Meal 1 89.99 89.99\nTOTAL 89.99\nVAT 0.00', payable: 89.99, outcome: 'refuse' },
  { name: 'N8 Builders Warehouse', text: 'Builders Warehouse\nTAX INVOICE\nVAT No 4055667788\nDate: 2026-09-01\nCement 5 89.00 445.00\nSub Total 386.96\nVAT 15% 58.04\nTotal Due 445.00', payable: 445, outcome: 'post' },

  // Round 13 — the payable under a label NO vocabulary knows. The gate now
  // measures amounts, not labels: a figure larger than the total refuses,
  // unless a tender and the change printed after it net to the total.
  ...([
    'AMT DUE', 'BAL DUE', 'TOT DUE', 'Please Pay', 'Payment Due', 'Outstanding',
    'Balance Outstanding', 'Verskuldig', 'Te Betale', 'Card Amount', 'SALE',
    'Amount Paid', 'ZAR', 'PURCHASE',
  ]).map((label): Slip => ({
    name: `L "${label}" below a plain Total`,
    text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\n${label} 253.00`,
    payable: 253, outcome: 'refuse',
  })),
  { name: 'L tip, then the card for total + tip', text: `${OCEAN}Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nTip 23.00\nCARD 253.00`, payable: 253, outcome: 'refuse' },
  { name: 'L unknown label ABOVE a VAT-analysis block', text: `${RECEIPT('Checkers Fourways', '100301')}Chicken 200.00\nBread 23.00\nSALE 253.00\nCARD 253.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'L cash that nets to the payable, not the total read', text: `${RECEIPT('Checkers Fourways', '100302')}Chicken 200.00\nBread 23.00\nSALE 253.00\nCASH 300.00\nCHANGE 47.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00`, payable: 253, outcome: 'refuse' },
  { name: 'L space-grouped payable', text: `${WALTONS}Sub Total 1 000.00\nVAT 150.00\nTotal 1 150.00\nGratuity 115.00\nPlease Pay 1 265.00`, payable: 1265, outcome: 'refuse' },

  // Round 13 — tender and change, in both directions.
  { name: 'T cash and change net to the total', text: `${RECEIPT('Spar Rivonia', '100311')}Braai Pack 1 253.00 253.00\nSub Total 220.00\nVAT 33.00\nTOTAL 253.00\nCASH 300.00\nCHANGE 47.00`, payable: 253, outcome: 'post' },
  { name: 'T change larger than the total', text: `${RECEIPT('Spar Rivonia', '100312')}Bread 1 23.00 23.00\nSub Total 20.00\nVAT 3.00\nTOTAL 23.00\nCASH 200.00\nCHANGE 177.00`, payable: 23, outcome: 'post' },
  { name: 'T tender with no change line', text: `${RECEIPT('Spar Rivonia', '100313')}Braai Pack 1 253.00 253.00\nSub Total 220.00\nVAT 33.00\nTOTAL 253.00\nCASH 300.00`, payable: 253, outcome: 'refuse' },
  { name: 'T change that does not net', text: `${RECEIPT('Spar Rivonia', '100314')}Braai Pack 1 253.00 253.00\nSub Total 220.00\nVAT 33.00\nTOTAL 253.00\nCASH 300.00\nCHANGE 40.00`, payable: 253, outcome: 'refuse' },

  // Round 13 — the round-12 vocabulary's regressions: a paid invoice, a zero
  // balance and a loyalty balance must not become the payable.
  { name: 'P1 paid invoice, Balance Due 0.00', text: `${WALTONS}Sub Total 1000.00\nVAT 150.00\nTotal 1150.00\nAmount Paid 1150.00\nBalance Due 0.00`, payable: 1150, outcome: 'post' },
  { name: 'P2 till slip ending BALANCE 0.00', text: `${RECEIPT('Spar Rivonia', '100321')}Bread 1 23.00 23.00\nSub Total 20.00\nVAT 3.00\nTOTAL 23.00\nCARD 23.00\nBALANCE 0.00`, payable: 23, outcome: 'post' },
  { name: 'P3 balance brought forward above the invoice', text: `${WALTONS}Balance 500.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00`, payable: 1150, outcome: 'post' },
  { name: 'P4 Smart Shopper Balance larger than the total', text: `${RECEIPT('Pick n Pay Norwood', '100322')}Bread 1 23.00 23.00\nSub Total 20.00\nVAT 3.00\nTOTAL 23.00\nCARD 23.00\nSmart Shopper Balance 45.00`, payable: 23, outcome: 'refuse' },

  // Round 13 — what measuring amounts costs honest slips, pinned so the cost
  // stays visible: a promotion making one item dearer than the slip, a
  // two-column item row whose quantity reads as a thousands group, and a
  // "you saved" figure larger than the total. Each refuses; none posts wrong.
  { name: 'Z promotion, item dearer than the slip', text: `${RECEIPT('Checkers Fourways', '100331')}Kettle 120.00\nPromo -30.00\nSub Total 78.26\nVAT 11.74\nTOTAL 90.00\nCARD 90.00`, payable: 90, outcome: 'refuse' },
  { name: 'Z two-column item, quantity 1 and a 3-digit price', text: `${RECEIPT('Checkers Fourways', '100332')}Chicken Braai Pack 1 200.00\nSub Total 173.91\nVAT 26.09\nTOTAL 200.00\nCARD 200.00`, payable: 200, outcome: 'refuse' },
  { name: 'Z savings larger than the total', text: `${RECEIPT('Clicks Sandton', '100333')}Perfume 1 69.98 69.98\nSub Total 60.85\nVAT 9.13\nTOTAL 69.98\nCARD 69.98\nYou saved R80.00`, payable: 69.98, outcome: 'refuse' },
  { name: 'Z invoice with a line discount', text: `${INVOICE('Acme Supplies', 'AC9002')}Widget 1 1200.00 1200.00\nDiscount -200.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00`, payable: 1150, outcome: 'refuse' },

  // Round 13 — ORDINARY receipts and invoices, so the corpus is mostly what a
  // real till roll and an AP inbox actually contain.
  { name: 'R1 Checkers card', text: `${RECEIPT('Checkers Fourways', '100201')}Chicken Braai Pack 1 129.99 129.99\nWhite Bread 1 23.00 23.00\nMilk 2L 1 47.01 47.01\nSub Total 173.91\nVAT 15% 26.09\nTOTAL 200.00\nCARD 200.00`, payable: 200, outcome: 'post' },
  { name: 'R2 Woolworths Food, cash and change', text: `${RECEIPT('Woolworths Food Rosebank', '100202')}Salad 1 54.99 54.99\nJuice 1 32.99 32.99\nSub Total 76.50\nVAT 15% 11.48\nTOTAL 87.98\nCASH 100.00\nCHANGE 12.02`, payable: 87.98, outcome: 'post' },
  { name: 'R3 Clicks, points and savings', text: `${RECEIPT('Clicks Sandton', '100203')}Panado 24s 1 39.99 39.99\nToothpaste 1 29.99 29.99\nSub Total 60.84\nVAT 15% 9.14\nTOTAL 69.98\nCARD 69.98\nClubCard Points Earned 7\nYou saved R5.00`, payable: 69.98, outcome: 'post' },
  { name: 'R4 Dis-Chem', text: `${RECEIPT('Dis-Chem Bryanston', '100204')}Vitamin C 1 119.95 119.95\nSub Total 104.30\nVAT 15.65\nTotal 119.95\nCARD 119.95`, payable: 119.95, outcome: 'post' },
  { name: 'R5 Shell fuel', text: `${RECEIPT('Shell Rivonia', '100205')}Unleaded 95 40.00L 22.90 916.00\nSub Total 796.52\nVAT 119.48\nTotal 916.00\nCARD 916.00`, payable: 916, outcome: 'post' },
  { name: 'R6 Nandos, card, no tip', text: `${RECEIPT('Nandos Fourways', '100206')}Quarter Chicken 2 89.90 179.80\nCoke 2 24.90 49.80\nSub Total 199.65\nVAT 15% 29.95\nTotal 229.60\nCARD 229.60`, payable: 229.6, outcome: 'post' },
  { name: 'R7 Vida e Caffe', text: `${RECEIPT('Vida e Caffe', '100207')}Americano 1 34.00 34.00\nSub Total 29.57\nVAT 4.43\nTotal 34.00\nCARD 34.00`, payable: 34, outcome: 'post' },
  { name: 'R8 Makro, invoice layout', text: `${RECEIPT('Makro Woodmead', '100208')}Printer Paper 5 89.99 449.95\nToner 1 1199.00 1199.00\nSub Total 1433.87\nVAT 15% 215.08\nTotal 1648.95\nCARD 1648.95`, payable: 1648.95, outcome: 'post' },
  { name: 'R9 Incredible, space-grouped thousands', text: `${RECEIPT('Incredible Connection', '100209')}Mouse 1 1 499.00\nSub Total 1 303.48\nVAT 195.52\nTotal Due 1 499.00\nCARD 1 499.00`, payable: 1499, outcome: 'post' },
  { name: 'R10 Telkom invoice, Amount Due only', text: 'Telkom SA\nTAX INVOICE\nVAT No 4010105461\nDate: 2026-09-01\nInvoice No: TK88123\nFibre 100Mbps 1 999.00 999.00\nSub Total 868.70\nVAT 130.30\nAmount Due 999.00', payable: 999, outcome: 'post' },
  { name: 'R11 Office National, remittance slip', text: 'Office National\nTAX INVOICE\nVAT No 4020304050\nDate: 2026-09-01\nInvoice No: ON5512\nStaples 10 12.50 125.00\nSub Total 108.70\nVAT 16.30\nTotal 125.00\nREMITTANCE ADVICE\nAmount Due 125.00', payable: 125, outcome: 'post' },
  { name: 'R12 Pick n Pay, Smart Shopper points', text: `${RECEIPT('Pick n Pay Norwood', '100212')}Eggs 18s 1 64.99 64.99\nSub Total 56.51\nVAT 8.48\nTOTAL 64.99\nCARD 64.99\nSmart Shopper Points 64`, payable: 64.99, outcome: 'post' },
  { name: 'R13 Spar zero-rated, cash and change', text: `${RECEIPT('Spar Parkhurst', '100213')}Brown Bread 1 18.99 18.99\nSub Total 18.99\nVAT 0.00\nTOTAL 18.99\nCASH 20.00\nCHANGE 1.01`, payable: 18.99, outcome: 'post' },
  { name: 'R14 Uber Eats', text: 'Uber Eats\nTAX INVOICE\nDate: 2026-09-01\nInvoice No: UE77123\nBurger 1 95.00 95.00\nSub Total 82.61\nVAT 12.39\nTotal 95.00', payable: 95, outcome: 'post' },
  { name: 'R15 Bolt trip', text: 'Bolt\nTAX INVOICE\nDate: 2026-09-01\nInvoice No: BT55123\nTrip 1 86.00 86.00\nSub Total 74.78\nVAT 11.22\nTotal 86.00', payable: 86, outcome: 'post' },
  { name: 'R16 Protea Hotel', text: 'Protea Hotel Midrand\nTAX INVOICE\nVAT No 4050607080\nDate: 2026-09-01\nInvoice No: PH9912\nAccommodation 1 1450.00 1450.00\nSub Total 1260.87\nVAT 189.13\nTotal 1450.00\nCARD 1450.00', payable: 1450, outcome: 'post' },
  { name: 'R17 restaurant, tip line zero', text: `${RECEIPT('Ocean Basket Menlyn', '100217')}Hake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nTip 0.00\nCARD 230.00`, payable: 230, outcome: 'post' },
  { name: 'R18 Game', text: `${RECEIPT('Game Fourways', '100218')}Kettle 1 299.00 299.00\nSub Total 260.00\nVAT 39.00\nTotal 299.00\nCARD 299.00`, payable: 299, outcome: 'post' },
  { name: 'R19 comma decimals', text: `${RECEIPT('Checkers Hyper', '100219')}Coffee 1 89,99 89,99\nSub Total 78,25\nVAT 11,74\nTOTAL 89,99\nCARD 89,99`, payable: 89.99, outcome: 'post' },
  { name: 'R20 TOTAL (VAT INCL), no net printed', text: `${RECEIPT('Spar Rivonia', '100220')}Bread 1 23.00 23.00\nMilk 1 22.00 22.00\nVAT 5.87\nTOTAL (VAT INCL) 45.00\nCARD 45.00`, payable: 45, outcome: 'post' },
  { name: 'R21 Amount Excl / Incl VAT invoice', text: `${INVOICE('Rentokil', 'RK1001')}Pest Control 1 575.00 575.00\nAmount Excl VAT 500.00\nVAT 75.00\nAmount Incl VAT 575.00`, payable: 575, outcome: 'post' },
  { name: 'R22 VAT @ 15%', text: `${RECEIPT('Mr Price Home', '100222')}Cushion 2 99.99 199.98\nSub Total 173.90\nVAT @ 15% 26.08\nTotal 199.98\nCARD 199.98`, payable: 199.98, outcome: 'post' },
  { name: 'R23 toll plaza', text: `${RECEIPT('SANRAL Toll Plaza', '100223')}Class 1 1 45.00 45.00\nSub Total 39.13\nVAT 5.87\nTotal 45.00\nCARD 45.00`, payable: 45, outcome: 'post' },
  { name: 'R24 parking, cash and change', text: `${RECEIPT('Sandton City Parking', '100224')}Parking 3h 1 30.00 30.00\nSub Total 26.09\nVAT 3.91\nTotal 30.00\nCASH 50.00\nCHANGE 20.00`, payable: 30, outcome: 'post' },
  { name: 'R25 Takealot with a delivery line', text: `${INVOICE('Takealot', 'TA771')}Headphones 1 499.00 499.00\nDelivery 1 60.00 60.00\nSub Total 486.09\nVAT 72.91\nTotal 559.00`, payable: 559, outcome: 'post' },
  { name: 'R26 Vodacom invoice with a due date', text: `${INVOICE('Vodacom', 'VC5512')}Contract 1 449.00 449.00\nSub Total 390.43\nVAT 58.57\nTotal Due 449.00\nPayment due by 2026-09-15`, payable: 449, outcome: 'post' },
  { name: 'R27 supplier invoice with bank details', text: `${INVOICE('Acme Supplies', 'AC9001')}Widgets 10 100.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00\nBank: FNB Acc 62123456789 Branch 250655`, payable: 1150, outcome: 'post' },
  // Refuses on the pre-existing reconciliation rule (net + VAT is 38.00 of
  // 43.00), not on round 13: a tip inside the total is not in the net.
  { name: 'R28 coffee, tip included in the total', text: `${RECEIPT('Seattle Coffee', '100228')}Latte 1 38.00 38.00\nSub Total 33.04\nVAT 4.96\nTip 5.00\nTotal 43.00\nCARD 43.00`, payable: 43, outcome: 'refuse' },
  { name: 'R29 Engen, litres printed', text: `${RECEIPT('Engen Sunninghill', '100229')}Diesel 50 Litres 23.10 1155.00\nSub Total 1004.35\nVAT 150.65\nTotal 1155.00\nCARD 1155.00`, payable: 1155, outcome: 'post' },
  { name: 'R30 Clicks, two items', text: `${RECEIPT('Clicks Rosebank', '100230')}Shampoo 1 59.99 59.99\nSoap 3 12.99 38.97\nSub Total 86.05\nVAT 12.91\nTOTAL 98.96\nCARD 98.96`, payable: 98.96, outcome: 'post' },
  { name: 'R31 Pick n Pay, card', text: `${RECEIPT('Pick n Pay Hyde Park', '100231')}Coffee 1 79.99 79.99\nSub Total 69.56\nVAT 10.43\nTOTAL 79.99\nCARD 79.99`, payable: 79.99, outcome: 'post' },
  { name: 'R32 Builders invoice, two lines', text: `${INVOICE('Builders Warehouse', 'BW3001')}Paint 20L 2 899.00 1798.00\nRollers 3 49.00 147.00\nSub Total 1691.30\nVAT 15% 253.70\nTotal Due 1945.00`, payable: 1945, outcome: 'post' },
  { name: 'R33 accountant invoice', text: `${INVOICE('Smith & Co Accountants', 'SC2026-09')}Monthly bookkeeping 1 2500.00 2500.00\nSub Total 2500.00\nVAT 375.00\nTotal 2875.00`, payable: 2875, outcome: 'post' },
  { name: 'R34 Wimpy, Cash Tendered and Change Due', text: `${RECEIPT('Wimpy Fourways', '100234')}Breakfast 1 89.90 89.90\nSub Total 78.17\nVAT 11.73\nTotal 89.90\nCash Tendered 100.00\nChange Due 10.10`, payable: 89.9, outcome: 'post' },

  // Round 14 — refunds, returns and Afrikaans credit notes (review r13). Ten
  // of the fourteen posted or were approved as a purchase at 14e979376; none
  // may now, on any path.
  { name: "F1 TOTAL REFUND positive", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle -499.00\nVAT 15% 65.09\nTOTAL -499.00\nTOTAL REFUND 499.00", payable: null, outcome: 'refuse' },
  { name: "F2 Refund Total positive", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle -499.00\nVAT 15% 65.09\nTOTAL -499.00\nRefund Total 499.00", payable: null, outcome: 'refuse' },
  { name: "F3 neg VAT, Refund Total pos", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle -499.00\nVAT 15% -65.09\nTOTAL -499.00\nRefund Total 499.00", payable: null, outcome: 'refuse' },
  { name: "F4 Amount Payable pos (refund payable to customer)", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nRETURN\nKettle -499.00\nSub Total -433.91\nVAT 15% 65.09\nTOTAL -499.00\nAmount Payable 499.00", payable: null, outcome: 'refuse' },
  { name: "F5 Return Total pos, TOTAL neg, VAT pos analysis", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nRETURNS\nKettle -499.00\nTOTAL -499.00\nVISA -499.00\nVAT ANALYSIS\nExcl VAT 433.91\nVAT 65.09\nReturns Total 499.00", payable: null, outcome: 'refuse' },
  { name: "F6 exchange neg total + Goods Total pos", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nEXCHANGE\nGoods Total 614.00\nReturned -1113.00\nVAT 15% 65.09\nTOTAL -499.00", payable: null, outcome: 'refuse' },
  { name: "F7 TOTAL neg with Amount Due 0.00", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle -499.00\nVAT 15% 65.09\nTOTAL -499.00\nAmount Due 0.00", payable: null, outcome: 'refuse' },
  { name: "F8 Kredietnota VAT label", text: "Acme Voorrade\nKREDIETNOTA\nDatum: 2026-09-01\nSub Totaal 100.00\nVAT 15% 15.00\nTotaal 115.00", payable: null, outcome: 'refuse' },
  { name: "F9 refund trailing minus, VAT incl", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle 499.00-\nTOTAL 499.00-\nVISA REFUND 499.00-\nVAT 15% 65.09-", payable: null, outcome: 'refuse' },
  { name: "F10 RETURN slip positive", text: "GAME Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nRETURN SLIP\nKettle 499.00\nSub Total 433.91\nVAT 15% 65.09\nTOTAL 499.00\nREFUNDED TO CARD 499.00", payable: null, outcome: 'refuse' },
  { name: "F11 REFUND slip positive (no CREDIT NOTE)", text: "CHECKERS\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle 115.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD REFUND 115.00", payable: null, outcome: 'refuse' },
  { name: "F12 REFUND trailing minus", text: "CHECKERS\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nREFUND\nKettle 115.00-\nVAT 15% 15.00-\nTOTAL 115.00-", payable: null, outcome: 'refuse' },
  { name: "F13 Kredietnota positive", text: "Acme Voorrade\nKREDIETNOTA\nDatum: 2026-09-01\nSub Totaal 100.00\nBTW 15% 15.00\nTotaal 115.00", payable: null, outcome: 'refuse' },
  { name: "F14 returns total positive + TOTAL negative", text: "GAME\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\nRETURNS\nReturns Total 499.00\nVAT 65.09\nTOTAL -499.00", payable: null, outcome: 'refuse' },

  // Round 14 — a charge or deduction around the total that the round-13 rule
  // explained away or never saw: a `Chg` read as change, a tip under a split
  // tender, a card "tender" with change, a discount after the total, and a
  // payable whose cents OCR dropped. Each posted or approved a wrong figure at
  // 14e979376.
  { name: "M1 payable then \"incl Svc Chg\" same line", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nPlease Pay 253.00 incl Svc Chg 23.00", payable: 253, outcome: 'refuse' },
  { name: "M2 payable then Service Chg next line", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nPlease Pay 253.00\nIncl. Service Chg 23.00", payable: 253, outcome: 'refuse' },
  { name: "M3 CARD then Svc Chg included", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nCARD 253.00\nSvc Chg incl 23.00", payable: 253, outcome: 'refuse' },
  { name: "M4 CARD then Tip (mislabelled Change)", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nCARD 253.00\nChange 23.00", payable: 253, outcome: 'refuse' },
  { name: "M5 tip from cash change", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nCASH 300.00\nCHANGE 70.00\nTip 23.00", payable: 253, outcome: 'refuse' },
  { name: "M6 split tender with tip, no grand total", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nTip 23.00\nVISA 126.50\nMASTERCARD 126.50", payable: 253, outcome: 'refuse' },
  { name: "M7 split card+cash with tip", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nTip 23.00\nCARD 200.00\nCASH 100.00\nCHANGE 47.00", payable: 253, outcome: 'refuse' },
  { name: "M8 delivery, split tender, no grand total", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nDelivery 57.50\nCARD 150.00\nCASH 150.00\nCHANGE 12.50", payable: 287.5, outcome: 'refuse' },
  { name: "M9 discount after VAT total, card less", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 220.00\nVAT 15% 33.00\nTotal 253.00\nStaff Discount -23.00\nCARD 230.00", payable: 230, outcome: 'refuse' },
  { name: "M10 all integers, unknown payable", text: "Ocean Basket Sandton\nTAX INVOICE\nDate: 2026-09-01\nHake and Chips 1 200\nSub Total 200\nVAT 15% 30\nTotal 230\nGratuity 23\nAMT DUE 253", payable: 253, outcome: 'refuse' },
  { name: "M11 cents on total, payable integer", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23\nAMT DUE 253", payable: 253, outcome: 'refuse' },
  { name: "M12 payable decimal dropped by OCR (space)", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\nAMT DUE 253 00", payable: 253, outcome: 'refuse' },
  { name: "M13 payable decimal as letter O", text: "Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\nHake and Chips 1 200.00 200.00\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\nAMT DUE 253.OO", payable: 253, outcome: 'refuse' },
  { name: "M14 space-grouped payable mid-line + tip", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 000.00\nSub Total 1 000.00\nVAT 15% 150.00\nTotal 1 150.00\nPlease Pay 1 265.00 Tip 115.00", payable: 1265, outcome: 'refuse' },
  { name: "M15 space-grouped payable + ZAR suffix", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 000.00\nSub Total 1 000.00\nVAT 15% 150.00\nTotal 1 150.00\nGratuity 115.00\nPlease Pay 1 265.00 ZAR", payable: 1265, outcome: 'refuse' },
  { name: "M16 space-grouped payable + tax flag", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 000.00\nSub Total 1 000.00\nVAT 15% 150.00\nTotal 1 150.00\nDelivery 115.00\nAMT DUE 1 265.00 *", payable: 1265, outcome: 'refuse' },
  { name: "M17 space-grouped payable R prefix mid", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 000.00\nSub Total 1 000.00\nVAT 15% 150.00\nTotal 1 150.00\nDelivery 115.00\nAMT DUE R1 265.00 (incl)", payable: 1265, outcome: 'refuse' },
  { name: "M18 comma decimal space-grouped mid", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 000.00\nSub Total 1 000,00\nVAT 15% 150,00\nTotal 1 150,00\nDelivery 115,00\nAMT DUE 1 265,00 ZAR", payable: 1265, outcome: 'refuse' },

  // Round 14 — the credit and charge words inside an ORDINARY purchase: an item,
  // a card type, a refund-policy footer, a delivery-note number. All post.
  { name: "V1 Credit card surcharge item", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\nCredit card surcharge 1 15.00 15.00\nSub Total 1015.00\nVAT 152.25\nTotal 1167.25", payable: 1167.25, outcome: 'post' },
  { name: "V2 VISA CREDIT tender", text: "Checkers Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 100401\nBread 1 23.00 23.00\nSub Total 20.00\nVAT 3.00\nTOTAL 23.00\nVISA CREDIT 23.00", payable: 23, outcome: 'post' },
  { name: "V3 NO REFUND WITHOUT SLIP footer", text: "Game Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 100402\nKettle 1 299.00 299.00\nSub Total 260.00\nVAT 39.00\nTotal 299.00\nCARD 299.00\nNO REFUND WITHOUT SLIP", payable: 299, outcome: 'post' },
  { name: "V4 Refund policy footer", text: "Game Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 100403\nKettle 1 299.00 299.00\nSub Total 260.00\nVAT 39.00\nTotal 299.00\nCARD 299.00\nRefunds within 30 days with slip", payable: 299, outcome: 'post' },
  { name: "V5 card slip account type CREDIT line", text: "Game Fourways\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 100404\nKettle 1 299.00 299.00\nSub Total 260.00\nVAT 39.00\nTotal 299.00\nCARD 299.00\nAcc Type: CREDIT", payable: 299, outcome: 'post' },
  { name: "V7 Delivery note number footer", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00\nDelivery Note No: DN4471", payable: 1150, outcome: 'post' },
  { name: "V8 Delivery address footer", text: "Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\nCopy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00\nDelivery address 12 Main Road", payable: 1150, outcome: 'post' },
];
