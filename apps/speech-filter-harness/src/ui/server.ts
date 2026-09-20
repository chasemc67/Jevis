import { createServer, type ServerResponse } from 'node:http';
import { DEFAULT_STT_MODEL, isGatewaySttModel, type GatewaySttModel } from '../stt/models.js';
import type { Log } from '../stt/types.js';
import { page } from './page.js';

export interface UiSessionControls {
  readonly sttModel: GatewaySttModel;
  /** Register before awaiting startup, and use the run signal to cancel a pending reconnect. */
  onSttModelChange(listener: (model: GatewaySttModel) => Promise<void>): () => void;
}

interface UiOptions {
  port: number;
  mode: string;
  classifier: string;
  sttModel?: GatewaySttModel;
  sttProvider?: string;
  log: Log;
  run: (signal: AbortSignal, log: Log, controls: UiSessionControls) => Promise<void>;
}

/** A loopback-only observer/controller. The browser never receives configuration or credentials. */
export async function startUiServer(options: UiOptions): Promise<{ url: string; close: () => Promise<void> }> {
  type Record = { time: string; event: string; [key: string]: unknown };
  interface Client { response: ServerResponse; pending: string[]; bytes: number; blocked: boolean }
  interface ActiveSession { abort: AbortController; done: Promise<void>; switchModel?: (model: GatewaySttModel) => Promise<void> }
  const clients = new Set<Client>();
  const history: { id: number; record: Record; bytes: number }[] = [];
  const submits: typeof history = [];
  let sequence = 0;
  let historyBytes = 0;
  let submitBytes = 0;
  let started: (typeof history)[number] | undefined;
  let active: ActiveSession | undefined;
  let closed = false;
  let state = 'idle';
  let url = '';
  let sttModel = options.sttModel ?? DEFAULT_STT_MODEL;
  let pendingModelChanges = 0;
  let modelChanges = Promise.resolve();
  const status = () => ({ running: !!active, mode: options.mode, classifier: options.classifier, state,
    sttProvider: options.sttProvider ?? 'gateway', sttModel, sttModelChanging: pendingModelChanges > 0 });
  const flush = (client: Client): void => {
    while (!client.blocked && !client.response.destroyed && client.pending.length) {
      const chunk = client.pending.shift()!;
      client.bytes -= Buffer.byteLength(chunk);
      if (!client.response.write(chunk)) {
        client.blocked = true;
        client.response.once('drain', () => { client.blocked = false; flush(client); });
      }
    }
  };
  const enqueue = (client: Client, chunk: string): void => {
    if (client.response.destroyed) return;
    client.bytes += Buffer.byteLength(chunk);
    // Bound slow-tab memory without confusing a normal large snapshot with a stalled tab.
    if (client.bytes > 8 * 1024 * 1024) {
      clients.delete(client);
      client.response.destroy();
      return;
    }
    client.pending.push(chunk);
    flush(client);
  };
  const send = (client: Client, record: Record): void => enqueue(client, `data: ${JSON.stringify(record)}\n\n`);
  const publish: Log = (event, fields = {}) => {
    options.log(event, fields);
    const record = { ...fields, time: new Date().toISOString(), event };
    const item = { id: sequence++, record, bytes: Buffer.byteLength(JSON.stringify(record)) };
    history.push(item);
    historyBytes += item.bytes;
    while (history.length > 2000 || historyBytes > 4 * 1024 * 1024) historyBytes -= history.shift()!.bytes;
    if (event === 'harness_started') started = item;
    if (event === 'queue_submit') {
      submits.push(item);
      submitBytes += item.bytes;
      while (submits.length > 1000 || submitBytes > 1024 * 1024) submitBytes -= submits.shift()!.bytes;
    }
    for (const client of clients) send(client, item.record);
  };
  const sendStatus = (): void => publish('ui_status', status());
  const start = (): boolean => {
    if (active || closed || pendingModelChanges) return false;
    history.length = 0;
    submits.length = 0;
    historyBytes = 0;
    submitBytes = 0;
    started = undefined;
    publish('ui_reset');
    state = 'running';
    const abort = new AbortController();
    const session: ActiveSession = { abort, done: Promise.resolve() };
    const controls: UiSessionControls = {
      get sttModel() { return sttModel; },
      onSttModelChange(listener) {
        session.switchModel = listener;
        return () => { if (session.switchModel === listener) delete session.switchModel; };
      },
    };
    const done = Promise.resolve().then(() => options.run(abort.signal, publish, controls)).then(() => {
      state = abort.signal.aborted ? 'stopped' : 'completed';
    }, (error: unknown) => {
      state = abort.signal.aborted ? 'stopped' : 'error';
      // Keep detailed provider/capture failures terminal-only; never reflect credentials to the page.
      if (!abort.signal.aborted) {
        options.log('harness_error', { message: error instanceof Error ? error.message : 'Harness failed' });
        publish('ui_error', { message: 'Stream failed. Check the local terminal diagnostics, configuration, and input device.' });
      }
    }).finally(() => { active = undefined; sendStatus(); });
    session.done = done;
    active = session;
    sendStatus();
    return true;
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (code: number, body: unknown): void => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    // Reject foreign origins and DNS-rebinding hosts, including attempts to start live capture.
    const authority = new URL(url).host;
    if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== url)) {
      json(403, { error: 'Use the local URL printed by Jevis.' }); return;
    }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page); return;
    }
    if (request.method === 'GET' && request.url === '/api/status') { json(200, status()); return; }
    if (request.method === 'GET' && request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.flushHeaders();
      const client: Client = { response, pending: [], bytes: 0, blocked: false };
      // Reconnects rebuild from a bounded snapshot, avoiding duplicate chat messages.
      send(client, { time: new Date().toISOString(), event: 'ui_reset' });
      const snapshot = new Map([...submits, ...history, ...(started ? [started] : [])].map(item => [item.id, item]));
      for (const item of [...snapshot.values()].sort((a, b) => a.id - b.id)) send(client, item.record);
      send(client, { time: new Date().toISOString(), event: 'ui_status', ...status() });
      if (!response.destroyed) clients.add(client);
      response.on('close', () => clients.delete(client));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/run') {
      json(start() ? 202 : 409, status()); return;
    }
    if (request.method === 'POST' && request.url === '/api/stop') {
      active?.abort.abort();
      if (active) state = 'stopping';
      sendStatus();
      json(202, status()); return;
    }
    if (request.method === 'POST' && request.url === '/api/stt-model') {
      // The only client-controlled configuration is a small, strict model allowlist.
      void (async () => {
        if (!request.headers['content-type']?.startsWith('application/json')) {
          request.resume(); json(415, { error: 'Send a JSON model selection.' }); return;
        }
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 1024) { json(413, { error: 'Model selection is too large.' }); return; }
        }
        let model: unknown;
        try {
          const parsed: unknown = JSON.parse(body);
          model = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'model' in parsed ? parsed.model : undefined;
        } catch { json(400, { error: 'Send a valid JSON model selection.' }); return; }
        if (!isGatewaySttModel(model)) { json(400, { error: 'Choose a supported Gateway STT model.' }); return; }
        if (options.sttProvider === 'deepgram' && options.mode !== 'fixture') {
          json(409, { error: 'Start with the Gateway STT provider to select a Gateway model.' }); return;
        }
        const selectedModel = model;
        pendingModelChanges++;
        sendStatus();
        const change = modelChanges.then(async () => {
          if (closed || active?.abort.signal.aborted) {
            json(409, { error: 'The stream is stopping. Change the model after it stops.' }); return;
          }
          if (selectedModel !== sttModel) {
            const session = active;
            if (session && options.mode !== 'fixture' && !session.switchModel) {
              json(409, { error: 'Stop the stream before changing its STT model.' }); return;
            }
            await session?.switchModel?.(selectedModel);
            if (session?.abort.signal.aborted || closed) {
              json(409, { error: 'The stream stopped before its STT model changed.' }); return;
            }
            sttModel = selectedModel;
          }
          json(200, { ...status(), sttModelChanging: pendingModelChanges > 1 });
        }).catch((error: unknown) => {
          options.log('stt_model_change_error', { message: error instanceof Error ? error.message : 'STT reconnect failed' });
          json(503, { error: 'STT reconnect failed. Check the local terminal diagnostics, then restart the stream.' });
        }).finally(() => { pendingModelChanges--; sendStatus(); });
        modelChanges = change;
        await change;
      })().catch(() => { if (!response.headersSent) json(400, { error: 'Could not read the model selection.' }); });
      return;
    }
    json(404, { error: 'Not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the visual demo');
  url = `http://127.0.0.1:${address.port}`;
  const heartbeat = setInterval(() => {
    for (const client of clients) enqueue(client, ': keepalive\n\n');
  }, 15000);
  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => closing ??= (async () => {
      closed = true;
      clearInterval(heartbeat);
      active?.abort.abort();
      await active?.done;
      await modelChanges;
      for (const client of clients) client.response.destroy();
      clients.clear();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })(),
  };
}
