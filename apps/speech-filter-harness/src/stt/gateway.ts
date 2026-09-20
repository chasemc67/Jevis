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
class GatewaySttError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

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
  /** Keep a microphone session alive across provider stream endings/outages. */
  continuous?: boolean;
  reconnectDelayMs?: number;
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
  private abort = new AbortController();
  private reader?: ReadableStreamDefaultReader<TranscriptionStreamPart>;
  private normalizer = new GatewayTranscriptNormalizer();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private reconnects = 0;
  private streamOffsetMs = 0;
  private lastEventEndMs = 0;
  private unfinishedTranscript = false;
  private readonly audioQueue: Buffer[] = [];
  private queuedBytes = 0;
  private audioBytes = 0;
  private pendingAudio?: { controller: ReadableStreamDefaultController<Uint8Array | string>; resolve(): void };
  private isConnected = false;
  private filterConnected = false;
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
    return { droppedAudioFrames: this.droppedFrames, reconnects: this.reconnects, malformedEvents: this.malformedEvents };
  }

  connect(): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    if (this.stopped || this.finishing) return Promise.reject(new Error('STT connection stopped.'));
    this.options.callbacks.onConnection(false);
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    void this.connectionPromise.catch(() => {});
    this.openStream();
    return this.connectionPromise;
  }

  private openStream(): void {
    if (this.stopped || this.finishing || this.failure) return;
    const abort = this.abort = new AbortController();
    this.streamOffsetMs = Math.max(this.lastEventEndMs, this.streamOffsetMs + this.audioBytes / PCM_BYTES_PER_MS);
    this.audioBytes = 0;
    this.normalizer = new GatewayTranscriptNormalizer();
    this.unfinishedTranscript = false;
    this.nonemptyTranscriptEvents = 0;
    this.options.callbacks.log('stt_connecting', { provider: 'gateway', model: this.model });
    this.connectTimer = setTimeout(() => this.fail(new Error('Gateway STT connection timed out.')), this.options.connectTimeoutMs ?? 10_000);
    const audio = new ReadableStream<Uint8Array | string>({
      pull: controller => {
        if (abort.signal.aborted) { controller.close(); return; }
        // HWM=0 prevents eager pull. Gateway reads audio only after its socket
        // opens, so this is the SDK-supported point to start microphone capture.
        this.markConnected();
        const frame = this.audioQueue.shift();
        if (frame) { this.queuedBytes -= frame.length; controller.enqueue(frame); return; }
        if (this.finishing || this.stopped || this.failure) { controller.close(); return; }
        return new Promise<void>(resolve => { this.pendingAudio = { controller, resolve }; });
      },
      cancel: () => { if (this.abort === abort) this.clearAudio(); },
    }, { highWaterMark: 0 });
    try {
      const result = (this.options.transcribe ?? streamTranscribe)({
        model: createGateway({ apiKey: this.options.apiKey }).transcriptionModel(this.model),
        audio, inputAudioFormat: { type: 'audio/pcm', rate: GATEWAY_STT_SAMPLE_RATE },
        abortSignal: abort.signal,
      });
      this.reader = result.fullStream.getReader();
      this.pump = this.consume(this.reader, abort.signal);
    } catch (error) { this.fail(this.safeError(error)); }
  }

  private markConnected(): void {
    if (this.isConnected || this.stopped || this.failure || this.finishing) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.isConnected = true;
    this.filterConnected = true;
    this.options.callbacks.onConnection(true);
    this.options.callbacks.log('stt_connected', { provider: 'gateway', model: this.model, timing: 'approximate_word_timestamps' });
    this.resolveConnection?.();
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
  }

  private async consume(reader: ReadableStreamDefaultReader<TranscriptionStreamPart>, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const { value: part, done } = await reader.read();
        if (signal.aborted) return;
        if (done) {
          if (!this.finishing) {
            this.fail(new GatewaySttError('Gateway STT stream ended before audio input finished.'), !this.unfinishedTranscript);
            return;
          }
          this.resolveDone();
          return;
        }
        if (part.type === 'raw') continue;
        if (part.type === 'error') throw this.safeError(part.error);
        let event: WordEvent | undefined;
        try { event = this.normalizer.apply(part, this.audioBytes / PCM_BYTES_PER_MS); }
        catch { this.malformedEvents++; throw new GatewaySttError('Gateway STT returned malformed or overlapping transcript events; restart the stream.', false); }
        if (!event) continue;
        if (event.words.length) { this.nonemptyTranscriptEvents++; this.reconnectAttempt = 0; }
        this.unfinishedTranscript = !event.isFinal && event.words.length > 0;
        // Provider timestamps/IDs restart at zero on every stream. Keep the
        // filter's clock monotonic when a normal EOF preserves a sealed final.
        event = {
          ...event, startMs: event.startMs + this.streamOffsetMs, endMs: event.endMs + this.streamOffsetMs,
          words: event.words.map(word => ({ ...word, startMs: word.startMs + this.streamOffsetMs, endMs: word.endMs + this.streamOffsetMs })),
        };
        this.lastEventEndMs = Math.max(this.lastEventEndMs, event.endMs);
        this.options.callbacks.onTranscript(event);
        if (event.isFinal && event.words.length) this.options.callbacks.onBoundary('endpoint', event.endMs);
      }
    } catch (error) {
      if (signal.aborted) return;
      // The SDK rejects finish.text="" even for a valid all-silence input.
      if (this.finishing && this.nonemptyTranscriptEvents === 0 && NoTranscriptGeneratedError.isInstance(error)) {
        this.resolveDone();
      } else this.fail(this.safeError(error), NoTranscriptGeneratedError.isInstance(error) && !this.unfinishedTranscript);
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
    this.droppedFrames += this.audioQueue.length;
    this.audioQueue.length = 0;
    this.queuedBytes = 0;
    if (this.pendingAudio) {
      // Release a pending SDK read even if it does not react to abort itself.
      try { this.pendingAudio.controller.close(); } catch { /* Already canceled. */ }
      this.pendingAudio.resolve();
    }
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
    const fatal = status === 400 || status === 401 || status === 403 || status === 404 ||
      ['authentication_error', 'forbidden', 'model_not_found', 'invalid_request_error'].includes(String(type));
    return new GatewaySttError(`Gateway STT (${this.model}): ${message}`, !fatal);
  }

  private fail(error: Error, cleanEnd = false): void {
    if (this.failure || this.stopped) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    const retry = this.options.continuous && !this.finishing &&
      (!(error instanceof GatewaySttError) || error.retryable);
    // A completed final is still awaiting Jev/debounce. Normal provider EOF
    // must not revoke it; errors/unfinished hypotheses still fail closed.
    this.disconnect(cleanEnd ? 'stream_ended' : 'provider_error', !(retry && cleanEnd));
    this.abort.abort(error);
    this.clearAudio();
    void this.reader?.cancel(error).catch(() => {});
    if (retry) {
      if (this.reconnectTimer) return;
      const delayMs = Math.min(4000, (this.options.reconnectDelayMs ?? 250) * 2 ** Math.min(this.reconnectAttempt++, 4));
      this.reconnects++;
      this.options.callbacks.log('stt_reconnect', {
        provider: 'gateway', model: this.model, reconnects: this.reconnects,
        delayMs, reason: cleanEnd ? 'stream_ended' : 'provider_error',
      });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.openStream();
      }, delayMs);
      return;
    }
    this.failure = error;
    this.rejectConnection?.(error);
    this.rejectConnection = undefined;
    this.resolveConnection = undefined;
    this.rejectDone(error);
  }

  private disconnect(reason: string, notify = true): void {
    if (!this.isConnected && !this.filterConnected) return;
    this.isConnected = false;
    if (notify && this.filterConnected) {
      this.filterConnected = false;
      this.options.callbacks.onConnection(false);
    }
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
