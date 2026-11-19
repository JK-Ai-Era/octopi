/**
 * Onboarding 向导 — CLI 渲染器（product-onboarding.md §3）。
 *
 * 渲染器只做呈现与输入采集；步骤图（nextStep 状态机）、校验、落盘/播种/探针
 * 都在 engine `config-admin/onboarding*.js`（单源，Web 渲染器共享——评审 M2）。
 *
 * 行为约定（评审处置）：
 * - B2：commit 时机由状态机 commit 标记驱动（测通后/services 前、exit save、走完）。
 * - `b` 回上一步只属于 choose() 列表语义；文本输入的 `b` 是字面值（n8）。
 * - 所有 secret 只进 .env/内存；OnboardingResult 不回带明文（m10）。
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEPLOYMENT_MODES,
  ONBOARDING_STEPS,
  apiKeyEnvVar,
  initialOnboardingState,
  nextStep,
  providerChoices,
  validateStep,
} from '@octopi-agent/engine/config-admin/onboarding.js';
import { probeErrorCopy, PROBE_ERROR_KINDS, type ProbeErrorKind } from '@octopi-agent/engine/config-admin/error-copy.js';
import type {
  DeploymentMode,
  OnboardingChoices,
  OnboardingEvent,
  OnboardingMachineState,
  OnboardingStepId,
} from '@octopi-agent/engine/config-admin/onboarding.js';
import { applyOnboarding, isRemoteBind, probeProvider } from '@octopi-agent/engine/config-admin/onboarding-apply.js';
import type { ApplyOnboardingDeps } from '@octopi-agent/engine/config-admin/onboarding-apply.js';
import type { ProductLang } from '@octopi-agent/engine/config-admin/i18n.js';
import { OctopiConfigSchema } from '../../config-schema/index.js';
import { askText, choose, closePrompts, confirm, stdinExhausted } from './prompt.js';

/** 向导结果（不含任何 secret —— m10） */
export interface OnboardingResult {
  configPath: string;
  /** 试聊步确认直接开聊（调用方接力 chatCommand） */
  launchChat: boolean;
  /** 是否走完全部步骤（EOF/中止时 false——调用方不得谎报「完成」） */
  completed: boolean;
  /** 选择是否已落盘（commit 点发生过；中途退出但已保存时调用方不得谎报「配置未改」） */
  saved: boolean;
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

/** 单步渲染执行的结果：用户动作翻译成状态机事件 */
interface StepOutcome {
  event: OnboardingEvent;
  /** 仅 first-chat 步设置（调用方接力 chatCommand） */
  launchChat?: boolean;
}

/** 落盘依赖（整文件 schema 校验由套件层 compose schema 注入——M2 deps 语义） */
function applyDeps(opts: RunOnboardingOptions): ApplyOnboardingDeps {
  return {
    configPath: opts.configPath,
    octopiHome: opts.octopiHome,
    adminName: opts.adminName,
    validateConfig: (raw) => {
      const parsed = OctopiConfigSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
        throw new Error(`onboarding_config_invalid: 合并后配置未过 schema（${issues.join('; ')}）——未写盘`);
      }
    },
  };
}

/** 重入 CLI 自身跑子命令（serve/webui）；config 透传（B2 附） */
function spawnCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

type ProbeLabels = Record<ProbeErrorKind, string>;

/**
 * 顶层 effectPolicy.privilegedAck 读取（elevated 启动闸门的声明面；daemon 只认顶层，同 `<top>` 口径）。
 *
 * @param configPath - 配置文件路径
 * @returns 声明字符串；缺失/损坏按「未声明」处理（落盘路径会 fail-loud）
 */
export function readTopLevelPrivilegedAck(configPath: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { effectPolicy?: { privilegedAck?: unknown } };
    const ack = raw.effectPolicy?.privilegedAck;
    return typeof ack === 'string' && ack.trim() ? ack : undefined;
  } catch {
    // 吞掉读取/解析失败（文件缺失或损坏）——按「未声明」处理；损坏配置会在落盘/启动路径 fail-loud
    return undefined;
  }
}

/**
 * 把 privileged 声明写进顶层 effectPolicy（启动闸门的显式表态；值表达「用户 init 时确认」）。
 * 落盘前整文件 schema 校验 fail-loud（同 mergeConfigFragment 的 M15 口径，不写坏文件）。
 *
 * @param configPath - 配置文件路径
 * @param ack - 声明值（任意非空字符串）
 */
export function writePrivilegedAckDeclaration(configPath: string, ack: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`onboarding_privileged_ack: 配置读取/解析失败（${String(e)}）——未写盘`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('onboarding_privileged_ack: 配置不是 JSON 对象——未写盘');
  }
  const cfg = raw as Record<string, unknown>;
  const ep = cfg.effectPolicy;
  if (ep !== undefined && (typeof ep !== 'object' || ep === null || Array.isArray(ep))) {
    throw new Error('onboarding_privileged_ack: effectPolicy 不是对象——未写盘');
  }
  cfg.effectPolicy = { ...((ep as Record<string, unknown>) ?? {}), privilegedAck: ack };
  const parsed = OctopiConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
    throw new Error(`onboarding_privileged_ack: 合并后配置未过 schema（${issues.join('; ')}）——未写盘`);
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function probeLabels(zh: boolean): ProbeLabels {
  // 文案单源在 engine error-copy（批 3-2 四份单源化）；码表由 PROBE_ERROR_KINDS 派生
  const lang = zh ? 'zh' : 'en';
  const labels = {} as Record<string, string>;
  for (const kind of PROBE_ERROR_KINDS) {
    const copy = probeErrorCopy(kind, lang);
    labels[kind] = `${copy.title} —— ${copy.detail}`;
  }
  return labels as ProbeLabels;
}

/** 交互向导主循环（状态机驱动——M2：步骤图真相在 engine nextStep） */
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

  let state: OnboardingMachineState = initialOnboardingState();
  let launchChat = false;
  let saved = false;
  const commit = async (): Promise<void> => {
    const applied = await applyOnboarding(choices, applyDeps(opts));
    saved = true;
    // M3：降级显式——demo 播种失败的警告必须透出到 CLI（此前静默丢弃）
    if (applied.demoWarning) {
      console.warn(`\n⚠️  ${choices.lang === 'en' ? 'Demo kit not seeded:' : '示例任务包未播种：'}${applied.demoWarning}`);
      console.warn(
        choices.lang === 'en'
          ? '   Main config is saved and unaffected; the "Try this example" card will be unavailable.'
          : '   主配置已保存不受影响；「试试这个示例」暂不可用。',
      );
    }
  };

  while (state.current !== null) {
    if (stdinExhausted()) {
      console.log('\n输入已结束（EOF），中止向导——重跑 octopi init 继续。');
      state = nextStep(state, { kind: 'eof' }).state;
      break;
    }
    const outcome = await runStep(state.current, choices, opts);
    if (outcome.launchChat !== undefined) launchChat = outcome.launchChat;
    const transition = nextStep(state, outcome.event);
    state = transition.state;
    if (transition.notice === 'back-at-first') console.log('已经是第一步了。'); // m13：空栈回退给提示，不静默绕圈
    if (transition.commit !== 'none') await commit(); // B2/m5/防御落盘——时机由状态机决定
  }
  return { configPath: opts.configPath, launchChat, completed: state.completed, saved };
}

/** 单步渲染执行（渲染 + 采集；动作翻译成状态机事件） */
async function runStep(
  step: OnboardingStepId,
  choices: OnboardingChoices,
  opts: RunOnboardingOptions,
): Promise<StepOutcome> {
  const zh = choices.lang === 'zh';
  switch (step) {
    case 'welcome': {
      // 第一步定界面语言（后续全部文案随它切双语）；此时语言未定，问题与 chrome 都给双语
      const defIndex = choices.lang === 'en' ? 1 : 2;
      const picked = await choose(
        '三分钟让你的 agent 跑起来。先选界面语言 / Get your agent running in 3 minutes. Pick your language.',
        [
          { id: 'en', label: 'English' },
          { id: 'zh', label: '中文' },
        ],
        {
          defaultId: choices.lang,
          hint: `选择 / pick (1-2，回车=${defIndex}，b=回上一步 / back)`,
          invalidHint: '请输入 1-2 之间的数字 / enter a number 1-2',
        },
      );
      if (picked === '__back__') return { event: { kind: 'back' } };
      choices.lang = picked === 'en' ? 'en' : 'zh';
      return { event: { kind: 'next' } };
    }
    case 'init-mode': {
      // CLI 先行期只有命令行一条道（Web 渲染器批 2 起打开）；--web 已在入口 fail-loud
      choices.initMode = 'cli';
      return { event: { kind: 'next' } };
    }
    case 'deployment-mode': {
      const picked = await choose(
        zh ? '怎么用这套部署？' : 'How will this deployment be used?',
        DEPLOYMENT_MODES.map((m) => ({ id: m.id, label: m.labels[choices.lang] ?? m.id, hint: m.descriptions[choices.lang] })),
        { defaultId: choices.deploymentMode },
      );
      if (picked === '__back__') return { event: { kind: 'back' } };
      choices.deploymentMode = picked as DeploymentMode;
      if (choices.deploymentMode === 'multi-organization') {
        const org = await askText(zh ? '首个组织的名字（如公司/团队名）' : 'Name of your first organization');
        if (!org.trim()) {
          console.log(zh ? '组织名不能为空。' : 'Organization name cannot be empty.');
          return { event: { kind: 'goto', step: 'deployment-mode' } };
        }
        choices.orgName = org.trim();
      }
      if (choices.deploymentMode !== 'personal') {
        for (;;) {
          if (stdinExhausted()) return { event: { kind: 'exit', save: false } };
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
            if (stdinExhausted()) return { event: { kind: 'exit', save: false } };
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
      return { event: { kind: 'next' } };
    }
    case 'provider': {
      const picked = await choose(
        zh ? '用哪个模型服务？' : 'Which model provider?',
        providerChoices().map((p) => ({ id: p.id, label: p.labels?.[choices.lang] ?? p.label, hint: p.keyHints?.[choices.lang] })),
        { defaultId: choices.providerId },
      );
      if (picked === '__back__') return { event: { kind: 'back' } };
      choices.providerId = picked;
      if (picked === 'custom') {
        // M15：custom 必须采集 baseUrl（schema min(1)）
        const url = await askText(zh ? '服务的 Base URL（OpenAI 兼容接口地址）' : 'Service base URL (OpenAI-compatible endpoint)');
        try {
          new URL(url.trim());
          choices.providerOverrides = { ...(choices.providerOverrides ?? {}), baseUrl: url.trim() };
        } catch {
          console.log(zh ? 'URL 格式不对（例：https://api.example.com/v1）' : 'Invalid URL (e.g. https://api.example.com/v1)');
          return { event: { kind: 'goto', step: 'provider' } };
        }
      }
      return { event: { kind: 'next' } };
    }
    case 'api-key': {
      const envVar = apiKeyEnvVar(choices.providerId);
      if (!envVar) return { event: { kind: 'next' } };
      const zhHint = providerChoices().find((p) => p.id === choices.providerId)?.keyHints?.[choices.lang];
      if (zhHint) console.log(`💡 ${zhHint}`);
      const key = await askText(zh ? '粘贴 API Key' : 'Paste your API key', { hidden: true });
      if (!key.trim()) {
        console.log(zh ? 'key 不能为空（或回上一步换无需 key 的本地模型）。' : 'Key cannot be empty (or go back and pick a keyless local model).');
        return { event: { kind: 'goto', step: 'api-key' } };
      }
      choices.apiKey = key.trim();
      return { event: { kind: 'next' } };
    }
    case 'model': {
      const preset = providerChoices().find((p) => p.id === choices.providerId);
      const models = preset?.models ?? [];
      if (models.length === 0) {
        const typed = await askText(zh ? '填写模型名（服务方给的 id）' : 'Type the model id');
        if (!typed.trim()) return { event: { kind: 'goto', step: 'model' } };
        choices.modelId = typed.trim();
        return { event: { kind: 'next' } };
      }
      // m3：--model 在交互模式也生效（作为默认项）
      const defId = opts.model && models.some((m) => m.id === opts.model) ? opts.model : models[0].id;
      const picked = await choose(
        zh ? '用哪个模型？（可手填清单外的 id）' : 'Which model? (you can type an id outside the list)',
        models.map((m) => ({ id: m.id, label: m.name ?? m.id })),
        { defaultId: defId },
      );
      if (picked === '__back__') return { event: { kind: 'back' } };
      choices.modelId = picked === '__other__' ? '' : picked;
      if (!choices.modelId) {
        const typed = await askText(zh ? '填写模型名' : 'Type the model id');
        if (!typed.trim()) return { event: { kind: 'goto', step: 'model' } };
        choices.modelId = typed.trim();
      }
      return { event: { kind: 'next' } };
    }
    case 'probe': {
      process.stdout.write(zh ? '\n🔌 测通中…\n' : '\n🔌 Testing the connection…\n');
      const outcome = await probeProvider(choices);
      if (outcome === 'ok') {
        console.log(zh ? '✅ 连接正常！' : '✅ Connection OK!');
        return { event: { kind: 'next' } };
      }
      const labels = probeLabels(zh);
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
        if (action === 'retry') return { event: { kind: 'goto', step: 'probe' } };
        if (action === 'rekey') {
          choices.apiKey = '';
          return { event: { kind: 'goto', step: 'api-key' } }; // M1：精确落点
        }
        if (action === 'reprovider') {
          choices.providerId = 'ollama';
          choices.modelId = '';
          choices.apiKey = '';
          return { event: { kind: 'goto', step: 'provider' } }; // M1：精确落点
        }
        return { event: { kind: 'exit', save: true } }; // m5：文案=行为
      }
    }
    case 'services': {
      // 高权限 init 的启动前知情确认（elevated 声明闸门的 UX 面）：与其启动后被
      // privileged_declaration_required 拒绝，不如先告知风险；确认启动即把声明写进
      // 顶层 effectPolicy.privilegedAck（值表达「用户 init 时确认」），拒绝则不启动。
      const { isProcessElevated } = await import(
        '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js'
      );
      const needsAck = (await isProcessElevated()) && !readTopLevelPrivilegedAck(opts.configPath);
      if (needsAck) {
        console.log(
          zh
            ? '\n⚠️  当前终端以系统管理员（root/admin）高权限运行——启动后 Octopi 将具备系统级权限。'
            : '\n⚠️  This terminal is elevated (root/admin) — Octopi would run with system-level privileges.',
        );
        console.log(
          zh
            ? '   选 y 启动即表示你明确知悉并接受特权部署；向导会把该声明写入配置顶层 effectPolicy.privilegedAck。'
            : '   Starting confirms you understand and accept a privileged deployment; the wizard records it as top-level effectPolicy.privilegedAck.',
        );
        console.log(
          zh
            ? '   不接受请选 n（稍后改用普通权限终端启动）。'
            : '   Decline with n to start later from a regular (non-elevated) terminal.',
        );
      }
      const go = await confirm(zh ? '现在启动服务？（gateway + webui）' : 'Start services now? (gateway + webui)', { defaultYes: true });
      if (!go) {
        console.log(zh ? '稍后手动启动：octopi serve start && octopi webui start' : 'Start later with: octopi serve start && octopi webui start');
        if (needsAck) {
          console.log(
            zh
              ? '   注意：未写入 privilegedAck 时高权限直接启动会被拒——请改用普通权限终端，或手动在配置顶层 effectPolicy 加 privilegedAck。'
              : '   Note: elevated startup is refused without privilegedAck — use a non-elevated terminal, or add top-level effectPolicy.privilegedAck manually.',
          );
        }
        return { event: { kind: 'next' } };
      }
      if (needsAck) {
        const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        writePrivilegedAckDeclaration(opts.configPath, `user-confirmed-at-init-${ts}`);
        console.log(
          zh
            ? '✅ 已写入 effectPolicy.privilegedAck（用户 init 时确认的特权声明）。'
            : '✅ effectPolicy.privilegedAck recorded (user confirmed the privileged deployment at init).',
        );
      }
      const cfg = opts.configPath ? ['--config', opts.configPath] : []; // B2 附：配置透传
      const rc1 = await spawnCli(['serve', 'start', ...cfg]);
      const rc2 = await spawnCli(['webui', 'start', ...cfg]);
      if (rc1 !== 0 || rc2 !== 0) {
        console.log(zh ? '⚠️ 服务启动有异常，可稍后用 octopi serve status 检查。' : '⚠️ Services reported an error — check with: octopi serve status');
      }
      return { event: { kind: 'next' } };
    }
    case 'first-chat': {
      console.log(zh ? '\n🎉 全部就绪！打开 http://localhost:8180 或运行 octopi chat 开聊。' : '\n🎉 All set! Open http://localhost:8180 or run: octopi chat');
      const launch = await confirm(zh ? '现在就在终端里聊几句？' : 'Chat in the terminal now?', { defaultYes: true });
      return { event: { kind: 'next' }, launchChat: launch };
    }
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

  const applied = await applyOnboarding(choices, applyDeps(opts));
  if (applied.demoWarning) {
    // M3：--yes 路径同权透出（降级显式不因非交互而消失）
    console.warn(`\n⚠️  ${choices.lang === 'en' ? 'Demo kit not seeded:' : '示例任务包未播种：'}${applied.demoWarning}`);
  }
  // 高权限 --yes 无从交互确认——只告警不代写声明（privilegedAck 必须是人的显式表态）
  const { isProcessElevated } = await import(
    '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js'
  );
  if ((await isProcessElevated()) && !readTopLevelPrivilegedAck(opts.configPath)) {
    console.warn(
      choices.lang === 'en'
        ? '\n⚠️  Elevated (root/admin) init: serve will refuse to start until top-level effectPolicy.privilegedAck is declared — or start from a non-elevated terminal.'
        : '\n⚠️  高权限（root/admin）init：serve 启动会被拒，直到在顶层 effectPolicy.privilegedAck 显式声明——或改用普通权限终端启动。',
    );
  }
  return { configPath: opts.configPath, launchChat: false, completed: true, saved: true };
}

/**
 * 打开浏览器（darwin/linux/win32 平台分派）
 *
 * @param url - 目标地址
 */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/**
 * --web 路径（§3 步骤 2）：把用户带进 Web 向导。
 * 服务在跑 → 读 setup-token.json 拼 URL 开浏览器（token 不进命令行参数）；
 * 服务没跑 → 指引起服务（daemon 首启会打印带 setup 的向导链接）。
 *
 * @param opts - 运行选项
 */
async function runWebHandoff(opts: RunOnboardingOptions): Promise<OnboardingResult> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const webUrl = `http://localhost:${process.env.OCTOPI_WEBUI_PORT ?? 8180}`;
  let reachable = false;
  try {
    const res = await fetch(`http://localhost:${process.env.OCTOPI_GATEWAY_PORT ?? 18180}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log('🌐 Web 向导需要服务在跑。请先执行：');
    console.log('     octopi serve start');
    console.log('   首启时终端会打印「🧙 首启配置向导」链接（含一次性 setup token）；');
    console.log('   或在这里继续命令行向导：octopi init --cli');
    return { configPath: opts.configPath, launchChat: false, completed: false, saved: false };
  }
  let target = webUrl;
  try {
    const t = JSON.parse(readFileSync(join(opts.octopiHome, 'setup-token.json'), 'utf8')) as {
      token?: unknown;
      expiresAt?: unknown;
    };
    if (typeof t.token === 'string' && typeof t.expiresAt === 'number' && t.expiresAt > Date.now()) {
      target = `${webUrl}/?setup=${t.token}`;
    }
  } catch {
    // 无 token 文件：已配置或已过期——直接开控制台（非首启不需要向导）
  }
  console.log(`🌐 打开 Web 向导：${target}`);
  openBrowser(target);
  return { configPath: opts.configPath, launchChat: false, completed: true, saved: false };
}

/**
 * 跑 onboarding 向导（CLI 渲染）。
 *
 * @param opts - 运行选项
 * @returns 向导结果（无 secret）
 */
export async function runOnboardingWizard(opts: RunOnboardingOptions): Promise<OnboardingResult> {
  if (opts.webRequested) {
    closePrompts();
    return await runWebHandoff(opts);
  }
  try {
    if (opts.yes) return await runNonInteractive(opts);
    return await runInteractive(opts);
  } finally {
    closePrompts();
  }
}
