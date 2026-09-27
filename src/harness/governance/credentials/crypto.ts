/**
 * 凭证密钥加解密 — AES-256-GCM
 *
 * 主密钥来源（非明文落盘）：
 * 1. 环境变量 OCTOPI_CREDENTIALS_KEY（hex/base64，32 字节）
 * 2. OCTOPI_CREDENTIALS_KEY_FILE（文件内容同上）
 *
 * 无主密钥时：写入/解密直接失败，不降级明文。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_ENV = 'OCTOPI_CREDENTIALS_KEY';
const KEY_FILE_ENV = 'OCTOPI_CREDENTIALS_KEY_FILE';

function parseKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty credential master key');
  // 64 hex chars → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  // base64 32 bytes
  try {
    const b = Buffer.from(trimmed, 'base64');
    if (b.length === 32) return b;
  } catch {
    // fall through to scrypt
  }
  // 口令形态：scrypt 派生 32 字节（盐固定于域分隔；口令应足够长）
  return scryptSync(trimmed, 'octopi.credentials.v1', 32);
}

/**
 * 读取主密钥
 *
 * @returns 32 字节主密钥
 * @throws 未配置时抛错
 */
export function loadCredentialMasterKey(): Buffer {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv?.trim()) return parseKeyMaterial(fromEnv);
  const file = process.env[KEY_FILE_ENV];
  if (file?.trim()) {
    const text = readFileSync(file, 'utf8');
    return parseKeyMaterial(text);
  }
  throw new Error(
    `credential master key not configured (set ${KEY_ENV} or ${KEY_FILE_ENV})`,
  );
}

/**
 * 加密密钥材料
 *
 * @param plaintext - 明文密钥
 * @param key - 32 字节主密钥
 */
export function encryptSecret(
  plaintext: string,
  key: Buffer = loadCredentialMasterKey(),
): { cipher: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: Buffer.concat([enc, tag]), nonce };
}

/**
 * 解密密钥材料
 *
 * @param cipher - 密文（含 GCM tag）
 * @param nonce - 12 字节 nonce
 * @param key - 32 字节主密钥
 */
export function decryptSecret(
  cipher: Buffer,
  nonce: Buffer,
  key: Buffer = loadCredentialMasterKey(),
): string {
  if (cipher.length < 17) throw new Error('credential cipher too short');
  const tag = cipher.subarray(cipher.length - 16);
  const body = cipher.subarray(0, cipher.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
