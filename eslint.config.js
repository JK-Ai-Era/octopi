import tseslint from 'typescript-eslint';

/**
 * Architecture boundary rules:
 * - Core (packages/core) must not import Harness / Integration / Loop / CLI / subsystems
 * - Loop (packages/core) must not import Harness / Integration
 * - Harness (packages/engine) must not import Integration / gateway / cli / web
 *
 * Dependency direction: Integration → Harness → Loop → Core.
 * Mirrored by tests/architecture/boundaries.test.ts.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**', 'packages/*/dist/**', 'packages/webui/**'],
  },
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // 注册规则以便 eslint-disable 生效；默认不强制（测试/mock 允许 any）
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['packages/core/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/harness/**', '../harness/**', '../../harness/**', '@octopi-agent/engine/**'],
              message:
                'Core (Layer 1) must not import Harness. Move the contract into Core or invert the dependency.',
            },
            {
              group: ['**/integration/**', '../integration/**', '../../integration/**'],
              message: 'Core (Layer 1) must not import Integration.',
            },
            {
              group: ['**/loop/**', '../loop/**', '../../loop/**'],
              message: 'Core (Layer 1) must not import Loop. Loop depends on Core, not the reverse.',
            },
            {
              group: ['**/cli/**', '../cli/**', '../../cli/**'],
              message: 'Core (Layer 1) must not import CLI.',
            },
            {
              group: ['**/subsystems/**', '../subsystems/**', '../../subsystems/**'],
              message: 'Core (Layer 1) must not import subsystems.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/loop/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/harness/**', '../harness/**', '../../harness/**', '@octopi-agent/engine/**'],
              message: 'Loop (Layer 0) must not import Harness.',
            },
            {
              group: ['**/integration/**', '../integration/**', '../../integration/**'],
              message: 'Loop (Layer 0) must not import Integration.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/engine/src/harness/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/integration/**'],
              message:
                'Harness (Layer 2) must not import Integration. Move the contract into Core/Harness or inject the implementation from the host.',
            },
            {
              group: ['**/gateway/**', '**/cli/**', '**/web/**', '**/webui/**'],
              message:
                'Harness (Layer 2) must not import gateway / cli / web. Those belong to outer packages.',
            },
          ],
        },
      ],
    },
  },
);
