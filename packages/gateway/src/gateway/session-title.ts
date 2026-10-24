/**
 * 会话标题更新 — snippet 临时标题 / 小模型摘要
 *
 * 由 Gateway 在 turn 落盘后调用；失败不阻断主流程。
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { readTitleState } from '@octopi-agent/core/types/session.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  buildSnippetTitle,
  buildTitlePrompt,
  isTitleSignalReady,
  isWeakTitle,
  normalizeGeneratedTitle,
  shouldUpdateTitle,
} from '@octopi-agent/engine/harness/session/title.js';
import { pickSummarizeProvider } from '@octopi-agent/engine/harness/context/summarize.js';

export interface SessionTitleDeps {
  load(sessionId: string): Promise<SessionData | null>;
  /** 标题是用户数据：写 `metadata` 三键（updateMetadata 通道，与 pinnedAt 同款），不整包 save */
  patchMetadata(sessionId: string, mutate: (meta: Record<string, unknown>) => void): Promise<void>;
  providers: Map<string, ModelProvider>;
  modelLevels?: Record<string, { primary: string; fallback?: string[] }>;
  /** 兜底主模型 provider（level 未配置时） */
  resolveFallback(session: SessionData): { provider: ModelProvider; model?: string } | null;
  onTitleUpdated(
    sessionId: string,
    title: string,
    titleSource: 'snippet' | 'auto',
    agentId?: string,
  ): void;
}

/**
 * 按信号更新会话标题：snippet 兜底；信号足够时用小模型摘要。
 *
 * @param sessionId - 目标会话
 * @param deps - 存储 / 模型 / 回调
 * @returns 是否写入了标题
 */
export async function maybeUpdateSessionTitle(
  sessionId: string,
  deps: SessionTitleDeps,
): Promise<boolean> {
  const session = await deps.load(sessionId);
  if (!session) return false;
  if (!shouldUpdateTitle(readTitleState(session.metadata))) return false;

  if (isTitleSignalReady(session)) {
    const generated = await generateTitleWithModel(session, deps);
    if (generated) {
      return persistTitle(sessionId, generated, 'auto', deps);
    }
    // 模型失败：继续走 snippet 兜底（取有语义的用户消息，而不是「你好」）
  }

  const snippet = buildSnippetTitle(session.messages);
  if (!snippet) return false;
  // 已是同一 snippet 则不写盘；但 titleSource 可能仍是空的旧数据
  const current = readTitleState(session.metadata);
  if (snippet === current.title && current.titleSource) return false;
  console.warn(`[SessionTitle] snippet fallback: "${snippet}" (session=${sessionId})`);
  return persistTitle(sessionId, snippet, 'snippet', deps);
}

/**
 * 手动重命名（永不被自动覆盖）。
 *
 * 标题是用户数据：权威写 `session.metadata` 三键（持久化走 updateMetadata 通道，
 * 与 pinnedAt 同款，长驻 run 的整包 save 不回滚）；`session.meta` 三键只作
 * 内存内投影（返回值 / 广播即时一致），不要拿它当权威读。
 *
 * @param session - 会话数据（原地写 metadata 三键与 meta 投影）
 * @param title - 用户输入标题
 * @returns 规范化后的标题；空串返回 null
 */
export function applyUserTitle(session: SessionData, title: string): string | null {
  const t = normalizeGeneratedTitle(title) ?? title.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t) return null;
  const at = Date.now();
  session.metadata = session.metadata ?? {};
  session.metadata.title = t;
  session.metadata.titleSource = 'user';
  session.metadata.titleUpdatedAt = at;
  session.meta.title = t;
  session.meta.titleSource = 'user';
  session.meta.titleUpdatedAt = at;
  session.meta.updatedAt = at;
  return t;
}

/**
 * 写回标题前重读 session，避免用旧快照覆盖 Runner 刚写入的消息。
 *
 * 持久化走 updateMetadata 通道（不整包 save）：标题写入完全不触碰消息列表，
 * 从根上消除「标题写回覆盖并发落盘消息」的窗口。
 */
async function persistTitle(
  sessionId: string,
  title: string,
  titleSource: 'snippet' | 'auto',
  deps: SessionTitleDeps,
): Promise<boolean> {
  const latest = await deps.load(sessionId);
  if (!latest) return false;

  const now = Date.now();
  let written = false;
  await deps.patchMetadata(sessionId, (meta) => {
    // 守卫在 updateMetadata 写锁临界区内重读重判：load→patch 之间的并发 rename
    // 不得被自动标题覆盖（早判快照会漏掉这个窗口，且覆盖会把 titleUpdatedAt 推到
    // now、令后续 save 仲裁也无法还原）
    const current = readTitleState(meta);
    if (!shouldUpdateTitle(current)) return;
    if ((current.titleUpdatedAt ?? 0) > now) return;
    if (current.title === title && current.titleSource === titleSource) return;
    meta.title = title;
    meta.titleSource = titleSource;
    meta.titleUpdatedAt = now;
    written = true;
  });
  if (!written) return false;
  deps.onTitleUpdated(sessionId, title, titleSource, latest.agentId ?? latest.meta.agentId);
  return true;
}

async function generateTitleWithModel(
  session: SessionData,
  deps: SessionTitleDeps,
): Promise<string | null> {
  const fallback = deps.resolveFallback(session);
  const baseProvider = fallback?.provider ?? [...deps.providers.values()][0];
  if (!baseProvider) return null;

  const picked = pickSummarizeProvider(deps.providers, deps.modelLevels, baseProvider);
  const candidates: Array<{ provider: ModelProvider; model?: string; label: string }> = [
    { provider: picked.provider, model: picked.model ?? fallback?.model, label: 'summary' },
  ];
  if (fallback && fallback.provider !== picked.provider) {
    candidates.push({ provider: fallback.provider, model: fallback.model, label: 'session' });
  }

  for (const c of candidates) {
    if (!c.provider) continue;
    try {
      const response = await c.provider.chat({
        messages: buildTitlePrompt(session.messages),
        model: c.model,
        temperature: 0.1,
        maxTokens: 64,
      });
      const title = normalizeGeneratedTitle(response.content ?? '');
      if (title && !isWeakTitle(title)) {
        console.warn(`[SessionTitle] generated via ${c.label}: "${title}" (session=${session.id})`);
        return title;
      }
      console.warn(
        `[SessionTitle] ${c.label} model returned weak/empty title: ${JSON.stringify(response.content ?? '')} (session=${session.id})`,
      );
    } catch (err) {
      // 单路失败换下一候选；全失败由调用方走 snippet，不中断对话
      console.warn(
        `[SessionTitle] ${c.label} model failed (session=${session.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}
