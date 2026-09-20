import { WebSocket } from 'ws';
import type { Log } from '../stt/types.js';

/** One browser-owned capture. Binary messages are 20ms mono PCM16 little-endian. */
export class BrowserAudioSource {
  readonly done: Promise<void>;
  /** Resolves only when the browser disappears, not during harness cleanup. */
  readonly disconnected: Promise<void>;
  private resolveDisconnected!: () => void;
  private resolveDone!: () => void;
  private onFrame?: (frame: Buffer) => void;
  private stopped = false;
  private watchdog?: ReturnType<typeof setTimeout>;

  constructor(private readonly socket: WebSocket, readonly sampleRate: number, private readonly log: Log) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.disconnected = new Promise(resolve => { this.resolveDisconnected = resolve; });
    socket.on('message', (data, binary) => {
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!binary || frame.length !== sampleRate / 50 * 2) {
        socket.close(1008, 'Expected 20ms mono PCM16 frames');
        this.disconnect();
        return;
      }
      if (this.stopped) return;
      this.armWatchdog();
      this.onFrame?.(frame);
    });
    socket.once('close', () => this.disconnect());
    socket.once('error', () => this.disconnect());
  }

  async start(onFrame: (frame: Buffer) => void): Promise<void> {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) { await this.stop(); return; }
    this.onFrame = onFrame;
    this.socket.send(JSON.stringify({ type: 'ready', sampleRate: this.sampleRate, channels: 1, format: 'pcm16le', frameMs: 20 }));
    this.armWatchdog();
    this.log('audio_started', { source: 'browser', sampleRate: this.sampleRate, channels: 1, frameMs: 20 });
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    // A crashed/suspended tab must not leave an unattended cloud session alive.
    this.watchdog = setTimeout(() => { this.socket.terminate(); this.disconnect(); }, 10_000);
    this.watchdog.unref();
  }

  private disconnect(): void {
    if (this.stopped) return;
    this.resolveDisconnected();
    void this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.onFrame = undefined;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'Capture stopped');
    this.resolveDone();
    this.log('audio_stopped', { source: 'browser', sampleRate: this.sampleRate });
  }
}
