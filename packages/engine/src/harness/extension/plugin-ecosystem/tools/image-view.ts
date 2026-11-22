/**
 * file_read 图像查看 —— 探测与成本闸（arch/file-read-image-view.md §2.1/§2.5）
 *
 * 职责边界：
 * - 魔数嗅探：只认内容不认扩展名（伪装扩展名必须能识别）
 * - 尺寸探测：纯 JS 头部解析，不引编解码器（probe 无损、零依赖）
 * - 成本闸：降采样 + 上限校验（超限 fail-loud 拒绝，不截断图）
 *
 * 判据（是否挂图）不在本模块——统一走 core `modelAcceptsInput`（§2.3 唯一出口）。
 */

/** 支持的光栅格式（嗅探面） */
export type RasterFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';

const MIME_BY_FORMAT: Record<RasterFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * 魔数嗅探：确认 buffer 是受支持的光栅图像并给出格式。
 *
 * @param buf - 文件头若干字节（≥32 即可判定全部支持格式）
 * @returns 格式；非受支持图像返回 null
 */
export function sniffRaster(buf: Uint8Array): RasterFormat | null {
  const at = (i: number): number => (i < buf.length ? buf[i] : -1);
  const ascii = (start: number, len: number): string => {
    let s = '';
    for (let i = start; i < start + len && i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && ascii(1, 3) === 'PNG' && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (ascii(0, 4) === 'GIF8' && (ascii(4, 2) === '7a' || ascii(4, 2) === '9a')) return 'gif';
  // WebP: "RIFF" .... "WEBP"
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  // BMP: "BM" + 合理 DIB 头尺寸（12/40/52/56/64/108/124）——纯两字节会误判文本
  if (ascii(0, 2) === 'BM') {
    if (buf.byteLength < 18) return null;
    const dib = (buf[14] | (buf[15] << 8) | (buf[16] << 16) | (buf[17] << 24)) >>> 0;
    return dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124
      ? 'bmp'
      : null;
  }
  return null;
}

/** 图像尺寸探测结果 */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * 光栅图尺寸探测（纯 JS 头部解析，无编解码）。
 *
 * @param buf - 文件完整内容或至少包含头部的截断
 * @param format - 嗅探得到的格式
 * @returns 尺寸；头部不可解析时返回 null（调用方按 fail-loud 处置）
 */
export function probeRasterSize(buf: Uint8Array, format: RasterFormat): ImageSize | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const be16 = (o: number): number => view.getUint16(o, false);
  const le16 = (o: number): number => view.getUint16(o, true);
  const be32 = (o: number): number => view.getUint32(o, false);
  const le32 = (o: number): number => view.getUint32(o, true);
  const fits = (o: number, bytes: number): boolean => o + bytes <= buf.byteLength;

  switch (format) {
    case 'png': {
      // IHDR 固定在 offset 16：宽高各 u32be
      if (!fits(16, 8)) return null;
      return { width: be32(16), height: be32(20) };
    }
    case 'gif': {
      // 逻辑屏幕描述符 offset 6：宽高各 u16le
      if (!fits(6, 4)) return null;
      return { width: le16(6), height: le16(8) };
    }
    case 'bmp': {
      // BITMAPFILEHEADER 14 字节 + DIB 头：宽高在 offset 18/22（i32le；高可为负=顶向下）
      if (!fits(22, 4)) return null;
      return { width: le32(18), height: Math.abs(view.getInt32(22, true)) };
    }
    case 'webp': {
      // 三种容器：VP8X（画布尺寸 24bit+1）/ VP8L（14bit 打包）/ VP8（帧头）
      if (!fits(12, 4)) return null;
      const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
      if (chunk === 'VP8X' && fits(24, 6)) {
        const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
        const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
        return { width: w + 1, height: h + 1 };
      }
      if (chunk === 'VP8L' && fits(21, 4)) {
        const b = buf;
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ' && fits(26, 7)) {
        // 帧标签 3 字节 + 同步码 9D 01 2A + u16le 宽高（14bit 有效）
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
        return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      }
      return null;
    }
    case 'jpeg': {
      // 扫描段找 SOFn（C0-C3/C5-C7/C9-CB/CD-CF）：高 u16be 在 +5，宽 u16be 在 +7
      let off = 2;
      while (off + 9 < buf.byteLength) {
        if (buf[off] !== 0xff) return null;
        const marker = buf[off + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          off += 2;
          continue;
        }
        const segLen = be16(off + 2);
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
          if (!fits(off + 7, 4)) return null;
          return { width: be16(off + 7), height: be16(off + 5) };
        }
        if (segLen < 2) return null;
        off += 2 + segLen;
      }
      return null;
    }
  }
}

/** 成本闸配置（数值走配置，无硬编码旋钮；见 config-schema/context.ts ImageCostGateSchema） */
export interface ImageCostGateConfig {
  /** 降采样目标长边（默认 1024） */
  maxEdge: number;
  /** 编码后字节上限（超限 fail-loud） */
  maxBytes: number;
  /** 输入像素上限（解码前拒绝，防解压炸弹） */
  maxPixels: number;
  /** JPEG/WebP 有损编码质量（默认 82） */
  quality: number;
}

/** 缺省成本闸（数值唯一来源；config schema 只声明 optional 无 default，缺省解析落到这里） */
export const DEFAULT_IMAGE_COST_GATE: ImageCostGateConfig = {
  maxEdge: 1024,
  maxBytes: 512 * 1024,
  maxPixels: 40_000_000,
  quality: 82,
};

/** 成本闸处置产物：降采样后的载荷字节 + 指针元信息（附件路线：字节入附件存储，结果只放引用） */
export interface CostGatedImage {
  /** 成本闸后载荷字节（入附件存储；永不进 result/JSONL） */
  bytes: Buffer;
  /** 实际载荷 MIME（GIF 转码 / WebP 兜底后跟载荷走） */
  mimeType: string;
  width: number;
  height: number;
  /** 载荷字节数 */
  sizeBytes: number;
  resized: boolean;
  /** 处置标注（如「动图取首帧」「maxBytes 兜底转码」）；无特殊处置不带 */
  note?: string;
}

/**
 * 成本闸：降采样长边 ≤ maxEdge + 上限校验。
 *
 * 超限语义是 **fail-loud 拒绝**（抛错），不是截断图——截断的图会让模型看到
 * 错误内容还以为看全了。降采样用 sharp（编解码唯一落点）；输入像素超限在
 * 解码前拒绝（解压炸弹防线）。
 *
 * @param raw - 原始文件字节
 * @param format - 嗅探格式
 * @param gate - 成本闸配置
 * @returns 降采样后的内嵌载荷与元信息
 * @throws 超出 maxPixels / maxBytes，或编解码失败（含具体原因）
 */
export async function applyImageCostGate(
  raw: Buffer,
  format: RasterFormat,
  gate: ImageCostGateConfig,
): Promise<CostGatedImage> {
  const sharp = (await import('sharp')).default;
  // limitInputPixels 在解码前生效（解压炸弹防线）
  const pipeline = sharp(raw, { limitInputPixels: gate.maxPixels, failOn: 'error' });
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`image_probe_failed: cannot determine dimensions of ${format} input`);
  }
  if (width * height > gate.maxPixels) {
    throw new Error(
      `image_too_large: ${width}x${height} (${width * height} px) exceeds maxPixels ${gate.maxPixels}`,
    );
  }

  const longEdge = Math.max(width, height);
  const needsResize = longEdge > gate.maxEdge;
  // 动图（GIF/WebP 动画）静态化取首帧——处置必须显式标注，不能静默改义
  const firstFrameOnly = (meta.pages ?? 1) > 1;
  const notes: string[] = [];
  if (firstFrameOnly) notes.push('animated input: first frame only');

  // 无缩放且体积已在闸内：原样放行（不重编码——无损输入不降质，JPEG 不二次有损）
  if (!needsResize && format !== 'gif' && raw.byteLength <= gate.maxBytes) {
    return {
      bytes: raw,
      mimeType: MIME_BY_FORMAT[format],
      width,
      height,
      sizeBytes: raw.byteLength,
      resized: false,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    };
  }

  // 需要改写：重开管线（resize 须在编码链前；metadata 管线已消费）
  const source = (): import('sharp').Sharp => {
    const p = sharp(raw, { limitInputPixels: gate.maxPixels, failOn: 'error' });
    return needsResize
      ? p.resize({ width: gate.maxEdge, height: gate.maxEdge, fit: 'inside', withoutEnlargement: true })
      : p;
  };
  // 有损格式保质量旋钮；GIF 首帧静态化转 PNG
  const native = (): import('sharp').Sharp =>
    format === 'jpeg'
      ? source().jpeg({ quality: gate.quality })
      : format === 'webp'
        ? source().webp({ quality: gate.quality })
        : format === 'gif'
          ? source().png()
          : source().png({ compressionLevel: 9 });

  let out = await native().toBuffer({ resolveWithObject: true });
  let outFormat: RasterFormat = format === 'gif' ? 'png' : format;

  // 体积兜底：原生编码超 maxBytes → WebP（保 alpha、体积小）重试；仍超限才 fail-loud
  if (out.info.size > gate.maxBytes && format !== 'webp') {
    out = await source().webp({ quality: gate.quality }).toBuffer({ resolveWithObject: true });
    outFormat = 'webp';
    notes.push(`transcoded to webp for maxBytes ${gate.maxBytes}`);
  }
  if (out.info.size > gate.maxBytes) {
    throw new Error(
      `image_too_large: encoded ${out.info.size} bytes exceeds maxBytes ${gate.maxBytes} ` +
        `(${width}x${height} → ${needsResize ? `long edge ${gate.maxEdge}` : 'no resize'}, webp q${gate.quality} fallback tried)`,
    );
  }

  return {
    bytes: out.data,
    mimeType: MIME_BY_FORMAT[outFormat],
    width: out.info.width,
    height: out.info.height,
    sizeBytes: out.info.size,
    resized: needsResize,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/**
 * 图像查看完整探测（嗅探 + 尺寸）：file_read 图像分支的入口。
 *
 * @param raw - 文件字节
 * @returns 嗅探格式 + 尺寸；非受支持图像返回 null
 */
export function probeImage(raw: Uint8Array): { format: RasterFormat; mime: string; size: ImageSize | null } | null {
  const format = sniffRaster(raw);
  if (!format) return null;
  return { format, mime: MIME_BY_FORMAT[format], size: probeRasterSize(raw, format) };
}

// ── SVG（arch/file-read-image-view.md §2.2）────────────────────────────
//
// 安全姿势（已实证 + 测试固化）：光栅化用 resvg（Rust，非脚本渲染器）——
// `<script>` 不执行、外部引用（http/file）不拉取。**禁止**改用任何会执行
// 脚本或解析网络/文件引用的渲染路径（如浏览器引擎快照）。

/** SVG 嗅探只看头部（前导声明 + 首个标签很短） */
const SVG_SNIFF_HEAD_BYTES = 4096;

/**
 * SVG 嗅探：首个元素标签是 `<svg` 才认（认内容不认扩展名）。
 *
 * 跳过 BOM / 空白 / `<?xml …?>` / `<!-- … -->` / `<!DOCTYPE …>`（含内部子集）。
 * 只做确定性认定——HTML/纯文本即便中段含 `<svg` 也不认。
 *
 * @param buf - 文件头若干字节
 * @returns 是 SVG 文档返回 true
 */
export function sniffSvg(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, SVG_SNIFF_HEAD_BYTES)).toString('utf-8').replace(/^\uFEFF/, '');
  let i = 0;
  while (i < head.length) {
    const ch = head[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (head.startsWith('<?', i)) {
      const end = head.indexOf('?>', i);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (head.startsWith('<!--', i)) {
      const end = head.indexOf('-->', i);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (head.startsWith('<!', i)) {
      // DOCTYPE 可带内部子集 […]：] 前的 > 不是结束
      const bracket = head.indexOf('[', i);
      let end = head.indexOf('>', i);
      if (bracket >= 0 && (end < 0 || bracket < end)) {
        const close = head.indexOf(']', bracket);
        if (close < 0) return false;
        end = head.indexOf('>', close);
      }
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    return /^<svg(?=[\s/>]|$)/i.test(head.slice(i));
  }
  return false;
}

/**
 * SVG 固有尺寸探测：width/height（绝对 px 数值）→ 否则 viewBox 宽高 → 否则 null。
 *
 * 百分比/物理单位（% / pt / cm …）不换算（渲染像素由 rasterize 的 zoom 决定），
 * 此尺寸只用于 maxPixels 防线与指针元信息。
 *
 * @param svgText - SVG 文本
 * @returns 尺寸；无法确定返回 null（调用方 fail-loud）
 */
export function probeSvgSize(svgText: string): ImageSize | null {
  const tag = /<svg\b[^>]*>/i.exec(svgText);
  if (!tag) return null;
  const attrs = tag[0];
  const attrVal = (name: string): string | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
    return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
  };
  const parseAbs = (v: string | null): number | null => {
    if (v === null) return null;
    const m = /^([0-9]*\.?[0-9]+)(px)?$/i.exec(v.trim());
    return m ? parseFloat(m[1]) : null;
  };
  const w = parseAbs(attrVal('width'));
  const h = parseAbs(attrVal('height'));
  if (w !== null && h !== null && w > 0 && h > 0) {
    return { width: Math.ceil(w), height: Math.ceil(h) };
  }
  const viewBox = attrVal('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.ceil(parts[2]), height: Math.ceil(parts[3]) };
    }
  }
  return null;
}

/**
 * SVG 光栅化 + 成本闸：resvg（非脚本渲染器）渲染 → PNG。
 *
 * 闸顺序：固有尺寸 maxPixels 防线（解码/渲染前拒绝）→ zoom 降采样长边 ≤ maxEdge
 * （不放大）→ 编码后 maxBytes fail-loud（拒绝而非截断）。
 *
 * @param raw - SVG 文件原始字节
 * @param gate - 成本闸配置
 * @returns 降采样后的 PNG 内嵌载荷与元信息
 * @throws 尺寸无法确定 / 超限 / 渲染失败（含具体原因）
 */
export async function renderSvgImage(raw: Buffer, gate: ImageCostGateConfig): Promise<CostGatedImage> {
  const svgText = raw.toString('utf-8');
  const size = probeSvgSize(svgText);
  if (!size) {
    throw new Error('svg_probe_failed: cannot determine SVG dimensions (no usable width/height/viewBox)');
  }
  if (size.width * size.height > gate.maxPixels) {
    throw new Error(
      `image_too_large: ${size.width}x${size.height} (${size.width * size.height} px) exceeds maxPixels ${gate.maxPixels}`,
    );
  }

  const resvgMod = (await import('@resvg/resvg-js')) as unknown as {
    Resvg?: new (svg: string, options?: Record<string, unknown>) => {
      render(): { asPng(): Buffer; width: number; height: number };
    };
    default?: {
      Resvg?: new (svg: string, options?: Record<string, unknown>) => {
        render(): { asPng(): Buffer; width: number; height: number };
      };
    };
  };
  const Resvg = resvgMod.Resvg ?? resvgMod.default?.Resvg;
  if (!Resvg) throw new Error('svg_render_failed: @resvg/resvg-js binding unavailable');

  const longEdge = Math.max(size.width, size.height);
  const zoom = Math.min(1, gate.maxEdge / longEdge);
  let rendered: Buffer;
  let width: number;
  let height: number;
  try {
    const img = new Resvg(svgText, { fitTo: { mode: 'zoom', value: zoom } }).render();
    rendered = img.asPng();
    width = img.width;
    height = img.height;
  } catch (err) {
    throw new Error(`svg_render_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rendered.byteLength > gate.maxBytes) {
    throw new Error(
      `image_too_large: encoded ${rendered.byteLength} bytes exceeds maxBytes ${gate.maxBytes} ` +
        `(svg ${size.width}x${size.height} → ${zoom < 1 ? `zoom ${zoom.toFixed(3)}` : 'no resize'})`,
    );
  }

  return {
    bytes: rendered,
    mimeType: 'image/png',
    width,
    height,
    sizeBytes: rendered.byteLength,
    resized: zoom < 1,
  };
}
