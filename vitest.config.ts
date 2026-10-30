import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Components (.tsx) can be rendered in tests; the app's tsconfig keeps jsx: preserve for Next.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
