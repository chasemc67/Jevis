# Bugfix: keep listening after first chat submit (continuous mic)

## Symptom
Live mic + UI works for the first directed utterance (one chat submit), then stops. User expects continuous always-on listening for 2nd/3rd messages without clicking Start again.

## Root cause (verify, then fix)
In `apps/speech-filter-harness/src/main.ts`, mic/wav mode does:

```ts
await Promise.race([source.done, stt.done]);
```

Gateway STT (`experimental_streamTranscribe`) often ends the provider stream after a final/silence. That resolves/rejects `stt.done`, which ends the whole harness run and the UI goes to `completed` — even though the mic should stay open.

Deepgram has reconnect logic; Gateway currently reports `reconnects: 0`.

## Required behavior
For `--mode mic` (always-on):
1. Mic capture stays open until the user clicks Stop / Ctrl-C / abort.
2. If Gateway STT stream ends or errors transiently while mic is still running, **automatically reconnect** a new STT stream and keep feeding audio (with a short backoff; log `stt_reconnect`).
3. Filter must continue creating new regions after each submit (`debounce_emitted` seal is fine) so multiple chat messages can submit over time.
4. Do **not** require clicking Start again between utterances.
5. WAV mode can still end when the file + STT finish (finalize once); mic must loop/reconnect.
6. Preserve mid-session STT model switching.

## Implementation guidance
Prefer one of:
- **A (best):** `GatewayStt` / `SttSession` auto-reconnects on unexpected stream end while session not closed; `stt.done` only settles when `close()` is called (or fatal auth errors after N retries).
- **B:** In `main.ts` mic loop: while !aborted, if stt ends, reconnect STT without stopping `SoxAudioSource`.

Add regression tests:
- Simulated STT stream ending after first final → reconnect → second utterance still filtered/submitted.
- After emit+seal, a new region accepts later words and can submit again.

Update README briefly: always-on mic keeps listening across multiple turns; STT reconnects automatically.

Run `npm run check`, commit, push `origin/main`.

Do not commit `.env` or secrets.
