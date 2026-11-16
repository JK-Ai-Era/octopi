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
      // core 子路径：loop/* 在 src/loop（不在 src/core 下），长前缀先匹配
      '@octopi-agent/core/loop': resolve(here, '../core/src/loop'),
      '@octopi-agent/core': resolve(here, '../core/src/core'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 批 3-3 拆包：按真实模块图分组（rehype-highlight→lowlight→highlight.js/lib/core+languages，
        // 评m7：键名分组不会命中子路径）。vendor 缓存粒度细——产品代码小步快跑时用户命中缓存
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'vendor-react';
          if (id.includes('node_modules/highlight.js') || id.includes('node_modules/lowlight') || id.includes('node_modules/rehype-highlight')) {
            return 'vendor-hljs';
          }
          return undefined;
        },
      },
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
