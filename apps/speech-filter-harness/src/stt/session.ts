import type { GatewaySttModel } from './models.js';
import type { SttCallbacks } from './types.js';

export interface SttAdapter {
  readonly done: Promise<void>;
  readonly stats: { droppedAudioFrames: number; reconnects: number; malformedEvents: number };
  connect(): Promise<void>;
  sendAudio(frame: Buffer): boolean;
  finalize(): Promise<void>;
  close(): Promise<void>;
}

/** Swap only STT: capture, the filter, chat history, and the app stay alive. */
export class SttSession {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private adapter?: SttAdapter;
  private generation = 0;
  private closed = false;
  private transition = Promise.resolve();
  private closing?: Promise<void>;
  private retired = { droppedAudioFrames: 0, reconnects: 0, malformedEvents: 0 };
  private droppedDuringSwitch = 0;

  constructor(
    private readonly callbacks: SttCallbacks,
    private readonly create: (model: GatewaySttModel, callbacks: SttCallbacks) => SttAdapter,
  ) {
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    void this.done.catch(() => {});
  }

  get stats(): SttAdapter['stats'] {
    const current = this.adapter?.stats;
    return {
      droppedAudioFrames: this.retired.droppedAudioFrames + this.droppedDuringSwitch + (current?.droppedAudioFrames ?? 0),
      reconnects: this.retired.reconnects + (current?.reconnects ?? 0),
      malformedEvents: this.retired.malformedEvents + (current?.malformedEvents ?? 0),
    };
  }

  setModel(model: GatewaySttModel): Promise<void> {
    const change = this.transition.then(async () => {
      if (this.closed) throw new Error('STT session is stopped. Start a new stream to change models.');
      const generation = ++this.generation;
      this.callbacks.onConnection(false);
      const previous = this.adapter;
      this.adapter = undefined;
      if (previous) {
        await previous.close();
        this.retire(previous);
      }
      if (this.closed) return;
      const current = (): boolean => !this.closed && this.generation === generation;
      const adapter = this.create(model, {
        onTranscript: event => { if (current()) this.callbacks.onTranscript(event); },
        onBoundary: (reason, endMs) => { if (current()) this.callbacks.onBoundary(reason, endMs); },
        onConnection: connected => { if (current()) this.callbacks.onConnection(connected); },
        log: (event, fields) => { if (current()) this.callbacks.log(event, fields); },
      });
      this.adapter = adapter;
      void adapter.done.catch(error => { if (current()) this.rejectDone(error); });
      await adapter.connect();
    });
    this.transition = change.catch(error => {
      if (!this.closed) this.rejectDone(error);
    });
    return change;
  }

  sendAudio(frame: Buffer): boolean {
    if (!this.adapter || this.closed) { this.droppedDuringSwitch++; return false; }
    return this.adapter.sendAudio(frame);
  }

  async finalize(): Promise<void> {
    await this.transition;
    if (!this.closed) await this.adapter?.finalize();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      ++this.generation;
      this.callbacks.onConnection(false);
      // Interrupt a pending connect before awaiting the serialized transition.
      await this.adapter?.close();
      await this.transition;
      if (this.adapter) this.retire(this.adapter);
      this.adapter = undefined;
      this.resolveDone();
    })();
  }

  private retire(adapter: SttAdapter): void {
    for (const key of ['droppedAudioFrames', 'reconnects', 'malformedEvents'] as const) this.retired[key] += adapter.stats[key];
  }
}
