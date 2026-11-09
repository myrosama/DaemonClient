import { defineConfig } from 'vitest/config';

export default defineConfig({
  // A string tsconfig stops Vite looking up the tsconfig.json beside each file.
  // relay-policy.test.ts imports from immich/web, whose tsconfig extends a file
  // only `svelte-kit sync` creates, so on CI that lookup failed the whole file.
  // These are the only options of this package's tsconfig that esbuild uses.
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { target: 'ES2022' } }) },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
