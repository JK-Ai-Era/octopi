/**
 * Module path resolver for workers and child processes.
 *
 * Neither Worker nor child_process can execute TypeScript. Production loads
 * compiled files under packages/pkg/dist. Vitest imports src TypeScript, so we
 * map src -> dist. Callers MUST pass their own `import.meta.url`.
 */
export function resolveWorkerUrl(moduleFile: string, fromUrl: string): URL {
  const normalized = fromUrl.replace(/\\/g, '/');
  if (normalized.includes('/src/') && normalized.endsWith('.ts')) {
    const distBase = normalized.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
    return new URL(moduleFile, distBase);
  }
  return new URL(moduleFile, fromUrl);
}
