import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { SttCallbacks, Word, WordEvent } from './types.js';

export const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
export const DEEPGRAM_PARAMS = Object.freeze({
  model: 'nova-3',
  interim_results: 'true',
  smart_format: 'true',
  encoding: 'linear16',
  channels: '1',
  sample_rate: '16000',
  language: 'en-US',
  endpointing: '300',
  utterance_end_ms: '1000',
  vad_events: 'true',
});

export function deepgramUrl(): string {
  return `${DEEPGRAM_WS_URL}?${new URLSearchParams(DEEPGRAM_PARAMS)}`;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(4000, 250 * 2 ** Math.min(Math.max(0, attempt), 4));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function milliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid STT timestamp');
  return Math.round(value * 1000);
}

/** Validate untrusted vendor data before it reaches alignment or intent filtering. */
export function normalizeDeepgramResult(value: unknown): WordEvent {
  const result = object(value);
  if (result.type !== 'Results' || typeof result.is_final !== 'boolean') throw new Error('Invalid Results event');
  if (result.speech_final !== undefined && typeof result.speech_final !== 'boolean') throw new Error('Invalid speech_final');
  const startMs = milliseconds(result.start);
  const endMs = startMs + milliseconds(result.duration);
  const alternatives = object(result.channel).alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) throw new Error('Missing STT alternatives');
  const alternative = object(alternatives[0]);
  if (typeof alternative.transcript !== 'string' || !Array.isArray(alternative.words)) throw new Error('Missing word hypothesis');
  const isFinal = result.is_final;
  const words: Word[] = alternative.words.map((entry: unknown) => {
    const word = object(entry);
    const text = word.punctuated_word ?? word.word;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid STT word');
    const wordStart = milliseconds(word.start);
    const wordEnd = milliseconds(word.end);
    if (wordEnd < wordStart || wordStart < startMs - 20 || wordEnd > endMs + 20) throw new Error('Invalid STT word range');
    return { text: text.trim(), startMs: wordStart, endMs: wordEnd, isFinal };
  });
  if (words.some((word, index) => index > 0 && word.startMs < words[index - 1]!.startMs)) throw new Error('Unordered STT words');
  if (alternative.transcript.trim() && words.length === 0) throw new Error('Transcript has no timed words');
  return { text: alternative.transcript, words, startMs, endMs, isFinal, speechFinal: result.speech_final === true };
}

export interface DeepgramOptions {
  apiKey: string;
  callbacks: SttCallbacks;
  /** Injectable transport for deterministic tests; production endpoint is fixed. */
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
}

/** No audio queue: frames captured during an outage are discarded, never replayed. */
export class DeepgramStt {
  /** Rejects terminal provider failures so callers can stop ongoing microphone capture. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private socket?: WebSocket;
  private running = false;
  private finishing = false;
  private isConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private lastAudioAt = 0;
  private lastWordEndMs = -1;
  private boundaryEndMs = -1;
  private connectionPromise?: Promise<void>;
  private resolveConnection?: () => void;
  private rejectConnection?: (error: Error) => void;
  private finalizeResolve?: () => void;
  private droppedFrames = 0;
  private reconnects = 0;
  private malformedEvents = 0;

  constructor(private readonly options: DeepgramOptions) {
    if (!options.apiKey.trim()) throw new Error('DEEPGRAM_API_KEY is required for microphone and WAV streaming.');
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    void this.done.catch(() => {});
  }

  get connected(): boolean { return this.isConnected; }
  get stats(): { droppedAudioFrames: number; reconnects: number; malformedEvents: number } {
    return { droppedAudioFrames: this.droppedFrames, reconnects: this.reconnects, malformedEvents: this.malformedEvents };
  }

  connect(): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    this.running = true;
    this.options.callbacks.onConnection(false);
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    this.openSocket();
    return this.connectionPromise;
  }

  private openSocket(): void {
    if (!this.running || this.finishing) return;
    this.options.callbacks.log('stt_connecting', { provider: 'deepgram', model: 'nova-3' });
    const createSocket = this.options.createSocket ?? ((url, options) => new WebSocket(url, options));
    let socket: WebSocket;
    try {
      socket = createSocket(deepgramUrl(), {
        headers: { Authorization: `Token ${this.options.apiKey}` },
        handshakeTimeout: 8000,
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
      });
    } catch {
      this.disconnected('socket_initialization_failed');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || !this.running) { socket.terminate(); return; }
      this.isConnected = true;
      this.lastWordEndMs = -1;
      this.boundaryEndMs = -1;
      this.lastAudioAt = Date.now();
      this.options.callbacks.onConnection(true);
      this.options.callbacks.log('stt_connected', { provider: 'deepgram', model: 'nova-3' });
      this.resolveConnection?.();
      this.resolveConnection = undefined;
      this.rejectConnection = undefined;
      // A connection that drops immediately must still increase its retry delay.
      this.stableTimer = setTimeout(() => { this.reconnectAttempt = 0; }, 10_000);
      this.keepAliveTimer = setInterval(() => {
        if (this.connected && Date.now() - this.lastAudioAt >= 3000) this.sendControl('KeepAlive');
      }, 3000);
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.socket !== socket || !this.connected) return;
      try {
        if (isBinary) throw new Error('Unexpected binary STT event');
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        this.handleMessage(JSON.parse(raw.toString('utf8')) as unknown);
      } catch {
        this.malformedEvents++;
        this.options.callbacks.log('stt_malformed_event', { count: this.malformedEvents, action: 'disconnect_and_reset' });
        this.disconnected('malformed_event');
        socket.terminate();
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      if (this.socket !== socket) return;
      const status = response.statusCode;
      response.resume();
      this.options.callbacks.log('stt_http_error', { status });
      if (status === 401 || status === 403) {
        this.running = false;
        const error = new Error(`Deepgram authentication failed (HTTP ${status}); check DEEPGRAM_API_KEY.`);
        this.rejectConnection?.(error);
        this.rejectDone(error);
        this.rejectConnection = undefined;
      }
      this.disconnected(`http_${status ?? 'unknown'}`);
      socket.terminate();
    });
    socket.on('error', (error: Error & { code?: string }) => {
      if (this.socket !== socket) return;
      this.options.callbacks.log('stt_socket_error', { code: error.code ?? 'WEBSOCKET_ERROR' });
      this.disconnected('socket_error');
      socket.terminate();
    });
    socket.on('close', (code: number) => {
      if (this.socket !== socket) return;
      this.disconnected(`close_${code}`);
      this.socket = undefined;
      this.finalizeResolve?.();
      this.finalizeResolve = undefined;
      this.scheduleReconnect();
    });
  }

  private handleMessage(value: unknown): void {
    const message = object(value);
    switch (message.type) {
      case 'Results': {
        const event = normalizeDeepgramResult(message);
        const last = event.words.at(-1);
        if (last) this.lastWordEndMs = Math.max(this.lastWordEndMs, last.endMs);
        this.options.callbacks.onTranscript(event);
        if (event.speechFinal) this.boundary('endpoint', last?.endMs ?? this.lastWordEndMs);
        if (message.from_finalize === true) {
          this.finalizeResolve?.();
          this.finalizeResolve = undefined;
        }
        break;
      }
      case 'UtteranceEnd': this.boundary('utterance_end', milliseconds(message.last_word_end)); break;
      case 'SpeechStarted': this.options.callbacks.log('stt_speech_started'); break;
      case 'Metadata': break;
      case 'Error': throw new Error('STT vendor error');
      default: throw new Error('Unrecognized STT event');
    }
  }

  private boundary(reason: string, endMs: number): void {
    // UtteranceEnd often follows speech_final; a delayed old boundary must not
    // close a newer region that has already started receiving words.
    if (endMs < 0 || endMs <= this.boundaryEndMs || endMs < this.lastWordEndMs) return;
    this.boundaryEndMs = endMs;
    this.options.callbacks.onBoundary(reason, endMs);
  }

  private disconnected(reason: string): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.keepAliveTimer = undefined;
    this.stableTimer = undefined;
    if (this.isConnected) {
      this.isConnected = false;
      this.options.callbacks.onConnection(false);
      this.options.callbacks.log('stt_disconnected', { reason, droppedAudioFrames: this.droppedFrames });
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.finishing || this.reconnectTimer) return;
    const waitMs = reconnectDelayMs(this.reconnectAttempt++);
    this.reconnects++;
    this.options.callbacks.log('stt_reconnect_scheduled', { delayMs: waitMs, reconnects: this.reconnects });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, waitMs);
  }

  sendAudio(frame: Buffer): boolean {
    const socket = this.socket;
    if (!this.connected || this.finishing || !socket || socket.readyState !== WebSocket.OPEN) return this.dropFrame();
    // One second of network backlog is already stale. Reset instead of submitting
    // an old, spliced utterance after a slow link recovers.
    if (socket.bufferedAmount > 32_000) {
      this.disconnected('audio_backpressure');
      socket.terminate();
      return this.dropFrame();
    }
    this.lastAudioAt = Date.now();
    socket.send(frame, { binary: true }, error => {
      if (error && this.socket === socket) {
        this.disconnected('audio_send_failed');
        socket.terminate();
      }
    });
    return true;
  }

  private dropFrame(): false {
    this.droppedFrames++;
    if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) {
      this.options.callbacks.log('stt_audio_dropped', { droppedAudioFrames: this.droppedFrames });
    }
    return false;
  }

  private sendControl(type: 'KeepAlive' | 'Finalize' | 'CloseStream'): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type }), { binary: false }, error => {
      if (error && this.socket === socket) {
        this.disconnected('control_send_failed');
        socket.terminate();
      }
    });
  }

  /** Flush the tail while keeping the connection open for the filter debounce. */
  async finalize(): Promise<void> {
    this.finishing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (!this.connected) return;
    await new Promise<void>(resolve => {
      // Deepgram does not guarantee from_finalize when its audio buffer is empty.
      const timer = setTimeout(() => {
        this.options.callbacks.log('stt_finalize_wait_elapsed');
        this.finalizeResolve = undefined;
        resolve();
      }, 2500);
      this.finalizeResolve = () => { clearTimeout(timer); resolve(); };
      this.sendControl('Finalize');
    });
  }

  async close(): Promise<void> {
    this.running = false;
    this.finishing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectConnection?.(new Error('STT connection stopped.'));
    this.rejectConnection = undefined;
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 3000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocket.OPEN) this.sendControl('CloseStream');
        else socket.terminate();
      });
    }
    this.disconnected('stopped');
    this.resolveDone();
    this.options.callbacks.log('stt_stopped', this.stats);
  }
}
