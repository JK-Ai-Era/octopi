/**
 * Path glob compilation — shared by tool glob filters and path denylists.
 *
 * Semantics follow rg/git so that `file_search`'s `glob` argument and
 * `effectPolicy.pathDenylist` cannot drift apart:
 * - `**` crosses directories; `*` and `?` do not cross `/`
 * - a pattern without `/` (for example `*.md`) matches at any depth
 * - `{a,b}` alternatives are supported, including nesting
 */

/**
 * Compile a path glob into a regular expression over root-relative paths.
 *
 * @param glob - glob pattern
 * @returns anchored, case-insensitive matcher for a root-relative path
 */
export function globToPathRegex(glob: string): RegExp {
  const trimmed = glob.trim();
  if (!trimmed) throw new Error('glob must be non-empty');
  // Compiled patterns are pure functions of the pattern text, and denylists are
  // re-evaluated for every walked file, so memoize instead of recompiling.
  const cached = COMPILED.get(trimmed);
  if (cached) return cached;
  const normalized = trimmed.includes('/') ? trimmed : `**/${trimmed}`;
  const regex = new RegExp(`^${globToSource(normalized)}$`, 'i');
  if (COMPILED.size >= COMPILE_CACHE_LIMIT) COMPILED.clear();
  COMPILED.set(trimmed, regex);
  return regex;
}

const COMPILED = new Map<string, RegExp>();
const COMPILE_CACHE_LIMIT = 512;

/**
 * Normalize a deny pattern into the path dialect the matcher speaks.
 *
 * Windows deployments write separators the way their shell does, so `\` is
 * always a separator here. That makes an escaped literal (`.git\**` meaning
 * "a file literally named `.git*`") impossible to express — acceptable, since a
 * separator is what every real denylist entry means.
 *
 * @param pattern - raw deny pattern from configuration
 * @returns pattern using `/` separators
 */
export function normalizeDenyPattern(pattern: string): string {
  return pattern.trim().split('\\').join('/');
}

/**
 * Reject deny patterns that can never match a root-relative path.
 *
 * A pattern that silently matches nothing is worse than a startup error: the
 * deployment keeps believing it is protected. Shapes rejected here are all
 * spellings that look meaningful but cannot match (`/x` anchors outside the
 * root, `x/` never matches a resolved file, `../x` has no candidate).
 *
 * @param pattern - raw deny pattern from configuration
 */
export function validateDenyPattern(pattern: string): void {
  const normalized = normalizeDenyPattern(pattern);
  if (!normalized) throw new Error('pathDenylist: pattern must be non-empty');
  if (normalized.startsWith('/')) {
    throw new Error(`pathDenylist: "${pattern}" must be root-relative (drop the leading "/")`);
  }
  if (normalized.endsWith('/')) {
    throw new Error(`pathDenylist: "${pattern}" must not end with a separator`);
  }
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`pathDenylist: "${pattern}" must not contain "." or ".." segments`);
  }
}

/**
 * Compile a normalized glob fragment into regex source.
 *
 * @param glob - glob containing path separators
 * @returns regex source without anchors
 */
function globToSource(glob: string): string {
  let out = '';
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    // `\*`, `\?` and friends are literals.
    if (char === '\\' && index + 1 < glob.length && '*?[]{}\\/!'.includes(glob[index + 1])) {
      out += escapeRegex(glob[index + 1]);
      index += 2;
      continue;
    }

    if (char === '*' && glob[index + 1] === '*') {
      index += 2;
      if (glob[index] === '/') {
        index += 1;
        // `**/` → any depth prefix, including zero segments
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
      continue;
    }

    if (char === '*') {
      index += 1;
      out += '[^/]*';
      continue;
    }

    if (char === '?') {
      index += 1;
      out += '[^/]';
      continue;
    }

    if (char === '{') {
      const end = findBraceEnd(glob, index);
      if (end === -1) {
        out += '\\{';
        index += 1;
        continue;
      }
      const alternatives = splitBraceAlternatives(glob.slice(index + 1, end));
      out += `(?:${alternatives.map((alt) => globToSource(alt)).join('|')})`;
      index = end + 1;
      continue;
    }

    if ('.+^$()|[]'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
    index += 1;
  }

  return out;
}

/**
 * Find the `}` matching the `{` at `openIndex`, skipping nesting.
 *
 * @param glob - glob string
 * @param openIndex - index of `{`
 * @returns index of the matching `}`; -1 when unbalanced
 */
function findBraceEnd(glob: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < glob.length; index += 1) {
    if (glob[index] === '{') depth += 1;
    else if (glob[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Split top-level comma alternatives inside braces.
 *
 * @param body - contents between braces
 * @returns alternatives
 */
function splitBraceAlternatives(body: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives;
}

/**
 * Escape a single character for use in a regex literal.
 *
 * @param char - character to escape
 * @returns escaped character
 */
function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a root-relative path matches any denylist pattern.
 *
 * Both the full relative path and the file name are tested, so `.env*` and
 * `.git/**` can coexist without the caller deciding which form a pattern means.
 * Invalid patterns are the caller's mistake and throw: silently ignoring a
 * typo'd security pattern would leave the deployment believing it is protected.
 *
 * @param relativePath - path relative to the containing root, using `/`
 * @param patterns - denylist globs
 * @returns true when any pattern matches
 */
export function matchesDenyPattern(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = relativePath.split('\\').join('/');
  const segments = normalized.split('/').filter(Boolean);

  // Test the full path *and every suffix*, so a pattern like `.git/**` denies a
  // `.git` directory at any depth. Anchoring only at the root would let
  // `pkg/.git/config` through, which for a security denylist is a silent hole.
  const candidates = [normalized];
  for (let index = 1; index < segments.length; index += 1) {
    candidates.push(segments.slice(index).join('/'));
  }
  const name = segments[segments.length - 1] ?? normalized;
  if (!candidates.includes(name)) candidates.push(name);

  return patterns.some((pattern) => {
    const matcher = globToPathRegex(normalizeDenyPattern(pattern));
    return candidates.some((candidate) => matcher.test(candidate));
  });
}
