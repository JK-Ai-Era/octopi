import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Windows 上默认可能只绑 IPv6 [::1]，部分浏览器/IPv4 访问会连不上。
    // CLI `octopi webui start` 会按配置 web.host 传 `--host` 覆盖此处。
    host: 'localhost',
    port: 5173,
    strictPort: false,
  },
});
