/** Self-contained localhost UI. Transcript content is always rendered as text. */
export const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jevis · Speech filter lab</title>
  <style>
    :root { color-scheme: dark; --bg:#101519; --panel:#171e23; --line:#303c43; --text:#ecf1ef; --muted:#9cacae; --mint:#9be2be; --amber:#e8c282; --blue:#91c8df; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select { font:inherit; }
    button,select { border:1px solid var(--line); border-radius:7px; background:#202a30; color:var(--text); padding:9px 13px; }
    button { cursor:pointer; transition:background .15s; }
    button:hover:not(:disabled) { background:#334149; }
    button:disabled { opacity:.4; cursor:default; }
    button.primary { background:var(--mint); color:#142a22; border-color:var(--mint); font-weight:650; }
    button.primary:hover:not(:disabled) { background:#b7f3d4; }
    :focus-visible { outline:2px solid var(--blue); outline-offset:4px; }
    [hidden] { display:none !important; }
    .shell { max-width:1700px; margin:auto; padding:24px 28px 22px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:22px; margin-bottom:20px; }
    .eyebrow { font-size:11px; font-weight:700; letter-spacing:.15em; text-transform:uppercase; color:var(--mint); }
    h1 { margin:7px 0 3px; font-size:30px; letter-spacing:-.035em; font-weight:600; }
    h2 { margin:0; font-size:17px; font-weight:600; letter-spacing:-.02em; }
    p { margin:0; }
    .subtle { color:var(--muted); }
    .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
    .header-status { display:flex; align-items:center; gap:9px; color:var(--muted); font-size:12px; }
    .dot { display:inline-block; height:7px; width:7px; border-radius:50%; background:var(--muted); }
    .dot.active { background:var(--mint); box-shadow:0 0 0 4px #9be2be12; }
    .toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:16px 20px; padding:15px 18px; border:1px solid var(--line); border-radius:10px; background:#141c20; margin-bottom:22px; }
    .run-controls,.panel-controls { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
    .source { color:var(--muted); font-size:12px; margin-left:4px; }
    .panel-controls { gap:18px; }
    .panel-controls label { display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; }
    .model-controls { flex-basis:100%; display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; border-top:1px solid var(--line); padding-top:12px; font-size:12px; }
    .model-controls select { max-width:100%; }
    .model-controls .subtle { font-size:11px; }
    .active-model { overflow-wrap:anywhere; }
    input[type=checkbox] { accent-color:var(--mint); width:15px; height:15px; margin:0; }
    kbd { font:10px ui-monospace,SFMono-Regular,monospace; padding:1px 5px; border:1px solid #46535a; border-radius:3px; color:var(--muted); }
    .workspace { display:grid; grid-template-columns:minmax(310px, .9fr) minmax(420px, 1.3fr); gap:20px; align-items:start; }
    .workspace.chat-only { grid-template-columns:1fr; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
    .panel-head { display:flex; align-items:start; justify-content:space-between; gap:14px; padding:19px 21px 16px; border-bottom:1px solid var(--line); }
    .panel-head p { margin-top:4px; color:var(--muted); font-size:12px; }
    .letter { font:10px ui-monospace,SFMono-Regular,monospace; color:var(--muted); margin-bottom:5px; letter-spacing:.08em; }
    .tag { display:inline-block; border:1px solid #41514d; color:var(--mint); background:#24362e; border-radius:4px; padding:3px 7px; white-space:nowrap; font-size:10px; letter-spacing:.04em; }
    .tag.neutral { color:var(--muted); background:#222d32; border-color:#39484e; }
    .chat { min-height:650px; display:flex; flex-direction:column; }
    .chat-list { flex:1; min-height:465px; max-height:calc(100vh - 370px); overflow:auto; padding:23px 21px; }
    .chat-empty { margin:85px auto 55px; max-width:260px; text-align:center; color:var(--muted); }
    .empty-symbol { margin:0 auto 16px; width:43px; height:43px; border:1px solid #3e514a; border-radius:12px; color:var(--mint); display:grid; place-items:center; font-size:24px; }
    .chat-empty strong { display:block; color:var(--text); font-size:16px; margin-bottom:7px; font-weight:500; }
    .chat-empty p { font-size:13px; }
    .message { padding:15px 17px; background:#20332b; border:1px solid #395948; border-radius:3px 11px 11px 11px; margin-bottom:16px; animation:enter .25s ease-out; }
    .message-meta { display:flex; justify-content:space-between; gap:12px; color:var(--mint); font-size:10px; margin-bottom:8px; }
    .message-text { font-size:18px; line-height:1.55; overflow-wrap:anywhere; }
    .message-range { margin-top:10px; color:#9bb2a7; font-size:10px; }
    .chat-foot { display:flex; justify-content:space-between; gap:12px; padding:13px 21px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
    .chat-foot strong { color:var(--mint); }
    .inspectors { display:grid; gap:20px; min-width:0; }
    .raw-body { padding:16px 21px; }
    .raw-current { font-size:17px; min-height:52px; line-height:1.6; overflow-wrap:anywhere; }
    .raw-info { display:flex; justify-content:space-between; margin-bottom:8px; gap:12px; font-size:10px; color:var(--muted); }
    .raw-log { border-top:1px solid var(--line); max-height:123px; overflow:auto; padding:10px 21px; }
    .raw-row { display:grid; grid-template-columns:66px 45px 1fr; gap:9px; color:var(--muted); font-size:11px; padding:4px 0; }
    .raw-row .final { color:var(--blue); }
    .raw-row p { overflow-wrap:anywhere; }
    .decision-body { padding:17px 21px 19px; }
    .decision-controls { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px; }
    .decision-controls label { color:var(--muted); font-size:11px; }
    select { max-width:70%; padding:5px 8px; font-size:11px; }
    .gate-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:13px; }
    .gate { padding:4px 9px; background:#3c3527; color:var(--amber); border:1px solid #635437; border-radius:5px; text-transform:uppercase; font-size:11px; font-weight:650; letter-spacing:.05em; }
    .gate.ready { background:#233c2f; color:var(--mint); border-color:#46654e; }
    .gate.ambient { background:#283b44; color:var(--blue); border-color:#405d6b; }
    .gate-detail { color:var(--muted); font-size:11px; }
    .window { background:#11191d; border:1px solid #304047; border-radius:7px; padding:14px; min-height:92px; margin-bottom:9px; line-height:2.1; font-size:15px; }
    .word { display:inline-block; padding:0 3px; margin:0 1px 3px 0; border-radius:3px; }
    .word.directed { color:#c4f7d9; background:#2b4937; }
    .word.ambient { color:#829297; text-decoration:line-through; text-decoration-color:#54666d; }
    .word sup { font:8px ui-monospace,SFMono-Regular,monospace; color:#7e929a; padding-right:4px; top:-.55em; position:relative; }
    .legend { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; font-size:10px; color:var(--muted); margin-bottom:17px; }
    .legend-key { display:inline-block; width:8px; height:8px; border-radius:2px; background:#355542; margin-right:5px; }
    .legend-key.prefix { background:#56686e; margin-left:12px; }
    .countdown-row { display:flex; justify-content:space-between; gap:10px; color:var(--muted); font-size:11px; margin-bottom:7px; }
    .countdown-row strong { color:var(--text); font-weight:500; }
    .track { height:4px; background:#2d3c43; border-radius:3px; overflow:hidden; margin-bottom:17px; }
    .track-fill { height:100%; width:0; background:var(--mint); transition:width .08s linear; }
    .candidate-heading { display:flex; justify-content:space-between; gap:10px; color:var(--muted); font-size:10px; margin-bottom:7px; }
    .table-scroll { overflow:auto; max-height:280px; border:1px solid var(--line); border-radius:6px; }
    table { width:100%; border-collapse:collapse; text-align:left; font-size:11px; }
    th { position:sticky; top:0; background:#202a30; font-weight:500; color:var(--muted); font-size:10px; }
    th,td { padding:8px 9px; border-bottom:1px solid #2c3940; vertical-align:top; }
    tr:last-child td { border-bottom:none; }
    td.candidate-text { min-width:115px; max-width:320px; overflow-wrap:anywhere; }
    td.probs { min-width:143px; white-space:nowrap; font-size:10px; color:var(--muted); }
    .choice { color:var(--amber); font-size:10px; }
    .choice.directed { color:var(--mint); }
    .choice.ambient { color:var(--blue); }
    .bool { color:var(--text); margin-top:4px; }
    .table-empty { padding:20px; color:var(--muted); font-size:12px; }
    .thresholds { color:var(--muted); font-size:10px; margin:8px 0 0; }
    .metrics { display:flex; flex-wrap:wrap; gap:17px; padding:12px 21px; border-top:1px solid var(--line); color:var(--muted); font-size:10px; }
    .metrics b { font-weight:500; color:var(--text); margin-left:5px; }
    .notice { margin-bottom:17px; padding:12px 16px; border:1px solid #735942; border-radius:7px; background:#342b24; color:#f0cba6; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
    footer { display:flex; justify-content:space-between; gap:20px; color:#839497; font-size:10px; margin-top:20px; }
    @keyframes enter { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @media (prefers-reduced-motion:reduce) { *,*:before,*:after { animation:none !important; transition:none !important; } }
    @media (min-width:1100px) { .workspace { grid-template-columns:minmax(260px,.9fr) minmax(230px,.8fr) minmax(430px,1.4fr); gap:16px; } .workspace.single-inspector { grid-template-columns:minmax(310px,.9fr) minmax(420px,1.4fr); } .workspace.chat-only { grid-template-columns:1fr; } .inspectors { display:contents; } #raw-panel { display:flex; flex-direction:column; min-height:650px; } .raw-current { max-height:190px; overflow:auto; } .raw-log { max-height:420px; } .raw-row { grid-template-columns:60px 1fr; gap:3px 7px; } .raw-row p { grid-column:1 / -1; padding-bottom:6px; } .panel-head,.decision-body,.raw-body { padding-left:17px; padding-right:17px; } }
    @media (max-width:1000px) { .shell { padding:23px 20px; } .toolbar { align-items:start; flex-direction:column; gap:13px; } .workspace { grid-template-columns:minmax(260px,.8fr) minmax(350px,1.2fr); gap:14px; } .panel-head,.decision-body,.raw-body { padding-left:16px; padding-right:16px; } }
    @media (max-width:760px) { .shell { padding:20px 14px; } header { align-items:start; } h1 { font-size:26px; } .header-status { max-width:100px; } .workspace { grid-template-columns:1fr; } .chat { min-height:280px; } .chat-list { min-height:160px; max-height:400px; } .chat-empty { margin:25px auto; } .source { flex-basis:100%; } footer { flex-direction:column; gap:5px; } .panel-controls { gap:13px; } }
  </style>
</head>
<body>
<div class="shell">
  <header>
    <div><div class="eyebrow">Jevis / Speech filter lab</div><h1>Speech in. Intent out.</h1><p class="subtle">Watch ambient speech fall away before it reaches the agent.</p></div>
    <div class="header-status"><span class="dot" id="connection-dot"></span><span id="connection">Connecting locally…</span></div>
  </header>
  <div class="toolbar">
    <div class="run-controls"><button class="primary" id="run" type="button">Run offline demo</button><button id="stop" type="button" disabled>Stop</button><span class="source" id="source">Fixture · scripted Jev labels · no API keys</span></div>
    <div class="panel-controls" aria-label="Visible panels"><span class="subtle" style="font-size:11px">Inspect</span><label><input id="toggle-raw" type="checkbox" checked>Raw transcript <kbd>R</kbd></label><label><input id="toggle-jev" type="checkbox" checked>Jev decisions <kbd>J</kbd></label></div>
    <div class="model-controls"><label for="stt-model">STT model</label><select id="stt-model" aria-describedby="stt-model-help"><option value="openai/gpt-realtime-whisper">OpenAI gpt-realtime-whisper</option><option value="xai/grok-stt">xAI grok-stt</option></select><span class="subtle" id="stt-model-help">Select the Gateway model for live input.</span></div>
  </div>
  <div id="notice" class="notice" role="alert" hidden></div>
  <main class="workspace" id="workspace">
    <section class="panel chat" aria-labelledby="chat-title">
      <div class="panel-head"><div><div class="letter">A / AGENT INPUT</div><h2 id="chat-title">Chat stream</h2><p>Only gated, debounced submits reach this stream.</p></div><span class="tag">ALWAYS ON</span></div>
      <div class="chat-list" id="chat-list" role="log" aria-label="Submitted agent messages" aria-live="polite">
        <div class="chat-empty" id="chat-empty"><div class="empty-symbol" aria-hidden="true">↳</div><strong>Waiting for directed speech</strong><p>Ambient words stay outside. A confident directed phrase appears here after the debounce fires.</p></div>
      </div>
      <div class="chat-foot"><span><strong id="submit-count">0</strong> submitted messages</span><span class="mono">words[startIndex..]</span></div>
    </section>
    <div class="inspectors" id="inspectors">
      <section class="panel" id="raw-panel" aria-labelledby="raw-title">
        <div class="panel-head"><div><div class="letter">B / BEFORE THE FILTER</div><h2 id="raw-title">Raw transcript</h2><p>Unfiltered speech, including ambient conversation.</p><p class="active-model mono" id="active-stt-model">Fixture replay · no live STT</p></div><span class="tag neutral">UNFILTERED</span></div>
        <div class="raw-body"><div class="raw-info"><span id="raw-kind">Waiting for words</span><span class="mono" id="raw-time">—</span></div><p class="raw-current subtle" id="raw-current">The live word stream will appear here.</p></div>
        <div class="raw-log" id="raw-log" aria-label="Recent unfiltered transcript events"><p class="subtle" style="font-size:11px">Partial and final transcript updates stay visible here.</p></div>
      </section>
      <section class="panel" id="jev-panel" aria-labelledby="jev-title">
        <div class="panel-head"><div><div class="letter">C / INSIDE THE FILTER</div><h2 id="jev-title">Jev · window & decision</h2><p id="classifier-label">Scripted fixture labels stand in for Jev.</p></div><span class="tag neutral" id="classifier-tag">OFFLINE</span></div>
        <div class="decision-body">
          <div class="decision-controls"><label for="evaluation">Evaluation history</label><select id="evaluation"><option value="latest">Follow latest</option></select></div>
          <div class="gate-row"><span class="gate" id="gate">hold</span><span class="gate-detail" id="gate-detail">Waiting for the first evaluation</span></div>
          <div class="window" id="window"><span class="subtle">Word indices and the selected span will appear here.</span></div>
          <div class="legend"><span><i class="legend-key"></i>Directed span<i class="legend-key prefix"></i>Ambient / excluded prefix</span><span class="mono" id="indices">startIndex — · excludedBefore 0</span></div>
          <div class="countdown-row"><span>Submit debounce <span id="debounce-config">· 1,500 ms</span></span><strong id="debounce-state">Waiting for speech</strong></div><div class="track"><div class="track-fill" id="debounce-fill"></div></div>
          <div class="candidate-heading"><span>CANDIDATE WINDOWS & CLASSIFIER OUTPUT</span><span class="mono" id="latency">—</span></div>
          <div class="table-scroll"><table id="candidate-table" hidden><thead><tr><th scope="col">Start</th><th scope="col">Candidate text</th><th scope="col">Choice</th><th scope="col">Probabilities</th></tr></thead><tbody id="candidates"></tbody></table><div class="table-empty" id="candidate-empty">Start the demo to inspect each sliding window.</div></div>
          <p class="thresholds" id="thresholds">Submission requires both Choice and Boolean confidence.</p>
        </div>
        <div class="metrics"><span>Evaluations <b id="evaluation-count">0</b></span><span>Inflight dropped <b id="inflight-count">0</b></span><span>Stale ignored <b id="stale-count">0</b></span><span>Held <b id="held-count">0</b></span></div>
      </section>
    </div>
  </main>
  <footer><span id="run-state">Ready · paced fixture replay runs entirely on your machine.</span><span>R: raw transcript · J: Jev decisions · Chat is always visible</span></footer>
</div>
<script>
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { running:false, phase:'idle', mode:'fixture', classifier:'dry-run', sttProvider:'gateway', sttModel:'openai/gpt-realtime-whisper', sttModelChanging:false, modelPending:false, requestedSttModel:null, started:false, connected:false, pending:false, invalidated:false, submits:0, evaluations:0, held:0, debounceMs:1500, latestPreview:null, history:[], selected:'latest', rawCount:0 };
  const MAX_HISTORY = 150;
  const MAX_MESSAGES = 1000;
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const prob = (value) => typeof value === 'number' && Number.isFinite(value) ? (100 * value).toFixed(1) + '%' : '—';
  const key = (record) => String(record.regionId) + ':' + String(record.seq);
  function time(value) { const date = new Date(value || Date.now()); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }); }
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
  function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  function isOffline() { return /dry|script|offline/i.test(state.classifier); }
  function updateStatus(record) {
    if (typeof record.running === 'boolean') state.running = record.running;
    if (record.state) state.phase = record.state;
    if (record.mode) state.mode = record.mode;
    if (record.classifier) state.classifier = record.classifier;
    if (record.sttProvider) state.sttProvider = record.sttProvider;
    if (record.sttModel) state.sttModel = record.sttModel;
    if (typeof record.sttModelChanging === 'boolean') state.sttModelChanging = record.sttModelChanging;
    if (state.running) state.started = true;
    const offline = isOffline();
    const disabled = state.classifier === 'disabled';
    const modelChanging = state.sttModelChanging || state.modelPending;
    const deepgram = state.mode !== 'fixture' && state.sttProvider === 'deepgram';
    $('stt-model').value = state.requestedSttModel || state.sttModel;
    $('stt-model').disabled = modelChanging || state.pending || !state.connected || state.phase === 'stopping' || deepgram;
    $('stt-model-help').textContent = modelChanging ? 'Reconnecting STT…' : state.mode === 'fixture' ? 'Selected for live input. Fixture replay needs no API keys.' : deepgram ? 'Gateway model selection requires the Gateway STT provider.' : 'Switching reconnects STT; the chat and filter stay open.';
    $('active-stt-model').textContent = state.mode === 'fixture' ? 'Fixture replay · no live STT' : deepgram ? 'Deepgram' : state.sttModel + (modelChanging ? ' · reconnecting…' : '');
    $('run').disabled = state.running || state.pending || modelChanging || !state.connected;
    $('stop').disabled = !state.running || state.pending || state.phase === 'stopping';
    $('run').textContent = state.started ? (state.mode === 'mic' ? 'Start microphone' : 'Replay ' + (offline ? 'offline demo' : state.mode)) : (offline ? 'Run offline demo' : 'Start ' + state.mode);
    $('source').textContent = state.mode + ' · ' + (disabled ? 'STT only · classifier disabled' : offline ? 'scripted Jev labels · no API keys' : 'Jev via Vercel AI Gateway');
    $('classifier-label').textContent = disabled ? 'Classifier disabled in STT-only mode.' : offline ? 'Scripted fixture labels stand in for Jev.' : 'Live Jev labels via Vercel AI Gateway.';
    $('classifier-tag').textContent = disabled ? 'DISABLED' : offline ? 'OFFLINE' : 'LIVE JEV';
    const phaseLabel = state.phase === 'completed' ? 'Complete' : state.phase === 'error' ? 'Stream failed' : 'Stopped';
    $('run-state').textContent = state.phase === 'stopping' ? 'Stopping input…' : state.running ? 'Running · ' + (offline ? 'paced offline fixture replay' : state.mode + ' input') : (state.started ? phaseLabel + ' · results remain visible. Replay to start fresh.' : 'Ready · ' + (offline ? 'paced fixture replay runs entirely on your machine.' : 'start the configured input source.'));
    $('connection').textContent = state.connected ? (state.running ? 'Stream running' : 'Local server connected') : 'Reconnecting locally…';
    $('connection-dot').classList.toggle('active', state.connected);
  }
  function panelVisibility() {
    $('raw-panel').hidden = !$('toggle-raw').checked;
    $('jev-panel').hidden = !$('toggle-jev').checked;
    const bothHidden = !$('toggle-raw').checked && !$('toggle-jev').checked;
    $('inspectors').hidden = bothHidden;
    $('workspace').classList.toggle('chat-only', bothHidden);
    $('workspace').classList.toggle('single-inspector', $('toggle-raw').checked !== $('toggle-jev').checked);
  }
  $('toggle-raw').addEventListener('change', panelVisibility);
  $('toggle-jev').addEventListener('change', panelVisibility);
  document.addEventListener('keydown', (event) => {
    const editing = /TEXTAREA|SELECT/.test(event.target.tagName) || (event.target.tagName === 'INPUT' && !['checkbox','radio','button','submit'].includes(event.target.type)) || event.target.isContentEditable;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || editing) return;
    const target = event.key.toLowerCase() === 'r' ? 'toggle-raw' : event.key.toLowerCase() === 'j' ? 'toggle-jev' : null;
    if (target) { event.preventDefault(); $(target).checked = !$(target).checked; panelVisibility(); }
  });
  async function action(path) {
    state.pending = true; updateStatus({}); notice('');
    try { const response = await fetch(path, { method:'POST' }); if (!response.ok) { const body = await response.text(); throw new Error(body || 'Request failed (' + response.status + ')'); } }
    catch (error) { notice(error.message || 'Could not reach the local server.'); }
    finally { state.pending = false; updateStatus({}); }
  }
  $('run').addEventListener('click', () => action('/api/run'));
  $('stop').addEventListener('click', () => action('/api/stop'));
  $('stt-model').addEventListener('change', async () => {
    const model = $('stt-model').value;
    state.modelPending = true; state.requestedSttModel = model; updateStatus({}); notice('');
    try {
      const response = await fetch('/api/stt-model', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ model }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not switch STT models.');
      updateStatus(result);
    } catch (error) { notice(error.message || 'Could not reach the local server.'); }
    finally { state.modelPending = false; state.requestedSttModel = null; updateStatus({}); }
  });
  function reset() {
    state.submits = 0; state.evaluations = 0; state.held = 0; state.latestPreview = null; state.history = []; state.selected = 'latest'; state.rawCount = 0; state.invalidated = false;
    for (const el of $('chat-list').querySelectorAll('.message')) el.remove();
    $('chat-empty').hidden = false; $('submit-count').textContent = '0';
    $('raw-current').textContent = 'The live word stream will appear here.'; $('raw-current').classList.add('subtle'); $('raw-kind').textContent = 'Waiting for words'; $('raw-time').textContent = '—'; $('raw-log').replaceChildren();
    for (const id of ['evaluation-count','inflight-count','stale-count','held-count']) $(id).textContent = '0';
    notice(''); updateHistory(); renderDecision();
  }
  function entry(record, create) {
    let item = state.history.find((candidate) => candidate.key === key(record));
    if (!item && create) {
      const previous = state.history.at(-1);
      if (previous && !previous.result) previous.superseded = true;
      item = { key:key(record), regionId:record.regionId, seq:record.seq, request:null, result:null, preview:state.latestPreview && key(state.latestPreview) === key(record) ? state.latestPreview : null, fired:false, submitted:false, superseded:false };
      state.history.push(item); if (state.history.length > MAX_HISTORY) state.history.shift();
      state.evaluations++; $('evaluation-count').textContent = String(state.evaluations); updateHistory();
    }
    return item;
  }
  function updateHistory() {
    const selected = state.selected;
    $('evaluation').replaceChildren(node('option', '', 'Follow latest'));
    $('evaluation').firstChild.value = 'latest';
    for (const item of [...state.history].reverse()) {
      const label = 'Region ' + item.regionId + ' / #' + item.seq + (item.result ? ' · ' + item.result.gate : item.superseded ? ' · superseded' : ' · evaluating');
      const option = node('option', '', label); option.value = item.key; $('evaluation').append(option);
    }
    state.selected = selected === 'latest' || state.history.some((item) => item.key === selected) ? selected : 'latest';
    $('evaluation').value = state.selected;
  }
  $('evaluation').addEventListener('change', () => { state.selected = $('evaluation').value; renderDecision(); });
  function currentEntry() { return state.selected === 'latest' ? state.history.at(-1) : state.history.find((item) => item.key === state.selected); }
  function currentPreview() {
    const item = currentEntry();
    if (state.selected !== 'latest') return item && item.preview;
    return state.latestPreview || (item && item.preview);
  }
  function renderDecision() {
    const item = currentEntry();
    const preview = currentPreview();
    const sameEvaluation = !item || !preview || key(preview) === item.key;
    const result = sameEvaluation && item && item.result;
    const request = sameEvaluation && item && item.request;
    const invalidated = state.selected === 'latest' && state.invalidated;
    const gate = invalidated ? 'unclear' : preview ? preview.gate : result ? result.gate : 'unclear';
    const ready = gate === 'directed' && (!preview || preview.decisionFresh !== false);
    $('gate').textContent = ready ? 'ready' : gate === 'ambient' ? 'ambient-exclude' : 'hold';
    $('gate').className = 'gate' + (ready ? ' ready' : gate === 'ambient' ? ' ambient' : '');
    $('gate-detail').textContent = invalidated ? 'Filter inactive · inspect past evaluations above' : !sameEvaluation ? 'Region ' + preview.regionId + ' / words #' + preview.seq + ' · awaiting current evaluation' : item ? 'Region ' + item.regionId + ' / evaluation ' + item.seq + (item.submitted ? ' · submitted' : item.superseded ? ' · superseded by newer words' : !result ? ' · evaluating…' : result.error ? ' · classifier error' : ready ? ' · both confidence gates passed' : gate === 'ambient' ? ' · ambient prefix excluded' : ' · confidence not sufficient') : 'Waiting for the first evaluation';
    $('window').replaceChildren();
    const fullText = preview ? preview.fullTranscript : request ? request.fullTranscript : '';
    const words = preview && Array.isArray(preview.words) ? preview.words : fullText ? fullText.split(/\s+/).map((text) => ({ text })) : [];
    const startIndex = preview && preview.startIndex;
    const excludedBefore = preview ? number(preview.excludedBefore) : 0;
    if (!words.length) $('window').append(node('span','subtle','Word indices and the selected span will appear here.'));
    words.forEach((word,index) => {
      const directed = ready && Number.isInteger(startIndex) && index >= startIndex;
      const excluded = index < excludedBefore || (ready && Number.isInteger(startIndex) && index < startIndex);
      const span = node('span','word' + (directed ? ' directed' : excluded ? ' ambient' : ''));
      span.append(node('sup','',index),document.createTextNode(typeof word === 'string' ? word : word.text)); $('window').append(span,document.createTextNode(' '));
    });
    $('indices').textContent = 'startIndex ' + (Number.isInteger(startIndex) ? startIndex : '—') + ' · excludedBefore ' + excludedBefore;
    $('latency').textContent = result && typeof result.latencyMs === 'number' ? result.latencyMs.toFixed(0) + ' ms' : result && result.error ? 'error' : item && item.superseded ? 'superseded' : item ? 'evaluating…' : '—';
    const candidates = (result && result.candidates) || (request && request.candidates) || [];
    $('candidate-table').hidden = !candidates.length; $('candidate-empty').hidden = !!candidates.length; $('candidates').replaceChildren();
    $('candidate-empty').textContent = preview ? 'Waiting for evaluation of the current words.' : 'Start the demo to inspect each sliding window.';
    for (const candidate of candidates) {
      const decision = result && result.decisions && result.decisions.find((d) => d.startIndex === candidate.startIndex);
      const row = node('tr'); row.append(node('td','mono',candidate.startIndex),node('td','candidate-text',candidate.text));
      row.append(node('td','choice ' + (decision && ['directed','ambient','unclear'].includes(decision.addressing) ? decision.addressing : ''), decision ? decision.addressing : result && result.error ? 'error' : item && item.superseded ? 'superseded' : 'pending'));
      const probs = node('td','probs mono');
      probs.append(node('div','','D ' + prob(decision && decision.directedProbability) + ' · A ' + prob(decision && decision.ambientProbability)),node('div','','U ' + prob(decision ? Math.max(0,1 - decision.directedProbability - decision.ambientProbability) : undefined)),node('div','bool','is_directed ' + prob(decision && decision.isDirectedProbability)));
      row.append(probs); $('candidates').append(row);
    }
    tick();
  }
  function tick() {
    const item = currentEntry();
    const preview = currentPreview();
    const matchingItem = item && (!preview || key(preview) === item.key) ? item : null;
    let label = 'Waiting for speech'; let progress = 0;
    if (matchingItem && matchingItem.submitted) { label = 'Fired → submitted'; progress = 1; }
    else if ((matchingItem && matchingItem.fired) || (preview && preview.debounceReady)) { label = 'Fired · awaiting / applying gate'; progress = 1; }
    else if (preview && preview.debounceDueAt) {
      const dueAt = typeof preview.debounceDueAt === 'number' ? preview.debounceDueAt : new Date(preview.debounceDueAt).valueOf();
      const remaining = Math.max(0,dueAt - Date.now());
      progress = Math.max(0,Math.min(1,1 - remaining / number(preview.debounceMs,state.debounceMs)));
      label = state.selected !== 'latest' ? 'Historical evaluation' : remaining > 0 ? (remaining / 1000).toFixed(1) + ' s until fire' : 'Deadline reached';
    }
    if (matchingItem && matchingItem.held) { label = 'Fired → held (' + matchingItem.held + ')'; progress = 1; }
    else if (matchingItem && matchingItem.superseded) label = 'Superseded by newer words';
    else if (state.selected === 'latest' && state.invalidated && !(matchingItem && matchingItem.fired)) { label = 'Cancelled · filter inactive'; progress = 0; }
    else if (!state.running && preview && !preview.debounceReady && !(matchingItem && matchingItem.fired) && ['stopped','error'].includes(state.phase)) label = 'Stopped before debounce';
    $('debounce-state').textContent = label; $('debounce-fill').style.width = (progress * 100) + '%';
  }
  function raw(record) {
    const final = record.event === 'stt_final';
    $('raw-current').textContent = record.text || ''; $('raw-current').classList.remove('subtle');
    $('raw-kind').textContent = final ? 'FINAL · unfiltered' : 'PARTIAL · unfiltered'; $('raw-time').textContent = time(record.time);
    if (state.rawCount === 0) $('raw-log').replaceChildren(); state.rawCount++;
    const row = node('div','raw-row'); row.append(node('span','mono',time(record.time)),node('span',final ? 'final' : '',final ? 'FINAL' : 'partial'),node('p','',record.text || ''));
    $('raw-log').append(row); while ($('raw-log').childElementCount > MAX_HISTORY) $('raw-log').firstChild.remove(); $('raw-log').scrollTop = $('raw-log').scrollHeight;
  }
  function submitted(record) {
    if (Array.from($('chat-list').querySelectorAll('.message')).some((el) => el.dataset.id === String(record.id))) return;
    const card = node('article','message'); card.dataset.id = String(record.id);
    const meta = node('div','message-meta mono'); meta.append(node('span','','SUBMITTED / ' + String(state.submits + 1).padStart(2,'0')),node('time','',time(record.emittedAt || record.time)));
    card.append(meta,node('p','message-text',record.text || ''),node('p','message-range mono','startIndex ' + record.startIndex + (record.endIndex === undefined ? '' : ' → ' + record.endIndex) + ' · debounce complete'));
    $('chat-empty').hidden = true; $('chat-list').append(card); state.submits++; $('submit-count').textContent = String(state.submits);
    const messages = $('chat-list').querySelectorAll('.message'); if (messages.length > MAX_MESSAGES) messages[0].remove(); $('chat-list').scrollTop = $('chat-list').scrollHeight;
    const item = state.history.find((candidate) => candidate.key === String(record.id)); if (item) item.submitted = true; renderDecision();
  }
  function receive(record) {
    switch (record.event) {
      case 'ui_reset': reset(); break;
      case 'ui_status': updateStatus(record); break;
      case 'harness_started':
        state.started = true; state.debounceMs = number(record.debounceMs,1500); updateStatus({ ...record, running:true });
        $('debounce-config').textContent = '· ' + state.debounceMs.toLocaleString() + ' ms';
        if (record.directedThreshold !== undefined || record.booleanThreshold !== undefined) $('thresholds').textContent = 'Gate: Choice directed ≥ ' + prob(record.directedThreshold) + ' and Boolean is_directed ≥ ' + prob(record.booleanThreshold) + '. D / A / U = directed / ambient / unclear.';
        break;
      case 'stt_partial': case 'stt_final': raw(record); break;
      case 'evaluation_requested': { const item = entry(record,true); item.request = record; renderDecision(); break; }
      case 'jev_result': { const item = entry(record,true); item.result = record; if (!item.request && record.candidates) item.request = record; updateHistory(); renderDecision(); break; }
      case 'filter_preview': { state.invalidated = false; state.latestPreview = record; const item = entry(record,false); if (item) item.preview = record; renderDecision(); break; }
      case 'filter_reset': state.invalidated = record.reason || true; renderDecision(); break;
      case 'debounce_fired': { const item = entry(record,false); if (item) item.fired = true; tick(); break; }
      case 'segment_held': { state.held++; $('held-count').textContent = String(state.held); const item = [...state.history].reverse().find((item) => item.regionId === record.regionId); if (item) item.held = record.gate; tick(); break; }
      case 'queue_submit': submitted(record); break;
      case 'jev_inflight_dropped': $('inflight-count').textContent = String(record.count); break;
      case 'jev_stale_ignored': { $('stale-count').textContent = String(record.count); const item = entry(record,false); if (item) item.superseded = true; updateHistory(); renderDecision(); break; }
      case 'filter_counters': $('inflight-count').textContent = String(record.jev_inflight_dropped || 0); $('stale-count').textContent = String(record.jev_stale_ignored || 0); $('held-count').textContent = String(record.segments_held || 0); break;
      case 'harness_error': case 'ui_error': case 'fatal_error': notice(record.message || record.error || 'The source stopped with an error. Check the terminal for details.'); break;
      case 'jev_error': { const item = entry(record,true); item.result = { ...(item.request || record), gate:'unclear', error:'Jev evaluation failed', decisions:[] }; notice('Jev evaluation failed. The filter is holding this segment.'); updateHistory(); renderDecision(); break; }
    }
  }
  const events = new EventSource('/events');
  events.onopen = () => { state.connected = true; updateStatus({}); };
  events.onerror = () => { state.connected = false; updateStatus({}); };
  events.onmessage = (event) => { try { receive(JSON.parse(event.data)); } catch (error) { notice('Could not render a local stream event: ' + error.message); } };
  fetch('/api/status').then((response) => response.ok ? response.json() : Promise.reject(new Error('Status unavailable'))).then(updateStatus).catch(() => {});
  setInterval(tick,100);
  updateStatus({});
</script>
</body>
</html>`;
