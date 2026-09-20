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

### Recommended STT (pick one; **default = Deepgram Nova-3**)

| Option | Concrete default | Why |
|--------|------------------|-----|
| **Deepgram Nova-3 streaming (Phase 0 default)** | Model `nova-3`; WS `wss://api.deepgram.com/v1/listen`; `interim_results=true`; `smart_format=true`; `encoding=linear16`; `channels=1`; `sample_rate=16000`; `language=en-US`; `endpointing=300`; optional `utterance_end_ms=1000`, `vad_events=true`. Env: `DEEPGRAM_API_KEY`. | Best fit for "fire Jev on every new word": interim + word timings. |
| **Deepgram Flux (optional later)** | `flux-general-en` on `/v2/listen` — turn-based events | Prefer Nova-3 for Phase 0 word-trigger loop |
| **AssemblyAI Universal-3.5 Pro Realtime** | Vendor realtime WS. Env: `ASSEMBLYAI_API_KEY`. | Alt if WER wins on fixtures |
| **OpenAI `gpt-live-transcribe`** | Transcription session (not voice-agent S2S) | Alt if already on OpenAI |

**Do not use** Whisper batch / file STT for this loop.

**Harness must implement:** normalize vendor events into `{ text, words: { text, startMs, endMs, isFinal }[] }` so Jev code is STT-agnostic.

---

## High-level pipeline
```
Always-on mic
  → PCM frames
  → Realtime STT WebSocket
  → Partial transcript + word events
  → On every new word: Jev via Vercel AI Gateway (Choice + Boolean) over sliding window
  → Maintain start_index of "agent-directed" span
  → Confidence gate (directed / ambient / unclear)
  → 1–2s debounce after last word
  → Emit filtered segment to Text Feed / queue
  → (Later) Pluggable DownstreamModel.submit(text)
```

---

## Component design

### 1) Always-on mic harness
- Capture mono PCM (**16 kHz** preferred).
- Stream continuously; no push-to-talk in Phase 0.
- Log RMS / VAD locally for debug only — **not** the intent gate.
- Graceful reconnect if STT socket drops.
- **Privacy:** local desktop harness only; do not upload raw audio beyond STT vendor; log transcripts/Jev locally. Document always-on mic captures ambient speech. Optional: mute hotkey.

### 2) Realtime STT adapter
- `onPartial(text, words[])` / `onFinal(text, words[])`
- Each word: `{ text, startMs, endMs, isFinal }`
- **Trigger:** call Jev on **every new word** (toggle to every 2–3 words for profiling).

**In-flight Jev concurrency (required):**
1. At most **one** outstanding evaluate for the live region.
2. On newer word while in flight: **cancel** prior (AbortController) or **ignore** stale result (`seq >= lastAppliedSeq`).
3. Never block STT socket on Jev.
4. Log `jev_inflight_dropped` / `jev_stale_ignored` counters.

### 3) Sliding-window start index
- `fullTranscript`, `words[]`, `startIndex`
- Defaults: `K = 8`, `WINDOW_MAX_WORDS = 40`
- On each new word: candidate windows from last 1..K + current startIndex + 0; ask Jev which is directed; update startIndex to earliest directed-with-confidence.
- Ambient-only → do not emit; keep listening.
- **Region reset:** on Deepgram `UtteranceEnd` / endpointing silence / >~1.5–2s no new words.
- **Emit:** `words[startIndex .. last].join(" ")` only. Never text before startIndex.

### 4) Jev classifier via Vercel AI Gateway (required)
**Do not call TypeSafe API directly.** Use AI Gateway.

- Model ID: `typesafe-ai/jev`
- Preferred: AI SDK `experimental_evaluate` (`import { experimental_evaluate as evaluate } from 'ai'`)
- Explicit provider: `gateway.evaluationModel('typesafe-ai/jev')` from `@ai-sdk/gateway`
- HTTP: `POST https://ai-gateway.vercel.sh/v1/evaluate` with `Authorization: Bearer $AI_GATEWAY_API_KEY`
- Auth: **`AI_GATEWAY_API_KEY`** only (no separate `TYPESAFE_API_KEY`)
- Optional: `providerOptions.gateway: { zeroDataRetention: true, only: ['typesafe-ai'] }`
- Input: text/JSON `state` only (no raw audio)
- Latency ~70–500ms; batch Choice + Boolean in **one** evaluate call
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
- STT WS: reconnect backoff 250ms → 4s; surface `stt_disconnected`; no emit while disconnected
- Jev: retry once on 429/5xx with jitter; then hold as unclear
- Malformed answers → unclear; don't crash harness

### 8) Text feed / queue (Phase 0 deliverable)
UI or CLI showing: live partial STT, startIndex + filtered preview, each Jev result, emitted queue.
```typescript
interface DownstreamModel {
  submit(segment: FilteredSegment): Promise<void>;
}
// Phase 0: ConsoleDownstream | MemoryQueueDownstream only
```

---

## Build order
1. Mic → Deepgram STT → print partials/finals (no Jev)
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
    src/stt/deepgram.ts
    src/stt/types.ts
    src/jev/client.ts
    src/jev/questions.ts
    src/filter/slidingWindow.ts
    src/filter/debounce.ts
    src/filter/gate.ts
    src/feed/textFeed.ts
    src/downstream/types.ts
    src/downstream/console.ts
    src/main.ts
    fixtures/ambient/
```

## Config knobs
- `STT_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY`
- `JEV_MODEL=typesafe-ai/jev`
- `AI_GATEWAY_API_KEY`
- `JEV_EVERY_N_WORDS=1`
- `DEBOUNCE_MS=1500`
- `T_DIR_CONFIDENCE=0.6`
- `T_NOUL=0.6`
- `K=8`
- `WINDOW_MAX_WORDS=40`
- `REGION_SILENCE_MS=1500`

## Acceptance criteria
- [ ] Always-on mic → Deepgram Nova-3 (or documented alt) with visible partials
- [ ] Jev via Gateway on word events; latencies logged
- [ ] Stale/in-flight Jev cancelled or ignored
- [ ] Sliding startIndex; region reset; emit = words[startIndex..]
- [ ] Gate blocks ambient; debounce 1–2s
- [ ] STT reconnect + Jev fail-closed
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
