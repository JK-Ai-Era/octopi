/**
 * P6-4 host storage primitives: api.stateDir (0700 plugin state directory),
 * api.secrets (vault-backed per-plugin namespace), and manifest secretOptions
 * redaction in config echo surfaces (M4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginApi } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/api.js';
import { CredentialStore } from '../packages/engine/src/harness/governance/credentials/store.js';
import { redactProvider, resolveEchoPlaceholders, type RedactedSecret } from '../packages/engine/src/config-admin/redact.js';
import { validateManifest } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/manifest.js';

let root: string;
let savedKey: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-p64-'));
  // AES-GCM master key for the vault (64 hex chars → 32 bytes).
  savedKey = process.env.OCTOPI_CREDENTIALS_KEY;
  process.env.OCTOPI_CREDENTIALS_KEY = 'ab'.repeat(32);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OCTOPI_CREDENTIALS_KEY;
  else process.env.OCTOPI_CREDENTIALS_KEY = savedKey;
  rmSync(root, { recursive: true, force: true });
});

function makeApi(id = 'p', store?: CredentialStore): PluginApi {
  return new PluginApi({
    id,
    name: id,
    version: '1.0.0',
    source: 'test',
    rootDir: '/tmp',
    pluginConfig: {},
    stateDir: join(root, 'plugin-state', id),
    ...(store ? { credentialStore: store } : {}),
  });
}

describe('api.stateDir (P6-4)', () => {
  it('creates the plugin state directory with mode 0700 on first use', async () => {
    const api = makeApi();
    expect(api.stateDir.endsWith(join('plugin-state', 'p'))).toBe(true);
    expect(existsSync(api.stateDir)).toBe(false);

    await api.ensureStateDir();
    expect(existsSync(api.stateDir)).toBe(true);
    expect(statSync(api.stateDir).mode & 0o777).toBe(0o700);
  });

  it('tightens an already-existing looser directory to 0700', async () => {
    const api = makeApi();
    const { mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(api.stateDir, { recursive: true, mode: 0o755 });
    chmodSync(api.stateDir, 0o755);

    await api.ensureStateDir();
    expect(statSync(api.stateDir).mode & 0o777).toBe(0o700);
  });
});

describe('api.secrets (P6-4)', () => {
  it('round-trips a secret through the vault and deletes it', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const api = makeApi('p', store);

    expect(await api.secrets.get('bot_token')).toBeNull();
    await api.secrets.set('bot_token', 'tok-1');
    expect(await api.secrets.get('bot_token')).toBe('tok-1');

    expect(await api.secrets.delete('bot_token')).toBe(true);
    expect(await api.secrets.get('bot_token')).toBeNull();
    expect(await api.secrets.delete('bot_token')).toBe(false);
  });

  it('keeps namespaces private: another plugin cannot read the value, and direct vault consumers are rejected', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const a = makeApi('a', store);
    const b = makeApi('b', store);

    await a.secrets.set('token', 'secret-of-a');
    // Namespace isolation: b's lookup for "token" is a different credential.
    expect(await b.secrets.get('token')).toBeNull();
    // Binding enforcement: even with the name, another consumer is refused.
    await expect(store.reveal('plugin:a:token', { kind: 'plugin', id: 'b' })).rejects.toThrow(/not bound to consumer/);
    expect(await a.secrets.get('token')).toBe('secret-of-a');
  });

  it('rejects invalid keys and empty values with real errors', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const api = makeApi('p', store);

    await expect(api.secrets.get('bad:key')).rejects.toThrow(/invalid secret key/);
    await expect(api.secrets.set('bad/key', 'v')).rejects.toThrow(/invalid secret key/);
    await expect(api.secrets.set('key', '')).rejects.toThrow(/non-empty string/);
  });

  it('meta surfaces never echo the plaintext', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const api = makeApi('p', store);
    await api.secrets.set('token', 'very-secret');

    const meta = store.get('plugin:p:token');
    expect(meta).not.toBeNull();
    expect(meta!.hasSecret).toBe(true);
    expect(JSON.stringify(meta)).not.toContain('very-secret');
  });
});

describe('vault failure and default paths (P6-4 review)', () => {
  it('secrets.set fails loud without a configured master key', async () => {
    const saved = process.env.OCTOPI_CREDENTIALS_KEY;
    delete process.env.OCTOPI_CREDENTIALS_KEY;
    try {
      const store = await CredentialStore.open({ dbPath: ':memory:' });
      const api = makeApi('p', store);
      await expect(api.secrets.set('token', 'v')).rejects.toThrow(/master key not configured/);
    } finally {
      if (saved !== undefined) process.env.OCTOPI_CREDENTIALS_KEY = saved;
    }
  });

  it('stateDir derives from OCTOPI_HOME when not injected', async () => {
    const saved = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = root;
    try {
      const api = new PluginApi({ id: 'p', name: 'p', version: '1.0.0', source: 'test', rootDir: '/tmp', pluginConfig: {} });
      expect(api.stateDir).toBe(join(root, 'plugin-state', 'p'));
    } finally {
      if (saved === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = saved;
    }
  });

  it('cross-plugin overwrite/delete cannot reach another namespace', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const a = makeApi('a', store);
    const b = makeApi('b', store);

    await a.secrets.set('token', 'secret-of-a');
    await b.secrets.set('token', 'secret-of-b'); // different namespace row
    expect(await a.secrets.get('token')).toBe('secret-of-a');
    expect(await b.secrets.delete('token')).toBe(true); // deletes b's row only
    expect(await a.secrets.get('token')).toBe('secret-of-a');
  });

  it('expired secrets resolve as absent (parity with resolve())', async () => {
    const store = await CredentialStore.open({ dbPath: ':memory:' });
    const api = makeApi('p', store);
    await api.secrets.set('token', 'v');
    store.set({
      name: 'plugin:p:token',
      kind: 'api_key',
      secretMode: 'encrypted',
      secretValue: 'v',
      expiresAt: Date.now() - 1000,
      scope: { level: 'plugin', key: 'p' },
    });
    expect(await api.secrets.get('token')).toBeNull();
  });
});

describe('manifest secretOptions + config echo redaction (M4)', () => {
  const manifestWithSecretOptions = (secretOptions?: string[]) => ({
    id: 'p',
    apiVersion: '1',
    version: '1.0.0',
    name: 'p',
    entry: 'index.mjs',
    engine: { octopi: '>=0' },
    configSchema: { type: 'object' },
    ...(secretOptions ? { secretOptions } : {}),
  });

  it('manifest accepts declared secret option keys and rejects invalid names', () => {
    expect(() => validateManifest(manifestWithSecretOptions(['token', 'apiToken.v2']))).not.toThrow();
    expect(() => validateManifest(manifestWithSecretOptions(['bad key']))).toThrow();
    expect(() => validateManifest(manifestWithSecretOptions([]))).not.toThrow();
  });

  it('redactProvider masks declared option keys as RedactedSecret and passes others through', () => {
    const view = redactProvider(
      'pr',
      {
        plugin: 'p',
        baseUrl: 'https://example.invalid',
        options: { token: 'plain-secret', envToken: '${MY_TOKEN}', region: 'eu', amount: 7 },
      },
      ['token', 'envToken'],
    );

    expect(view.options!.token).toEqual({ configured: true, ref: 'literal' } satisfies RedactedSecret);
    expect(view.options!.envToken).toEqual({ configured: true, ref: 'MY_TOKEN' } satisfies RedactedSecret);
    expect(view.options!.region).toBe('eu');
    expect(view.options!.amount).toBe(7);
    expect(JSON.stringify(view)).not.toContain('plain-secret');
  });

  it('redactProvider without declared keys keeps legacy pass-through (built-in providers)', () => {
    const view = redactProvider('x', { baseUrl: 'https://example.invalid', options: { knob: 'v' } });
    expect(view.options!.knob).toBe('v');
  });

  it('redactProvider fails closed when the plugin contribution is unknown (null)', () => {
    const view = redactProvider('pr', { plugin: 'gone', baseUrl: 'https://example.invalid', options: { region: 'eu', token: 's' } }, null);
    expect(view.options!.region).toEqual({ configured: true, ref: 'literal' });
    expect(view.options!.token).toEqual({ configured: true, ref: 'literal' });
    expect(JSON.stringify(view)).not.toContain('eu');
  });

  it('echo placeholders resolve to the stored value on upsert (web-console round-trip is write-safe)', () => {
    const previous = { options: { token: 'stored-secret', region: 'eu' } };
    const upserted = {
      options: {
        token: { configured: true, ref: 'literal' }, // round-tripped placeholder
        region: 'us',
        fresh: { configured: true, ref: 'literal' }, // placeholder without stored value
      },
    };
    const resolved = resolveEchoPlaceholders(upserted, previous, ['token', 'fresh']);
    expect(resolved.options!.token).toBe('stored-secret');
    expect(resolved.options!.region).toBe('us');
    expect(resolved.options!.fresh).toBeUndefined();
    // No placeholder survives into the written config.
    expect(JSON.stringify(resolved)).not.toContain('"configured"');
  });

  it('non-secret options are untouched by the placeholder rule', () => {
    const resolved = resolveEchoPlaceholders({ options: { flag: { configured: true, ref: 'literal' } } }, { options: { flag: 'v' } }, []);
    expect(resolved.options!.flag).toEqual({ configured: true, ref: 'literal' });
  });
});
