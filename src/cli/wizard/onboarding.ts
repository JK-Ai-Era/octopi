/**
 * Onboarding 向导 — CLI 渲染器（product-onboarding.md §3）。
 *
 * 渲染器只做呈现与 IO 执行；步骤序/校验/配置组装在 engine `config-admin/onboarding.js`
 * （单源，Web 渲染器共享）。评审 M2 抽取（nextStep/applyOnboarding deps 注入）随批 2
 * Web 渲染器落地；本文件的 commit 点/动作阶段即抽取胚胎。
 *
 * 行为约定（评审处置）：
 * - B2：配置落盘 + 播种在 services 动作**之前**（spawn 出的进程读盘才拿得到新配置）。
 * - `b` 回上一步只属于 choose() 列表语义；文本输入的 `b` 是字面值（n8）。
 * - 所有 secret 只进 .env/内存；OnboardingResult 不回带明文（m10）。
 *
 * @module
 */

import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEPLOYMENT_MODES,
  ONBOARDING_STEPS,
  apiKeyEnvVar,
  assembleOnboarding,
  providerChoices,
  validateStep,
} from '@octopi-agent/engine/config-admin/onboarding.js';
import type {
  DeploymentMode,
  OnboardingChoices,
  OnboardingOutput,
  OnboardingStepId,
} from '@octopi-agent/engine/config-admin/onboarding.js';
import type { ProductLang } from '@octopi-agent/engine/config-admin/i18n.js';
import { expandEnvValues } from '@octopi-agent/engine/config-admin/env.js';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import { OctopiConfigSchema } from '../../config-schema/index.js';
import { askText, choose, closePrompts, confirm, stdinExhausted } from './prompt.js';

/** 向导结果（不含任何 secret —— m10） */
export interface OnboardingResult {
  configPath: string;
  /** 试聊步确认直接开聊（调用方接力 chatCommand） */
  launchChat: boolean;
  /** 是否走完全部步骤（EOF/中止时 false——调用方不得谎报「完成」） */
  completed: boolean;
}

/** 运行选项 */
export interface RunOnboardingOptions {
  configPath: string;
  octopiHome: string;
  yes?: boolean;
  provider?: string;
  model?: string;
  webEnabled?: boolean;
  webRequested?: boolean;
  /** 管理员名（默认 admin；撞名时的可执行出路，M10） */
  adminName?: string;
}

/** 步骤执行结果（goto 支撑探针失败动作面的精确落点，M1） */
type StepResult =
  | { action: 'next' }
  | { action: 'back' }
  | { action: 'goto'; step: OnboardingStepId }
  | { action: 'exit'; save: boolean };

/** 探针错误四类归并（§5 映射） */
export function classifyProbeError(err: Error): 'network' | 'auth' | 'model' | 'server' {
  const msg = err.message.toLowerCase();
  if (/401|403|unauthorized|forbidden|api.?key|invalid.?key/.test(msg)) return 'auth';
  if (/enotfound|econnrefused|etimedout|econnreset|fetch failed|network|getaddrinfo/.test(msg)) return 'network';
  if (/model/.test(msg) && /not.?found|unknown|does.?not.?exist|invalid/.test(msg)) return 'model';
  return 'server'; // 纯 404/5xx 归 server（m9：baseUrl 写错的 404 不再误指「模型没找到」）
}

/** 写一行 .env（0600；同名替换、异名追加） */
export function writeEnvLine(octopiHome: string, line: string): void {
  const envPath = join(octopiHome, '.env');
  const eq = line.indexOf('=');
  const key = line.slice(0, eq);
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    /* 首次写入 */
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith(`${key}=`));
  lines.push(line);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  chmodSync(envPath, 0o600); // 已存在宽松权限也收紧（M6 关联的 key 安全面）
}

/**
 * 合入 octopi.json（B3 全接线 + M15 落盘前 schema 校验 + m6 entry 级合并）。
 *
 * @param configPath - 目标配置文件
 * @param output - 向导产出
 * @throws 合并结果不过 OctopiConfigSchema（fail-loud，不写坏文件）
 */
export function mergeConfigFragment(configPath: string, output: OnboardingOutput): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const models = { ...((raw.models as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
  const providers = { ...((models.providers as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(output.configFragment.providers) as Array<[string, Record<string, unknown>]>) {
    // entry 级合并：向导拥有 baseUrl/apiKey/models，既有 timeoutSeconds/options 保留（m6）
    providers[name] = { ...((providers[name] as Record<string, unknown>) ?? {}), ...cfg };
  }
  models.providers = providers;
  // B3：档位与 agent model 接线到所选 provider/model
  models.level = { ...((models.level as Record<string, unknown>) ?? {}), ...output.configFragment.levels };
  raw.models = models;
  if (Array.isArray(raw.agents)) {
    raw.agents = (raw.agents as Array<Record<string, unknown>>).map((a) =>
      a && typeof a === 'object' ? { ...a, model: output.configFragment.agentModel } : a,
    );
  }
  raw.language = output.configFragment.language;
  raw.deploymentMode = output.configFragment.deploymentMode;

  // M15：落盘前 schema 校验 fail-loud（坏配置留在盘上比不落盘更难查）
  const parsed = OctopiConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
    throw new Error(`onboarding_config_invalid: 合并后配置未过 schema（${issues.join('; ')}）——未写盘`);
  }
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/**
 * 部署模式播种（§4）：①default 自助面（tenant/user id = 'default'，DEFAULT_TENANT_ID 语义，M11）；
 * ②③组织 + admin（带密码）。幂等；撞名（他域已有同名 admin）fail-loud 且给出可执行出路（M10）。
 */
export async function seedDeploymentRegistry(octopiHome: string, choices: OnboardingChoices, opts?: RunOnboardingOptions): Promise<void> {
  const { RegistryService } = await import('@octopi-agent/engine/harness/governance/registry/service.js');
  const registry = await RegistryService.create({ dbPath: join(octopiHome, 'registry.db') });
  try {
    const adminName = opts?.adminName ?? process.env.OCTOPI_ADMIN_NAME ?? 'admin';
    if (choices.deploymentMode === 'personal') {
      // M11：显式 'default' 租户/用户（与 core DEFAULT_TENANT_ID 同一 ID 空间）
      const tenant = registry.ensureTenant('default', 'default');
      const existing = registry.getUserInTenant(tenant.tenantId, 'default');
      if (!existing) {
        await registry.createUserInTenant({ tenantId: tenant.tenantId, name: 'default', isPlatformAdmin: true });
      }
      // M12：personal 远程绑定强制设密码（收进来的 adminPassword 即 default 用户密码）
      if (choices.adminPassword) await registry.setUserPassword((registry.getUserInTenant(tenant.tenantId, 'default'))!.userId, choices.adminPassword);
      return;
    }
    const tenantName = choices.deploymentMode === 'multi-organization' ? (choices.orgName ?? 'default') : 'default';
    const tenant = registry.ensureTenant(tenantName, tenantName === 'default' ? 'default' : undefined);
    if (!choices.adminPassword) throw new Error('onboarding_admin_password_required: ②③模式 admin 必须设密码');
    const existing = registry.getUserInTenant(tenant.tenantId, adminName);
    if (existing) {
      await registry.setUserPassword(existing.userId, choices.adminPassword);
      return;
    }
    const elsewhere = registry.getUserByName(adminName);
    if (elsewhere && elsewhere.tenantId !== tenant.tenantId) {
      // M10：绝不跨租户覆写密码；给出可执行出路
      throw new Error(
        `registry_admin_name_taken: 用户名 ${adminName} 已被其他组织占用——重跑并指定 OCTOPI_ADMIN_NAME=<其他名字>`,
      );
    }
    await registry.createUserInTenant({
      tenantId: tenant.tenantId,
      name: adminName,
      password: choices.adminPassword,
      isPlatformAdmin: true,
    });
  } finally {
    registry.close();
  }
}

/** 落盘动作（.env + 配置）；播种由调用点带 opts 执行 */
function applyOutput(output: OnboardingOutput, opts: RunOnboardingOptions): void {
  for (const line of output.envLines) writeEnvLine(opts.octopiHome, line);
  mergeConfigFragment(opts.configPath, output);
}

/**
 * 探针（§5 测通内核）：expandEnvValues 展开后建 provider 做一次可用性检查（B1）。
 *
 * @param choices - 当前选择
 * @returns 错误类别；'' 无错误时用 'ok' 返回（见返回值联合）
 */
export async function probeProvider(choices: OnboardingChoices): Promise<'ok' | 'network' | 'auth' | 'model' | 'server'> {
  const envVar = apiKeyEnvVar(choices.providerId);
  if (envVar && choices.apiKey) process.env[envVar] = choices.apiKey.trim();
  const { configFragment } = assembleOnboarding(choices);
  // B1：createProviderFromConfig 不做 env 展开——必须先展开，否则 ${VAR} 字面量进 Authorization 头恒 401
  const providerCfg = expandEnvValues(Object.values(configFragment.providers)[0] as Record<string, unknown>);
  try {
    const provider = await createProviderFromConfig(choices.providerId, providerCfg as never, {});
    const ok = await provider.isAvailable();
    return ok ? 'ok' : 'server';
  } catch (err) {
    return classifyProbeError(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 重入 CLI 自身跑子命令（serve/webui）；config 透传（B2 附） */
function spawnCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

interface ProbeLabels {
  auth: string;
  network: string;
  model: string;
  server: string;
}

function probeLabels(zh: boolean): ProbeLabels {
  return zh
    ? {
        auth: 'API Key 不对或没权限——检查 key 是否复制完整、是否有效。',
        network: '连不上服务——检查网络 / Base URL / 代理。',
        model: '这个模型名没找到——回到模型步重拉清单或改名。',
        server: '服务方异常——稍后重试，或换一个模型服务。',
      }
    : {
        auth: 'The API key was rejected — check it was pasted correctly and is active.',
        network: 'Cannot reach the service — check network / base URL / proxy.',
        model: 'Model not found — go back and pick from the list or type the exact id.',
        server: 'The provider is having trouble — retry later or switch provider.',
      };
}

/** 交互向导主循环 */
async function runInteractive(opts: RunOnboardingOptions): Promise<OnboardingResult> {
  const choices: OnboardingChoices = {
    lang: 'zh',
    initMode: 'cli',
    deploymentMode: 'personal',
    providerId: opts.provider ?? 'deepseek',
    modelId: opts.model ?? '',
  };
  // M14：language 真消费者——已有配置的语言预选为默认
  try {
    const raw = JSON.parse(readFileSync(opts.configPath, 'utf8')) as { language?: ProductLang };
    if (raw.language === 'zh' || raw.language === 'en') choices.lang = raw.language;
  } catch {
    /* 配置缺失/损坏由后续步骤报错 */
  }

  const stepStack: OnboardingStepId[] = [];
  let idx = 0;
  let committed = false;
  let launchChat = false;
  const commit = async (): Promise<void> => {
    if (committed) return;
    applyOutput(assembleOnboarding(choices), opts);
    await seedDeploymentRegistry(opts.octopiHome, choices, opts);
    committed = true;
  };

  while (idx < ONBOARDING_STEPS.length) {
    if (stdinExhausted()) {
      console.log('\n输入已结束（EOF），中止向导——重跑 octopi init 继续。');
      break;
    }
    const step = ONBOARDING_STEPS[idx];
    const result = await runStep(step, choices, opts);
    if (result.action === 'exit') {
      if (result.save) await commit(); // m5：「保存并退出」行为与文案一致
      break;
    }
    if (result.action === 'back') {
      const prev = stepStack.pop();
      if (prev !== undefined) {
        idx = ONBOARDING_STEPS.indexOf(prev);
      } else {
        console.log('已经是第一步了。'); // m13：空栈回退给提示，不静默绕圈
      }
      continue;
    }
    if (result.action === 'goto') {
      stepStack.push(step);
      idx = ONBOARDING_STEPS.indexOf(result.step);
      continue;
    }
    stepStack.push(step);
    if (step === 'probe') await commit(); // B2：落盘+播种先于 services 动作
    idx += 1;
  }
  if (idx >= ONBOARDING_STEPS.length) await commit(); // 防御落盘仅限正常走完（EOF/中止的半截状态不组装）
  return { configPath: opts.configPath, launchChat, completed: idx >= ONBOARDING_STEPS.length };
}

/** 单步渲染执行 */
async function runStep(
  step: OnboardingStepId,
  choices: OnboardingChoices,
  opts: RunOnboardingOptions,
): Promise<StepResult> {
  const zh = choices.lang === 'zh';
  switch (step) {
    case 'welcome': {
      const raw = await askText(
        zh ? '三分钟让你的 agent 跑起来。先选界面语言 / Get your agent running in 3 minutes. Language first.' : 'Get your agent running in 3 minutes. Pick your language.',
        { default: choices.lang },
      );
      choices.lang = raw === 'en' ? 'en' : 'zh';
      return { action: 'next' };
    }
    case 'init-mode': {
      // CLI 先行期只有命令行一条道（Web 渲染器批 2 起打开）；--web 已在入口 fail-loud
      choices.initMode = 'cli';
      return { action: 'next' };
    }
    case 'deployment-mode': {
      const picked = await choose(
        zh ? '怎么用这套部署？' : 'How will this deployment be used?',
        DEPLOYMENT_MODES.map((m) => ({ id: m.id, label: m.labels[choices.lang] ?? m.id, hint: m.descriptions[choices.lang] })),
        { defaultId: choices.deploymentMode },
      );
      if (picked === '__back__') return { action: 'back' };
      choices.deploymentMode = picked as DeploymentMode;
      if (choices.deploymentMode === 'multi-organization') {
        const org = await askText(zh ? '首个组织的名字（如公司/团队名）' : 'Name of your first organization');
        if (!org.trim()) {
          console.log(zh ? '组织名不能为空。' : 'Organization name cannot be empty.');
          return { action: 'goto', step: 'deployment-mode' };
        }
        choices.orgName = org.trim();
      }
      if (choices.deploymentMode !== 'personal') {
        for (;;) {
          if (stdinExhausted()) return { action: 'exit', save: false };
          const pw = await askText(zh ? '给 admin 管理员设个密码' : 'Set a password for the admin account', { hidden: true });
          const pw2 = await askText(zh ? '再输一遍确认' : 'Type it again to confirm', { hidden: true });
          if (pw && pw === pw2) {
            choices.adminPassword = pw;
            break;
          }
          console.log(zh ? '两次输入不一致或为空，重来。' : 'Passwords differ or empty — try again.');
        }
      } else {
        // M12：personal 远程绑定不裸奔——检测 channels/web 的 host，非 local 强制设密码
        const remote = isRemoteBind(opts.configPath);
        if (remote) {
          console.log(zh ? '⚠️ 检测到服务绑定非本机地址——个人模式远程暴露必须设密码。' : '⚠️ Remote bind detected — personal mode requires a password when exposed.');
          for (;;) {
            if (stdinExhausted()) return { action: 'exit', save: false };
            const pw = await askText(zh ? '给本机用户设个密码' : 'Set a password for the local user', { hidden: true });
            const pw2 = await askText(zh ? '再输一遍确认' : 'Type it again to confirm', { hidden: true });
            if (pw && pw === pw2) {
              choices.adminPassword = pw;
              break;
            }
            console.log(zh ? '两次输入不一致或为空，重来。' : 'Passwords differ or empty — try again.');
          }
        }
      }
      return { action: 'next' };
    }
    case 'provider': {
      const picked = await choose(
        zh ? '用哪个模型服务？' : 'Which model provider?',
        providerChoices().map((p) => ({ id: p.id, label: p.labels?.[choices.lang] ?? p.label, hint: p.keyHints?.[choices.lang] })),
        { defaultId: choices.providerId },
      );
      if (picked === '__back__') return { action: 'back' };
      choices.providerId = picked;
      if (picked === 'custom') {
        // M15：custom 必须采集 baseUrl（schema min(1)）
        const url = await askText(zh ? '服务的 Base URL（OpenAI 兼容接口地址）' : 'Service base URL (OpenAI-compatible endpoint)');
        try {
          new URL(url.trim());
          choices.providerOverrides = { ...(choices.providerOverrides ?? {}), baseUrl: url.trim() };
        } catch {
          console.log(zh ? 'URL 格式不对（例：https://api.example.com/v1）' : 'Invalid URL (e.g. https://api.example.com/v1)');
          return { action: 'goto', step: 'provider' };
        }
      }
      return { action: 'next' };
    }
    case 'api-key': {
      const envVar = apiKeyEnvVar(choices.providerId);
      if (!envVar) return { action: 'next' };
      const zhHint = providerChoices().find((p) => p.id === choices.providerId)?.keyHints?.[choices.lang];
      if (zhHint) console.log(`💡 ${zhHint}`);
      const key = await askText(zh ? '粘贴 API Key' : 'Paste your API key', { hidden: true });
      if (!key.trim()) {
        console.log(zh ? 'key 不能为空（或回上一步换无需 key 的本地模型）。' : 'Key cannot be empty (or go back and pick a keyless local model).');
        return { action: 'goto', step: 'api-key' };
      }
      choices.apiKey = key.trim();
      return { action: 'next' };
    }
    case 'model': {
      const preset = providerChoices().find((p) => p.id === choices.providerId);
      const models = preset?.models ?? [];
      if (models.length === 0) {
        const typed = await askText(zh ? '填写模型名（服务方给的 id）' : 'Type the model id');
        if (!typed.trim()) return { action: 'goto', step: 'model' };
        choices.modelId = typed.trim();
        return { action: 'next' };
      }
      // m3：--model 在交互模式也生效（作为默认项）
      const defId = opts.model && models.some((m) => m.id === opts.model) ? opts.model : models[0].id;
      const picked = await choose(
        zh ? '用哪个模型？（可手填清单外的 id）' : 'Which model? (you can type an id outside the list)',
        models.map((m) => ({ id: m.id, label: m.name ?? m.id })),
        { defaultId: defId },
      );
      if (picked === '__back__') return { action: 'back' };
      choices.modelId = picked === '__other__' ? '' : picked;
      if (!choices.modelId) {
        const typed = await askText(zh ? '填写模型名' : 'Type the model id');
        if (!typed.trim()) return { action: 'goto', step: 'model' };
        choices.modelId = typed.trim();
      }
      return { action: 'next' };
    }
    case 'probe': {
      const zhMsg = zh;
      process.stdout.write(zh ? '\n🔌 测通中…\n' : '\n🔌 Testing the connection…\n');
      const outcome = await probeProvider(choices);
      if (outcome === 'ok') {
        console.log(zh ? '✅ 连接正常！' : '✅ Connection OK!');
        return { action: 'next' };
      }
      const labels = probeLabels(zhMsg);
      console.log(`\n❌ ${labels[outcome]}`);
      for (;;) {
        const action = await choose(
          zh ? '怎么办？' : 'What now?',
          [
            { id: 'retry', label: zh ? '重试' : 'Retry' },
            { id: 'rekey', label: zh ? '重新录 API Key' : 'Re-enter API key' },
            { id: 'reprovider', label: zh ? '换一个模型服务' : 'Switch provider' },
            { id: 'manual', label: zh ? '保存当前设置并退出向导（稍后手动编辑）' : 'Save and exit (edit manually later)' },
          ],
          { defaultId: 'retry' },
        );
        if (action === 'retry') return { action: 'goto', step: 'probe' };
        if (action === 'rekey') {
          choices.apiKey = '';
          return { action: 'goto', step: 'api-key' }; // M1：精确落点
        }
        if (action === 'reprovider') {
          choices.providerId = 'ollama';
          choices.modelId = '';
          choices.apiKey = '';
          return { action: 'goto', step: 'provider' }; // M1：精确落点
        }
        return { action: 'exit', save: true }; // m5：文案=行为
      }
    }
    case 'services': {
      const go = await confirm(zh ? '现在启动服务？（gateway + webui）' : 'Start services now? (gateway + webui)', { defaultYes: true });
      if (!go) {
        console.log(zh ? '稍后手动启动：octopi serve start && octopi webui start' : 'Start later with: octopi serve start && octopi webui start');
        return { action: 'next' };
      }
      const cfg = opts.configPath ? ['--config', opts.configPath] : []; // B2 附：配置透传
      const rc1 = await spawnCli(['serve', 'start', ...cfg]);
      const rc2 = await spawnCli(['webui', 'start', ...cfg]);
      if (rc1 !== 0 || rc2 !== 0) {
        console.log(zh ? '⚠️ 服务启动有异常，可稍后用 octopi serve status 检查。' : '⚠️ Services reported an error — check with: octopi serve status');
      }
      return { action: 'next' };
    }
    case 'first-chat': {
      console.log(zh ? '\n🎉 全部就绪！打开 http://localhost:8180 或运行 octopi chat 开聊。' : '\n🎉 All set! Open http://localhost:8180 or run: octopi chat');
      launchChatRef.value = await confirm(zh ? '现在就在终端里聊几句？' : 'Chat in the terminal now?', { defaultYes: true });
      return { action: 'next' };
    }
  }
}

// first-chat 步的回传通道（runStep 无闭包状态；极简单例）
const launchChatRef = { value: false };

/** 配置里是否绑定非本机地址（M12） */
function isRemoteBind(configPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      web?: { host?: string };
      channels?: Array<{ type?: string; host?: string }>;
    };
    const hosts = [raw.web?.host, ...(raw.channels ?? []).map((c) => c.host)];
    return hosts.some((h) => h === 'lan' || h === '0.0.0.0');
  } catch {
    return false;
  }
}

/** 非交互路径（--yes）：预设默认 + env/flags，动作步不执行 */
async function runNonInteractive(opts: RunOnboardingOptions): Promise<OnboardingResult> {
  const choices: OnboardingChoices = {
    lang: (process.env.OCTOPI_LANG as ProductLang | undefined) === 'en' ? 'en' : 'zh',
    initMode: 'cli',
    deploymentMode: (process.env.OCTOPI_DEPLOYMENT_MODE as DeploymentMode | undefined) ?? 'personal',
    providerId: opts.provider ?? 'ollama',
    modelId: opts.model ?? '',
    apiKey: process.env.OCTOPI_API_KEY ?? '',
  };
  if (choices.deploymentMode !== 'personal') {
    // ②③模式的 admin 必须有密码：--yes 走 env（交互模式两遍输入）
    choices.adminPassword = process.env.OCTOPI_ADMIN_PASSWORD ?? '';
    if (!choices.adminPassword) {
      throw new Error('onboarding_deployment-mode: 模式②③ 需要 OCTOPI_ADMIN_PASSWORD / org modes require OCTOPI_ADMIN_PASSWORD in --yes');
    }
    choices.orgName = process.env.OCTOPI_ORG_NAME;
  }

  // 预设默认模型先填（--yes 的「预设默认值」语义），再进校验链
  if (!choices.modelId) {
    const preset = providerChoices().find((p) => p.id === choices.providerId);
    choices.modelId = preset?.models[0]?.id ?? '';
    if (!choices.modelId) throw new Error('onboarding_model: 预设无默认模型，--model 必填 / preset has no default model, --model required');
  }

  for (const step of ONBOARDING_STEPS) {
    const err = validateStep(step, choices);
    if (err) throw new Error(`onboarding_${step}: ${err}`);
  }

  const output = assembleOnboarding(choices);
  applyOutput(output, opts);
  await seedDeploymentRegistry(opts.octopiHome, choices, opts);
  return { configPath: opts.configPath, launchChat: false, completed: true };
}

/**
 * 跑 onboarding 向导（CLI 渲染）。
 *
 * @param opts - 运行选项
 * @returns 向导结果（无 secret）
 * @throws --web 在 Web 渲染器落地前 fail-loud
 */
export async function runOnboardingWizard(opts: RunOnboardingOptions): Promise<OnboardingResult> {
  if (opts.webRequested) {
    closePrompts();
    throw new Error('web_wizard_not_available: Web 向导将在后续版本提供，请用命令行继续（octopi init --cli）');
  }
  try {
    if (opts.yes) return await runNonInteractive(opts);
    launchChatRef.value = false;
    const result = await runInteractive(opts);
    return { ...result, launchChat: launchChatRef.value };
  } finally {
    closePrompts();
  }
}
