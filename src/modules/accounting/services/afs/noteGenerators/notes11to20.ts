// src/modules/accounting/services/afs/noteGenerators/notes11to20.ts
// Compatibility shim — actual code lives in notes11to15.ts and notes16to20.ts

export {
  generateNote11CashAndCashEquivalents,
  generateNote12ShareCapital,
  generateNote13Borrowings,
  generateNote14LeaseLiabilities,
  generateNote15Provisions,
} from './notes11to15';

export {
  generateNote16TradePayables,
  generateNote17IncomeTax,
  generateNote18RevenueDisaggregation,
  generateNote19OtherIncome,
  generateNote20OperatingExpenses,
} from './notes16to20';
