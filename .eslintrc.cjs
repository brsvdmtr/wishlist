/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  settings: {
    next: {
      rootDir: ['apps/web/'],
    },
  },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/out/**',
    '**/coverage/**',
    '**/.turbo/**',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  overrides: [
    {
      files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
      extends: ['next/core-web-vitals'],
    },
    {
      files: ['apps/api/**/*.{ts,js}', 'apps/bot/**/*.{ts,js}', 'packages/**/*.{ts,js}'],
      env: { node: true },
    },
  ],
};
