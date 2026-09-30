import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // gateway (more specific first)
      {
        find: /^@octopi-agent\/gateway\/(.*)\.js$/,
        replacement: resolve(root, 'packages/gateway/src') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/gateway$/,
        replacement: resolve(root, 'packages/gateway/src/index.ts'),
      },
      // engine (more specific first)
      {
        find: /^@octopi-agent\/engine\/harness\/(.*)\.js$/,
        replacement: resolve(root, 'packages/engine/src/harness') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/engine\/integration\/(.*)\.js$/,
        replacement: resolve(root, 'packages/engine/src/integration') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/engine\/config-schema\/(.*)\.js$/,
        replacement: resolve(root, 'packages/engine/src/config-schema') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/engine\/(.*)\.js$/,
        replacement: resolve(root, 'packages/engine/src') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/engine$/,
        replacement: resolve(root, 'packages/engine/src/index.ts'),
      },
      // core
      {
        find: /^@octopi-agent\/core\/loop\/(.*)\.js$/,
        replacement: resolve(root, 'packages/core/src/loop') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/core\/loop$/,
        replacement: resolve(root, 'packages/core/src/loop/index.ts'),
      },
      {
        find: /^@octopi-agent\/core\/(.*)\.js$/,
        replacement: resolve(root, 'packages/core/src/core') + '/$1.ts',
      },
      {
        find: /^@octopi-agent\/core$/,
        replacement: resolve(root, 'packages/core/src/core/index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
