/**
 * agents / plugins / channels — Extension & Agent 段（→ @octopi-agent/engine）
 *
 * @module
 */
import { z } from 'zod';
import {
  ConfigPathSchema,
  InlinePersonaSchema,
  ModelConfigSchema,
  NetworkHostSchema,
  SessionRightsSchema,
  ToolPolicySchema,
} from './shared.js';
import { EffectPolicyConfigSchema } from './governance.js';

export const AgentConfigSchema = z.object({
  id: z.string({ error: 'Agent must have an id' }).min(1, 'Agent id cannot be empty'),
  /**
   * agent 文件态 home（persona / skills / agent.db 基线）。与 `workspace` 同规：
   * 绝对路径或 `~` 形态——相对路径加载即拒，杜绝隐式 resolve 到进程 cwd。
   */
  home: ConfigPathSchema.optional(),
  /** 工具基路径：绝对路径或 ~ 形态（相对路径加载即拒，杜绝隐式 resolve 到进程 cwd） */
  workspace: ConfigPathSchema.optional(),
  /** ToolEffectPolicy 运行模式（P3）；与 tools allow/deny 无关 */
  effectPolicy: EffectPolicyConfigSchema.optional(),
  /** 文件式 persona 目录，或内联 systemPrompt。legacy string 形态等价 home（同路径契约） */
  persona: z.union([ConfigPathSchema, InlinePersonaSchema]).optional(),
  model: z.union([z.string().min(1), ModelConfigSchema]),
  tools: ToolPolicySchema.optional(),
  /** Skill 目录（缺省 `home/skills`）：与 `workspace`/`home` 同规（绝对或 `~` 形态，拒相对） */
  skillDirectory: ConfigPathSchema.optional(),
  skills: z.array(z.string()).optional(),
  channelBindings: z.record(z.string(), z.string()).optional(),
  /** Session ACL 天花板（E6 L1）；与角色 max / 绑定取交集 */
  maxSessionRights: SessionRightsSchema.optional(),
  /** Knowledge 召回（覆盖全局 knowledge.recall） */
  knowledge: z
    .object({
      recall: z.enum(['off', 'hint', 'hybrid', 'inject']).optional(),
    })
    .optional(),
  /**
   * 特质标签（`arch/delegation.md` §9.2）。
   *
   * 供父 agent 按特质发现委派目标（`AgentRegistry.findByTrait`）。
   * 自由字符串，只影响**委派寻址**，不含任何权限语义。
   *
   * 命名说明：刻意不叫 `capabilities` —— 该词已被工具安全标签
   * （`RegisteredTool.definition.capabilities`，如 `'fs-read'`/`'exec'`）占用，
   * 后者由 SecurityGuard 做安全拦截，两者语义无关（`docs/task-system.md` A2）。
   */
  traits: z
    .array(z.string())
    .optional()
    .describe(
      'Trait tags for delegation discovery (e.g. ["research","general"]). ' +
        'Free strings matched exactly; ONLY affects which agent a capability-based ' +
        'delegate_dispatch resolves to. Carries NO permission meaning — control tool ' +
        'access via `tools`, rights via `delegation.rightsCeiling`/`maxSessionRights`. ' +
        'Not related to tool capability tags (RegisteredTool.definition.capabilities).',
    ),
  /**
   * 委派策略（`arch/delegation.md` §9.2）。
   *
   * **整段可省略**：省略即用 `DEFAULT_DELEGATION_POLICY`
   * —— 委派**默认开启**（可被委派、可发委派、限一层）。
   * 关闭必须显式写 `false`。
   * 有此段且 `callable: true` 的 agent 即「子 agent 模板」；
   * 无 `channelBindings` 的这类 agent 不会出现在用户对话面。
   */
  delegation: z
    .object({
      /** 能否被委派（默认 true） */
      callable: z
        .boolean()
        .default(true)
        .describe(
          'Whether this agent can BE delegated to (as a child agent). Default TRUE — ' +
            'agents are delegation-capable out of the box. Set false to restrict this agent ' +
            'to direct user conversation only.',
        ),
      /** 允许哪些 agentId 调我（缺省 = 任意） */
      callableBy: z.array(z.string()).optional(),
      /** 我能不能再委派（默认 true） */
      canDelegate: z
        .boolean()
        .default(true)
        .describe(
          'Whether this agent GAINS the delegate_* tools (delegate_dispatch/list/get/cancel). ' +
            'Default TRUE. Set false to strip those tools from this agent.',
        ),
      /** 递归上限（默认 1 = 我能派子，子不能再派；runaway 兜底） */
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'How many delegation levels may originate here. Default 1 = I may spawn one ' +
            'level, my children cannot delegate further. This is the runaway guard now that ' +
            'delegation is on by default; raise to 2+ only when nested delegation is wanted.',
        ),
      /** 被委派时的权利天花板（只能收紧不能放宽，D3） */
      rightsCeiling: SessionRightsSchema.optional(),
      /** 委派预算上限（请求预算与此取交集） */
      budget: z
        .object({
          maxTurns: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
          timeoutMs: z.number().positive().optional(),
        })
        .optional(),
      // outputSchema：结构化输出契约，v1 留字段位不实现（arch/delegation.md O2）
    })
    .optional(),
});

export const PluginConfigSchema = z.object({
  loadPaths: z.array(z.string()).optional(),
  configs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const ChannelConfigSchema = z.object({
  type: z.string({ error: 'Channel must have a type' }).min(1),
  port: z.number().positive().optional(),
  host: NetworkHostSchema.optional(),
  path: z.string().optional(),
  apiKey: z.string().optional(),
  corsOrigins: z.array(z.string()).optional(),
});
