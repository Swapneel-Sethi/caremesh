// Minimal Adaption Responses API client.
//
// This is deliberately not a general OpenAI-compatible SDK: it only builds the
// request shape CarePulse needs and maps every failure to a small internal
// code. Upstream response bodies and the API key are never logged or returned.

import { config } from './config.mjs';

export class AdaptionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AdaptionError';
    this.code = code;
  }
}

function normalizeBaseUrl(value) {
  return String(value || 'https://api.prod.adaptionlabs.ai/api/v1').replace(/\/+$/, '');
}

export async function createAdaptionResponse(options = {}) {
  const {
    input,
    instructions,
    tools,
    toolChoice,
    maxToolCalls,
    maxOutputTokens = config.adaptionMaxOutputTokens,
    temperature = 0,
    store = false,
    model = config.adaptionModel,
    enabled = config.adaptionEnabled,
    apiKey = process.env.ADAPTION_API_KEY || '',
    baseUrl = config.adaptionBaseUrl,
    timeoutMs = config.adaptionTimeoutMs,
    fetchImpl = globalThis.fetch
  } = options;

  if (!enabled) throw new AdaptionError('disabled');
  if (!apiKey) throw new AdaptionError('missing_credentials');
  if (typeof input !== 'string' || !input) throw new AdaptionError('invalid_input');
  if (typeof fetchImpl !== 'function') throw new AdaptionError('unavailable');

  const body = {
    model,
    input,
    max_output_tokens: maxOutputTokens,
    temperature,
    store
  };
  if (instructions) body.instructions = instructions;
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (maxToolCalls) body.max_tool_calls = maxToolCalls;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response?.ok) throw new AdaptionError(`http_${Number(response?.status) || 0}`);

    try {
      return await response.json();
    } catch {
      throw new AdaptionError('malformed_response');
    }
  } catch (error) {
    if (error instanceof AdaptionError) throw error;
    if (error?.name === 'AbortError' || controller.signal.aborted) throw new AdaptionError('timeout');
    throw new AdaptionError('network_error');
  } finally {
    clearTimeout(timer);
  }
}

export function extractFunctionCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item) => item && item.type === 'function_call' && typeof item.name === 'string');
}

export function findFunctionCall(response, name) {
  return extractFunctionCalls(response).find((item) => item.name === name) || null;
}

export function parseFunctionArguments(call) {
  if (!call || typeof call.arguments !== 'string') return null;
  try {
    const parsed = JSON.parse(call.arguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function adaptionStatus() {
  return { enabled: config.adaptionEnabled, model: config.adaptionModel };
}
