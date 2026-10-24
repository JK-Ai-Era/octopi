/**
 * 配置修补原语 — raw JSON（未展开 `${ENV}`）段级读写 + 乐观锁 hash + 引用完整性
 *
 * 语义对齐 doctor --fix 写回先例：操作 **raw** 对象，占位符原样保留。
 * 文件 IO（备份/原子写）在根包 FileConfigService，本模块纯函数无 IO。
 *
 * @module
 */

import { createHash } from 'node:crypto';

/**
 * 配置内容 hash（乐观锁）
 *
 * WebUI 保存前带 `expectedHash`；与当前盘上内容 hash 不一致 = 并发编辑冲突，
 * 拒绝写入让用户选择（arch/config-hot-reload.md §0）。对**原始文本**做 hash，
 * 相同语义不同缩进也算冲突——保守正确。
 *
 * @param rawText - 配置文件原始文本
 * @returns sha256 hex
 */
export function computeConfigHash(rawText: string): string {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

/**
 * 按路径读取 raw JSON 值
 *
 * @param raw - raw 对象
 * @param path - 路径段（对象键名或数组下标）
 * @returns 命中的值；任一段缺失返回 undefined
 */
export function getJsonPath(raw: unknown, path: Array<string | number>): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/**
 * 按路径写入 raw JSON 值（中间缺失的对象自动创建；数组下标越界即抛错）
 *
 * @param raw - raw 对象（就地修改）
 * @param path - 路径段
 * @param value - 写入值
 * @throws 路径中间为原始值、或数组下标越界时抛错（fail-loud）
 */
export function setJsonPath(raw: Record<string, unknown>, path: Array<string | number>, value: unknown): void {
  if (path.length === 0) throw new Error('setJsonPath: empty path');
  let cur: Record<string | number, unknown> = raw;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object') {
      cur[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur) && typeof last === 'number' && (last < 0 || last > cur.length)) {
    throw new Error(`setJsonPath: array index out of range: ${last}`);
  }
  if (Array.isArray(cur) && typeof last === 'number' && last === cur.length) {
    cur.push(value);
  } else {
    cur[last] = value;
  }
}

/**
 * 按路径删除 raw JSON 值（对象键 delete；数组下标 splice）
 *
 * @param raw - raw 对象（就地修改）
 * @param path - 路径段
 * @throws 路径未命中时抛错（fail-loud，避免静默 no-op 造成「以为删了」）
 */
export function deleteJsonPath(raw: Record<string, unknown>, path: Array<string | number>): void {
  if (path.length === 0) throw new Error('deleteJsonPath: empty path');
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = parentPath.length === 0 ? raw : getJsonPath(raw, parentPath);
  if (parent === null || typeof parent !== 'object') {
    throw new Error(`deleteJsonPath: path not found: ${path.join('.')}`);
  }
  if (Array.isArray(parent)) {
    if (typeof last !== 'number' || last < 0 || last >= parent.length) {
      throw new Error(`deleteJsonPath: array index out of range: ${last}`);
    }
    parent.splice(last, 1);
    return;
  }
  const record = parent as Record<string | number, unknown>;
  if (!(last in record)) {
    throw new Error(`deleteJsonPath: key not found: ${path.join('.')}`);
  }
  delete record[last];
}

/**
 * 解析 model 引用中的 provider 名
 *
 * 与 resolveModelConfig 同一约定：`provider/model` 取斜杠前段；裸名/level 名
 * 无法直接归 provider，交 `findProviderReferences` 的 levelMap 递归处理。
 *
 * @param ref - model 引用字符串
 * @returns provider 名；裸名返回 null
 */
function parseProviderFromRef(ref: string): string | null {
  const idx = ref.indexOf('/');
  return idx > 0 ? ref.slice(0, idx) : null;
}

/**
 * provider 引用完整性：找出引用了指定 provider 的配置点
 *
 * 用于删除 provider 前的拒绝检查（arch/config-hot-reload.md §5.1）。**保守扫描**：
 * 覆盖 `agents[].model`（字符串 / 对象 / fallbackModels）与 `models.level.*`
 * （primary / fallback）；宁可多报疑似引用，不可漏报造成断链。
 *
 * @param raw - raw 配置对象
 * @param providerName - 待检查的 provider 名
 * @returns 引用点描述数组（如 `agents[assistant].model`）；无引用返回空数组
 */
export function findProviderReferences(raw: Record<string, unknown>, providerName: string): string[] {
  const hits: string[] = [];
  const models = raw.models as Record<string, unknown> | undefined;
  const levelMap = models?.level as Record<string, unknown> | undefined;
  /** levelName → 该 level 是否引用 provider（缓存；预置 false 防循环引用） */
  const levelRefs = new Map<string, boolean>();

  const checkLevel = (level: Record<string, unknown>, where: string): void => {
    if (typeof level.primary === 'string') checkModelValue(level.primary, `${where}.primary`);
    if (Array.isArray(level.fallback)) {
      level.fallback.forEach((f, i) => checkModelValue(f, `${where}.fallback[${i}]`));
    }
  };

  /** 判断 level 是否引用 provider（命中时记 level 内部位置；调用方记引用者位置） */
  const levelRefCheck = (levelName: string): boolean => {
    const cached = levelRefs.get(levelName);
    if (cached !== undefined) return cached;
    levelRefs.set(levelName, false); // 防循环引用
    const level = levelMap?.[levelName] as Record<string, unknown> | undefined;
    let found = false;
    if (level && typeof level === 'object') {
      const before = hits.length;
      checkLevel(level, `models.level.${levelName}`);
      found = hits.length > before;
    }
    levelRefs.set(levelName, found);
    return found;
  };

  const checkModelValue = (value: unknown, where: string): void => {
    if (typeof value === 'string') {
      if (parseProviderFromRef(value) === providerName) {
        hits.push(where);
        return;
      }
      // 裸名：可能是 level 引用，命中则引用点一并记录
      if (levelMap && levelRefCheck(value)) {
        hits.push(where);
      }
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.provider === providerName) hits.push(where);
    }
  };

  const agents = Array.isArray(raw.agents) ? (raw.agents as Array<Record<string, unknown>>) : [];
  agents.forEach((agent, i) => {
    const id = typeof agent.id === 'string' ? agent.id : String(i);
    const where = `agents[${id}]`;
    checkModelValue(agent.model, `${where}.model`);
    const model = agent.model as Record<string, unknown> | undefined;
    if (model && Array.isArray(model.fallbackModels)) {
      model.fallbackModels.forEach((f, j) => checkModelValue(f, `${where}.model.fallbackModels[${j}]`));
    }
  });

  if (levelMap) {
    for (const levelName of Object.keys(levelMap)) {
      levelRefCheck(levelName);
    }
  }

  // models.embedding.provider 也是真实引用（漏扫会静默断 embedding）
  const embedding = models?.embedding as Record<string, unknown> | undefined;
  if (embedding && typeof embedding.provider === 'string' && embedding.provider === providerName) {
    hits.push('models.embedding.provider');
  }

  // concurrency.providerPool.slots[].provider（slot 引用）
  const concurrency = raw.concurrency as Record<string, unknown> | undefined;
  const pool = concurrency?.providerPool as Record<string, unknown> | undefined;
  if (Array.isArray(pool?.slots)) {
    (pool.slots as Array<Record<string, unknown>>).forEach((slot, i) => {
      if (slot?.provider === providerName) {
        hits.push(`concurrency.providerPool.slots[${i}].provider`);
      }
    });
  }

  return hits;
}
