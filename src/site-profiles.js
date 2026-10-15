const AI_RULE_FILTER = Object.freeze({
  type: 'req_rate',
  within_second: 11,
  max_challenge: 11111,
  max_per_uri: 11111,
  extra: {},
});

const PROTOCOL_RULES = Object.freeze({
  openai: Object.freeze([
    ['AI API OpenAI 接口放行', '^/v1/(chat/completions|responses|completions|embeddings|models|moderations|rerank|images|audio|files|uploads|batches|vector_stores|assistants|threads|conversations|containers|fine_tuning|realtime|live|videos|skills|evals|graders|fim/completions|ocr|agents/completions)(/.*)?$'],
  ]),
  anthropic: Object.freeze([
    ['AI API Anthropic 接口放行', '^/v1/(messages|models|files|skills)(/.*)?$'],
  ]),
  gemini: Object.freeze([
    ['AI API Gemini 原生接口放行', '^/(v1|v1beta)/(models|files|cachedContents|batches|operations)(/.*)?$'],
    ['AI API Gemini 上传接口放行', '^/upload/(v1|v1beta)/files(/.*)?$'],
    ['AI API Gemini OpenAI 兼容接口放行', '^/v1beta/openai/(chat/completions|responses|embeddings|models|images|audio)(/.*)?$'],
  ]),
  azure_openai: Object.freeze([
    ['AI API Azure OpenAI v1 接口放行', '^/openai/v1/(chat/completions|responses|embeddings|models|moderations|images|audio)(/.*)?$'],
    ['AI API Azure OpenAI 部署接口放行', '^/openai/deployments/[^/]+/(chat/completions|completions|embeddings|images/generations|audio/(speech|transcriptions|translations))(/.*)?$'],
  ]),
  cohere: Object.freeze([
    ['AI API Cohere 接口放行', '^/v2/(chat|parse|embed|rerank|audio/transcriptions)(/.*)?$'],
  ]),
  china_ai: Object.freeze([
    ['AI API 国内 OpenAI 兼容接口放行', '^/compatible-mode/v1/(chat/completions|responses|embeddings|rerank|reranks|models|images|audio)(/.*)?$'],
    ['AI API 国内 v3 接口放行', '^/api/v3/(chat/completions|responses|embeddings|rerank|models|images|audio|files|batch|batches)(/.*)?$'],
    ['AI API 国内 v2 接口放行', '^/v2/(chat/completions|embeddings|rerank|models|images|audio)(/.*)?$'],
  ]),
});

export const SITE_PROFILES = Object.freeze({
  web: Object.freeze({ label: '普通网站', protocols: Object.freeze([]) }),
  openai: Object.freeze({ label: 'OpenAI API', protocols: Object.freeze(['openai']) }),
  anthropic: Object.freeze({ label: 'Anthropic API', protocols: Object.freeze(['anthropic']) }),
  gemini: Object.freeze({ label: 'Gemini API', protocols: Object.freeze(['gemini']) }),
  azure_openai: Object.freeze({ label: 'Azure OpenAI API', protocols: Object.freeze(['azure_openai']) }),
  cohere: Object.freeze({ label: 'Cohere API', protocols: Object.freeze(['cohere']) }),
  china_ai: Object.freeze({ label: '国内 AI API', protocols: Object.freeze(['china_ai']) }),
  mixed_ai: Object.freeze({
    label: 'AI API 全协议',
    protocols: Object.freeze(['openai', 'anthropic', 'gemini', 'azure_openai', 'cohere', 'china_ai']),
  }),
});

export function normalizeSiteProfile(value) {
  const profile = String(value ?? 'web').trim().toLowerCase() || 'web';
  if (!Object.hasOwn(SITE_PROFILES, profile)) throw new RangeError('建站策略无效');
  return profile;
}

export function siteProfileLabel(value) {
  return SITE_PROFILES[normalizeSiteProfile(value)].label;
}

function buildAllowRule([description, regex]) {
  return {
    matcher: [{ item: 'uri', op: 'regex', value: regex, value2: '' }],
    filter: structuredClone(AI_RULE_FILTER),
    mode: 'break',
    des: description,
    enable: 1,
  };
}

export function siteProfileRules(value) {
  const profile = SITE_PROFILES[normalizeSiteProfile(value)];
  return profile.protocols.flatMap(protocol => PROTOCOL_RULES[protocol].map(buildAllowRule));
}

function existingExtraRules(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return structuredClone(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new TypeError('网站自定义 CC 规则格式无效');
}

export function applySiteProfile(input, value) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('网站配置必须是对象');
  const profile = normalizeSiteProfile(value);
  const output = structuredClone(input);
  if (profile === 'web') return output;

  output.extra_cc_rule = [...siteProfileRules(profile), ...existingExtraRules(output.extra_cc_rule)];
  output.proxy_cache = [];
  const timeout = Number(output.proxy_timeout);
  output.proxy_timeout = Number.isFinite(timeout) ? Math.max(600, timeout) : 600;
  output.proxy_http_version = '1.1';
  output.websocket_enable = 1;
  return output;
}
