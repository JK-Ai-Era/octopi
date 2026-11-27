/**
 * Knowledge source location — 归一化与词法校验（写入口唯一真相）
 *
 * 为什么在 Service 写入口做：location 是落库数据，UI 只是众多调用方之一
 * （Gateway 的会话附件、CLI、未来 MCP 工具都会注册源）。只在 UI 里清洗，
 * 别的调用方仍会把 `"C:\Users\me\docs"` 这类带引号的粘贴值写进库，索引时
 * 表现为「0 文件、无报错」的死源。
 *
 * 边界：
 * - 词法校验（去包裹引号/空白、绝对路径、URL scheme）不 stat；盘上是否存在由 ingest
 *   负责，写成源级 error（显式失败），不阻断注册把离线盘/稍后挂载的路径提前登记。
 * - 本地类返回 **canonical 形态**（最深存在前缀 realpath + 尾段原样；前缀全不存在则
 *   原样返回）——ingest 复检 `resolveCanonicalLocation(location) === location` 即漂移
 *   闸（R5 围栏，arch/multi-tenancy.md §9.1-19），防登记后路径被换/软链换向。
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { getOctopiHome } from '../../paths.js';
import { normalizePathLexical } from './file-identity.js';
import type { KnowledgeSourceKind } from './types.js';

/**
 * 注册入口允许的源类型（**唯一真相**）。
 *
 * 用 `Record<KnowledgeSourceKind, true>` 做穷举：将来给 `KnowledgeSourceKind`
 * 加成员而忘记在此登记，会直接编译失败——避免 gateway / HTTP 校验 / ingest
 * 各留一份 `new Set([...])` 而互相漂移。
 */
const KIND_TABLE: Record<KnowledgeSourceKind, true> = {
  workspace: true,
  directory: true,
  file: true,
  url: true,
  connector: true,
};

export const KNOWLEDGE_SOURCE_KINDS: readonly KnowledgeSourceKind[] = Object.keys(
  KIND_TABLE,
) as KnowledgeSourceKind[];

/** 成对包裹引号：Windows「复制为路径」、中文输入法、shell 复制都会带上 */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['`', '`'],
];

/**
 * 去两端空白与成对包裹引号（可多层，如 `" 'C:\x' "`）。
 *
 * @param raw - 用户/调用方原始输入
 * @returns 去除包裹后的文本（可能为空串）
 */
export function stripLocationWrapping(raw: string): string {
  let out = raw.trim();
  let stripped = true;
  while (stripped && out.length >= 2) {
    stripped = false;
    for (const [open, close] of WRAPPING_QUOTES) {
      if (out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return out;
}

function locationError(message: string, code = 'location_invalid'): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * canonical 化本地路径：最深存在的祖先做 realpath，尾段（尚不存在的叶子）原样拼回。
 * 前缀全不存在（含他平台风格路径）→ 原样返回，不猜测、不改写。
 *
 * @param path - 绝对路径（调用方先过 normalizeSourceLocation）
 * @returns canonical 形态
 */
export function resolveCanonicalLocation(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      if (!isAbsolute(head)) return path; // 无存在前缀：保持原样（含他平台风格路径）
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * path 是否位于 dir 内（含 dir 自身）。
 *
 * **围栏专用** containment 判定：在默认大小写不敏感的文件系统（macOS/Windows）上比较前
 * 折叠大小写——realpath 保留查询写法，大小写敏感的前缀比较会被 `/Users/JK/.octopi` 一类
 * 变体绕过（评审 BLOCKER-2）。折叠仅限本围栏判定；文件查找/删除层的身份语义不变
 * （「大小写变体是不同身份」契约，knowledge-promotion C2′）。
 */
function isInside(path: string, dir: string): boolean {
  const fold =
    process.platform === 'win32' || process.platform === 'darwin'
      ? (s: string): string => s.toLowerCase()
      : (s: string): string => s;
  const p = fold(path);
  const d = fold(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** 本地文件系统类源（受围栏/漂移闸/ canonical 化；url/connector 不读盘） */
export function isLocalPathKind(kind: KnowledgeSourceKind): boolean {
  return kind === 'workspace' || kind === 'directory' || kind === 'file';
}

/**
 * 知识源 location 租户围栏（R5，arch/multi-tenancy.md §9.1-19；单源判定，勿复制）。
 *
 * 口径（大哥 2026-11-28 拍板）：knowledge 是外部世界的信息——任意外部路径可引；但
 * 「运行时内部态」（OCTOPI_HOME 树：会话/凭据/配置/registry/他租户家当……）不是外部
 * 世界，整体禁入，唯一放行 `workspace/<写者租户>/**`（自己的工作产物）。host 面/平台
 * admin 豁免（运维口子）。realpath 解析后判定，防软链绕过。
 *
 * @param writer - 写者（归属租户 + 是否豁免）
 * @param kind - 源类型（仅本地类受围栏）
 * @param rawLocation - 原始 location
 * @returns allowed=true 附 canonical 形态；allowed=false 附 fail-loud 原因（含
 *   `location_invalid`：路径本身不合法——本函数只裁决不抛异常，评审 MINOR-8）
 */
export function isKnowledgeLocationAllowed(
  writer: { tenantId: string; fenceExempt: boolean },
  kind: KnowledgeSourceKind,
  rawLocation: string,
):
  | { allowed: true; canonical: string }
  | { allowed: false; code: 'location_forbidden' | 'location_invalid'; reason: string } {
  if (!isLocalPathKind(kind)) {
    return { allowed: true, canonical: rawLocation };
  }
  let location: string;
  try {
    location = normalizeSourceLocation(kind, rawLocation);
  } catch (err) {
    return {
      allowed: false,
      code: 'location_invalid',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const canonical = resolveCanonicalLocation(location);
  if (writer.fenceExempt) return { allowed: true, canonical };
  const home = resolveCanonicalLocation(getOctopiHome());
  if (!isInside(canonical, home)) return { allowed: true, canonical };
  const ownWorkspace = resolveCanonicalLocation(join(home, 'workspace', writer.tenantId));
  if (isInside(canonical, ownWorkspace)) return { allowed: true, canonical };
  return {
    allowed: false,
    code: 'location_forbidden',
    reason: `location resolves inside runtime internals (outside own tenant workspace): ${canonical}`,
  };
}

/**
 * 写入形态闸（R5 / 评审 MAJOR-5，反「登记期换向」TOCTOU）：本地类 location 落库前必须
 * **已是 canonical 形态且自洽**（`resolveCanonicalLocation(x) === x`）。登记面把
 * `isKnowledgeLocationAllowed` 裁决出的 canonical 原样传下来——判定与落库用同一字符串；
 * 判定之后被换向（改名 + 软链顶替）即在此被拒。漏斗不替调用方改写：替调用方 resolve
 * 等于把换向结果洗白入库（漂移闸随后自洽、永不复检）。
 *
 * @param kind - 源类型（非本地类沿用 normalizeSourceLocation 契约）
 * @param rawLocation - 调用方提供的 location
 * @returns 原样返回（自洽 canonical 形态）
 * @throws Error(code='location_must_be_canonical') 形态不自洽（非 canonical 输入或判定后换向）
 */
/**
 * 派生源行的围栏豁免标记（评审 MAJOR-3a，2026-11-28 拍板）：
 * `fenceExempt = 登记面资格 ∧ 行指向运行时内部态`。
 *
 * - **资格**（exemptionGranted）只有登记面知道：host 面/平台 admin 豁免身份，或宿主管线
 *   （附件检索）显式声明——经受信链（gateway→client→writer-service）传入，绝不接受 wire
 *   声明（用户 input 无此通道）。
 * - **∧ 内部态**（无豁免判定 denied）收窄标记：外部行恒 0——即使资格者登记的行后来被换向
 *   到内部态，drift 闸 + 无标记复判双重拦截，不因「登记过」而白送豁免。
 *
 * ingest 读取复判按行上标记放行；写入口（writer-service）落库时推导。
 *
 * @param exemptionGranted - 登记面资格（writer.isPlatformAdmin 或宿主管线显式）
 * @param ownerTenantId - 行的归属租户域（落库域）
 * @param kind - 源类型（非本地类不受围栏 → 恒 false）
 * @param canonicalLocation - 已过写入形态闸的 canonical location
 * @returns true = 该行指向内部态且登记面有豁免资格 → 读取复判放行
 */
export function deriveFenceExempt(
  exemptionGranted: boolean,
  ownerTenantId: string,
  kind: KnowledgeSourceKind,
  canonicalLocation: string,
): boolean {
  if (!exemptionGranted || !isLocalPathKind(kind)) return false;
  return !isKnowledgeLocationAllowed(
    { tenantId: ownerTenantId, fenceExempt: false },
    kind,
    canonicalLocation,
  ).allowed;
}

export function assertStableCanonicalLocation(
  kind: KnowledgeSourceKind,
  rawLocation: string,
): string {
  const form = normalizeSourceForm(kind, rawLocation);
  if (!isLocalPathKind(kind)) return form;
  const canonical = resolveCanonicalLocation(form);
  if (canonical !== form) {
    throw locationError(
      `location_must_be_canonical: pass the canonical form returned by the fence (resolution differs: ${form} -> ${canonical})`,
      'location_must_be_canonical',
    );
  }
  return form;
}

/**
 * 归一化并校验源 location。
 *
 * - 本地类（workspace / directory / file）：必须是绝对路径（词法判定，不要求存在）
 * - url：必须是 http(s)
 * - connector：JSON 配置串（可解析）或 http(s) 的 list URL
 *
 * @param kind - 源类型
 * @param raw - 原始 location
 * @returns 归一化后的 location（本地类 = canonical 形态：最深存在前缀 realpath + 尾段）
 * @throws Error(code='location_invalid') 归一化后仍不合法
 */
export function normalizeSourceLocation(kind: KnowledgeSourceKind, raw: string): string {
  const form = normalizeSourceForm(kind, raw);
  return isLocalPathKind(kind) ? resolveCanonicalLocation(form) : form;
}

/** 词法归一 + 校验（不 resolve）：本地类返回绝对词法形态，其余同 normalizeSourceLocation */
function normalizeSourceForm(kind: KnowledgeSourceKind, raw: string): string {
  if (!KNOWLEDGE_SOURCE_KINDS.includes(kind)) {
    throw locationError(`invalid kind: ${kind}`);
  }
  const location = stripLocationWrapping(raw);
  if (!location) {
    throw locationError('location is required');
  }
  if (isLocalPathKind(kind)) {
    try {
      normalizePathLexical(location);
    } catch {
      throw locationError(
        `location must be an absolute path (got "${location}"); example: /Users/you/docs or C:/Users/you/docs`,
      );
    }
    return location;
  }
  if (kind === 'url') {
    if (!/^https?:\/\//i.test(location)) {
      throw locationError(`url source location must be http(s): ${location}`);
    }
    return location;
  }
  // connector
  if (location.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(location);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
    } catch {
      throw locationError('connector location JSON is invalid');
    }
    return location;
  }
  if (!/^https?:\/\//i.test(location)) {
    throw locationError(`connector location must be a JSON config or http(s) URL: ${location}`);
  }
  return location;
}
