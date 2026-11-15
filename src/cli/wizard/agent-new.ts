/**
 * 新建 agent 向导 — CLI 渲染器（旅程 B：选类型 / 取名称呼 / 挂资料 / 试聊）。
 *
 * 类型模板 = 生成器（product-onboarding.md §5c）：创建时一次性展开
 * AGENTS.md 主 persona + persona/ 补充件 + skills/<id>/SKILL.md，模板不进运行时。
 * 资产面 = registry agent（定义权威，白名单 definition）；家当物化经
 * registry-bridge 同一物化语义（ensureAgentDirs 幂等）。
 *
 * @module
 */

import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BUILTIN_AGENT_ROLE_PRESETS,
  getAgentRolePreset,
  renderAgentRole,
} from '@octopi-agent/engine/config-admin/agent-presets.js';
import type { ProductLang } from '@octopi-agent/engine/config-admin/i18n.js';
import type { AgentRecord } from '@octopi-agent/engine/harness/governance/registry/types.js';
import { agentHomeDir } from '@octopi-agent/engine/paths.js';
import { askText, choose, closePrompts, confirm, stdinExhausted } from './prompt.js';

/** 向导结果 */
export interface CreateAgentResult {
  agentId: string;
  agentName: string;
  presetId: string;
  /** 试聊步确认直接开聊（调用方接力 chatCommand） */
  launchChat: boolean;
}

/** 运行选项 */
export interface CreateAgentOptions {
  octopiHome: string;
  configPath: string;
  lang?: ProductLang;
}

function renderSkillMarkdown(skill: { name: string; description: string; content: string; tools?: string[] }): string {
  // n4：frontmatter 值用双引号包裹（description 常含 `: `，裸 YAML 非法）
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  const toolsLine = skill.tools?.length ? `tools: ${skill.tools.join(', ')}\n` : '';
  return `---\nname: "${esc(skill.name)}"\ndescription: "${esc(skill.description)}"\n${toolsLine}---\n${skill.content}`;
}

/**
 * 跑「新建 agent」向导（CLI 渲染）
 *
 * @param opts - 运行选项
 * @returns 创建结果（含试聊意向）
 */
export async function runCreateAgentWizard(opts: CreateAgentOptions): Promise<CreateAgentResult> {
  // M14：language 真消费者——配置语言优先，缺省 zh
  let lang: ProductLang = opts.lang ?? 'zh';
  if (!opts.lang) {
    try {
      const raw = JSON.parse(readFileSync(opts.configPath, 'utf8')) as { language?: ProductLang };
      if (raw.language === 'zh' || raw.language === 'en') lang = raw.language;
    } catch {
      /* 配置不可读时维持缺省 zh */
    }
  }
  const zh = lang === 'zh';
  const { RegistryService } = await import('@octopi-agent/engine/harness/governance/registry/service.js');
  const { createRegistryAgentBridge } = await import('../../registry-bridge.js');

  const registry = await RegistryService.create({ dbPath: join(opts.octopiHome, 'registry.db') });
  try {
    // 归属身份：播种面保证 default（①）或 admin（②③）存在
    const owner = registry.getUserByName('default') ?? registry.getUserByName('admin');
    if (!owner) {
      throw new Error('create_agent_no_owner: 未找到 default/admin 用户——请先运行 octopi init 完成部署初始化');
    }
    const tenantId = owner.tenantId;

    // ── ① 选类型 ──
    const presetId = await choose(
      zh ? '给它选个类型（预设了对应的能力组合）' : 'Pick a type (each comes with a curated skill set)',
      BUILTIN_AGENT_ROLE_PRESETS.map((p) => ({
        id: p.id,
        label: p.labels?.[lang] ?? p.label,
        hint: p.descriptions?.[lang] ?? p.description,
      })),
    );

    // ── ② 取名 + 称呼 ──
    let agentName = '';
    for (;;) {
      if (stdinExhausted()) throw new Error('create_agent_aborted: 输入结束（EOF），中止创建');
      agentName = (await askText(zh ? '它叫什么名字？' : 'What is its name?')).trim();
      if (agentName) break;
      console.log(zh ? '名字不能为空。' : 'Name cannot be empty.');
    }
    const addressToUser = (await askText(zh ? '它怎么称呼你？' : 'How should it address you?', { default: zh ? '你' : 'you' })).trim();

    const preset = getAgentRolePreset(presetId);
    if (!preset) throw new Error(`unknown agent role preset: ${presetId}`);
    const rendered = renderAgentRole(presetId, { agentName, addressToUser });

    // ── 创建（registry 权威面 + 白名单 definition）──
    let record: AgentRecord;
    try {
      record = registry.createAgent({
        tenantId,
        ownerUserId: owner.userId,
        name: agentName,
        definition: JSON.stringify({
          name: agentName,
          description: preset.descriptions?.[lang] ?? preset.description,
          // model = 档位名字符串（schema: string | ModelConfig）；档位解析吃 raw 配置 models.level
          model: rendered.recommendedModelLevel ?? 'standard',
          ...(rendered.skills.length > 0 ? { skills: rendered.skills.map((s) => s.id) } : {}),
        }),
      });
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new Error(`create_agent_name_taken: 名字「${agentName}」已被占用，换个名字重跑（octopi agent new）`);
      }
      throw err;
    }

    // ── 家当物化 + 模板展开（任一失败补偿回滚，m12：不留半成品 agent）──
    try {
      const rawConfig = JSON.parse(readFileSync(opts.configPath, 'utf8')) as Record<string, unknown>;
      const bridge = createRegistryAgentBridge({ getRawConfig: () => rawConfig, homeDir: opts.octopiHome });
      await bridge.materialize(record);

      const home = agentHomeDir(opts.octopiHome, record.agentId);
      // M9：清掉通用 persona 脚手架四件（10-soul/20-identity/30-user/40-tools）——
      // 类型包是该 agent 的 persona 全量，通用模板（Name: Assistant）会与用户取名打架
      for (const tpl of ['10-soul.md', '20-identity.md', '30-user.md', '40-tools.md']) {
        try {
          unlinkSync(join(home, 'persona', tpl));
        } catch {
          /* 不存在即目标态 */
        }
      }
      writeFileSync(join(home, 'AGENTS.md'), rendered.agentsMd, 'utf8');
      for (const pf of rendered.personaFiles) {
        const p = join(home, 'persona', pf.file);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, pf.content, 'utf8');
      }
      for (const skill of rendered.skills) {
        const p = join(home, 'skills', skill.id, 'SKILL.md');
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, renderSkillMarkdown(skill), 'utf8');
      }
    } catch (err) {
      // 补偿：注册记录 + 家当目录一并回收（尽力而为），错误原样上抛
      try {
        registry.deleteAgent({ agentId: record.agentId, viewerUserId: owner.userId });
      } catch {
        /* 回滚尽力而为 */
      }
      try {
        rmSync(agentHomeDir(opts.octopiHome, record.agentId), { recursive: true, force: true });
      } catch {
        /* 回滚尽力而为 */
      }
      throw err;
    }

    // ── ③ 挂资料（可选）──
    // M8 处置：不建 registry 定义面幽灵源（webui 上传会另建真源、挂载变空指针）。
    // 两段式受管注册（knowledge 面建档 + registry 登记）随批 2 webui 上传流落地；
    // CLI 侧诚实降级为指引。
    if (await confirm(zh ? '要给它配资料库吗？（现在走指引，服务起后在 webui 上传）' : 'Set up a knowledge base? (guided — upload in webui after services start)', { defaultYes: false })) {
      console.log(
        zh
          ? `👉 做法：启动服务后打开 webui → 资料库 → 新建「${agentName} 的资料」→ 上传文件 → 挂给 ${agentName}。`
          : `👉 How: start services → webui → Knowledge → create "${agentName}'s knowledge" → upload files → mount to ${agentName}.`,
      );
    }

    // ── ④ 试聊 ──
    console.log(zh ? `\n🎉 ${agentName} 就绪！` : `\n🎉 ${agentName} is ready!`);
    const launchChat = await confirm(zh ? `现在就和 ${agentName} 聊聊？` : `Chat with ${agentName} now?`, { defaultYes: true });
    return { agentId: record.agentId, agentName, presetId, launchChat };
  } finally {
    closePrompts();
    registry.close();
  }
}
