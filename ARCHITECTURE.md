# Jevis — Phase 0 PoC Architecture Spec

Self-contained build spec. Goal: always-on microphone → streaming STT partial text → Jev directed-speech filter → debounced, sliding-window filtered text → pluggable downstream model.

**Phase 0 (required first):** minimal test harness only (mic → STT → Jev → visible text feed/queue). Do **not** wire a real agent until the harness proves filtering on ambient speech.

Repo name: **Jevis** (Jev + voice input filter).

---

## Non-goals (Phase 0)
- No Grok Voice / OpenAI Realtime speech-to-speech as the STT layer
- No production agent tools, TTS, or barge-in UX yet
- No wake-word dependency as the primary gate (sliding window + Jev replace keywords/silence hacks)

---

## Why not Grok Voice for STT
- Gateway model `xai/grok-voice-think-fast-2.0` is **speech-to-speech** over WebSocket (audio in → audio out), not a dedicated text STT stream.
- Optional transcripts are a side channel; the product is S2S.
- VAD: Grok exposes **`server_vad` only** (no `semantic_vad`).
- **Use a dedicated realtime STT** that emits word/partial text deltas.

### Streaming STT (**default = AI Gateway / OpenAI**)

| Option | Concrete default | Why |
|--------|------------------|-----|
| **Gateway OpenAI (Phase 0 default)** | `STT_PROVIDER=gateway`; `STT_MODEL=openai/gpt-realtime-whisper`; AI SDK `experimental_streamTranscribe` with `gateway.transcriptionModel(...)`; 24 kHz mono PCM16. Env: `AI_GATEWAY_API_KEY`. | One key for streaming STT and Jev. |
| **Gateway xAI (client toggle)** | `STT_MODEL=xai/grok-stt`; same Gateway adapter, audio format, and key. | Dedicated streaming transcription, distinct from Grok Voice speech-to-speech. |
| **Deepgram Nova-3 (optional/deferred)** | Explicit `STT_PROVIDER=deepgram` **and** `DEEPGRAM_API_KEY`; WS `wss://api.deepgram.com/v1/listen`; `interim_results=true`; `smart_format=true`; `encoding=linear16`; `channels=1`; `sample_rate=16000`; `language=en-US`; `endpointing=300`; `utterance_end_ms=1000`; `vad_events=true`. | Existing alternate adapter with native word timings. Jev still needs the Gateway key. |

The visual UI selects either Gateway STT model. Switching replaces only the STT session, clears pending filter state, and retains submitted chat. Audio arriving while STT is unavailable is dropped, not replayed. The selector does not change fixture input into microphone input and is disabled for the Deepgram provider. Legacy `STT_PROVIDER=deepgram` configurations without a Deepgram key fall back to Gateway.

**Do not use** Whisper batch / file STT for this loop.

**Normalization contract:** `{ text, words: { text, startMs, endMs, isFinal }[], startMs, endMs, isFinal }` describes a replaceable time-range hypothesis so Jev code is STT-agnostic. Gateway deltas/partials/finals become word events with approximate timestamps derived from supplied transcript ranges and the PCM clock; these are not forced word alignment. Revisions replace the affected range rather than appending duplicate text.

---

## High-level pipeline
```
Always-on mic
  → PCM frames
  → Gateway streaming STT (OpenAI ↔ xAI; optional Deepgram)
  → Partial transcript + word events
  → On every new word: Jev via Vercel AI Gateway (Choice + Boolean) over sliding window
  → Maintain startIndex of "agent-directed" span
  → Confidence gate (directed / ambient / unclear)
  → 1–2s debounce after last word
  → Emit filtered segment to Text Feed / queue
  → (Later) Pluggable DownstreamModel.submit(text)
```

---

## Component design

### 1) Always-on mic harness
- SoX captures the microphone through macOS CoreAudio or decodes and paces a WAV file. Both produce signed 16-bit little-endian mono PCM in 20 ms frames: **24 kHz for Gateway**, **16 kHz for Deepgram**.
- Word-event JSON fixtures bypass audio/STT. `--dry-run` additionally uses scripted Jev labels and requires no keys; it validates harness behavior, not model accuracy.
- Stream continuously; no push-to-talk in Phase 0.
- Log RMS / VAD locally for debug only — **not** the intent gate.
- Gateway stream failures stop the run; restart from the UI/CLI. The optional Deepgram adapter reconnects with backoff.
- **Privacy:** local desktop harness only; audio goes to the selected STT provider through Gateway (directly for optional Deepgram), and transcript context/candidates go to Jev through Gateway; logs stay local. Document always-on mic captures ambient speech. Optional: mute hotkey.

### 2) Realtime STT adapter
- `onPartial(text, words[])` / `onFinal(text, words[])`
- Each word: `{ text, startMs, endMs, isFinal }`
- **Trigger:** call Jev on **every new word** (toggle to every 2–3 words for profiling).

**In-flight Jev concurrency (required):**
1. At most **one** outstanding evaluate across regions, with one coalesced latest request queued.
2. On a newer word or transcript revision: **cancel** prior (AbortController), wait for its settlement before starting the next call, and **ignore** any result whose signal, region, or sequence is no longer current. Every text revision revokes the previous gate decision immediately.
3. Never block STT socket on Jev.
4. Log `jev_inflight_dropped` / `jev_stale_ignored` counters.

### 3) Sliding-window start index
- `fullTranscript`, `words[]`, `startIndex`
- Defaults: `K = 8`, `WINDOW_MAX_WORDS = 40`
- On each word update: candidate windows from last 1..K + valid current startIndex + the bounded window floor (`max(excludedBefore, words.length - WINDOW_MAX_WORDS, 0)`); ask Jev which entire candidate is directed; update startIndex to the earliest directed-with-confidence candidate.
- Ambient-only → do not emit; keep listening.
- **Region reset:** on Gateway final, Deepgram `UtteranceEnd` / endpoint, end of input, or 1.5–2s without a text change. Seal the input region while preserving its own pending decision/debounce; a boundary alone never forces submission.
- **Emit:** `words[startIndex .. last].join(" ")` only. Never text before startIndex.

### 4) Jev classifier via Vercel AI Gateway (required)
**Do not call TypeSafe API directly.** Use AI Gateway.

- Model ID: `typesafe-ai/jev`
- Preferred: AI SDK `experimental_evaluate` (`import { experimental_evaluate as evaluate } from 'ai'`)
- Explicit provider: `gateway.evaluationModel('typesafe-ai/jev')` from `@ai-sdk/gateway`
- Current SDK transport: `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model` (Gateway's separate public REST route is `/v1/evaluate`). The client fixes its destination to Gateway and rejects redirects.
- Auth: **`AI_GATEWAY_API_KEY`** only (no separate `TYPESAFE_API_KEY`)
- Provider routing: `providerOptions.gateway.only: ['typesafe-ai']`; optional `zeroDataRetention: true` via `GATEWAY_ZERO_DATA_RETENTION=true`.
- Input: text/JSON `state` only (no raw audio)
- Log measured latency; batch Choice + Boolean for every candidate in **one** evaluate call. Default total deadline: `JEV_TIMEOUT_MS=4000`, including retries.
- No native streaming — re-call on new words

**Questions every call:**
A. Choice `addressing`: directed | ambient | unclear
B. Boolean `is_directed`: clearly talking to agent vs ambient

### 5) Confidence gate
- Act on directed only if Choice `directed` prob ≥ `T_DIR_CONFIDENCE` (0.6) AND Boolean ≥ `T_NOUL` (0.6)
- unclear / low confidence → hold (no submit, no hard reset)
- ambient high confidence → freeze/reset startIndex to exclude prefix
- **Fail closed** on Jev errors — never fail-open to ambient submit

### 6) Debounce
- Default `DEBOUNCE_MS = 1500` (1000–2000)
- On fire: if gate directed and span non-empty → emit FilteredSegment
- Use latest **applied** gate result (not stale in-flight)

### 7) Errors / retries
- Gateway STT: stop on disconnect, malformed events, or excessive audio backpressure; surface the error and restart the run. Model switching deliberately reconnects STT.
- Optional Deepgram STT: reconnect backoff 250ms → 4s. Both adapters surface `stt_disconnected`; disconnect/model switch discards pending filter state and suppresses queued submissions.
- Jev: retry once on 429/5xx with jitter; then hold as unclear
- Malformed answers → unclear; don't crash harness

### 8) Text feed / queue (Phase 0 deliverable)
UI or CLI showing: live partial STT, startIndex + filtered preview, each Jev result, emitted queue.
The local visual UI (`--ui`, loopback port 3210 by default) starts input only after Run/Start. Chat is always visible and receives submitted segments only; Raw transcript and Jev decisions are independently toggleable. The STT model selector switches the two Gateway models. `npm run demo:ui` is the offline fixture UI; use `npm run dev -- --mode mic --ui` for live input because `demo:ui` includes `--dry-run`.
```typescript
interface DownstreamModel {
  submit(segment: FilteredSegment): Promise<void>;
}
// Phase 0: ConsoleDownstream | MemoryQueueDownstream only
```

---

## Build order
1. Mic → Gateway streaming STT → print partials/finals (no Jev)
2. Word event alignment from STT
3. Gateway Jev client: one evaluate with Choice+Boolean; log latency
4. Every-new-word loop + sliding startIndex + stale handling + region reset
5. Confidence gate + debounce → Text Feed (emit words[startIndex..] only)
6. DownstreamModel interface with console/queue impl
7. **Stop.** Validate on ambient fixtures before real agent

---

## Suggested layout
```
/
  package.json
  README.md
  ARCHITECTURE.md
  .env.example
  apps/speech-filter-harness/
    src/mic/
    src/stt/gateway.ts
    src/stt/session.ts
    src/stt/deepgram.ts
    src/stt/types.ts
    src/jev/client.ts
    src/jev/questions.ts
    src/filter/slidingWindow.ts
    src/filter/debounce.ts
    src/filter/gate.ts
    src/feed/textFeed.ts
    src/ui/
    src/downstream/types.ts
    src/downstream/console.ts
    src/main.ts
    fixtures/ambient/
```

## Config knobs
- `STT_PROVIDER=gateway`
- `STT_MODEL=openai/gpt-realtime-whisper` (or `xai/grok-stt`)
- `DEEPGRAM_API_KEY` (optional; requires `STT_PROVIDER=deepgram`)
- `JEV_MODEL=typesafe-ai/jev`
- `AI_GATEWAY_API_KEY`
- `JEV_EVERY_N_WORDS=1`
- `DEBOUNCE_MS=1500`
- `T_DIR_CONFIDENCE=0.6`
- `T_NOUL=0.6`
- `K=8`
- `WINDOW_MAX_WORDS=40`
- `REGION_SILENCE_MS=1500`
- `JEV_TIMEOUT_MS=4000`
- `GATEWAY_ZERO_DATA_RETENTION=false`

## Acceptance criteria
- [ ] Always-on mic → Gateway streaming STT (OpenAI/xAI client toggle) with visible partials
- [ ] Jev via Gateway on word events; latencies logged
- [ ] Stale/in-flight Jev cancelled or ignored
- [ ] Sliding startIndex; region reset; emit = words[startIndex..]
- [ ] Gate blocks ambient; debounce 1–2s
- [ ] STT model-switch reconnect; stream failures and Jev errors fail closed
- [ ] Filtered segments in text feed/queue
- [ ] DownstreamModel with console/queue only
- [ ] README explains why not Grok Voice STT, Gateway-only Jev, STT defaults, how to swap STT

## Stack preference
- TypeScript / Node (or Bun if cleaner for mic)
- macOS-friendly mic capture (e.g. naudiodon, sox, or SoX via child process — pick what works on Apple Silicon without requiring Xcode GUI)
- Simple CLI TUI for Phase 0 is fine (Ink or plain console); optional minimal local web UI if faster
- pnpm or npm workspace OK

## References
- https://vercel.com/ai-gateway/models/jev — `typesafe-ai/jev`
- https://vercel.com/docs/ai-gateway/modalities/evaluation
- https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk
- https://docs.typesafe.ai/llms.txt
- https://developers.deepgram.com/docs/live-streaming-audio
