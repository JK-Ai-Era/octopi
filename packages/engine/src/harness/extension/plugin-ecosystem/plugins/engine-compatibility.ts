import { createRequire } from 'node:module';
import semver from 'semver';

let cachedVersion: string | undefined;

/** Read the installed engine package version through its public package export. */
export function getEngineVersion(): string {
  if (cachedVersion === undefined) {
    const require = createRequire(import.meta.url);
    const metadata = require('@octopi-agent/engine/package.json') as { version: string };
    cachedVersion = metadata.version;
  }
  return cachedVersion;
}

/** Return whether the installed engine satisfies a manifest's semver range. */
export function satisfiesEngineRange(version: string, range: string): boolean {
  if (!semver.valid(version) || !semver.validRange(range)) return false;
  return semver.satisfies(version, range);
}
