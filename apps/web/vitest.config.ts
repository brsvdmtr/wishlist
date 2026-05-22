import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['app/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
    passWithNoTests: true,
    setupFiles: ['./test/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['app/**/*.{ts,tsx}'],
      exclude: [
        'app/**/*.test.{ts,tsx}',
        'app/**/*.d.ts',
        'app/**/layout.tsx',
        'app/**/page.tsx',
      ],
    },
  },
  resolve: {
    alias: {
      // Match tsconfig: `@/*` resolves from the apps/web root, not app/.
      '@/': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
