// Model providers billed per token with an API key. All six speak the OpenAI chat-completions format.
// Base URLs and environment variable names are checked against each provider's own docs before release
// (see build\research\frontier.json); until then they are the documented values as last known.
// toolsVerified: tools go to a provider only when this is true (ctx is dropped otherwise, so the reply is text only).
// xAI is false, because its tool calls on chat completions are not confirmed (frontier.json tools.verified).
// streamUsage: the request asks for the token counts in the stream (stream_options.include_usage), which the cost display
// needs. UNVERIFIED, from the providers' docs as last known: Mistral's chat endpoint documents no stream_options field and
// is believed to reject an unknown field, so Mistral is left out and is expected to send its usage in the last chunk
// anyway. If it does not, its replies show "not reported" rather than an estimate.
// checkPath (optional): the path under baseUrl that a key check calls, GET {baseUrl}{checkPath} with the key. It is /models when
// absent. OpenRouter names its own key endpoint, so the check answers for the key itself and not for a list.
// OpenRouter, read on its official pages: https://openrouter.ai/docs/quickstart (base URL, /chat/completions, OPENROUTER_API_KEY),
// https://openrouter.ai/docs/api-reference/authentication (the key page, openrouter.ai/keys),
// https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties (GET /api/v1/models),
// https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key (GET /api/v1/key, 401 for a key it does not accept) and
// https://openrouter.ai/docs/guides/administration/usage-accounting (usage is always in the last stream chunk, and
// stream_options.include_usage is deprecated and has no effect, so streamUsage is false). Its tools are not verified.
export const API_PROVIDERS = [
  { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY', keyUrl: 'https://console.x.ai', docsUrl: 'https://docs.x.ai', toolsVerified: false, streamUsage: true },
  { id: 'openai', label: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://platform.openai.com/docs', toolsVerified: true, streamUsage: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', envVar: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com', toolsVerified: true, streamUsage: true },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', envVar: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', docsUrl: 'https://docs.mistral.ai', toolsVerified: true, streamUsage: false },
  { id: 'googleai', label: 'Google AI (Gemini API)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envVar: 'GOOGLE_AI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/openai', toolsVerified: true, streamUsage: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys', docsUrl: 'https://openrouter.ai/docs/quickstart', checkPath: '/key', toolsVerified: false, streamUsage: false },
];

export const apiProvider = id => API_PROVIDERS.find(p => p.id === id) ?? null;
