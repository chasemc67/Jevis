import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { readConfig } from './config.js';
import { ConsoleDownstream, MemoryQueueDownstream } from './downstream/console.js';
import { createTextFeed } from './feed/textFeed.js';
import { SpeechFilter } from './filter/controller.js';
import { FixtureJevEvaluator, loadFixture, replayFixture } from './fixtures/replay.js';
import { GatewayJevClient } from './jev/client.js';
import { SoxAudioSource } from './mic/sox.js';
import { DeepgramStt } from './stt/deepgram.js';
import type { SttCallbacks } from './stt/types.js';

const help = `Jevis Phase 0 — always-on speech to a filtered text feed

Usage: npm run dev -- [options]
  --mode mic|wav|fixture   Source (default: mic)
  --file PATH             WAV or word-event JSON file
  --dry-run               Fixture only: scripted classifier, no keys/network
  --stt-only              Print STT without Jev or downstream submission
  --speed NUMBER          Fixture event playback speed (default: 1)
  --downstream console|queue  Visible console sink or bounded memory queue
  --help                  Show this help

Examples:
  npm run demo
  npm run fixture
  npm run wav -- --file recordings/example.wav
  npm run stt
  npm run mic

Live audio requires Homebrew SoX and DEEPGRAM_API_KEY. Jev requires
AI_GATEWAY_API_KEY. Copy .env.example to .env and fill in keys locally.
Always-on audio includes ambient speech; Ctrl-C stops capture and discards
pending segments. No agent or tools run in Phase 0.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'mic' }, file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'stt-only': { type: 'boolean', default: false },
      speed: { type: 'string', default: '1' },
      downstream: { type: 'string', default: 'console' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false, strict: true,
  });
  if (values.help) { console.log(help); return; }
  loadEnv({ quiet: true });
  const config = readConfig();
  const mode = values.mode;
  const dryRun = values['dry-run'];
  const sttOnly = values['stt-only'];
  const speed = Number(values.speed);
  if (mode !== 'mic' && mode !== 'wav' && mode !== 'fixture') throw new Error('--mode must be mic, wav, or fixture');
  if (!['console', 'queue'].includes(values.downstream)) throw new Error('--downstream must be console or queue');
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('--speed must be a positive number');
  if (mode !== 'fixture' && (dryRun || speed !== 1)) throw new Error('--dry-run and --speed are only available in fixture mode');
  if (dryRun && sttOnly) throw new Error('Choose --dry-run or --stt-only, not both');
  if (mode === 'mic' && values.file) throw new Error('--file is only available in WAV or fixture mode');
  if (mode === 'wav' && !values.file) throw new Error('WAV mode requires --file path/to/audio.wav');
  if (mode !== 'fixture' && !config.deepgramApiKey) throw new Error('Set DEEPGRAM_API_KEY in .env for live microphone or WAV streaming. Try npm run demo without keys.');
  if (!sttOnly && !dryRun && !config.gatewayApiKey) throw new Error('Set AI_GATEWAY_API_KEY in .env for Jev via Vercel AI Gateway. Try npm run demo without keys.');

  const log = createTextFeed();
  const fixture = mode === 'fixture'
    ? await loadFixture(resolve(values.file ?? 'apps/speech-filter-harness/fixtures/ambient/mixed.json')) : undefined;
  const downstream = values.downstream === 'queue' ? new MemoryQueueDownstream(log) : new ConsoleDownstream(log);
  const filter = sttOnly ? undefined : new SpeechFilter(config,
    dryRun && fixture ? new FixtureJevEvaluator(fixture) : new GatewayJevClient({
      apiKey: config.gatewayApiKey!, timeoutMs: config.jevTimeoutMs,
      zeroDataRetention: config.zeroDataRetention, log,
    }), downstream, log);
  const callbacks: SttCallbacks = {
    onTranscript: event => filter ? filter.onTranscript(event) : log(event.isFinal ? 'stt_final' : 'stt_partial', { ...event }),
    onBoundary: (reason, endMs) => filter ? filter.onBoundary(reason, endMs) : log('region_reset', { reason, lastWordEndMs: endMs }),
    onConnection: connected => filter ? filter.onConnection(connected) : log(connected ? 'stt_connected' : 'stt_disconnected'),
    log,
  };
  const abort = new AbortController();
  let source: SoxAudioSource | undefined;
  let stt: DeepgramStt | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    // Immediately revoke queued segments; stop audio before closing STT.
    filter?.onConnection(false);
    await source?.stop();
    await stt?.close();
    await filter?.stop();
    if (stt) log('stt_counters', { ...stt.stats });
    if (downstream instanceof MemoryQueueDownstream) log('queue_summary', {
      size: downstream.segments.length, segments: downstream.segments.map(segment => segment.text),
    });
  })();
  const onSignal = (): void => { abort.abort(); void cleanup(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  log('harness_started', {
    mode, classifier: sttOnly ? 'disabled' : dryRun ? 'SCRIPTED_FIXTURE_MOCK' : 'typesafe-ai/jev via Vercel AI Gateway',
    downstream: values.downstream, debounceMs: config.debounceMs,
    everyNWords: config.everyNWords, windowMaxWords: config.windowMaxWords,
  });
  if (dryRun) log('dry_run_notice', { message: 'Scripted fixture labels test plumbing only; no Jev request or model accuracy validation.' });
  if (mode !== 'fixture') log('privacy_notice', {
    message: 'Audio, including ambient speech, streams to Deepgram. Only transcript text goes to Jev via Gateway. Ctrl-C stops capture.',
  });
  try {
    if (fixture) await replayFixture(fixture, callbacks, { signal: abort.signal, speed });
    else {
      stt = new DeepgramStt({ apiKey: config.deepgramApiKey!, callbacks });
      await stt.connect();
      if (abort.signal.aborted) return;
      source = new SoxAudioSource({
        kind: mode as 'mic' | 'wav', wavPath: values.file,
        soxPath: config.soxPath, device: config.micDevice, debugAudio: config.debugAudio,
        onFrame: frame => { stt!.sendAudio(frame); }, log,
      });
      await source.start();
      await Promise.race([source.done, stt.done]);
      if (!abort.signal.aborted && mode === 'wav') await stt.finalize();
    }
    if (!abort.signal.aborted) await filter?.finish();
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().catch((error: unknown) => {
  console.error(`Jevis: ${error instanceof Error ? error.message : 'Harness failed'}`);
  process.exitCode = 1;
});
