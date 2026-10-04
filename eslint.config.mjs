import { FlatCompat } from '@eslint/eslintrc';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// FlatCompat bridges eslint-plugin-react@7.x which still uses the legacy
// context.getFilename() API removed in ESLint 10. When the plugin ships
// proper ESLint 10 support this can be replaced with the native flat config.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  {
    ignores: ['node_modules/', '.next/', 'out/'],
  },

  // typescript-eslint: turn off core ESLint rules that TypeScript handles.
  tsPlugin.configs['flat/eslint-recommended'],

  // typescript-eslint recommended rules for .ts/.tsx files.
  ...tsPlugin.configs['flat/recommended'],

  // React recommended + jsx-runtime via legacy compat bridge.
  ...compat.extends('plugin:react/recommended', 'plugin:react/jsx-runtime'),

  // React Hooks — manually registered for flat config compat.
  {
    plugins: { 'react-hooks': pluginReactHooks },
    rules: pluginReactHooks.configs.recommended.rules,
  },

  // Project-wide overrides.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        // Type-aware linting for no-floating-promises (A–Z P3.3 — the June
        // audit's single highest-leverage guardrail: an unawaited promise in
        // an API route or effect fails silently in production).
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    settings: {
      // Hardcoded to avoid version.js calling context.getFilename() as a
      // fallback — that API was removed in ESLint 10. Update when React is bumped.
      react: { version: '19' },
    },
    rules: {
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
      // A–Z P3.3: unawaited promises fail silently in production (the June
      // audit's top guardrail). `void promise` is the explicit opt-out for
      // genuine fire-and-forget — it must be a visible, deliberate choice.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      'no-console': 'error',
      // These hooks rules surface false positives in Next.js patterns.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },

  // R-183: paystackClient.ts is the only entry point to the Paystack client. Its parts are
  // internal, and a vi.mock of the barrel only intercepts callers that import the barrel.
  // Flat config REPLACES rule options (it does not merge them): any future no-restricted-imports
  // or no-restricted-syntax entry for these files must be merged into this block. tests/ and
  // scripts/ are not covered by `bun run lint`.
  // Known harmless gap: `typeof import('…paystackHttp')` (a type query) is not caught,
  // nor is `require('…paystackHttp')` (it needs a deliberate no-require-imports disable first).
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/paystackHttp', '**/paystackTransactions', '**/paystackSubscriptions',
            '**/paystackHttp.*', '**/paystackTransactions.*', '**/paystackSubscriptions.*',
          ],
          message: "Import from '@/modules/billing/services/paystackClient' (R-183): the parts are internal to the Paystack client.",
        }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/paystack(Http|Transactions|Subscriptions)/]',
        message: "Import from '@/modules/billing/services/paystackClient' (R-183): the parts are internal to the Paystack client.",
      }, {
        selector: 'ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=/paystack(Http|Transactions|Subscriptions)/]',
        message: "Import from '@/modules/billing/services/paystackClient' (R-183): the parts are internal to the Paystack client.",
      }],
    },
  },
  {
    files: ['src/modules/billing/services/paystack{Client,Http,Transactions,Subscriptions}.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },

  // Files allowed to use console (logger internals).
  {
    files: ['src/lib/logger.ts', 'src/lib/api-error-handler.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
