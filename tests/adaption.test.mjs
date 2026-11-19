import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptionError,
  createAdaptionResponse,
  extractFunctionCalls,
  findFunctionCall,
  parseFunctionArguments
} from '../src/adaption.mjs';
import { generateCareBrief } from '../src/care-brief-adapter.mjs';

const base = 'https://example.test/api/v1';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('adaption request uses the verified endpoint, bearer auth and a minimal body', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({ output: [] });
  };

  await createAdaptionResponse({
    input: '{"escalation_context":{}}',
    instructions: 'Decide.',
    tools: [{ type: 'function', name: 'submit_decision' }],
    toolChoice: { type: 'function', name: 'submit_decision' },
    maxToolCalls: 1,
    maxOutputTokens: 128,
    temperature: 0,
    enabled: true,
    apiKey: 'unit-test-key',
    baseUrl: `${base}/`,
    timeoutMs: 500,
    fetchImpl
  });

  assert.equal(seen.url, `${base}/responses`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer unit-test-key');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.max_output_tokens, 128);
  assert.equal(seen.body.max_tool_calls, 1);
  assert.deepEqual(seen.body.tool_choice, { type: 'function', name: 'submit_decision' });
  assert.equal(seen.body.input, '{"escalation_context":{}}');
});

test('store defaults to false', async () => {
  let body;
  await createAdaptionResponse({
    input: '{}',
    enabled: true,
    apiKey: 'unit-test-key',
    baseUrl: base,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({});
    }
  });
  assert.equal(body.store, false);
});

test('a missing key fails before any network call', async () => {
  let called = false;
  await assert.rejects(
    () => createAdaptionResponse({
      input: '{}',
      enabled: true,
      apiKey: '',
      baseUrl: base,
      fetchImpl: async () => { called = true; return jsonResponse({}); }
    }),
    (error) => error instanceof AdaptionError && error.code === 'missing_credentials'
  );
  assert.equal(called, false);
});

test('disabled mode fails with an internal code', async () => {
  await assert.rejects(
    () => createAdaptionResponse({ input: '{}', enabled: false, apiKey: 'unit-test-key', fetchImpl: async () => jsonResponse({}) }),
    (error) => error instanceof AdaptionError && error.code === 'disabled'
  );
});

test('timeout aborts the request and maps to a safe code', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

  await assert.rejects(
    () => createAdaptionResponse({
      input: '{}',
      enabled: true,
      apiKey: 'unit-test-key',
      baseUrl: base,
      timeoutMs: 10,
      fetchImpl
    }),
    (error) => error instanceof AdaptionError && error.code === 'timeout'
  );
});

test('HTTP failures never expose the upstream body or key', async () => {
  await assert.rejects(
    () => createAdaptionResponse({
      input: '{}',
      enabled: true,
      apiKey: 'unit-test-key',
      baseUrl: base,
      fetchImpl: async () => jsonResponse({ message: 'provider detail' }, 503)
    }),
    (error) => {
      assert.ok(error instanceof AdaptionError);
      assert.equal(error.code, 'http_503');
      assert.doesNotMatch(String(error.message), /provider detail|unit-test-key/);
      return true;
    }
  );
});

test('malformed JSON maps to malformed_response', async () => {
  await assert.rejects(
    () => createAdaptionResponse({
      input: '{}',
      enabled: true,
      apiKey: 'unit-test-key',
      baseUrl: base,
      fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error('bad json'); } })
    }),
    (error) => error instanceof AdaptionError && error.code === 'malformed_response'
  );
});

test('network errors map to network_error', async () => {
  await assert.rejects(
    () => createAdaptionResponse({
      input: '{}',
      enabled: true,
      apiKey: 'unit-test-key',
      baseUrl: base,
      fetchImpl: async () => { throw new TypeError('socket closed'); }
    }),
    (error) => error instanceof AdaptionError && error.code === 'network_error'
  );
});

test('function call helpers read the verified Adaption output shape', () => {
  const response = {
    output: [
      { type: 'reasoning', id: 'r1' },
      {
        type: 'function_call',
        name: 'submit_decision',
        call_id: 'call_1',
        arguments: '{"action":"email_caregiver","reason_code":"repeated_miss","confidence":0.8}'
      }
    ]
  };

  const calls = extractFunctionCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(findFunctionCall(response, 'submit_decision').call_id, 'call_1');
  assert.equal(findFunctionCall(response, 'other'), null);
  assert.deepEqual(parseFunctionArguments(calls[0]), {
    action: 'email_caregiver',
    reason_code: 'repeated_miss',
    confidence: 0.8
  });
  assert.equal(parseFunctionArguments({ arguments: 'not json' }), null);
  assert.equal(parseFunctionArguments({ arguments: '[1,2]' }), null);
});

test('care brief adapter uses Adaption only when selected and minimizes data', async () => {
  const snapshot = {
    profiles: [{ name: 'Meera Rao', age: 72 }],
    medications: [{ name: 'Metformin 500 mg', schedule: '08:00', status: 'pending', instructions: 'Take with food.' }],
    appointments: [],
    careTeam: [{ name: 'Priya Shah', role: 'Caregiver' }]
  };

  let requested;
  const brief = await generateCareBrief(snapshot, {
    provider: 'adaption',
    enabled: true,
    apiKey: 'unit-test-key',
    baseUrl: base,
    timeoutMs: 500,
    fetchImpl: async (url, init) => {
      requested = JSON.parse(init.body);
      return jsonResponse({ output_text: 'TODAY\nAdaption brief.' });
    }
  });

  assert.equal(brief, 'TODAY\nAdaption brief.');
  assert.match(requested.input, /care_snapshot/);
  assert.doesNotMatch(requested.input, /Meera|Priya|500 mg|Take with food|@|\+91/);

  const fallback = await generateCareBrief(snapshot, {
    provider: 'adaption',
    enabled: true,
    apiKey: 'unit-test-key',
    baseUrl: base,
    timeoutMs: 500,
    fetchImpl: async () => { throw new Error('adaption down'); }
  });
  assert.match(fallback, /TODAY/);
});

test('care brief keeps Gemini and deterministic paths when Adaption is not selected', async () => {
  const snapshot = { medications: [], appointments: [], careTeam: [] };
  let called = false;
  const brief = await generateCareBrief(snapshot, {
    provider: 'gemini',
    fetchImpl: async () => { called = true; return jsonResponse({}); }
  });
  assert.match(brief, /TODAY/);
  assert.equal(called, false);
});
