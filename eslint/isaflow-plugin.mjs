/** Local ESLint plugin: IsaFlow-specific rules. Registered as `isaflow` in eslint.config.mjs. */
import { noRawFormInput } from './rules/no-raw-form-input.mjs';
import { noUnnamedControl } from './rules/no-unnamed-control.mjs';

export default {
  meta: { name: 'eslint-plugin-isaflow' },
  rules: { 'no-raw-form-input': noRawFormInput, 'no-unnamed-control': noUnnamedControl },
};
