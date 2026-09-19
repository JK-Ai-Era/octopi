/** sqlite-vec 可选依赖 — 无官方类型时的最小声明 */
declare module 'sqlite-vec' {
  const sqliteVec: {
    getLoadablePath?(): string;
  };
  export default sqliteVec;
}
