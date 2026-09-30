/**
 * CommandPlugin 已由 CommandRouter 取代（会话内斜杠命令调用面）。
 *
 * 保留导出面：CommandRouter / parse / builtin / skill-bridge。
 */

export type {
  ArgSpec,
  CommandCatalogItem,
  CommandConflict,
  CommandConflictCandidate,
  CommandContext,
  CommandDefinition,
  CommandEffect,
  CommandInvoker,
  CommandKind,
  CommandRegisterResult,
  CommandResult,
  CommandRisk,
  CommandSource,
  ConflictPolicy,
  DisplayPayload,
  ExpandedMessages,
  PrincipalRef,
  SessionOp,
  SessionReadView,
} from './types.js';

export {
  normalizeCommandName,
  parseCommand,
  unescapeLiteralSlash,
} from './parse.js';
export type { ParsedCommand } from './parse.js';

export { CommandRouter } from './router.js';
export type {
  CommandRouterOptions,
  ExecuteCommandInput,
  ExecuteCommandOutcome,
} from './router.js';

export {
  createBuiltinCommands,
  createClientCatalogCommand,
  issuesFromRegistry,
} from './builtin.js';
export type { BuiltinHost } from './builtin.js';

export {
  isValidCommandFieldName,
  skillCommandsFromManager,
} from './skill-bridge.js';

export { loadUserCommandDefs } from './user-source.js';

export { pluginCommandsFromManager } from './plugin-bridge.js';
