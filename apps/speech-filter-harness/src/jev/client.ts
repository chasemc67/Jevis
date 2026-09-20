import { createGateway } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';
import type { Log } from '../stt/types.js';
import { buildEvaluationRequest, questionIds } from './questions.js';
import type { CandidateDecision, EvaluationInput, JevEvaluation, JevEvaluator } from './types.js';

export const JEV_MODEL = 'typesafe-ai/jev';
// The SDK protocol endpoint differs from Gateway's public REST /v1/evaluate.
const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
const EVALUATION_URL = `${GATEWAY_BASE_URL}/evaluation-model`;

export interface GatewayJevClientOptions {
  apiKey: string;
  timeoutMs?: number;
  zeroDataRetention?: boolean;
  log?: Log;
}

export interface GatewayJevClientDependencies {
  /** Test transport injection; the destination remains fixed to AI Gateway. */
  fetch?: typeof globalThis.fetch;
  random?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** SDK validates answer types/distributions; additionally require its optional probabilities. */
function parseDecisions(input: EvaluationInput, answers: unknown): CandidateDecision[] {
  if (!isRecord(answers)) throw new Error('Malformed answers');
  return input.candidates.map(({ startIndex }) => {
    const ids = questionIds(startIndex);
    const addressing = answers[ids.addressing];
    const isDirected = answers[ids.isDirected];
    if (!isRecord(addressing) || !isRecord(isDirected)) throw new Error('Missing answer');
    const probabilities = addressing.probabilities;
    if (
      addressing.type !== 'choice' ||
      !['directed', 'ambient', 'unclear'].includes(String(addressing.choice)) ||
      !isRecord(probabilities) ||
      !isProbability(probabilities.directed) ||
      !isProbability(probabilities.ambient) ||
      !isProbability(probabilities.unclear) ||
      isDirected.type !== 'boolean' ||
      !isProbability(isDirected.probability)
    ) {
      throw new Error('Malformed answer');
    }
    return {
      startIndex,
      addressing: addressing.choice as CandidateDecision['addressing'],
      directedProbability: probabilities.directed,
      ambientProbability: probabilities.ambient,
      isDirectedProbability: isDirected.probability,
    };
  });
}

function validInput(input: EvaluationInput): boolean {
  return (
    typeof input.fullTranscript === 'string' &&
    input.candidates.length > 0 &&
    new Set(input.candidates.map(candidate => candidate.startIndex)).size === input.candidates.length &&
    input.candidates.every(candidate =>
      Number.isSafeInteger(candidate.startIndex) && candidate.startIndex >= 0 && candidate.text.trim().length > 0,
    )
  );
}

function abortError(): DOMException {
  return new DOMException('Jev evaluation cancelled', 'AbortError');
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class GatewayJevClient implements JevEvaluator {
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly random: () => number;

  constructor(
    private readonly options: GatewayJevClientOptions,
    dependencies: GatewayJevClientDependencies = {},
  ) {
    if (!options.apiKey.trim()) throw new Error('AI_GATEWAY_API_KEY is required for Jev');
    this.timeoutMs = options.timeoutMs ?? 4000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Jev timeout must be positive');
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.random = dependencies.random ?? Math.random;
  }

  async evaluate(input: EvaluationInput, signal: AbortSignal): Promise<JevEvaluation> {
    const started = performance.now();
    let attempts = 0;
    let status: number | undefined;
    let outcome = 'error';
    let timedOut = false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    // This bounds the entire call, including the one permitted retry and its jitter.
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Jev evaluation timed out', 'TimeoutError'));
    }, this.timeoutMs);
    const latencyMs = () => Math.round(performance.now() - started);
    const failClosed = (error: string): JevEvaluation => ({ decisions: [], latencyMs: latencyMs(), error });

    try {
      if (signal.aborted) throw abortError();
      if (!validInput(input)) return failClosed('invalid_input');
      const request = buildEvaluationRequest(input);
      const gateway = createGateway({
        apiKey: this.options.apiKey.trim(),
        baseURL: GATEWAY_BASE_URL,
        fetch: async (url, init) => {
          // Disallow alternate destinations and redirects even if upstream SDK behavior changes.
          if (String(url) !== EVALUATION_URL) throw new Error('Unexpected Gateway endpoint');
          const response = await this.fetch(url, { ...init, redirect: 'error' });
          status = response.status;
          return response;
        },
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        attempts += 1;
        status = undefined;
        try {
          const result = await evaluate({
            model: gateway.evaluationModel(JEV_MODEL),
            ...request,
            abortSignal: controller.signal,
            maxRetries: 0,
            providerOptions: {
              gateway: {
                only: ['typesafe-ai'],
                ...(this.options.zeroDataRetention ? { zeroDataRetention: true } : {}),
              },
            },
          });
          if (signal.aborted) throw abortError();
          if (timedOut) return failClosed('timeout');
          const decisions = parseDecisions(input, result.answers);
          outcome = 'ok';
          return { decisions, latencyMs: latencyMs() };
        } catch {
          if (signal.aborted) throw abortError();
          if (timedOut) return failClosed('timeout');
          // Use the observed HTTP status: SDK-wrapped parser/network errors can look like 500s.
          const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
          if (attempt === 0 && retryable) {
            const delayMs = 100 + Math.floor(this.random() * 150);
            this.options.log?.('jev_retry', { regionId: input.regionId, seq: input.seq, status, delayMs });
            await abortableDelay(delayMs, controller.signal);
            continue;
          }
          return failClosed(status !== undefined && status >= 200 && status < 300
            ? 'malformed_answers'
            : status === undefined ? 'network_error' : `gateway_http_${status}`);
        }
      }
      return failClosed('evaluation_failed');
    } catch {
      if (signal.aborted) {
        outcome = 'cancelled';
        throw abortError();
      }
      return failClosed(timedOut ? 'timeout' : 'evaluation_failed');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      // Never log SDK errors: they may embed authorization headers or transcript payloads.
      this.options.log?.('jev_latency', {
        regionId: input.regionId,
        seq: input.seq,
        latencyMs: latencyMs(),
        attempts,
        outcome: timedOut ? 'timeout' : outcome,
      });
    }
  }
}
