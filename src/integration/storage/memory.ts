/**
 * Storage memory module surface
 *
 * InMemorySessionStore 实现见 harness/session/in-memory-store.ts（Session 域纯内存默认实现）。
 * 本文件保持 Integration 存储入口的导出面，供测试与嵌入方按存储路径引用。
 */

export { InMemorySessionStore } from '../../harness/session/in-memory-store.js';
