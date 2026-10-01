import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@octopi-agent/gateway/web/sdk/client': resolve(here, '../gateway/src/web/sdk/client.ts'),
      '@octopi-agent/gateway/web/runtime/store': resolve(here, '../gateway/src/web/runtime/store.ts'),
      '@octopi-agent/gateway/web/conversation/types': resolve(here, '../gateway/src/web/conversation/types.ts'),
      '@octopi-agent/gateway': resolve(here, '../gateway/src'),
      '@octopi-agent/engine': resolve(here, '../engine/src'),
      '@octopi-agent/core': resolve(here, '../core/src/core'),
    },
  },
  server: {
    // Windows 上默认可能只绑 IPv6 [::1]，部分浏览器/IPv4 访问会连不上。
    // CLI `octopi webui start` 会按配置 web.host 传 `--host` 覆盖此处。
    host: 'localhost',
    port: 8180,
    strictPort: false,
  },
});
