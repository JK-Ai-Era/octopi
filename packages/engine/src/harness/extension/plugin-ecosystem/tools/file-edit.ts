/**
 * file_edit 工具 — 结构化文件编辑
 *
 * 比 file_write 更精确的编辑方式：指定旧文本 → 新文本的局部替换。
 * 避免大文件整文件覆写的 token 浪费和出错风险。
 *
 * 特性：
 * - 文本匹配替换（old_text → new_text）
 * - occurrence 选择（first / last / all / N）
 * - dry-run 预览模式
 * - 编辑后自动返回周围上下文
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import {
  isPathUnderRoots,
  isUnderAttachmentRoot,
  isUnderSessionUndoRoot,
  resolveToolPath,
} from './platform.js';
import { gateEffect } from '../../execution-environment/effect-policy.js';
import { detectEol, oldTextCandidates, toEol } from './eol.js';

export function createFileEditTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_edit',
      capabilities: ['fs-write', 'fs-read'],
      description: 'Edit a file by replacing specific text. More precise than file_write for targeted changes. Supports selecting which occurrence to replace and dry-run preview. old_text must match the CURRENT file content — if your view of the file is stale, re-read before editing; do not batch several edits against the same file in one turn (each edit builds on the previous result, stale batches lose changes).',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to edit',
          required: true,
        },
        old_text: {
          type: 'string',
          description: 'The exact text to find and replace (must match uniquely or use occurrence to select)',
          required: true,
        },
        new_text: {
          type: 'string',
          description: 'The replacement text',
          required: true,
        },
        occurrence: {
          type: 'string',
          description: 'Which occurrence to replace: "first" (default), "last", "all", or a number (1-indexed)',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, preview the change without writing to file (default: false)',
        },
      },
    },
    // 同文件并发读改写互相覆盖（丢编辑）：所在 tool_call 批次整体串行
    executionMode: 'sequential',
    handler: async (args, context) => {
      const { readFile } = await import('node:fs/promises');

      const rawPath = args.path as string;
      const cwd = context.cwd ?? process.cwd();
      const path = resolveToolPath(rawPath, cwd, {
        allowRoots: context.pathRoots,
        containment: context.pathContainment,
      });
      if (isUnderAttachmentRoot(path, context.attachmentRoots)) {
        throw new Error('session attachments are read-only; cannot edit attachments root');
      }
      if (isUnderSessionUndoRoot(path, context.undoRoots)) {
        throw new Error('session undo ledger is protected; cannot write to sessions undo dir');
      }
      const oldText = args.old_text as string;
      const newText = args.new_text as string;
      const occurrence = (args.occurrence as string) ?? 'first';
      const dryRun = (args.dry_run as boolean) ?? false;

      let content: string;
      try {
        content = await readFile(path, 'utf-8');
      } catch (error) {
        throw new Error(`Failed to read file "${path}": ${error instanceof Error ? error.message : String(error)}`);
      }

      // 行尾自适应匹配：多行 old_text（\n 书写）在 CRLF 文件上按字节匹配必然落空
      const fileEol = detectEol(content);
      const matchedOldText = oldTextCandidates(oldText).find((c) => content.includes(c));
      if (matchedOldText === undefined) {
        throw new Error(`old_text not found in "${path}". Ensure the text matches exactly including whitespace and indentation.`);
      }
      const insertText = toEol(newText, fileEol);

      // 查找所有匹配位置
      const positions: number[] = [];
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf(matchedOldText, searchFrom);
        if (idx === -1) break;
        positions.push(idx);
        searchFrom = idx + 1;
      }

      const matchCount = positions.length;
      if (matchCount === 0) {
        throw new Error(`old_text not found in "${path}". Ensure the text matches exactly including whitespace and indentation.`);
      }

      // 选择要替换的匹配
      let indicesToReplace: number[];
      if (occurrence === 'all') {
        indicesToReplace = positions;
      } else if (occurrence === 'first') {
        indicesToReplace = [positions[0]];
      } else if (occurrence === 'last') {
        indicesToReplace = [positions[positions.length - 1]];
      } else {
        const n = parseInt(occurrence, 10);
        if (isNaN(n) || n < 1 || n > matchCount) {
          throw new Error(`Invalid occurrence "${occurrence}": file has ${matchCount} match(es). Use "first", "last", "all", or a number 1-${matchCount}.`);
        }
        indicesToReplace = [positions[n - 1]];
      }

      // 从后向前替换以保持位置正确
      let newContent = content;
      const sortedIndices = [...indicesToReplace].sort((a, b) => b - a);
      for (const idx of sortedIndices) {
        newContent = newContent.slice(0, idx) + insertText + newContent.slice(idx + matchedOldText.length);
      }

      // 生成上下文预览（第一个替换点周围）
      const firstIdx = indicesToReplace[0];
      const before = content.slice(Math.max(0, firstIdx - 80), firstIdx);
      const match = content.slice(firstIdx, firstIdx + matchedOldText.length);
      const after = content.slice(firstIdx + matchedOldText.length, firstIdx + matchedOldText.length + 80);

      if (!dryRun) {
        await gateEffect(
          {
            kind: 'file.write',
            path,
            mode: 'edit',
            transactional: isPathUnderRoots(path, context.pathRoots ?? []),
          },
          {
            effects: context.effectChannel ?? 'engine',
            confirmEffect: context.confirmEffect,
          },
        );
        const effects = context.fileEffects;
        if (!effects) {
          throw new Error('file_effects_not_configured: file_edit requires ToolExecutionContext.fileEffects');
        }
        await effects.writeFile(path, newContent, { refuseFinalSymlink: context?.refuseFinalSymlink === true });
      }

      return {
        path,
        matchCount,
        replacedCount: indicesToReplace.length,
        occurrence,
        dryRun,
        preview: {
          before: `...${before}`,
          old: match,
          new: newText.length > 160 ? newText.slice(0, 160) + '...' : newText,
          after: `${after}...`,
        },
        totalLines: newContent.split('\n').length,
      };
    },
  };
}
