/**
 * @octopi-agent/gateway — HTTP/WS 进程面 + Channel + Web 运行时
 */

export { Gateway } from './gateway/gateway.js';
export type { GatewayConfig } from './types/gateway-config.js';
export { GatewayChatClient } from './gateway/client.js';
export { HttpChannelAdapter } from './protocols/http.js';
export type { StreamingChannelAdapter } from './protocols/http.js';
export { WebApiRouter } from './web/api/router.js';
export { OctopiClient } from './web/sdk/client.js';
export type {
  AgentEventEnvelope,
  MessageRecord,
  SessionTaskView,
  ModelCatalog,
  SessionModelView,
  CommandCatalogItemDto,
  PendingQuestion,
} from './web/sdk/client.js';
export { OctopiRuntimeStore } from './web/runtime/store.js';
export type { RunStatus, InspectorState } from './web/runtime/store.js';
export { ConversationAdapter } from './web/conversation/adapter.js';
export type { AdapterSnapshot } from './web/conversation/adapter.js';
export type {
  ConversationItem,
  ToolConversationItem,
  ViewMode,
} from './web/conversation/types.js';
export { GatewayOverrideConfigSchema } from './config-schema/gateway.js';
