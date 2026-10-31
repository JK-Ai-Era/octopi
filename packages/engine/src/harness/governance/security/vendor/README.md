# Vendored: tree-sitter-bash.wasm

主 shell 解析引擎（`shell-parser-treesitter.ts`）依赖的 bash 语法 WASM。

## 溯源

| 项 | 值 |
|----|----|
| 语法上游 | `tree-sitter/tree-sitter-bash` tag **v0.25.1** (commit `a06c2e4415e9bc0346c6b86d401879ffb44058f7`, released 2025-12-02) |
| 构建来源 | npm `@2h2d/tree-sitter-wasms@0.2.1`（"Verified, lifecycle-free Tree-sitter grammar WASMs"，SLSA provenance attestation + trusted publishing） |
| 构建工具链 | tree-sitter 0.26.11 · wasi-sdk 33.0+m (llvm 22.1.0) · binaryen wasm-opt 131 |
| 文件 | `tree-sitter-bash.wasm` (1,358,594 bytes) |
| sha256 | `80f035925cb4b3ba1c5126e64189fbd8eab0c62a8c5881a8111658ca4697c8e8` |
| 许可 | `tree-sitter-bash.LICENSE.txt`（语法上游许可，MIT） |

`web-tree-sitter` 运行时（packages/engine dependency）版本需与语法 ABI 兼容，
升级任一侧后跑 `tests/harness/shell-parser-treesitter.test.ts` 验证（含加载冒烟）。

## 更新流程

1. 从上游 `tree-sitter/tree-sitter-bash` 的 release tag 构建 wasm
   （`tree-sitter build --wasm`，或采用带 provenance 证明的预编译源）。
2. 替换本目录 `tree-sitter-bash.wasm`，更新上表（版本 / commit / sha256 / 构建工具链）。
3. 跑 `npm run build`（copy-engine-assets 会把本目录拷入 dist）+ 安全测试全量。
