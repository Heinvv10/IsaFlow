import base from '../../../vitest.integration.config';
// Selects only the baseline seed; the repository integration include never matches it.
export default {...base,test:{...base.test,include:['tests/integration/controls/intentReceiptLegacySeed.ts'],testTimeout:300000}};
