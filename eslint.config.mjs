import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/', '.next/', 'out/'],
  },

  // typescript-eslint: turn off core ESLint rules that TypeScript handles.
  tsPlugin.configs['flat/eslint-recommended'],

  // typescript-eslint recommended rules for .ts/.tsx files.
  ...tsPlugin.configs['flat/recommended'],

  // React (JSX-runtime mode — no need to import React in scope).
  pluginReact.configs.flat['jsx-runtime'],

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
      },
    },
    settings: {
      react: { version: 'detect' },
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
      'no-console': 'error',
      // These hooks rules surface false positives in Next.js patterns.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },

  // Files allowed to use console (logger internals).
  {
    files: ['src/lib/logger.ts', 'src/lib/api-error-handler.ts', 'src/lib/neon.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
