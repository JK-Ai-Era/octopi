import tseslint from 'typescript-eslint';

/**
 * Architecture boundary rules:
 * - Core (Layer 1) must not import Harness / Integration / Loop / CLI / subsystems
 * - Loop (Layer 0) must not import Harness / Integration
 *
 * Dependency direction: Integration → Harness → Loop → Core.
 * Mirrored by tests/architecture/boundaries.test.ts.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**'],
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
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/harness/**', '../harness/**', '../../harness/**'],
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
    files: ['src/loop/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/harness/**', '../harness/**', '../../harness/**'],
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
);
