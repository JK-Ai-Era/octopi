/**
 * Static file server for prebuilt WebUI dist (product path — no Vite).
 *
 * Spawn: node dist/cli/serve-webui.js <distDir> [--host <host>] [--port <port>]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';

const distArg = process.argv[2];
if (!distArg) {
  console.error('usage: serve-webui <distDir> [--host host] [--port port]');
  process.exit(1);
}

const distDir = resolve(distArg);
let host = '127.0.0.1';
let port = 8180;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--host' && process.argv[i + 1]) host = process.argv[++i];
  if (process.argv[i] === '--port' && process.argv[i + 1]) port = Number(process.argv[++i]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(root, rel);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let file = safeJoin(distDir, req.url || '/');
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    // SPA fallback
    if (!st?.isFile()) {
      file = join(distDir, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      res.writeHead(404).end('Not Found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`[serve-webui] ${distDir} → http://${host}:${port}`);
});
