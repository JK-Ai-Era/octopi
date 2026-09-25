/**
 * CredentialStore — env 模式 / 绑定 / resolve
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/harness/credentials/store.js';

const envKey = 'OCTOPI_TEST_CRED_TOKEN';

describe('CredentialStore', () => {
  afterEach(() => {
    delete process.env[envKey];
  });

  it('registers env-mode credential and resolves headers without exposing secret in meta', async () => {
    const store = await CredentialStore.open();
    process.env[envKey] = 'secret-token-value';

    const meta = store.set({
      name: 'demo-bearer',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
      description: 'demo',
    });

    expect(meta.hasSecret).toBe(true);
    expect(meta.secretEnv).toBe(envKey);
    expect(JSON.stringify(meta)).not.toContain('secret-token-value');

    const resolved = await store.resolve('demo-bearer');
    expect(resolved?.headers.Authorization).toBe('Bearer secret-token-value');

    const list = store.list();
    expect(list.map((c) => c.name)).toContain('demo-bearer');
    expect(JSON.stringify(list)).not.toContain('secret-token-value');
  });

  it('returns null when env var missing', async () => {
    const store = await CredentialStore.open();
    store.set({
      name: 'missing-env',
      kind: 'api_key',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_NOT_SET_XYZ',
      headerName: 'X-API-Key',
    });
    expect(await store.resolve('missing-env')).toBeNull();
  });

  it('binds consumers and supports delete', async () => {
    const store = await CredentialStore.open();
    store.set({ name: 'bind-me', kind: 'bearer', secretMode: 'env', secretEnv: envKey });
    store.bind({ kind: 'knowledge_source', id: 'ks_1' }, 'bind-me');
    expect(store.listBindings('bind-me')).toEqual([{ kind: 'knowledge_source', id: 'ks_1' }]);
    expect(store.delete('bind-me')).toBe(true);
    expect(store.get('bind-me')).toBeNull();
    expect(store.listBindings('bind-me')).toEqual([]);
  });

  it('rejects env mode without secretEnv', async () => {
    const store = await CredentialStore.open();
    expect(() =>
      store.set({ name: 'bad', kind: 'bearer', secretMode: 'env' }),
    ).toThrow(/secretEnv/);
  });
});
