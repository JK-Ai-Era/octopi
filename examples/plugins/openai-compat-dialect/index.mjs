/**
 * openai-compat-dialect — Provider contribution `openai-compat`.
 *
 * A ModelProvider factory for OpenAI-compatible endpoints with request-side
 * dialect tuning that the built-in `openai-completions` adapter intentionally
 * does not guess:
 *   - custom auth headers (e.g. X-Api-Key) and prefixes
 *   - extra static headers and extra body fields (merged UNDER standard fields)
 *   - thinking-level → dialect parameter mapping (value / boolean / object modes)
 *   - configurable reasoning-content field name in responses
 *
 * Per-instance tuning lives in `models.providers[key].options` (non-secret);
 * the API key always arrives via the credential channel (`apiKey`).
 */

const THINKING_MODES = new Set(['value', 'boolean', 'object']);

/** Parse and validate `options` from one models.providers entry. Fails loud. */
function parseOptions(raw) {
  const opts = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(opts).filter(
    (k) => !['auth', 'extraHeaders', 'extraBody', 'thinking', 'reasoningField', 'path'].includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(`openai-compat-dialect: unknown option(s): ${unknown.join(', ')}`);
  }

  const auth = opts.auth ?? {};
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('openai-compat-dialect: options.auth must be an object');
  }
  const authHeader = auth.header !== undefined ? String(auth.header) : 'Authorization';
  // HTTP 头名大小写不敏感：小写 authorization 也按 Bearer 前缀默认
  const authPrefix = auth.prefix !== undefined ? String(auth.prefix) : authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : '';

  if (opts.extraHeaders !== undefined && (typeof opts.extraHeaders !== 'object' || Array.isArray(opts.extraHeaders) || opts.extraHeaders === null)) {
    throw new Error('openai-compat-dialect: options.extraHeaders must be an object');
  }
  for (const [key, value] of Object.entries(opts.extraHeaders ?? {})) {
    if (typeof value !== 'string') throw new Error(`openai-compat-dialect: options.extraHeaders.${key} must be a string`);
  }
  if (opts.extraBody !== undefined && (typeof opts.extraBody !== 'object' || Array.isArray(opts.extraBody) || opts.extraBody === null)) {
    throw new Error('openai-compat-dialect: options.extraBody must be an object');
  }
  if (opts.reasoningField !== undefined && (typeof opts.reasoningField !== 'string' || opts.reasoningField.length === 0)) {
    throw new Error('openai-compat-dialect: options.reasoningField must be a non-empty string');
  }

  const thinking = opts.thinking;
  if (thinking !== undefined) {
    if (typeof thinking !== 'object' || Array.isArray(thinking) || thinking === null) {
      throw new Error('openai-compat-dialect: options.thinking must be an object');
    }
    if (typeof thinking.field !== 'string' || thinking.field.length === 0) {
      throw new Error('openai-compat-dialect: options.thinking.field is required');
    }
    const mode = thinking.mode ?? 'value';
    if (!THINKING_MODES.has(mode)) {
      throw new Error(`openai-compat-dialect: options.thinking.mode must be one of value|boolean|object (got "${mode}")`);
    }
    if (thinking.values !== undefined && (typeof thinking.values !== 'object' || Array.isArray(thinking.values) || thinking.values === null)) {
      throw new Error('openai-compat-dialect: options.thinking.values must be an object keyed by thinking level');
    }
    // 各模式的 per-level 值在构造期校验（fail-loud 不留到请求期）
    for (const [level, value] of Object.entries(thinking.values ?? {})) {
      const modeOfValues = thinking.mode ?? 'value';
      const ok =
        modeOfValues === 'boolean' ? typeof value === 'boolean'
        : modeOfValues === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : ['string', 'number', 'boolean'].includes(typeof value);
      if (!ok) {
        throw new Error(`openai-compat-dialect: options.thinking.values.${level} does not match mode "${modeOfValues}"`);
      }
    }
  }

  if (opts.path !== undefined && (typeof opts.path !== 'string' || !opts.path.startsWith('/'))) {
    throw new Error('openai-compat-dialect: options.path must start with "/"');
  }

  return {
    authHeader,
    authPrefix,
    extraHeaders: opts.extraHeaders ?? {},
    extraBody: opts.extraBody ?? {},
    thinking,
    reasoningField: opts.reasoningField ?? 'reasoning_content',
    path: opts.path ?? '/chat/completions',
  };
}

/** thinkingLevel → request-body fragment per configured dialect mode. */
function thinkingBodyFor(thinking, level) {
  if (!thinking || level === undefined || level === 'off') return {};
  const mode = thinking.mode ?? 'value';
  const fallback = mode === 'object' ? { type: 'enabled', level } : mode === 'boolean' ? true : level;
  const value = thinking.values?.[level] ?? fallback;
  if (mode === 'boolean' && value !== true && value !== false) {
    throw new Error(`openai-compat-dialect: options.thinking.values.${level} must be a boolean in boolean mode`);
  }
  return { [thinking.field]: value };
}

function mapFinishReason(raw) {
  switch (raw) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'error':
      return raw;
    default:
      // 未知结束因（content_filter / 各家自定义）一律视为 error：
      // 被过滤/被拒的回答不得呈现为正常结束（与内置 openai 适配器同语义）
      return 'error';
  }
}

function toTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = n(usage.prompt_tokens);
  const cached = n(usage.prompt_tokens_details?.cached_tokens);
  const cacheAware = typeof usage.prompt_tokens_details?.cached_tokens === 'number';
  // 与 engine usage.ts tokenUsageFromOpenAi 同一账目语义：cache 命中不得重复计入未缓存输入
  return {
    outputTokens: n(usage.completion_tokens),
    inputUncachedTokens: cacheAware ? Math.max(0, prompt - cached) : prompt,
    inputCachedTokens: cacheAware ? cached : 0,
    inputCacheWriteTokens: 0,
    cacheAware,
    inputReportedTokens: prompt,
    raw: usage,
  };
}

function toToolCalls(calls) {
  return calls.map((call, i) => {
    const fn = call.function ?? call;
    let parsed;
    let argumentsParseError;
    if (typeof fn.arguments === 'string') {
      try {
        parsed = JSON.parse(fn.arguments);
      } catch (err) {
        parsed = {};
        argumentsParseError = `tool call "${fn.name}" arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      parsed = fn.arguments ?? {};
    }
    return {
      id: call.id ?? `call_${i}`,
      name: fn.name,
      arguments: parsed,
      ...(argumentsParseError === undefined ? {} : { argumentsParseError }),
    };
  });
}

class CompatDialectProvider {
  constructor(context, opts) {
    this.name = context.providerName;
    this.opts = opts;
    this.baseUrl = context.baseUrl.replace(/\/$/, '');
    this.apiKey = context.apiKey;
    this.timeoutMs = context.timeoutMs ?? 60_000;
    this.modelInfoMap = new Map();
    this.models = [];
    for (const entry of context.models) {
      this.models.push(entry.name);
      this.modelInfoMap.set(entry.name, {
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        temperature: entry.temperature,
        reasoning: entry.reasoning,
        input: entry.input,
      });
    }
    this.defaultModel = context.defaultModel ?? this.models[0];
    this.disposed = false;
    this.inflight = new Set();
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      ...this.opts.extraHeaders,
    };
    if (this.apiKey !== '') headers[this.opts.authHeader] = this.opts.authPrefix + this.apiKey;
    return headers;
  }

  bodyFor(request) {
    const model = request.model ?? this.defaultModel;
    const modelInfo = this.modelInfoMap.get(model);
    const body = {
      // extraBody merges UNDER standard fields: standard contract always wins
      ...this.opts.extraBody,
      model,
      messages: request.messages,
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    else if (modelInfo?.temperature !== undefined) body.temperature = modelInfo.temperature;
    const cap = modelInfo?.maxOutputTokens;
    if (request.maxTokens !== undefined) {
      body.max_tokens = cap ? Math.min(request.maxTokens, cap) : request.maxTokens;
    } else if (cap !== undefined) {
      body.max_tokens = cap;
    }
    if (request.thinkingLevel !== undefined && request.thinkingLevel !== 'off' && modelInfo?.reasoning === false) {
      throw new Error(`Model "${model}" declares no reasoning support; cannot honor thinkingLevel "${request.thinkingLevel}"`);
    }
    Object.assign(body, thinkingBodyFor(this.opts.thinking, request.thinkingLevel));
    return body;
  }

  async send(request, extraBody) {
    if (this.disposed) throw new Error(`Provider "${this.name}" is disposed`);
    const controller = new AbortController();
    this.inflight.add(controller);
    // 连接期超时（到响应头为止）；body 消费期由 dispose / run 取消经 controller.signal 中止
    const timer = setTimeout(() => controller.abort(new Error(`Provider "${this.name}" connect timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    const release = () => {
      clearTimeout(timer);
      this.inflight.delete(controller);
    };
    try {
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;
      const response = await fetch(`${this.baseUrl}${this.opts.path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...this.bodyFor(request), ...extraBody }),
        signal,
      });
      return { response, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  async chat(request) {
    const { response, release } = await this.send(request, {});
    try {
      if (!response.ok) {
        throw new Error(`openai-compat-dialect: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim());
      }
      let data;
      try {
        data = await response.json();
      } catch (err) {
        throw new Error(`openai-compat-dialect: non-JSON response from ${this.baseUrl}${this.opts.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const choice = data.choices?.[0];
      if (!choice) throw new Error('openai-compat-dialect: no choices in response');
      const message = choice.message ?? {};
      return {
        content: message.content ?? '',
        ...(message[this.opts.reasoningField] ? { reasoning: message[this.opts.reasoningField] } : {}),
        ...(message.tool_calls ? { toolCalls: toToolCalls(message.tool_calls) } : {}),
        ...(data.usage ? { usage: toTokenUsage(data.usage) } : {}),
        model: data.model ?? request.model ?? this.defaultModel,
        finishReason: mapFinishReason(choice.finish_reason),
      };
    } finally {
      release();
    }
  }

  async *stream(request) {
    const { response, release } = await this.send(request, { stream: true, stream_options: { include_usage: true } });
    try {
      if (!response.ok) {
        throw new Error(`openai-compat-dialect: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim());
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('openai-compat-dialect: no response body');
      const decoder = new TextDecoder();
      const toolCallBuffers = new Map();
      let lastUsage;
      let lastFinishReason;
      let pending = '';
      let lastToolKey;
      let finished = false;
      const self = this;

      // 单行 SSE 处理（主循环与流尾残行共用）；finished 置位表示已发过 done
      function* handleLine(rawLine) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          for (const buffer of toolCallBuffers.values()) {
            yield self.flushToolCall(buffer);
          }
          toolCallBuffers.clear();
          yield {
            type: 'done',
            usage: lastUsage,
            finishReason: lastFinishReason ?? 'stop',
          };
          finished = true;
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // 非 JSON 的 data 行是 SSE 噪声，跳过而非毒化流
          return;
        }
        if (parsed.usage) lastUsage = toTokenUsage(parsed.usage);
        const choice = parsed.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) lastFinishReason = mapFinishReason(choice.finish_reason);
        const delta = choice.delta ?? {};
        if (delta[self.opts.reasoningField]) {
          yield { type: 'reasoning', content: delta[self.opts.reasoningField] };
        }
        if (delta.content) {
          yield { type: 'content', content: delta.content };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // 缺 index 的并行调用以 id 为键；两者皆缺的增量并入最近的调用
            let key;
            if (tc.index != null) key = `i${tc.index}`;
            else if (tc.id) key = `id:${tc.id}`;
            else key = lastToolKey ?? 'i0';
            lastToolKey = key;
            let buffer = toolCallBuffers.get(key);
            if (buffer && tc.id && buffer.id && tc.id !== buffer.id) {
              // 同键出现新 id：先落旧 buffer 再开新（避免拼出坏 JSON）
              yield self.flushToolCall(buffer);
              buffer = undefined;
            }
            if (!buffer) {
              buffer = { id: '', name: '', argsBuffer: '', outIndex: typeof tc.index === 'number' ? tc.index : undefined };
              toolCallBuffers.set(key, buffer);
            }
            if (tc.id) buffer.id = tc.id;
            if (tc.function?.name) buffer.name = tc.function.name;
            if (tc.function?.arguments) buffer.argsBuffer += tc.function.arguments;
          }
        }
      }

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const rawLine of lines) {
            yield* handleLine(rawLine);
            if (finished) return;
          }
        }
        // 无尾随换行的残行（手写兼容服务常见）同样要解析，不得静默丢弃
        if (pending.length > 0) {
          for (const rawLine of pending.split('\n')) {
            yield* handleLine(rawLine);
            if (finished) return;
          }
        }
        for (const buffer of toolCallBuffers.values()) {
          yield this.flushToolCall(buffer);
        }
        yield { type: 'done', usage: lastUsage, finishReason: lastFinishReason ?? 'stop' };
      } finally {
        // 消费方提前 break 时释放底层连接；流已到尽头时 cancel 为空操作
        try { await reader.cancel(); } catch { /* 已到尽头/已中止：无 body 可取消 */ }
        reader.releaseLock();
      }
    } finally {
      // dispose/退役必须能中止在途流：controller 注册到流消费完才解除
      release();
    }
  }

  flushToolCall(buffer) {
    // LLMStreamChunk.toolCall.arguments 是字符串原文；解析归 Loop（坏 JSON 由其记录 argumentsParseError）
    return {
      type: 'tool_call',
      toolCall: {
        id: buffer.id || undefined,
        name: buffer.name,
        arguments: buffer.argsBuffer,
        ...(buffer.outIndex === undefined ? {} : { index: buffer.outIndex }),
      },
    };
  }

  async isAvailable() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10_000));
      try {
        const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: controller.signal });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  getModelInfo(modelName) {
    return this.modelInfoMap.get(modelName) ?? null;
  }

  getModelInfos() {
    return [...this.modelInfoMap.values()];
  }

  async dispose() {
    this.disposed = true;
    for (const controller of this.inflight) controller.abort(new Error(`Provider "${this.name}" disposed`));
    this.inflight.clear();
  }
}

export default {
  id: 'openai-compat-dialect',
  register(api) {
    api.registerProvider('openai-compat', (context) => {
      return new CompatDialectProvider(context, parseOptions(context.options));
    });
  },
};
