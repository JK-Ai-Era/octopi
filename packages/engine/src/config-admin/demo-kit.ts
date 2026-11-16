/**
 * 演示任务包（批 3-1，product-onboarding.md「演示剧本」拍板）：
 * 内置样例资料库 + 「读资料 → 总结周报 → 存成文件」三步剧本 + demo agent 幂等播种。
 *
 * 单源纪律（批 2 教训：四份错误映射口径不一）：样例资料、剧本 prompt、demo agent
 * 定义全部住这里。gateway `/api/v1/demo/kit` 只做下发，webui 只消费不复制。
 * 「跑真 agent 真工具」：一键跑 = 普通 chat run 携带 {@link DEMO_SCRIPT_PROMPTS}，
 * agent 用真实文件工具读写 workspace/demo/——与手动使用同一数据路径，无假动画。
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentWorkspaceDir } from '../paths.js';

/**
 * demo agent 发现判据（单源）：definition.name === DEMO_AGENT_NAME 且 ownerUserId 匹配。
 * 不把幂等标记塞进 definition——registry-bridge 宿主治理白名单（ALLOWED_DEFINITION_KEYS）
 * 只放行 name/description/model/persona/tools/skills/contextEngine（评审 B1：demo 标记会被拒收）。
 */
export const DEMO_AGENT_NAME = '示例助手';

/** 样例资料所在子目录（相对 agent workspace） */
export const DEMO_SAMPLE_DIR = 'demo';

/** 剧本产物（周报）相对路径——剧本 prompt 与验收测试共用 */
export const DEMO_REPORT_PATH = `${DEMO_SAMPLE_DIR}/weekly-report.md`;

/**
 * 内置样例资料库：虚构小团队「灯塔」项目一周素材（周一站会 / 周三客户反馈 / 周五进展）。
 * 三份素材覆盖「读资料 → 总结周报」所需的信息点：本周完成、客户反馈、风险、下周计划。
 */
export const DEMO_SAMPLE_FILES: ReadonlyArray<{ path: string; content: string }> = [
  {
    path: `${DEMO_SAMPLE_DIR}/周一-站会纪要.md`,
    content: `# 周一站会纪要 — 灯塔项目（3 月 4 日）

参会：小林（前端）、阿凯（后端）、小雨（测试）、老王（PM）

本周目标：
- 完成登录模块重构（历史欠债：平均登录耗时 3 秒以上）
- API 网关从旧网关迁移到新网关（计划本周迁 60%）
- 测试环境上周不稳定的问题要有结论

风险上报：
- 测试环境共享数据库偶发锁表，小雨的回归测试被卡过两次，怀疑是环境里跑着旧的定时任务
- 登录重构要动会话签发，安全评审时间还没约上

分工：
- 小林：登录页与会话保持
- 阿凯：网关迁移脚本 + 登录接口
- 小雨：回归用例梳理 + 环境问题定位
`,
  },
  {
    path: `${DEMO_SAMPLE_DIR}/周三-客户反馈.md`,
    content: `# 周三客户反馈汇总（3 月 6 日）

## 客户 A（制造行业，200 人规模）
- 登录慢：「点完登录要转三秒多才进得去，每天要登好几次，体感很差」
- 导出报表只有 PDF，希望增加 CSV（他们财务要进 Excel 二次计算）

## 客户 B（设计工作室）
- 报表模块体验好，「周报视图比我们之前用的工具清楚」
- 希望报表支持按周对比

## 潜在线索 C（教育机构）
- 明确要求 SSO（对接他们的统一身份平台），没有 SSO 不进入采购评估
- 询问数据私有化部署方案

销售备注：客户 A 续约谈判窗口在下个月，登录性能是他们提的头号问题。
`,
  },
  {
    path: `${DEMO_SAMPLE_DIR}/周五-进展.md`,
    content: `# 周五进展（3 月 8 日）

已落地：
- 登录模块重构完成并灰度 50%：平均登录耗时 3.2s → 0.4s，下周一切全量
- API 网关迁移完成 60%（原计划 60%，符合预期）
- 测试环境锁表问题定位：是旧定时任务每天凌晨批量写库，已停用，观察两天无复发

新排期：
- CSV 导出已进排期，小林下周一动工，预计下周内可提测
- SSO 需求：老王下周一组织评审，需要先出工作量估算（线索 C 的采购门槛）

下周计划：
- API 网关迁移收尾（剩 40%）
- CSV 导出开发 + 提测
- 登录全量 + 客户 A 回访（带上性能对比数据）
- SSO 评审出结论
`,
  },
];

/**
 * 三步剧本 prompt（单源）：「读资料 → 总结周报 → 存成文件」。
 * 一键跑 = 普通 chat 消息携带此文案，agent 自主用文件工具完成三步（真 agent 真工具）。
 */
export const DEMO_SCRIPT_PROMPTS: Readonly<Record<'zh' | 'en', string>> = {
  zh: `请帮我总结一份本周周报：
1. 读取 demo/ 目录下的三份素材（周一-站会纪要、周三-客户反馈、周五-进展）；
2. 总结成一份周报，包含四节：本周完成、客户反馈要点、风险与关注、下周计划；
3. 把周报保存为 ${DEMO_REPORT_PATH}，写完后告诉我文件位置和一段摘要。`,
  en: `Please write my weekly report:
1. Read the three source notes under demo/ (Monday standup, Wednesday customer feedback, Friday progress);
2. Summarize them into a weekly report with four sections: Completed this week, Customer feedback highlights, Risks & concerns, Next week's plan;
3. Save the report as ${DEMO_REPORT_PATH}, then tell me the file path and a short summary.`,
};

/** demo agent 的最小 persona（AGENTS.md）——演示主角，不套通用脚手架 */
export function demoAgentPersona(lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'zh'
    ? `# 示例助手\n\n你是「示例助手」——Octopi 内置的体验向导 agent。\n\n- 你在一个真实的工作区里工作，可以用文件工具读写工作区的文件。\n- 演示剧本：读取 demo/ 目录的样例素材，总结周报并保存为 ${DEMO_REPORT_PATH}。\n- 回答用中文，简洁、面向第一次使用 Octopi 的用户。\n`
    : `# Demo Assistant\n\nYou are the built-in demo agent of Octopi — an onboarding guide.\n\n- You work in a real workspace and can read/write files with file tools.\n- Demo script: read the sample notes under demo/, summarize a weekly report, and save it as ${DEMO_REPORT_PATH}.\n- Answer in English, concise, aimed at first-time Octopi users.\n`;
}

/** 播种结果 */
export interface SeedDemoKitResult {
  /** demo agent id（新播种或已存在） */
  agentId: string;
  /** 本次是否新建了 demo agent（false = 已存在，幂等重入） */
  created: boolean;
  /** 本次新落盘的样例文件数（已存在的文件不覆盖，尊重用户改动） */
  samplesWritten: number;
}

/**
 * 播种演示任务包（幂等）：demo agent（registry 权威面 + 最小家当）+ 样例资料库。
 *
 * 幂等语义：
 * - demo agent 按 definition.name === DEMO_AGENT_NAME 且 ownerUserId 匹配查找，已存在则不重建、不重命名；
 * - 样例文件已存在则**不覆盖**（用户可能已改动素材——演示数据与用户数据同一路径）。
 *
 * @param opts.octopiHome - OCTOPI_HOME
 * @param opts.tenantId - 归属租户
 * @param opts.ownerUserId - 归属用户（demo agent 的 owner）
 * @param opts.lang - persona 语言（缺省 zh）
 * @returns 播种结果
 * @throws registry 或文件系统失败（fail-loud，调用方决定是否降级）
 */
export async function seedDemoKit(opts: {
  octopiHome: string;
  tenantId: string;
  ownerUserId: string;
  lang?: 'zh' | 'en';
}): Promise<SeedDemoKitResult> {
  const { RegistryService } = await import('../harness/governance/registry/service.js');
  const registry = await RegistryService.create({ dbPath: join(opts.octopiHome, 'registry.db') });
  try {
    const lang = opts.lang ?? 'zh';
    const existing = registry
      .listAgents({ tenantId: opts.tenantId as never, viewerUserId: opts.ownerUserId as never })
      .find((a) => {
        try {
          const def = JSON.parse(a.definition) as Record<string, unknown>;
          return def.name === DEMO_AGENT_NAME && a.ownerUserId === opts.ownerUserId;
        } catch {
          return false;
        }
      });

    let agentId: string;
    let created = false;
    if (existing) {
      agentId = existing.agentId as string;
    } else {
      const record = registry.createAgent({
        tenantId: opts.tenantId as never,
        ownerUserId: opts.ownerUserId as never,
        name: DEMO_AGENT_NAME,
        visibility: 'private',
        definition: JSON.stringify({
          name: DEMO_AGENT_NAME,
          description:
            lang === 'zh'
              ? '内置示例助手：一键体验「读资料 → 总结周报 → 存成文件」真 agent 真工具剧本。'
              : 'Built-in demo agent: run the read-summarize-save weekly report script with real tools.',
          model: 'standard',
        }),
      });
      agentId = record.agentId as string;
      created = true;
    }

    // 最小家当：AGENTS.md + workspace（demo 资料）。persona/ 目录待有补充件再建（评审 NIT：不建空目录）。
    const home = join(opts.octopiHome, 'agents', agentId);
    mkdirSync(home, { recursive: true });
    if (!existsSync(join(home, 'AGENTS.md'))) {
      writeFileSync(join(home, 'AGENTS.md'), demoAgentPersona(lang), 'utf8');
    }
    const workspace = agentWorkspaceDir(opts.octopiHome, opts.tenantId, agentId);
    let samplesWritten = 0;
    for (const sample of DEMO_SAMPLE_FILES) {
      const p = join(workspace, ...sample.path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      if (!existsSync(p)) {
        writeFileSync(p, sample.content, 'utf8');
        samplesWritten += 1;
      }
    }
    return { agentId, created, samplesWritten };
  } finally {
    registry.close();
  }
}
