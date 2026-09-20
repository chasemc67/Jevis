# Feature: Browser mic for web UI + continuous multi-turn listening

## Goals
1. **When using the web UI**, microphone capture must come from **Chrome/browser** via `getUserMedia`, with a **mic device picker** (enumerate `audioinput` devices, label after permission). Do **not** use SoX/CoreAudio for UI mic mode.
2. Browser asks for mic permission (the previous SoX path never prompted in Chrome — that was wrong for a web UI).
3. Capture PCM in the browser (AudioWorklet or ScriptProcessor fallback), send frames to the local Node server over WebSocket (or binary WS) for Gateway STT → Jev → chat.
4. **Continuous listening**: after each chat submit, keep listening for message 2, 3, … without clicking Start again. Auto-reconnect Gateway STT if the provider stream ends while the session is still active.
5. CLI/`npm run mic` without `--ui` may keep SoX for headless use. UI mic = browser only.

## UX
- Device `<select>`: list inputs; default to system default; persist last choice in localStorage.
- Buttons: Start / Stop. Start = getUserMedia(selected device) + open audio WS + start filter session.
- Show mic level meter from browser analyser (optional but nice).
- If permission denied, clear error with link to Chrome site settings.
- Prefer Chrome; document that Chromium is required for best device labels.

## Server
- Accept browser PCM (document sample rate — prefer 24 kHz mono PCM16 to match Gateway STT; resample in browser or server).
- Do not start SoX when UI session is browser-mic.
- Keep existing fixture / dry-run / wav paths working.
- Fix `Promise.race([source.done, stt.done])` so mic sessions don’t die when STT stream ends — reconnect STT while browser mic (or SoX CLI mic) still active.

## Tests / docs
- Unit/integration tests for STT reconnect + multi-submit regions.
- Update README: UI mic is browser-based with picker; Terminal SoX path is CLI-only.
- `npm run check` green; commit + push `origin/main`. No secrets.

## Out of scope
- Deepgram. Real agent. Changing Jev prompt semantics beyond continuity.
