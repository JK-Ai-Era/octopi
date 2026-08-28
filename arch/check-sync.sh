#!/bin/bash
# arch/check-sync.sh — 检查 arch/ 是否与代码同步
#
# 设计原则：
#   1. 动态发现 — 从 src/ 实际文件结构出发，不硬编码文件列表
#   2. 双向对比 — 既检查"代码中有但文档没提"，也检查"文档提了但代码中没有"
#   3. 自检查 — 覆盖所有 src/ 顶层目录，不遗漏新增模块
#
# 使用方法：
#   bash ~/Projects/octopi/arch/check-sync.sh
#
# 退出码：
#   0 — 全部通过
#   1 — 有问题需要关注

set -e

PROJECT=~/Projects/octopi
ARCH=~/Projects/octopi/arch
issues=0

echo "🔍 Octopi arch/ 同步检查"
echo "========================="
echo ""

# ──────────────────────────────────────────────
# 1. 模块存在性检查（动态发现）
#
# 不硬编码文件列表，而是从 src/ 的实际目录结构出发，
# 检查每个目录/文件是否在 arch/ 中被记录。
# ──────────────────────────────────────────────
echo "📦 模块存在性检查（动态发现）："

# 收集 src/ 下所有 .ts 文件（排除 index.ts 和测试相关）
src_files=$(find "$PROJECT/src" -name "*.ts" -not -name "index.ts" -not -path "*/node_modules/*" | sort)

# 从 arch/overview.md 提取所有被引用的文件路径
arch_referenced=$(grep -oE 'src/[a-zA-Z0-9_/.-]+\.ts' "$ARCH/overview.md" 2>/dev/null | sort -u || true)
arch_dep_referenced=$(grep -oE 'src/[a-zA-Z0-9_/.-]+\.ts' "$ARCH/dependency-map.md" 2>/dev/null | sort -u || true)
all_arch_referenced=$(echo -e "$arch_referenced\n$arch_dep_referenced" | sort -u | grep -v '^$' || true)

# 双向对比
unreferenced=0
echo ""
echo "  📁 src/ 文件总数: $(echo "$src_files" | wc -l | tr -d ' ')"
echo "  📝 arch/ 引用数: $(echo "$all_arch_referenced" | wc -l | tr -d ' ')"

# 方向 1: 代码中有但 arch/ 未引用
# 匹配策略：检查文件名或目录名是否在 arch/ 中出现
# （arch/ 文档用表格格式，不是完整路径）
echo ""
echo "  ── 代码中有但 arch/ 未记录 ──"
unreferenced=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  rel=${file#$PROJECT/}
  filename=$(basename "$rel")
  # 跳过辅助文件
  case "$filename" in
    index.ts|types.ts|shared.ts|constants.ts) continue ;;
  esac
  # 检查文件名或所在目录是否在 arch/ 中被提及
  # arch/ 文档用多种格式：完整路径、文件名、目录名、组件名
  dirname=$(basename "$(dirname "$rel")")
  found=0
  for archfile in "$ARCH"/*.md; do
    # 检查文件名（如 engine.ts）
    if grep -qiF "$filename" "$archfile" 2>/dev/null; then
      found=1
      break
    fi
    # 检查所在目录名（如 harness/planner/ 中的 planner）
    if grep -qiF "$dirname" "$archfile" 2>/dev/null; then
      found=1
      break
    fi
  done
  if [ $found -eq 0 ]; then
    echo "  ⚠️  $rel — 未在 arch/ 中记录"
    unreferenced=$((unreferenced + 1))
  fi
done <<< "$src_files"

if [ $unreferenced -eq 0 ]; then
  echo "  ✅ 无遗漏"
else
  issues=$((issues + unreferenced))
fi

# 方向 2: arch/ 引用了但代码中不存在
echo ""
echo "  ── arch/ 引用但代码中不存在 ──"
missing=0
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  if [ ! -f "$PROJECT/$ref" ]; then
    echo "  🔴 $ref — arch/ 记录了但文件不存在！"
    missing=$((missing + 1))
  fi
done <<< "$all_arch_referenced"

if [ $missing -eq 0 ]; then
  echo "  ✅ 无悬空引用"
else
  issues=$((issues + missing))
fi

# ──────────────────────────────────────────────
# 2. 顶层目录覆盖检查
#
# src/ 下的每个顶层目录都应该在 arch/overview.md 中被提及。
# 这确保新增的顶层模块不会被遗漏。
# ──────────────────────────────────────────────
echo ""
echo "📂 顶层目录覆盖检查："

for dir in "$PROJECT"/src/*/; do
  [ ! -d "$dir" ] && continue
  dirname=$(basename "$dir")
  # 跳过旧架构目录
  case "$dirname" in
    agent|loop|context|protocol) continue ;;  # deprecated
  esac
  if ! grep -q "$dirname" "$ARCH/overview.md" 2>/dev/null; then
    echo "  ⚠️  src/$dirname/ — 新顶层目录，未在 arch/overview.md 中记录"
    issues=$((issues + 1))
  fi
done
echo "  ✅ 顶层目录检查完成"

# ──────────────────────────────────────────────
# 3. 层规则检查
# ──────────────────────────────────────────────
echo ""
echo "🔒 层规则检查："

# Core → Harness
core_harness=$(grep -r "from '\.\./harness" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_harness" ]; then
  echo "  🔴 Core 层非法 import Harness："
  echo "     $core_harness"
  issues=$((issues + 1))
fi

# Core → Integration
core_int=$(grep -r "from '\.\./integration" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_int" ]; then
  echo "  🔴 Core 层非法 import Integration："
  echo "     $core_int"
  issues=$((issues + 1))
fi

# Core → Plugins
core_plugins=$(grep -r "from '\.\./plugins" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_plugins" ]; then
  echo "  🔴 Core 层非法 import Plugins："
  echo "     $core_plugins"
  issues=$((issues + 1))
fi

# Core → Providers
core_providers=$(grep -r "from '\.\./providers" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_providers" ]; then
  echo "  🔴 Core 层非法 import Providers："
  echo "     $core_providers"
  issues=$((issues + 1))
fi

# Core → Tools
core_tools=$(grep -r "from '\.\./tools" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_tools" ]; then
  echo "  🔴 Core 层非法 import Tools："
  echo "     $core_tools"
  issues=$((issues + 1))
fi

# Core → Testing
core_testing=$(grep -r "from '\.\./testing" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_testing" ]; then
  echo "  🔴 Core 层非法 import Testing："
  echo "     $core_testing"
  issues=$((issues + 1))
fi

# Core → Observability
core_obs=$(grep -r "from '\.\./observability" "$PROJECT/src/core/" 2>/dev/null || true)
if [ -n "$core_obs" ]; then
  echo "  🔴 Core 层非法 import Observability："
  echo "     $core_obs"
  issues=$((issues + 1))
fi

# Harness → Integration (除了 builder.ts/config-bridge.ts)
harness_int=$(grep -r "from '\.\./integration" "$PROJECT/src/harness/" 2>/dev/null | grep -v "builder.ts" | grep -v "config-bridge.ts" || true)
if [ -n "$harness_int" ]; then
  echo "  🟠 Harness 层非法 import Integration（AgentBuilder/ConfigBridge 除外）："
  echo "     $harness_int"
  issues=$((issues + 1))
fi

# Harness → Providers
harness_providers=$(grep -r "from '\.\./providers" "$PROJECT/src/harness/" 2>/dev/null || true)
if [ -n "$harness_providers" ]; then
  echo "  🟠 Harness 层非法 import Providers："
  echo "     $harness_providers"
  issues=$((issues + 1))
fi

# Harness → Tools
harness_tools=$(grep -r "from '\.\./tools" "$PROJECT/src/harness/" 2>/dev/null || true)
if [ -n "$harness_tools" ]; then
  echo "  🟠 Harness 层非法 import Tools："
  echo "     $harness_tools"
  issues=$((issues + 1))
fi

if [ $issues -eq 0 ]; then
  echo "  ✅ 无层规则违规"
fi

# ──────────────────────────────────────────────
# 4. 审计新鲜度
# ──────────────────────────────────────────────
echo ""
echo "📅 审计新鲜度："
last_audit=$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' "$ARCH/violations.md" 2>/dev/null | tail -1 || echo "未找到")
echo "  最后审计日期: $last_audit"

# ──────────────────────────────────────────────
# 汇总
# ──────────────────────────────────────────────
echo ""
echo "========================="
if [ $issues -eq 0 ]; then
  echo "✅ 全部通过，arch/ 与代码同步"
  exit 0
else
  echo "⚠️  发现 $issues 个问题，需要关注"
  exit 1
fi
