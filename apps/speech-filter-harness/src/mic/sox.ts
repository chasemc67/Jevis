import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Log } from '../stt/types.js';

export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
export const PCM_FRAME_BYTES = 640; // 20 ms, signed 16-bit little-endian mono.

export interface SoxAudioOptions {
  kind: 'mic' | 'wav';
  wavPath?: string;
  soxPath?: string;
  device?: string;
  debugAudio?: boolean;
  onFrame(frame: Buffer): void;
  log: Log;
}

export function buildSoxArgs(options: Pick<SoxAudioOptions, 'kind' | 'wavPath' | 'device'>): string[] {
  const input = options.kind === 'wav'
    ? [resolve(options.wavPath ?? '')]
    : options.device ? ['-t', 'coreaudio', options.device] : ['-d'];
  return ['-q', '--buffer', String(PCM_FRAME_BYTES), ...input,
    '-t', 'raw', '-r', String(PCM_SAMPLE_RATE), '-e', 'signed-integer',
    '-b', '16', '-c', '1', '-L', '-'];
}

export function pcmRms(frame: Buffer): number {
  let sum = 0;
  const count = Math.floor(frame.length / 2);
  for (let i = 0; i < count; i++) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

export function soxFailure(kind: 'mic' | 'wav', detail: string): Error {
  if (kind === 'wav') return new Error(`SoX could not decode the WAV input: ${detail}`);
  return new Error(`SoX microphone capture failed: ${detail}. On macOS, select an input in ` +
    'System Settings > Sound > Input (a Mac mini may need a USB, display, or Bluetooth microphone). ' +
    'Enable microphone access for the launching app (Terminal/iTerm/Codex) in ' +
    'System Settings > Privacy & Security > Microphone, then restart the command.');
}

/** Continuous CoreAudio capture or bounded, realtime-paced WAV conversion using Homebrew SoX. */
export class SoxAudioSource {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private process?: ChildProcess;
  private stopped = false;
  private started = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: SoxAudioOptions) {
    this.done = new Promise((resolveDone, rejectDone) => {
      this.resolveDone = resolveDone;
      this.rejectDone = rejectDone;
    });
    // Capture can fail before a caller reaches `await source.done`.
    void this.done.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Audio source can only be started once.');
    this.started = true;
    if (this.options.kind === 'wav') {
      if (!this.options.wavPath) throw new Error('WAV mode requires a file path.');
      await access(this.options.wavPath, constants.R_OK);
    }
    const child = spawn(this.options.soxPath ?? 'sox', buildSoxArgs(this.options), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    const closed = new Promise<void>((resolveClosed, rejectClosed) => {
      child.once('error', (error: NodeJS.ErrnoException) => rejectClosed(error.code === 'ENOENT'
        ? new Error('SoX was not found. Install it with `brew install sox`, or set SOX_PATH to its executable. No Xcode GUI setup is required.')
        : soxFailure(this.options.kind, error.message)));
      child.once('close', (code, signal) => {
        if (this.stopped || code === 0) resolveClosed();
        else rejectClosed(soxFailure(this.options.kind, stderr.trim() || `exit ${code}, signal ${signal}`));
      });
    });
    void closed.catch(() => {});
    const spawned = new Promise<void>((resolveSpawned, rejectSpawned) => {
      child.once('spawn', resolveSpawned);
      child.once('error', () => { void closed.catch(rejectSpawned); });
    });
    void this.consume(child, closed).then(this.resolveDone, this.rejectDone);
    await spawned;
    this.options.log('audio_started', { source: this.options.kind, sampleRate: PCM_SAMPLE_RATE, channels: 1 });
  }

  private async consume(child: ReturnType<typeof spawn>, closed: Promise<void>): Promise<void> {
    let pending = Buffer.alloc(0);
    let sentBytes = 0;
    let firstFrameAt: number | undefined;
    let lastDebugAt = 0;
    let inputTimeout: ReturnType<typeof setTimeout> | undefined;
    let noAudio = false;
    if (this.options.kind === 'mic') {
      inputTimeout = setTimeout(() => {
        noAudio = true;
        child.kill('SIGTERM');
      }, 8000);
    }
    const send = async (frame: Buffer): Promise<void> => {
      if (this.stopped) return;
      if (firstFrameAt === undefined) firstFrameAt = performance.now();
      if (this.options.kind === 'wav') {
        const waitMs = firstFrameAt + sentBytes / PCM_BYTES_PER_SECOND * 1000 - performance.now();
        if (waitMs > 0) await delay(waitMs, undefined, { signal: this.abort.signal });
      }
      if (this.stopped) return;
      this.options.onFrame(frame);
      sentBytes += frame.length;
      if (this.options.debugAudio && performance.now() - lastDebugAt >= 1000) {
        const rms = pcmRms(frame);
        this.options.log('audio_level', { rms: Number(rms.toFixed(4)), dbfs: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(1)) : '-Infinity', localDebugOnly: true });
        lastDebugAt = performance.now();
      }
    };
    try {
      if (!child.stdout) throw new Error('SoX stdout pipe was not created.');
      for await (const chunk of child.stdout) {
        if (inputTimeout) clearTimeout(inputTimeout);
        if (this.stopped) break;
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        while (pending.length >= PCM_FRAME_BYTES && !this.stopped) {
          await send(pending.subarray(0, PCM_FRAME_BYTES));
          pending = pending.subarray(PCM_FRAME_BYTES);
        }
      }
      if (pending.length % 2 !== 0 && !this.stopped) throw new Error('SoX produced an incomplete PCM sample.');
      if (pending.length > 0 && !this.stopped) await send(pending);
      await closed;
      if (this.options.kind === 'mic' && !this.stopped) throw soxFailure('mic', 'audio capture ended unexpectedly');
    } catch (error) {
      if (!this.stopped) {
        child.kill('SIGTERM');
        if (noAudio) throw soxFailure('mic', 'no PCM audio arrived within 8 seconds');
        throw error;
      }
    } finally {
      if (inputTimeout) clearTimeout(inputTimeout);
      this.options.log('audio_stopped', { source: this.options.kind, audioMs: sentBytes / PCM_BYTES_PER_SECOND * 1000 });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    const child = this.process;
    if (!child) { this.resolveDone(); return; }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    timer.unref();
    try { await this.done; } catch { /* Original caller receives the capture error. */ }
    finally { clearTimeout(timer); }
  }
}
