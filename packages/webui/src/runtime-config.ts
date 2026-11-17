/**
 * WebUI 运行时配置读取（`/octopi-config.js` → `window.__OCTOPI_WEB__`）。
 *
 * 与 gateway-base 的回源地址解析分开：这里只管 UI 行为旋钮（Git 页签轮询
 * 频率等），真相源是 octopi.json 的 `web.*` 段，serve-webui 启动时下发；
 * 缺省走内置默认。
 *
 * 边界镜像：浏览器包引不到 suite，本文件的校验/默认值与
 * `src/config-schema/webui.ts` 的 `isValidGitStatusPollSeconds` /
 * `DEFAULT_GIT_STATUS_POLL_SECONDS` 是同一契约的手工镜像，改边界两处同改。
 */

/** serve-webui 启动时注入的 UI 配置（`window.__OCTOPI_WEB__`） */
declare global {
  interface Window {
    __OCTOPI_WEB__?: {
      gitStatusPollSeconds?: number;
      deploymentMode?: string;
      /** 产品版本（package.json 构建信息；AboutPanel 展示） */
      version?: string;
      /** 配置语言（demo 剧本/文案语言对齐用） */
      language?: string;
    } | null;
  }
}

/** 注入配置对象读取（globalThis 访问保持 lib 无关：本文件会进无 DOM lib 的 tests 类型检查图） */
function injectedConfig(): Window['__OCTOPI_WEB__'] {
  return (globalThis as { __OCTOPI_WEB__?: Window['__OCTOPI_WEB__'] }).__OCTOPI_WEB__;
}

/**
 * 产品版本（「关于」页展示）。
 *
 * @returns 下发的版本号；缺失时 undefined（UI 显示占位）
 */
export function getProductVersion(): string | undefined {
  const v = injectedConfig()?.version;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 配置语言（demo 剧本等语言对齐——评审 m9）。
 *
 * @returns 'zh' | 'en'；缺失时 'zh'
 */
export function getLanguage(): 'zh' | 'en' {
  const v = injectedConfig()?.language;
  return v === 'en' ? 'en' : 'zh';
}

/** 无运行时下发时的 Git 页签轮询间隔（秒） */
const DEFAULT_GIT_STATUS_POLL_SECONDS = 5;

/**
 * Git 页签轮询间隔（秒）。0 = 仅手动刷新。
 *
 * @returns 校验后的配置值；下发缺失/非法时回退默认 5s
 */
export function getGitStatusPollSeconds(): number {
  const v = injectedConfig()?.gitStatusPollSeconds;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3600
    ? v
    : DEFAULT_GIT_STATUS_POLL_SECONDS;
}

/**
 * 部署模式（①personal 免登录 / ②organization / ③multi-organization 需登录）。
 *
 * @returns 部署模式；下发缺失时返回 undefined（按免登录处理）
 */
export function getDeploymentMode(): string | undefined {
  return injectedConfig()?.deploymentMode;
}

/**
 * 是否需要 registry 登录（②③模式）。
 *
 * @returns true = 需要登录页
 */
export function requiresLogin(): boolean {
  const mode = getDeploymentMode();
  return mode === 'organization' || mode === 'multi-organization';
}
