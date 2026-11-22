/**
 * 附件图像水合 —— url 形态 ImageBlock → data 形态（wire 发送前的视图级纯变换）
 *
 * 附件路线（arch/file-read-image-view.md §0/§2.1）的 wire 面：session 持久层只存
 * 引用（url 形态块 / attachmentId），请求构建时才把 root 内图像字节读出、换成
 * data 形态。base64 只活在请求里，不落持久层。
 *
 * 边界（M1-B 评审 B2/M4/M6 加固）：
 * - containment 用 `isPathUnderRoots`（真坐标：目录符号链接逃逸实测可绕词法前缀，
 *   见 shared/paths 原语说明）+ `readFileNoFollow`（末段 O_NOFOLLOW）；
 * - **派生区（derived/）不重闸**：载荷入库时已过成本闸，水合原样放行——
 *   结果元信息与 wire 载荷恒一致（不出现「存 2048 发 1024」的说谎元数据）；
 *   用户上传区（attachments/）过成本闸（无预闸）；
 * - 模型无图像能力 / 结果已老化 → 直接跳过（不读盘不编码）；
 * - 越界 / 缺失 / 非图像 / 闸失败 → 保持 url 形态并把**原因**写进块 note，
 *   由 convertContentBlock 降级文字指针（显式，不静默）；同时 console.warn 一次；
 * - 克隆式变换 + 按消息 memo（消息写后不可变）：不改传入消息、同消息不重复读盘。
 */

import type { Message } from '@octopi-agent/core/types.js';
import { stat } from 'node:fs/promises';
import { isPathUnderRoots, readFileNoFollow } from '../../shared/paths/index.js';
import { readImageRef } from '../../context/tool-result-body.js';
import { modelAcceptsInput } from '@octopi-agent/core/types/agent-definition.js';
import {
  DEFAULT_IMAGE_COST_GATE,
  applyImageCostGate,
  probeImage,
  type ImageCostGateConfig,
} from '../../extension/plugin-ecosystem/tools/image-view.js';

export interface HydrateImageOptions {
  /** 允许水合的根（该会话 attachments/ 与 derived/）；真坐标 containment */
  roots: string[];
  /** 派生区根（derived/：载荷入库时已闸过，水合不重闸） */
  derivedRoot?: string;
  /** 成本闸（仅用户上传区；派生区已闸过不重闸） */
  gate?: ImageCostGateConfig;
  /** 模型输入模态（无 image 能力直接跳过——不读盘不编码） */
  modelInput?: Array<'text' | 'image' | 'audio' | 'video'>;
  /** 已老化结果的 toolCallId（其信封块必然不发——跳过） */
  agedToolCallIds?: ReadonlySet<string>;
}

type LooseBlock = { type?: string; [key: string]: unknown };

/** 用户上传区预检上限（超出不水合、标注原因；附件服务上限 25MB） */
const HYDRATE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

/** 消息级水合 memo（消息写后不可变 → 引用键安全；同消息跨装配点零重复 IO） */
const memo = new WeakMap<Message, Message>();

/**
 * 水合一批消息的图像块（消息 content + 工具结果信封块）。
 *
 * @param messages - 视图消息（只读输入）
 * @param opts - 水合边界
 * @returns 克隆后的消息数组（无可水合块时返回原数组）
 */
export async function hydrateAttachmentImages(
  messages: Message[],
  opts: HydrateImageOptions,
): Promise<Message[]> {
  if (!modelAcceptsInput(opts.modelInput, 'image')) return messages;
  let anyChanged = false;
  const out: Message[] = [];
  for (const m of messages) {
    const hit = memo.get(m);
    if (hit) {
      if (hit !== m) anyChanged = true;
      out.push(hit);
      continue;
    }

    let content = m.content;
    let contentChanged = false;
    if (Array.isArray(content)) {
      const blocks = content as unknown as LooseBlock[];
      const hydrated: LooseBlock[] = [];
      for (const b of blocks) {
        const hb = await hydrateBlock(b, opts);
        if (hb !== b) contentChanged = true;
        hydrated.push(hb);
      }
      if (contentChanged) content = hydrated as never;
    }

    let toolResults = m.toolResults;
    let trChanged = false;
    if (toolResults && toolResults.length > 0) {
      const trs: typeof toolResults = [];
      for (const tr of toolResults) {
        if (opts.agedToolCallIds?.has(tr.toolCallId)) {
          trs.push(tr);
          continue;
        }
        const newResult = await hydrateResultImageRef(tr.result, opts);
        if (newResult === tr.result) {
          trs.push(tr);
          continue;
        }
        trChanged = true;
        trs.push({ ...tr, result: newResult });
      }
      if (trChanged) toolResults = trs;
    }

    const hydratedMsg =
      contentChanged || trChanged ? { ...m, content, toolResults } : m;
    if (contentChanged || trChanged) anyChanged = true;
    memo.set(m, hydratedMsg);
    out.push(hydratedMsg);
  }
  return anyChanged ? out : messages;
}

/** 结果图像引用水合（imageRef url → data 形态副本；无引用/未变化原样返回同一引用） */
async function hydrateResultImageRef(result: unknown, opts: HydrateImageOptions): Promise<unknown> {
  const ref = readImageRef(result);
  if (!ref) return result;
  const block = { type: 'image', ...ref };
  const hb = await hydrateBlock(block as LooseBlock, opts);
  if (hb === block) return result;
  const { type: _type, ...nextRef } = hb as Record<string, unknown>;
  return { ...(result as Record<string, unknown>), imageRef: nextRef };
}

/** 单块水合：url 形态本地图像 → data 形态；其余原样（同引用） */
async function hydrateBlock(block: LooseBlock, opts: HydrateImageOptions): Promise<LooseBlock> {
  if (!block || typeof block !== 'object' || block.type !== 'image') return block;
  const data = typeof block.data === 'string' ? block.data : '';
  if (data.length > 0) return block;
  const url = typeof block.url === 'string' ? block.url : '';
  if (!url || /^(https?|data):/i.test(url)) return block;

  // 真坐标 containment（目录符号链接逃逸在此拒绝）；失败标注原因，不静默
  if (!isPathUnderRoots(url, opts.roots)) {
    return markUnhydrated(block, 'outside attachment roots');
  }

  try {
    const st = await stat(url);
    if (st.size > HYDRATE_MAX_SOURCE_BYTES) {
      return markUnhydrated(block, `source too large (${st.size}B)`);
    }
    const raw = await readFileNoFollow(url, 'buffer');
    const image = probeImage(raw);
    if (!image) return markUnhydrated(block, 'not a raster image');
    // 派生区载荷已闸过：原样放行，不重编码（元信息与 wire 载荷恒一致）
    const derived = opts.derivedRoot ? isPathUnderRoots(url, [opts.derivedRoot]) : false;
    const gated = derived
      ? { bytes: raw, mimeType: image.mime }
      : await applyImageCostGate(raw, image.format, opts.gate ?? DEFAULT_IMAGE_COST_GATE);
    return {
      ...block,
      data: gated.bytes.toString('base64'),
      mimeType: gated.mimeType,
    };
  } catch (err) {
    return markUnhydrated(block, err instanceof Error ? err.message : String(err));
  }
}

/** 未水合标注：块保持 url 形态 + note（wire 降级文字带原因，M6） */
function markUnhydrated(block: LooseBlock, reason: string): LooseBlock {
  console.warn(`[hydrate-image] not hydrated: ${reason} (${String(block.url ?? '')})`);
  return { ...block, note: reason };
}
