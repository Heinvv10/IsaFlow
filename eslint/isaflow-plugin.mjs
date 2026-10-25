/** Local ESLint plugin: IsaFlow-specific rules. Registered as `isaflow` in eslint.config.mjs. */
import { noRawFormInput } from './rules/no-raw-form-input.mjs';

export default {
  meta: { name: 'eslint-plugin-isaflow' },
  rules: { 'no-raw-form-input': noRawFormInput },
};
