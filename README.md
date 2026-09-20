# Jevis — Phase 0

A local TypeScript harness for **microphone → Deepgram Nova-3 streaming STT → Jev directed-speech filter → visible text queue**. Jev runs exclusively through Vercel AI Gateway as `typesafe-ai/jev`. The only downstream implementations print or hold filtered text; no agent, tools, TTS, or wake-word system is wired in.

The implementation follows [ARCHITECTURE.md](ARCHITECTURE.md). JSON word-event fixtures make the filter runnable without a microphone. A clearly marked scripted dry-run also works without API keys or network access.

## Setup on Apple Silicon macOS

Use Node **22+** (the pinned AI SDK 7 and Gateway SDK require it), npm, and Homebrew SoX for audio modes. Node 24 is also supported. From the repo root:

```sh
brew install node@22 sox
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install
cp .env.example .env
npm run check
npm run demo
```

Skip the Node installation/PATH change if you already have a supported Node version. JSON fixtures need only Node/npm; SoX is needed for microphone capture and WAV conversion. No Node native audio module is compiled. Homebrew's Apple Silicon SoX bottle provides CoreAudio capture without opening or configuring the Xcode GUI. An initial Homebrew installation may require Apple's command-line tools.

Fill in `.env` locally:

- `DEEPGRAM_API_KEY`: a Deepgram key for live microphone or WAV STT.
- `AI_GATEWAY_API_KEY`: a Vercel AI Gateway key with access/credits for Jev. JSON fixtures with real Jev need only this key.

There is no TypeSafe credential or direct TypeSafe API path. `.env`, other local environment files, the `recordings/` directory, build output, and `*.log` files are ignored by git; `.env.example` contains no credentials. Keep personal audio under `recordings/`. Do not add secrets to fixture JSON or commit recordings of private conversations.

### One-time microphone setup

1. Connect an input device if needed. This Mac mini reported **Mac mini Speakers only** during implementation; no microphone input was available. A USB microphone/headset, a display with a microphone, or another supported input is needed.
2. Open **System Settings → Sound → Input**, select the microphone, and check that the input level moves when you speak. `MIC_DEVICE=default` uses the system input. A CoreAudio device name can be set explicitly through `MIC_DEVICE`.
3. Run `npm run stt` from the app you intend to use. Allow its microphone permission prompt. If access was denied, open **System Settings → Privacy & Security → Microphone**, enable the launching app (**Terminal**, **iTerm**, or **Codex**, as applicable), and restart the command. If the app is absent from the list, run the capture command from that app to request access.
4. Once partial/final text appears, run `npm run mic` with both API keys to include Jev.

Use `Ctrl+C` to stop capture and close the STT socket. There is no mute hotkey in Phase 0. With a connected input, local capture can also be checked without keys by running `sox -d -n stat` and stopping it with `Ctrl+C`; this discards samples locally.

If `sox` is not found, set `SOX_PATH=/opt/homebrew/bin/sox`. A capture error or no audio within eight seconds reports the input-device and macOS permission steps. `system_profiler SPAudioDataType` lists available audio hardware.

## Run the harness

Run commands from the repository root. The CLI loads `.env`; exported environment values take precedence.

| Command | Input and behavior | Credentials |
| --- | --- | --- |
| `npm run demo` | Timed canned words and explicitly scripted classification; fully offline | None |
| `npm run fixture` | Same canned words, evaluated by real Jev through Gateway | Gateway |
| `npm run mic` | Always-on microphone → Deepgram → Jev → console | Deepgram + Gateway |
| `npm run stt` | Microphone → Deepgram, printing partial/final text only | Deepgram |
| `npm run wav -- --file /path/to/recording.wav` | WAV decoded/resampled and streamed in real time through Deepgram → Jev | Deepgram + Gateway |
| `npm run check` | Typecheck, regression tests, and production build | None |

Examples:

```sh
# Filter into the bounded in-memory queue, still visible in the console.
npm run mic -- --downstream queue

# Exercise ambient-only and ambiguous speech with scripted labels, offline.
npm run fixture -- --file apps/speech-filter-harness/fixtures/ambient/ambient-only.json --dry-run
npm run fixture -- --file apps/speech-filter-harness/fixtures/ambient/unclear.json --dry-run

# Run real Jev on a JSON stream; no microphone or Deepgram key is needed.
npm run fixture -- --file apps/speech-filter-harness/fixtures/ambient/mixed.json

# Test WAV transcription first, without Jev.
npm run wav -- --file /path/to/recording.wav --stt-only

# Production build and CLI options.
npm run build
npm start -- --mode fixture --dry-run
npm run dev -- --help
```

`--mode` accepts `mic`, `wav`, or `fixture`. `--file` supplies a WAV or JSON fixture. The default fixture is `apps/speech-filter-harness/fixtures/ambient/mixed.json`. `--downstream` accepts `console` (default) or `queue`; the memory queue retains up to 1,000 segments and is lost on exit. `--dry-run` is available only for JSON fixtures. `--stt-only` bypasses Jev for input validation. `--speed` is a positive JSON replay speed multiplier; debounce, silence, and model deadlines stay in real wall-clock time, so use speed `1` when checking the bundled expected outputs.

WAV mode uses the same streaming STT path as the microphone. It does not use batch transcription, and it does not play the recording through speakers. WAV input can have another sample rate/channel count; SoX converts it to the required PCM format. A JSON fixture is offline with respect to STT; it still calls Gateway unless `--dry-run` or `--stt-only` is supplied.

### Expected demo output

`npm run demo` takes about 11 seconds at default timing. It labels all model decisions as a **scripted dry-run**, then replays three regions:

1. “The television is still playing.” — ambient, no submit.
2. “We already ate dinner. Could you summarize my notes?” — emit only **“Could you summarize my notes?”**, excluding the ambient prefix.
3. “Maybe later or perhaps tomorrow.” — unclear, no submit.

The two smaller fixtures each emit zero segments. These scripted outputs verify plumbing, candidate indices, and gating; they do **not** establish real Jev accuracy. Real Gateway outcomes can differ and must be observed on your own ambient/directed examples before considering any later agent integration.

Output is one JSON record per line, making transcripts, previews, gates, and queue submissions readable and machine-parseable. Look for STT partial/final records, `startIndex`, filtered previews, Jev decisions/latencies, `queue_submit`, and final counters. `jev_inflight_dropped` counts superseded work and `jev_stale_ignored` counts results that cannot be applied. Transcript control characters are JSON-escaped.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STT_PROVIDER` | `deepgram` | Only implemented live STT adapter |
| `DEEPGRAM_API_KEY` | unset | Required for microphone/WAV STT |
| `JEV_MODEL` | `typesafe-ai/jev` | Fixed Gateway evaluation model; other IDs are rejected |
| `AI_GATEWAY_API_KEY` | unset | Required for real Jev; no separate TypeSafe key |
| `JEV_EVERY_N_WORDS` | `1` | Evaluate every new word; `2` or `3` for profiling |
| `DEBOUNCE_MS` | `1500` | Quiet time before eligible text can submit; range 1000–2000 |
| `T_DIR_CONFIDENCE` | `0.6` | Minimum Choice probability for `directed` |
| `T_NOUL` | `0.6` | Minimum Boolean probability for `is_directed` |
| `K` | `8` | Consider suffix windows of 1 through K words |
| `WINDOW_MAX_WORDS` | `40` | Bound the words considered in a candidate window |
| `REGION_SILENCE_MS` | `1500` | Silence that closes a region; range 1500–2000 |
| `JEV_TIMEOUT_MS` | `4000` | Total evaluation deadline, including transient retry |
| `GATEWAY_ZERO_DATA_RETENTION` | `false` | Request Gateway zero-data-retention routing when true |
| `SOX_PATH` | `sox` | SoX executable, optionally an absolute path |
| `MIC_DEVICE` | `default` | CoreAudio input device |
| `DEBUG_AUDIO` | `false` | Local RMS/dBFS diagnostics; never used as an intent gate |

The Deepgram connection is `wss://api.deepgram.com/v1/listen` with these concrete query parameters:

```text
model=nova-3
interim_results=true
smart_format=true
encoding=linear16
channels=1
sample_rate=16000
language=en-US
endpointing=300
utterance_end_ms=1000
vad_events=true
```

Audio frames are 20 ms, mono, 16-bit signed little-endian PCM at 16 kHz. See [Deepgram's streaming documentation](https://developers.deepgram.com/docs/live-streaming-audio) for the vendor protocol.

## Filter behavior and concurrency

- The STT adapter normalizes word text, start/end milliseconds, and finality into [WordEvent](apps/speech-filter-harness/src/stt/types.ts). A time-range hypothesis replaces overlapping interim words; duplicate finals do not append duplicate text. Vendor-specific events stop at this boundary.
- Each new word updates the live region and candidate windows: recent suffixes of lengths 1…K, the current `startIndex`, and the region start, clipped to `WINDOW_MAX_WORDS` and any excluded ambient prefix. One Jev evaluation batches a Choice question (`directed`, `ambient`, `unclear`) and a Boolean question for each candidate.
- Jev receives text/JSON state only. The AI SDK's `experimental_evaluate` uses an explicit Gateway evaluation model; no audio is sent to Jev and no direct TypeSafe request is available. The SDK uses Gateway's SDK protocol endpoint; the public HTTP equivalent is `/v1/evaluate`. See [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation).
- The gate requires Choice `directed` at or above `T_DIR_CONFIDENCE` **and** Boolean probability at or above `T_NOUL`. The earliest qualifying candidate sets `startIndex`. High-confidence ambient excludes that prefix; unclear/low-confidence holds without submitting.
- STT callbacks never wait for Jev. There is at most one evaluator operation in progress; newer words cancel/supersede older work, retaining the latest pending input. The slot is released only once cancellation settles. A vendor update containing several new words is coalesced into its newest snapshot; the final residual words are also evaluated when profiling every 2–3 words. Region/sequence checks ignore stale results. A result for older words cannot authorize a newer transcript.
- Debounce emits only `words[startIndex…last]`. Endpointing/`UtteranceEnd` or the region silence timeout closes the region; pending output remains subject to the full debounce and that region's latest gate. A sealed region's result can finish its own pending debounce, but cannot change a newer region. New speech cancels unfinished evaluation work, which can conservatively drop a prior region. Emission consumes the audio time range, preventing delayed corrections from submitting old words again. A new region starts with a fresh gate and index. Disconnection, malformed answers, timeouts, and evaluation errors hold closed.
- STT reconnects with backoff from 250 ms up to 4 seconds. Audio during an unavailable connection is discarded rather than replayed as fresh speech. Disconnection clears eligibility and prevents submission. Jev retries a 429/5xx response once with jitter; other errors do not retry or fail open.

`DownstreamModel.submit(FilteredSegment)` has only `ConsoleDownstream` and `MemoryQueueDownstream` implementations in this phase. No text can trigger external agent actions.

## Fixtures and adapter extension

[fixtures/ambient](apps/speech-filter-harness/fixtures/ambient) contains `mixed.json`, `ambient-only.json`, and `unclear.json`. The schema has `version: 1`, a `name`, `durationMs`, an ordered `events` array, and explicit `dryRun` labels. Transcript events carry the shared `WordEvent`:

```json
{
  "atMs": 100,
  "type": "transcript",
  "event": {
    "text": "Hello",
    "startMs": 0,
    "endMs": 100,
    "isFinal": false,
    "words": [{ "text": "Hello", "startMs": 0, "endMs": 100, "isFinal": false }]
  }
}
```

`atMs` is the replay delivery time. Word/event timestamps describe the audio stream and may repeat across interim revisions. Boundary events are `{ "atMs": 1200, "type": "boundary", "reason": "utterance_end" }`; connection events use `{ "atMs": 0, "type": "connection", "connected": true }`. Leave enough time in `durationMs` after the final words for the debounce. Files are validated before replay: ordered event times, word ranges, field types, and dry-run probabilities.

`dryRun.rules` maps **exact candidate text** to explicit `addressing`, `directedProbability`, `ambientProbability`, and `isDirectedProbability` labels. Unmatched candidates use `dryRun.defaultDecision` (unclear in bundled fixtures). `dryRun.latencyMs` simulates evaluation delay for cancellation exercises. There is no keyword-based or wake-word classifier. Real Jev replay ignores these scripted labels.

To swap STT, add an adapter under `src/stt/` that consumes PCM frames and implements the same callbacks: `onTranscript(WordEvent)`, `onBoundary(reason, lastWordEndMs?)`, and `onConnection(connected)`. Preserve word timestamps/finality, normalize revisable ranges, and reset stream timing/alignment when reconnecting. Wire the new adapter in `main.ts` and explicitly extend `STT_PROVIDER` validation in `config.ts`. Keep the shared filter and Gateway client unchanged; add vendor-fixture alignment and reconnect tests. Merely setting another provider name is intentionally rejected. Flux, AssemblyAI, and other dedicated realtime transcription adapters are future options, not implemented fallback providers.

### Why not Grok Voice for STT?

Grok Voice Think Fast 2.0 is a speech-to-speech WebSocket model: it accepts audio and generates spoken responses. Its transcript events are part of a voice-agent session, rather than the dedicated word-level transcription interface this filter needs. The documented turn detection options are `server_vad` or manual (`null`), not `semantic_vad`. That is why this harness uses dedicated Nova-3 streaming STT. This rationale concerns **Grok Voice**; separate Grok transcription products are distinct. See [Vercel's Grok Voice model description](https://vercel.com/ai-gateway/models/grok-voice-think-fast-2.0) and [the voice session reference](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech).

## Privacy and validation limits

The microphone is always on while mic mode runs and captures ambient conversations. Raw audio goes only to the chosen STT service (Deepgram here); transcript text and candidate windows go to Vercel AI Gateway/Jev. Console transcripts and queue data stay in the local process unless you redirect or share them. Audio is not recorded by the harness. JSON dry-run makes no network requests; real fixture replay sends fixture text to Gateway. ZDR is an optional routing request, not a claim about the STT provider's retention policy.

Implementation was developed on Apple Silicon with Node 24.20.0 and Homebrew SoX 14.4.2 installed from bottles. Tests and the offline demo exercise the pipeline without credentials. **Real Deepgram/Jev classification and live microphone capture still require your API keys, a connected input device, and the macOS permission described above.** The machine had no input device when inspected; successful offline tests do not replace a live acceptance run.

Validation includes actual CLI replay of all three fixtures, mocked Gateway transport and Deepgram sockets, cancellation/reconnect/debounce regression tests, and real SoX conversion of a generated stereo WAV into paced mono PCM. The bounded local microphone check produced zero samples and SoX's “can not open audio device” error for the default input. No audio was uploaded during that check.

| Architecture acceptance item | Status |
| --- | --- |
| Always-on mic → Nova-3 → visible partials | Implemented; live run blocked by absent input device and API key; permission must be granted for the host app |
| Gateway-only Jev on word updates, latency logs | Implemented and transport-tested; real service/accuracy validation awaits Gateway key |
| Cancellation/stale ignore, one evaluate at a time | Regression-tested, including an uncancellable delayed result |
| Sliding index, region reset, directed suffix only | Regression-tested; mixed CLI fixture emits only the expected suffix |
| Confidence gate and 1–2 second debounce | Tested at defaults and the shorter debounce boundary; ambiguous/error results hold |
| Reconnect and fail-closed behavior | Mocked disconnect/auth/malformed-response tests; audio during outages is dropped |
| Visible feed/queue and downstream interface | Both console and bounded memory queue implemented; no real agent |
| Setup, STT defaults/extension, Grok Voice rationale | Documented above |

For live acceptance, start with `npm run stt`, then `npm run mic`: speak ambient conversation, a request addressed to the assistant after an ambient prefix, and an ambiguous fragment. Confirm that partials appear, Jev latencies/counters update, only the directed suffix reaches `queue_submit` after the quiet interval, and disconnects/errors never submit text. Stop at the console/queue stage until real ambient fixtures demonstrate acceptable filtering.
