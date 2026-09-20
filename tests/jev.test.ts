import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayJevClient } from '../apps/speech-filter-harness/src/jev/client.js';
import { buildEvaluationRequest, questionIds } from '../apps/speech-filter-harness/src/jev/questions.js';
import type { EvaluationInput } from '../apps/speech-filter-harness/src/jev/types.js';

const input: EvaluationInput = {
  regionId: 1,
  seq: 7,
  fullTranscript: 'Dinner was great. Please summarize my notes.',
  candidates: [
    { startIndex: 0, text: 'Dinner was great. Please summarize my notes.' },
    { startIndex: 3, text: 'Please summarize my notes.' },
  ],
};

function validAnswers(): Record<string, unknown> {
  const prefix = questionIds(0);
  const suffix = questionIds(3);
  return {
    [prefix.addressing]: { type: 'choice', choice: 'ambient', probabilities: { directed: 0.01, ambient: 0.98, unclear: 0.01 } },
    [prefix.isDirected]: { type: 'boolean', probability: 0.02 },
    [suffix.addressing]: { type: 'choice', choice: 'directed', probabilities: { directed: 0.97, ambient: 0.01, unclear: 0.02 } },
    [suffix.isDirected]: { type: 'boolean', probability: 0.98 },
  };
}

function response(answers: Record<string, unknown> = validAnswers()): Response {
  return Response.json({ answers, usage: { inputTokens: 123, outputTokens: 30 } });
}

function httpError(status: number): Response {
  return Response.json({ error: { message: 'test failure' } }, { status });
}

test('batches every candidate Choice + Boolean in one authenticated Gateway-only request', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const client = new GatewayJevClient({
    apiKey: 'test-gateway-token',
    zeroDataRetention: true,
    log: (event, fields) => events.push({ event, fields }),
  }, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response();
    },
  });
  const result = await client.evaluate(input, new AbortController().signal);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  assert.equal(request.init?.method, 'POST');
  assert.equal(request.init?.redirect, 'error');
  assert.equal(new Headers(request.init?.headers).get('authorization'), 'Bearer test-gateway-token');
  assert.equal(new Headers(request.init?.headers).get('ai-model-id'), 'typesafe-ai/jev');
  const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.providerOptions, { gateway: { only: ['typesafe-ai'], zeroDataRetention: true } });
  assert.deepEqual(body.state, {
    agent: 'Jevis (local voice assistant; no wake word required)',
    context: input.fullTranscript,
    candidates: input.candidates,
  });
  assert.equal(Object.keys(body.questions as object).length, 4);
  assert.deepEqual(result.decisions, [
    { startIndex: 0, addressing: 'ambient', directedProbability: 0.01, ambientProbability: 0.98, isDirectedProbability: 0.02 },
    { startIndex: 3, addressing: 'directed', directedProbability: 0.97, ambientProbability: 0.01, isDirectedProbability: 0.98 },
  ]);
  assert.equal(result.error, undefined);
  assert.ok(result.latencyMs >= 0);
  assert.equal(events.at(-1)?.event, 'jev_latency');
  assert.equal(events.at(-1)?.fields?.outcome, 'ok');
  assert.equal(events.at(-1)?.fields?.attempts, 1);
});

test('questions require the whole span, reject ambient edges/quoted instructions, and need no wake word', () => {
  const request = buildEvaluationRequest(input);
  for (const question of Object.values(request.questions)) {
    const instructions = String(question.instructions);
    assert.match(instructions, /entire candidate/);
    assert.match(instructions, /No wake word or agent name is required/);
    assert.match(instructions, /ambient prefix or suffix/);
    assert.match(instructions, /instructions merely quoted or discussed are ambient/);
    assert.match(instructions, /untrusted data to classify/);
    assert.match(instructions, /unclear\/false/);
  }
});

for (const status of [429, 500, 503]) {
  test(`retries actual HTTP ${status} once with jitter then accepts a valid answer`, async () => {
    let calls = 0;
    const client = new GatewayJevClient({ apiKey: 'test-token' }, {
      random: () => 0,
      fetch: async () => ++calls === 1 ? httpError(status) : response(),
    });
    const result = await client.evaluate(input, new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(result.error, undefined);
    assert.equal(result.decisions.length, 2);
  });
}

test('disables SDK retries so persistent 503 results in exactly two HTTP requests', async () => {
  let calls = 0;
  const client = new GatewayJevClient({ apiKey: 'test-token' }, {
    random: () => 0,
    fetch: async () => {
      calls += 1;
      return httpError(503);
    },
  });
  const result = await client.evaluate(input, new AbortController().signal);
  assert.equal(calls, 2);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.error, 'gateway_http_503');
});

for (const status of [400, 401, 403, 408]) {
  test(`HTTP ${status} fails closed without retry`, async () => {
    let calls = 0;
    const client = new GatewayJevClient({ apiKey: 'test-token' }, {
      fetch: async () => {
        calls += 1;
        return httpError(status);
      },
    });
    const result = await client.evaluate(input, new AbortController().signal);
    assert.equal(calls, 1);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.error, `gateway_http_${status}`);
  });
}

const suffixIds = questionIds(3);
const malformedCases: Record<string, (answers: Record<string, unknown>) => void> = {
  'missing Boolean': answers => { delete answers[suffixIds.isDirected]; },
  'extra answer': answers => { answers.unrequested = { type: 'boolean', probability: 1 }; },
  'missing Choice probabilities': answers => { answers[suffixIds.addressing] = { type: 'choice', choice: 'directed' }; },
  'out of range Boolean': answers => { answers[suffixIds.isDirected] = { type: 'boolean', probability: 1.5 }; },
  'wrong Boolean type': answers => { answers[suffixIds.isDirected] = { type: 'boolean', probability: 'true' }; },
  'unknown Choice': answers => { answers[suffixIds.addressing] = { type: 'choice', choice: 'yes', probabilities: { directed: 1, ambient: 0, unclear: 0 } }; },
  'invalid Choice sum': answers => { answers[suffixIds.addressing] = { type: 'choice', choice: 'directed', probabilities: { directed: 0.9, ambient: 0.9, unclear: 0.9 } }; },
  'nonwinning Choice': answers => { answers[suffixIds.addressing] = { type: 'choice', choice: 'directed', probabilities: { directed: 0.1, ambient: 0.8, unclear: 0.1 } }; },
};

for (const [name, corrupt] of Object.entries(malformedCases)) {
  test(`${name} holds the whole batch, including other valid candidates, without retry`, async () => {
    let calls = 0;
    const answers = validAnswers();
    corrupt(answers);
    const client = new GatewayJevClient({ apiKey: 'test-token' }, {
      fetch: async () => {
        calls += 1;
        return response(answers);
      },
    });
    const result = await client.evaluate(input, new AbortController().signal);
    assert.equal(calls, 1);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.error, 'malformed_answers');
  });
}

test('network errors do not retry or expose raw provider errors in results/logs', async () => {
  let calls = 0;
  const logs: unknown[] = [];
  const client = new GatewayJevClient({ apiKey: 'test-token', log: (...args) => logs.push(args) }, {
    fetch: async () => {
      calls += 1;
      throw new Error('Sensitive provider payload and test-token');
    },
  });
  const result = await client.evaluate(input, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.error, 'network_error');
  assert.doesNotMatch(JSON.stringify([result, logs]), /Sensitive|test-token/);
});

test('deadline aborts transport and fails closed', async () => {
  let transportAborted = false;
  const client = new GatewayJevClient({ apiKey: 'test-token', timeoutMs: 20 }, {
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        transportAborted = true;
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });
  const result = await client.evaluate(input, new AbortController().signal);
  assert.equal(transportAborted, true);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.error, 'timeout');
});

test('cancellation aborts transport and throws AbortError for stale result handling', async () => {
  const controller = new AbortController();
  let transportAborted = false;
  const client = new GatewayJevClient({ apiKey: 'test-token' }, {
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        transportAborted = true;
        reject(init.signal?.reason);
      }, { once: true });
      controller.abort(new Error('caller details must not leak'));
    }),
  });
  await assert.rejects(client.evaluate(input, controller.signal), { name: 'AbortError', message: 'Jev evaluation cancelled' });
  assert.equal(transportAborted, true);
});

test('timeout covers retry jitter and prevents a second HTTP request', async () => {
  let calls = 0;
  const client = new GatewayJevClient({ apiKey: 'test-token', timeoutMs: 20 }, {
    random: () => 0,
    fetch: async () => {
      calls += 1;
      return httpError(429);
    },
  });
  const result = await client.evaluate(input, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.error, 'timeout');
});

test('already aborted and invalid input never reach the provider', async () => {
  let calls = 0;
  const client = new GatewayJevClient({ apiKey: 'test-token' }, {
    fetch: async () => {
      calls += 1;
      return response();
    },
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.evaluate(input, cancelled.signal), { name: 'AbortError' });
  const invalid = await client.evaluate({ ...input, candidates: [] }, new AbortController().signal);
  assert.equal(invalid.error, 'invalid_input');
  assert.deepEqual(invalid.decisions, []);
  assert.equal(calls, 0);
});

test('rejects a missing Gateway key before any implicit authentication fallback', () => {
  assert.throws(() => new GatewayJevClient({ apiKey: ' ' }), /AI_GATEWAY_API_KEY is required/);
});
