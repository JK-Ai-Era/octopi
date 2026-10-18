/**
 * file_mkdir / file_rename / file_copy / file_stat / file_rmdir
 *
 * Cross-platform (Windows / macOS / Linux) file & folder tools.
 * Path rules match file_write: L2 resolveToolPath, attachment/undo self-protection.
 * Destructive ops go through ToolFileEffects where a reversible journal is possible.
 */
import type { RegisteredTool } from '@octopi-agent/core/types.js';
import {
  isPathUnderRoots,
  isUnderAttachmentRoot,
  resolveToolPath,
  isUnderSessionUndoRoot,
} from './platform.js';
import { gateEffect } from '../../execution-environment/effect-policy.js';


function resolveSafePath(
  rawPath: string,
  context: { cwd?: string; pathRoots?: string[]; pathContainment?: 'strict' | 'soft' | 'none'; attachmentRoots?: string[]; undoRoots?: string[] } | undefined,
  label: string,
): string {
  const cwd = context?.cwd ?? process.cwd();
  const path = resolveToolPath(rawPath, cwd, {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
  });
  if (isUnderAttachmentRoot(path, context?.attachmentRoots)) {
    throw new Error(`session attachments are read-only; cannot ${label} under attachments root`);
  }
  if (isUnderSessionUndoRoot(path, context?.undoRoots)) {
    throw new Error(`session undo ledger is protected; cannot ${label} under sessions undo dir`);
  }
  return path;
}

async function requireEffects(
  context: { fileEffects?: import('@octopi-agent/core/types/tools.js').ToolFileEffects } | undefined,
  toolName: string,
): Promise<import('@octopi-agent/core/types/tools.js').ToolFileEffects> {
  const effects = context?.fileEffects;
  if (!effects) {
    throw new Error(`file_effects_not_configured: ${toolName} requires ToolExecutionContext.fileEffects`);
  }
  return effects;
}

/**
 * file_mkdir — create a directory (optionally parents)
 */
export function createFileMkdirTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_mkdir',
      capabilities: ['fs-write'],
      description:
        'Create a directory. Creates parent directories when recursive=true (default). Cross-platform.',
      parameters: {
        path: {
          type: 'string',
          description: 'Directory path to create',
          required: true,
        },
        recursive: {
          type: 'boolean',
          description: 'Create parent directories if needed (default: true)',
        },
      },
    },
    handler: async (args, context) => {
      const { mkdir, stat } = await import('node:fs/promises');
      const path = resolveSafePath(args.path as string, context, 'mkdir');
      const recursive = (args.recursive as boolean) ?? true;

      const st = await stat(path).catch(() => null);
      if (st?.isDirectory()) {
        return { path, created: false, existed: true };
      }
      if (st) {
        throw new Error(`Path exists and is not a directory: ${path}`);
      }
      // Mirrors file_rmdir's gate shape: after this tool's existence checks
      // (no-op calls never prompt) and before the mutation. transactional
      // (in-roots) auto-allows; host-gate asks the host. Gate errors surface
      // unwrapped (effect_denied stays identifiable).
      await gateEffect(
        {
          kind: 'file.write',
          path,
          mode: 'create',
          transactional: isPathUnderRoots(path, context?.pathRoots ?? []),
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
        },
      );
      try {
        await mkdir(path, { recursive });
      } catch (error) {
        if (error instanceof Error && /not a directory/.test(error.message)) throw error;
        throw new Error(
          `Failed to create directory "${path}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        path,
        created: true,
        existed: false,
        reversible: false,
        note: 'directory creation is not journaled for turn undo',
      };
    },
  };
}

/**
 * file_rename — rename/move a file or directory
 *
 * Files: journaled via recordRename (edit-resend undo).
 * Directories: fs.rename; tree undo is not journaled (reversible:false).
 */
export function createFileRenameTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_rename',
      capabilities: ['fs-write'],
      description:
        'Rename or move a file or directory. Overwrites the destination if it exists (file) or fails if destination directory exists. File moves are journaled for undo; directory moves are not tree-undoable.',
      parameters: {
        from: {
          type: 'string',
          description: 'Source path',
          required: true,
        },
        to: {
          type: 'string',
          description: 'Destination path',
          required: true,
        },
      },
    },
    handler: async (args, context) => {
      const { rename, stat, rm, readFile } = await import('node:fs/promises');
      const from = resolveSafePath(args.from as string, context, 'rename');
      const to = resolveSafePath(args.to as string, context, 'rename');
      if (from === to) {
        return { from, to, renamed: false, reason: 'same_path' };
      }

      let srcStat;
      try {
        srcStat = await stat(from);
      } catch {
        throw new Error(`Source not found: ${from}`);
      }

      await gateEffect(
        {
          kind: 'file.write',
          path: to,
          mode: 'overwrite',
          transactional:
            isPathUnderRoots(from, context?.pathRoots ?? []) &&
            isPathUnderRoots(to, context?.pathRoots ?? []),
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
        },
      );

      const destStat = await stat(to).catch(() => null);
      if (srcStat.isDirectory() && destStat?.isDirectory()) {
        throw new Error(`Destination directory already exists: ${to}`);
      }
      if (srcStat.isDirectory() && destStat?.isFile()) {
        throw new Error(`Cannot overwrite file with directory: ${to}`);
      }

      if (srcStat.isDirectory()) {
        try {
          await rename(from, to);
        } catch (error) {
          throw new Error(
            `Failed to rename directory "${from}" → "${to}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          from,
          to,
          renamed: true,
          kind: 'directory',
          reversible: false,
          note: 'directory move is not journaled for turn undo',
        };
      }

      // Journal BEFORE any mutation so dest overwrite keeps a restorable `before`.
      // recordRename reads both paths from disk (delete(from)+overwrite/create(to)).
      const effects = await requireEffects(context, 'file_rename');
      const before = await readFile(from);
      await effects.recordRename(from, to);

      // Windows: rename fails if destination file exists — replace after journaling
      if (destStat?.isFile()) {
        await rm(to, { force: true });
      }
      try {
        await rename(from, to);
      } catch (error) {
        throw new Error(
          `Failed to rename file "${from}" → "${to}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        from,
        to,
        renamed: true,
        kind: 'file',
        reversible: true,
        bytes: before.byteLength,
      };
    },
  };
}

/**
 * file_copy — copy a file (not a directory)
 */
export function createFileCopyTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_copy',
      capabilities: ['fs-write', 'fs-read'],
      description:
        'Copy a file to a new path. Creates parent directories if needed. Does not copy directories (use shell only if policy allows).',
      parameters: {
        from: {
          type: 'string',
          description: 'Source file path',
          required: true,
        },
        to: {
          type: 'string',
          description: 'Destination file path',
          required: true,
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite destination if it exists (default: false)',
        },
      },
    },
    handler: async (args, context) => {
      const { copyFile, mkdir, stat, readFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const from = resolveSafePath(args.from as string, context, 'copy');
      const to = resolveSafePath(args.to as string, context, 'copy');
      const overwrite = (args.overwrite as boolean) ?? false;

      let srcStat;
      try {
        srcStat = await stat(from);
      } catch {
        throw new Error(`Source not found: ${from}`);
      }
      if (srcStat.isDirectory()) {
        throw new Error(`file_copy does not copy directories: ${from}`);
      }

      const destExists = await stat(to).then(() => true, () => false);
      if (destExists && !overwrite) {
        throw new Error(`Destination exists (pass overwrite=true to replace): ${to}`);
      }

      await gateEffect(
        {
          kind: 'file.write',
          path: to,
          mode: destExists ? 'overwrite' : 'create',
          transactional: isPathUnderRoots(to, context?.pathRoots ?? []),
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
        },
      );

      const effects = await requireEffects(context, 'file_copy');
      await mkdir(dirname(to), { recursive: true });

      // Journal destination before overwrite / create
      if (destExists) {
        const prior = await readFile(to);
        const after = await readFile(from);
        await effects.recordOverwrite(to, prior, after);
      } else {
        const after = await readFile(from);
        await effects.recordCreate(to, after);
      }
      // Binary-safe copy (images, Office, etc.)
      await copyFile(from, to);

      return {
        from,
        to,
        copied: true,
        overwrite,
        bytes: srcStat.size,
        reversible: true,
      };
    },
  };
}

/**
 * file_stat — file/directory metadata
 */
export function createFileStatTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_stat',
      capabilities: ['fs-read'],
      description:
        'Get file or directory metadata (type, size, mtime). Returns exists=false when missing. Cross-platform.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to stat',
          required: true,
        },
      },
    },
    handler: async (args, context) => {
      const { stat, realpath } = await import('node:fs/promises');
      const path = resolveSafePath(args.path as string, context, 'stat');
      try {
        const st = await stat(path);
        const resolved = await realpath(path).catch(() => path);
        return {
          path,
          realpath: resolved,
          exists: true,
          kind: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          mode: st.mode,
          readOnly: (st.mode & 0o200) === 0,
        };
      } catch {
        return { path, exists: false };
      }
    },
  };
}

/**
 * file_rmdir — remove an empty directory
 */
export function createFileRmdirTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_rmdir',
      capabilities: ['fs-write'],
      description:
        'Remove an empty directory. Refuses non-empty directories (delete files first or use file_delete). Cross-platform.',
      parameters: {
        path: {
          type: 'string',
          description: 'Directory path to remove (must be empty)',
          required: true,
        },
      },
    },
    handler: async (args, context) => {
      const { rmdir, readdir, stat } = await import('node:fs/promises');
      const path = resolveSafePath(args.path as string, context, 'rmdir');

      let st;
      try {
        st = await stat(path);
      } catch {
        throw new Error(`Directory not found: ${path}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Not a directory: ${path}`);
      }

      const entries = await readdir(path);
      if (entries.length > 0) {
        throw new Error(
          `Directory not empty (${entries.length} entries): ${path}. Remove contents first (file_delete / file_rmdir).`,
        );
      }

      await gateEffect(
        {
          kind: 'file.write',
          path,
          mode: 'overwrite',
          transactional: isPathUnderRoots(path, context?.pathRoots ?? []),
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
        },
      );

      try {
        await rmdir(path);
      } catch (error) {
        throw new Error(
          `Failed to remove directory "${path}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { path, removed: true, reversible: false, note: 'empty directory remove is not journaled' };
    },
  };
}

/** File/folder operation tools (built-in, zero deps) */
export function createFileOpsTools(): RegisteredTool[] {
  return [
    createFileMkdirTool(),
    createFileRenameTool(),
    createFileCopyTool(),
    createFileStatTool(),
    createFileRmdirTool(),
  ];
}
