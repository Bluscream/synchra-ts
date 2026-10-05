// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Size limits come from the project's coding rules: ~400 lines soft, 600 hard for a source file,
 * 100 for a function. ESLint covers both natively, so there is no separate test for them.
 *
 * `src/generated/` is exempt. Its length is a property of the API surface rather than of anyone's
 * judgement — splitting a 465-interface file or a 40-method resource class by line count would
 * scatter things that always change together — and nobody edits it by hand anyway.
 */
const GENERATED = ['src/generated/**'];

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'spec/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: false, skipComments: false }],
      'max-depth': ['error', 3],
      'max-params': ['error', 5],
      complexity: ['error', 15],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'prefer-const': 'error',

      // The rules the project's own conventions turn into hard errors rather than style notes.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // The wire format is snake_case and the generated types mirror it, so a naming-convention
      // rule would fight the API on every property. Shape is checked by the compiler instead.
      '@typescript-eslint/naming-convention': 'off',
    },
  },

  {
    files: GENERATED,
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
    },
  },

  {
    // The generator and the examples are scripts: they print, and they are the one place a bare
    // `console` is the right output channel.
    files: ['tools/**', 'examples/**'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
);
