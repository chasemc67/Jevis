import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { CandidateDecision, JevEvaluation, JevEvaluator, EvaluationInput } from '../jev/types.js';
import type { SttCallbacks, WordEvent } from '../stt/types.js';

export type FixtureEvent =
  | { atMs: number; type: 'transcript'; event: WordEvent }
  | { atMs: number; type: 'boundary'; reason: string }
  | { atMs: number; type: 'connection'; connected: boolean };

export type FixtureDecision = Omit<CandidateDecision, 'startIndex'>;

export interface WordFixture {
  version: 1;
  name: string;
  description?: string;
  /** Includes the final quiet interval, allowing the real debounce timer to fire. */
  durationMs: number;
  events: FixtureEvent[];
  dryRun: {
    latencyMs: number;
    /** Exact candidate text labels for a scripted demo; these are not model predictions. */
    rules: (FixtureDecision & { text: string })[];
    defaultDecision: FixtureDecision;
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid fixture ${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid fixture ${path}: expected a finite non-negative number`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid fixture ${path}: expected non-empty text`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid fixture ${path}: expected a boolean`);
  return value;
}

function decision(value: unknown, path: string): FixtureDecision {
  const raw = object(value, path);
  const addressing = raw.addressing;
  if (addressing !== 'directed' && addressing !== 'ambient' && addressing !== 'unclear') {
    throw new Error(`Invalid fixture ${path}.addressing: expected directed, ambient, or unclear`);
  }
  const probability = (key: string): number => {
    const result = number(raw[key], `${path}.${key}`);
    if (result > 1) throw new Error(`Invalid fixture ${path}.${key}: probability exceeds 1`);
    return result;
  };
  const directedProbability = probability('directedProbability');
  const ambientProbability = probability('ambientProbability');
  if (directedProbability + ambientProbability > 1 + Number.EPSILON) {
    throw new Error(`Invalid fixture ${path}: Choice probabilities exceed 1`);
  }
  return { addressing, directedProbability, ambientProbability, isDirectedProbability: probability('isDirectedProbability') };
}

function transcript(value: unknown, path: string): WordEvent {
  const raw = object(value, path);
  if (typeof raw.text !== 'string') throw new Error(`Invalid fixture ${path}.text: expected text`);
  const startMs = number(raw.startMs, `${path}.startMs`);
  const endMs = number(raw.endMs, `${path}.endMs`);
  if (endMs < startMs) throw new Error(`Invalid fixture ${path}: endMs precedes startMs`);
  if (!Array.isArray(raw.words)) throw new Error(`Invalid fixture ${path}.words: expected an array`);
  let previousEnd = startMs;
  const words = raw.words.map((value, i) => {
    const wordPath = `${path}.words[${i}]`;
    const rawWord = object(value, wordPath);
    const wordStart = number(rawWord.startMs, `${wordPath}.startMs`);
    const wordEnd = number(rawWord.endMs, `${wordPath}.endMs`);
    if (wordStart < previousEnd || wordEnd < wordStart || wordEnd > endMs) {
      throw new Error(`Invalid fixture ${wordPath}: words must be ordered and within the event time range`);
    }
    previousEnd = wordEnd;
    return {
      text: string(rawWord.text, `${wordPath}.text`),
      startMs: wordStart,
      endMs: wordEnd,
      isFinal: boolean(rawWord.isFinal, `${wordPath}.isFinal`),
    };
  });
  const event: WordEvent = { text: raw.text, words, startMs, endMs, isFinal: boolean(raw.isFinal, `${path}.isFinal`) };
  if (raw.speechFinal !== undefined) event.speechFinal = boolean(raw.speechFinal, `${path}.speechFinal`);
  return event;
}

/** Validate external fixtures before any event reaches the filter or a network service. */
export function parseFixture(value: unknown): WordFixture {
  const raw = object(value, 'root');
  if (raw.version !== 1) throw new Error('Invalid fixture version: expected 1');
  const name = string(raw.name, 'name');
  const durationMs = number(raw.durationMs, 'durationMs');
  if (!Array.isArray(raw.events) || raw.events.length === 0) throw new Error('Invalid fixture events: expected a non-empty array');
  let previousTime = 0;
  const events: FixtureEvent[] = raw.events.map((value, index) => {
    const path = `events[${index}]`;
    const event = object(value, path);
    const atMs = number(event.atMs, `${path}.atMs`);
    if (atMs < previousTime || atMs > durationMs) throw new Error(`Invalid fixture ${path}: event times must be ordered and within durationMs`);
    previousTime = atMs;
    switch (event.type) {
      case 'transcript': return { atMs, type: 'transcript', event: transcript(event.event, `${path}.event`) };
      case 'boundary': return { atMs, type: 'boundary', reason: string(event.reason, `${path}.reason`) };
      case 'connection': return { atMs, type: 'connection', connected: boolean(event.connected, `${path}.connected`) };
      default: throw new Error(`Invalid fixture ${path}.type: unknown event type`);
    }
  });
  const rawDryRun = object(raw.dryRun, 'dryRun');
  if (!Array.isArray(rawDryRun.rules)) throw new Error('Invalid fixture dryRun.rules: expected an array');
  const seen = new Set<string>();
  const rules = rawDryRun.rules.map((value, i) => {
    const path = `dryRun.rules[${i}]`;
    const rule = object(value, path);
    const text = string(rule.text, `${path}.text`);
    if (seen.has(text)) throw new Error(`Invalid fixture ${path}.text: duplicate label`);
    seen.add(text);
    return { text, ...decision(rule, path) };
  });
  const result: WordFixture = {
    version: 1, name, durationMs, events,
    dryRun: {
      latencyMs: number(rawDryRun.latencyMs, 'dryRun.latencyMs'),
      rules,
      defaultDecision: decision(rawDryRun.defaultDecision, 'dryRun.defaultDecision'),
    },
  };
  if (raw.description !== undefined) result.description = string(raw.description, 'description');
  return result;
}

export async function loadFixture(path: string): Promise<WordFixture> {
  return parseFixture(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export async function replayFixture(
  fixture: WordFixture,
  callbacks: SttCallbacks,
  options: { signal?: AbortSignal; speed?: number } = {},
): Promise<void> {
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Fixture speed must be a finite positive number');
  options.signal?.throwIfAborted();
  callbacks.log('fixture_started', { name: fixture.name, speed, durationMs: fixture.durationMs });
  callbacks.onConnection(true);
  const started = performance.now();
  const waitUntil = async (atMs: number): Promise<void> => {
    options.signal?.throwIfAborted();
    const remaining = atMs / speed - (performance.now() - started);
    if (remaining > 0) await delay(remaining, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
  };
  for (const item of fixture.events) {
    await waitUntil(item.atMs);
    switch (item.type) {
      case 'transcript': callbacks.onTranscript(structuredClone(item.event)); break;
      case 'boundary': callbacks.onBoundary(item.reason); break;
      case 'connection': callbacks.onConnection(item.connected); break;
    }
  }
  await waitUntil(fixture.durationMs);
  callbacks.log('fixture_completed', { name: fixture.name });
}

/** Offline plumbing demo only. Uses explicit fixture labels, never keywords or a real Jev model. */
export class FixtureJevEvaluator implements JevEvaluator {
  private readonly rules: Map<string, FixtureDecision>;

  constructor(private readonly fixture: WordFixture) {
    this.rules = new Map(fixture.dryRun.rules.map(({ text, ...label }) => [text, label]));
  }

  async evaluate(input: EvaluationInput, signal: AbortSignal): Promise<JevEvaluation> {
    const started = performance.now();
    signal.throwIfAborted();
    await delay(this.fixture.dryRun.latencyMs, undefined, { signal });
    return {
      decisions: input.candidates.map(candidate => ({
        startIndex: candidate.startIndex,
        ...(this.rules.get(candidate.text) ?? this.fixture.dryRun.defaultDecision),
      })),
      latencyMs: performance.now() - started,
    };
  }
}
