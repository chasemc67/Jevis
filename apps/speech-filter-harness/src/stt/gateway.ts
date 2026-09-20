import { createGateway } from '@ai-sdk/gateway';
import {
  experimental_streamTranscribe as streamTranscribe,
  NoTranscriptGeneratedError,
  type StreamTranscriptionResult,
  type TranscriptionStreamPart,
} from 'ai';
import { DEFAULT_STT_MODEL, type GatewaySttModel } from './models.js';
import type { SttCallbacks, Word, WordEvent } from './types.js';

export const GATEWAY_STT_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_MS = GATEWAY_STT_SAMPLE_RATE * 2 / 1000;
const MAX_QUEUED_AUDIO_BYTES = GATEWAY_STT_SAMPLE_RATE * 2;
type TranscriptPart = Extract<TranscriptionStreamPart, { type: 'transcript-delta' | 'transcript-partial' | 'transcript-final' }>;
class GatewaySttError extends Error {}

function timestamp(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid Gateway transcript timestamp.');
  return Math.round(value * 1000);
}

/**
 * Turn vendor deltas into replaceable hypotheses. Without word timestamps we
 * distribute new/revised words over received PCM time, preserving unchanged
 * prefix timings. These are approximate stream-clock positions, not alignment.
 */
export class GatewayTranscriptNormalizer {
  private text = '';
  private words: Word[] = [];
  private startMs = 0;
  private endMs = 0;
  private activeId?: string;
  private lastAnonymousFinal?: { text: string; audioEndMs: number; startSecond?: number };
  private readonly finalizedIds = new Set<string>();

  apply(part: TranscriptPart, audioEndMs: number): WordEvent | undefined {
    if (!Number.isFinite(audioEndMs) || audioEndMs < 0) throw new Error('Invalid PCM clock.');
    if (part.id !== undefined && typeof part.id !== 'string') throw new Error('Invalid transcript ID.');
    if (part.id !== undefined && this.finalizedIds.has(part.id)) return undefined;
    if (part.type === 'transcript-final' && part.id === undefined && !this.words.length &&
      this.lastAnonymousFinal?.text === part.text && this.lastAnonymousFinal.audioEndMs === audioEndMs &&
      this.lastAnonymousFinal.startSecond === part.startSecond) return undefined;
    if (this.activeId !== undefined && part.id !== undefined && this.activeId !== part.id && this.words.length) {
      // Reordering unfinished utterances would splice unrelated speech in the
      // filter's single replaceable tail. Invalidate the stream instead.
      throw new Error('Gateway returned overlapping unfinished transcript IDs.');
    }
    this.activeId ??= part.id;
    const isFinal = part.type === 'transcript-final';
    const incoming = part.type === 'transcript-delta' ? part.delta : part.text;
    if (typeof incoming !== 'string') throw new Error('Invalid Gateway transcript text.');
    this.text = part.type === 'transcript-delta' ? this.text + incoming : incoming;
    const tokens = this.text.trim().split(/\s+/u).filter(Boolean);
    const suppliedStart = part.type === 'transcript-delta' ? undefined : timestamp(part.startSecond);
    const suppliedEnd = part.type === 'transcript-final' ? timestamp(part.endSecond) :
      part.type === 'transcript-partial' && part.durationInSeconds !== undefined ?
        (suppliedStart ?? this.startMs) + timestamp(part.durationInSeconds)! : undefined;
    if (suppliedStart !== undefined && suppliedEnd !== undefined && suppliedEnd < suppliedStart) {
      throw new Error('Invalid Gateway transcript range.');
    }
    // Once a hypothesis has been emitted its replacement range must retain the
    // old start/end, including when the final text withdraws some of its words.
    if (!this.words.length && suppliedStart !== undefined) this.startMs = Math.max(this.startMs, suppliedStart);
    const endMs = Math.max(this.endMs, suppliedEnd ?? audioEndMs, this.startMs + Math.max(tokens.length, 1));
    let prefix = 0;
    while (prefix < tokens.length && this.words[prefix]?.text === tokens[prefix]) prefix++;
    const retained = this.words.slice(0, prefix).map(word => ({ ...word, isFinal }));
    const tailStart = retained.at(-1)?.endMs ?? this.startMs;
    const tailCount = tokens.length - prefix;
    const tailEnd = Math.max(endMs, tailStart + tailCount);
    const words: Word[] = [...retained, ...tokens.slice(prefix).map((text, index) => ({
      text,
      startMs: tailStart + (tailEnd - tailStart) * index / tailCount,
      endMs: tailStart + (tailEnd - tailStart) * (index + 1) / tailCount,
      isFinal,
    }))];
    const event: WordEvent = {
      text: tokens.join(' '), words, startMs: this.startMs,
      endMs: Math.max(endMs, words.at(-1)?.endMs ?? 0), isFinal, speechFinal: isFinal,
    };
    this.words = words;
    this.endMs = event.endMs;
    if (isFinal) {
      if (this.activeId === undefined) this.lastAnonymousFinal = { text: part.text, audioEndMs, startSecond: part.startSecond };
      if (this.activeId !== undefined) {
        this.finalizedIds.add(this.activeId);
        // Bound bookkeeping during indefinitely long microphone sessions.
        if (this.finalizedIds.size > 256) this.finalizedIds.delete(this.finalizedIds.values().next().value!);
      }
      this.activeId = undefined;
      this.text = '';
      this.words = [];
      this.startMs = this.endMs;
    }
    return event;
  }
}

export interface GatewaySttOptions {
  apiKey: string;
  model?: GatewaySttModel;
  callbacks: SttCallbacks;
  /** Injectable SDK call; tests still exercise the production audio/lifecycle adapter. */
  transcribe?: (options: Parameters<typeof streamTranscribe>[0]) => Pick<StreamTranscriptionResult, 'fullStream'>;
  connectTimeoutMs?: number;
  finalizeTimeoutMs?: number;
}

/** One cancellable Gateway session; switching models creates a fresh instance. */
export class GatewayStt {
  readonly done: Promise<void>;
  readonly model: GatewaySttModel;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private resolveConnection?: () => void;
  private rejectConnection?: (error: Error) => void;
  private connectionPromise?: Promise<void>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private readonly abort = new AbortController();
  private reader?: ReadableStreamDefaultReader<TranscriptionStreamPart>;
  private readonly normalizer = new GatewayTranscriptNormalizer();
  private readonly audioQueue: Buffer[] = [];
  private queuedBytes = 0;
  private audioBytes = 0;
  private pendingAudio?: { controller: ReadableStreamDefaultController<Uint8Array | string>; resolve(): void };
  private isConnected = false;
  private finishing = false;
  private stopped = false;
  private failure?: Error;
  private droppedFrames = 0;
  private malformedEvents = 0;
  private nonemptyTranscriptEvents = 0;
  private pump?: Promise<void>;
  private finalizePromise?: Promise<void>;

  constructor(private readonly options: GatewaySttOptions) {
    if (!options.apiKey.trim()) throw new Error('AI_GATEWAY_API_KEY is required for live STT.');
    this.model = options.model ?? DEFAULT_STT_MODEL;
    this.done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    void this.done.catch(() => {});
  }

  get connected(): boolean { return this.isConnected; }
  get stats(): { droppedAudioFrames: number; reconnects: number; malformedEvents: number } {
    return { droppedAudioFrames: this.droppedFrames, reconnects: 0, malformedEvents: this.malformedEvents };
  }

  connect(): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    if (this.stopped || this.finishing) return Promise.reject(new Error('STT connection stopped.'));
    this.options.callbacks.onConnection(false);
    this.options.callbacks.log('stt_connecting', { provider: 'gateway', model: this.model });
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    void this.connectionPromise.catch(() => {});
    this.connectTimer = setTimeout(() => this.fail(new Error('Gateway STT connection timed out.')), this.options.connectTimeoutMs ?? 10_000);
    const audio = new ReadableStream<Uint8Array | string>({
      pull: controller => {
        // HWM=0 prevents eager pull. Gateway reads audio only after its socket
        // opens, so this is the SDK-supported point to start microphone capture.
        this.markConnected();
        const frame = this.audioQueue.shift();
        if (frame) { this.queuedBytes -= frame.length; controller.enqueue(frame); return; }
        if (this.finishing || this.stopped || this.failure) { controller.close(); return; }
        return new Promise<void>(resolve => { this.pendingAudio = { controller, resolve }; });
      },
      cancel: () => this.clearAudio(),
    }, { highWaterMark: 0 });
    try {
      const result = (this.options.transcribe ?? streamTranscribe)({
        model: createGateway({ apiKey: this.options.apiKey }).transcriptionModel(this.model),
        audio, inputAudioFormat: { type: 'audio/pcm', rate: GATEWAY_STT_SAMPLE_RATE },
        abortSignal: this.abort.signal,
      });
      this.reader = result.fullStream.getReader();
      this.pump = this.consume();
    } catch (error) { this.fail(this.safeError(error)); }
    return this.connectionPromise;
  }

  private markConnected(): void {
    if (this.isConnected || this.stopped || this.failure || this.finishing) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.isConnected = true;
    this.options.callbacks.onConnection(true);
    this.options.callbacks.log('stt_connected', { provider: 'gateway', model: this.model, timing: 'approximate_word_timestamps' });
    this.resolveConnection?.();
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
  }

  private async consume(): Promise<void> {
    try {
      while (!this.stopped && !this.failure) {
        const { value: part, done } = await this.reader!.read();
        if (this.stopped || this.failure) return;
        if (done) {
          if (!this.finishing) throw new GatewaySttError('Gateway STT stream ended before audio input finished.');
          this.resolveDone();
          return;
        }
        if (part.type === 'raw') continue;
        if (part.type === 'error') throw this.safeError(part.error);
        let event: WordEvent | undefined;
        try { event = this.normalizer.apply(part, this.audioBytes / PCM_BYTES_PER_MS); }
        catch { this.malformedEvents++; throw new GatewaySttError('Gateway STT returned malformed or overlapping transcript events; restart the stream.'); }
        if (!event) continue;
        if (event.words.length) this.nonemptyTranscriptEvents++;
        this.options.callbacks.onTranscript(event);
        if (event.isFinal && event.words.length) this.options.callbacks.onBoundary('endpoint', event.endMs);
      }
    } catch (error) {
      if (this.stopped || this.failure) return;
      // The SDK rejects finish.text="" even for a valid all-silence input.
      if (this.finishing && this.nonemptyTranscriptEvents === 0 && NoTranscriptGeneratedError.isInstance(error)) {
        this.resolveDone();
      } else this.fail(this.safeError(error));
    }
  }

  sendAudio(frame: Buffer): boolean {
    if (!this.connected || this.finishing || this.stopped || this.failure) return this.dropFrame();
    if (!frame.length) return true;
    if (this.queuedBytes + frame.length > MAX_QUEUED_AUDIO_BYTES) {
      this.fail(new Error('Gateway STT audio backpressure exceeded one second; restart the stream.'));
      return this.dropFrame();
    }
    this.audioBytes += frame.length;
    const copy = Buffer.from(frame);
    const pending = this.pendingAudio;
    if (pending) {
      this.pendingAudio = undefined;
      pending.controller.enqueue(copy);
      pending.resolve();
    } else {
      this.audioQueue.push(copy);
      this.queuedBytes += copy.length;
    }
    return true;
  }

  private dropFrame(): false {
    this.droppedFrames++;
    if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) {
      this.options.callbacks.log('stt_audio_dropped', { droppedAudioFrames: this.droppedFrames });
    }
    return false;
  }

  private clearAudio(): void {
    this.audioQueue.length = 0;
    this.queuedBytes = 0;
    this.pendingAudio?.resolve();
    this.pendingAudio = undefined;
  }

  private safeError(error: unknown): Error {
    if (error instanceof GatewaySttError) return error;
    // SDK/WebSocket errors can include request headers, auth protocols, or
    // response bodies. Only expose stable classifications, never vendor text.
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const status = record.statusCode;
    const type = record.type;
    let message = 'Provider stream failed; verify AI_GATEWAY_API_KEY and model access, then restart the stream.';
    if (status === 401 || type === 'authentication_error') message = 'Authentication failed; check AI_GATEWAY_API_KEY.';
    else if (status === 403 || type === 'forbidden') message = 'Access denied; check Gateway key permissions and model access.';
    else if (status === 404 || type === 'model_not_found') message = 'The selected transcription model is unavailable for this Gateway account.';
    else if (status === 429 || type === 'rate_limit_exceeded') message = 'Rate limit exceeded; wait before restarting the stream.';
    else if (status === 400 || type === 'invalid_request_error') message = 'Gateway rejected the transcription request.';
    return new GatewaySttError(`Gateway STT (${this.model}): ${message}`);
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) return;
    this.failure = error;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.rejectConnection?.(error);
    this.rejectConnection = undefined;
    this.resolveConnection = undefined;
    this.disconnect('provider_error');
    this.abort.abort(error);
    this.clearAudio();
    void this.reader?.cancel(error).catch(() => {});
    this.rejectDone(error);
  }

  private disconnect(reason: string): void {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.options.callbacks.onConnection(false);
    this.options.callbacks.log('stt_disconnected', { provider: 'gateway', model: this.model, reason });
  }

  /** Closing audio asks Gateway to flush its tail; keep the filter live for debounce. */
  finalize(): Promise<void> {
    this.finalizePromise ??= this.finish();
    return this.finalizePromise;
  }

  private async finish(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.stopped || !this.connectionPromise) return;
    if (!this.connected) { await this.close(); return; }
    this.finishing = true;
    const pending = this.pendingAudio;
    if (pending) {
      this.pendingAudio = undefined;
      pending.controller.close();
      pending.resolve();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pump,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Gateway STT finalization timed out; trailing speech was not confirmed.');
            this.fail(error);
            reject(error);
          }, this.options.finalizeTimeoutMs ?? 10_000);
        }),
      ]);
      if (this.failure) throw this.failure;
    } finally { if (timer) clearTimeout(timer); }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.finishing = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.rejectConnection?.(new Error('STT connection stopped.'));
    this.rejectConnection = undefined;
    this.resolveConnection = undefined;
    this.disconnect('stopped');
    this.abort.abort(new Error('STT connection stopped.'));
    this.clearAudio();
    void this.reader?.cancel().catch(() => {});
    this.resolveDone();
    this.options.callbacks.log('stt_stopped', this.stats);
  }
}
