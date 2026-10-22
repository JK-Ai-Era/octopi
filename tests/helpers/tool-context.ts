/**
 * 测试用 ToolExecutionContext 夹具。
 *
 * `ToolExecutionContext` 的 `fileEffects` / `memoryEffects` 是必填契约
 * （缺失时文件写/记忆写工具必须拒绝执行），手搓 context 漏字段既过不了 tsc
 * 也会让工具在运行时拒绝。测试统一经此构造，只覆盖各自关心的字段。
 */
import { appendFile, writeFile } from 'node:fs/promises';
import type {
  MemoryEffectJournal,
  ToolExecutionContext,
  ToolFileEffects,
} from '@octopi-agent/core/types/tools.js';

/** 测试用直写端口（不记 undo）；undo 专项测试改用 TurnFileUndoLog */
export function testFileEffects(): ToolFileEffects {
  return {
    async writeFile(path, data) {
      await writeFile(path, data);
    },
    async appendFile(path, data) {
      await appendFile(path, data);
    },
    async recordDelete() {},
    async recordCreate() {},
    async recordRename() {},
    async recordOverwrite() {},
    async noteNotReversed() {},
  };
}

/** 测试用 no-op 记忆效应 journal；记忆逆放专项测试自行构造记录型实现 */
export function testMemoryEffects(): MemoryEffectJournal {
  return {
    async recordInsert() {},
    async recordUpdate() {},
    async recordDelete() {},
  };
}

/**
 * 构造完整 ToolExecutionContext：必填字段齐全，调用点只覆盖关心的字段。
 *
 * @param overrides 覆盖默认值的字段（如真实 TurnFileUndoLog、cwd、pathRoots）
 * @returns 可直接传给 tool.handler / registry.execute 的执行上下文
 */
export function makeToolContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    messages: [],
    fileEffects: testFileEffects(),
    memoryEffects: testMemoryEffects(),
    ...overrides,
  };
}
