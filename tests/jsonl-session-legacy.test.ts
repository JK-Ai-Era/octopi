/**
 * JsonlSessionStore — 旧版带冒号文件名兼容
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlSessionStore } from '../src/integration/storage/jsonl.js';
import type { SessionData } from '../src/harness/session-types.js';

let home: string;
let store: JsonlSessionStore;

beforeEach(() => {
  home = join(tmpdir(), `octopi-jsonl-legacy-${Date.now()}`);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  store = new JsonlSessionStore(() => home);
});

afterEach(() => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

function sample(id: string): SessionData {
  return {
    id,
    agentId: 'default',
    meta: {
      id,
      agentId: 'default',
      channelId: 'web',
      peerId: 'web-ui',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 1,
      updatedAt: 1,
    },
    messages: [{ role: 'user', content: 'hello' } as SessionData['messages'][number]],
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('JsonlSessionStore legacy filename fallback', () => {
  // Windows 无法创建含 `:` 的文件名；旧版冒号文件只可能来自 macOS/Linux
  test.skipIf(process.platform === 'win32')(
    'loads macOS-style colon filenames and migrates to safe name',
    async () => {
      const sessionId = 'default:web:1700000000000';
      const legacyPath = join(home, 'sessions', `${sessionId}.jsonl`);
      const safePath = join(home, 'sessions', 'default_web_1700000000000.jsonl');
      writeFileSync(legacyPath, JSON.stringify({ role: 'user', content: 'legacy' }) + '\n', 'utf-8');
      writeFileSync(
        join(home, 'sessions', 'sessions.json'),
        JSON.stringify({ [sessionId]: sample(sessionId).meta }, null, 2),
        'utf-8',
      );

      const loaded = await store.load('default', sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages[0]!.content).toBe('legacy');
      expect(existsSync(safePath)).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    },
  );

  test('save writes safe filename only', async () => {
    const sessionId = 'default:web:2';
    await store.save('default', sessionId, sample(sessionId));
    expect(existsSync(join(home, 'sessions', 'default_web_2.jsonl'))).toBe(true);
    expect(existsSync(join(home, 'sessions', `${sessionId}.jsonl`))).toBe(false);
  });
});
