import base from '../../../vitest.integration.config';
// Selects only the baseline dump; the repository integration include never matches it.
export default {...base,test:{...base.test,include:['tests/integration/controls/snapshotFlagBaselineDump.ts'],testTimeout:120000}};
