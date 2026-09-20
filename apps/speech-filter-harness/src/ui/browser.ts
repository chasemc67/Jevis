/** Served as a same-origin AudioWorklet module. Web Audio resamples the device
 * to the requested context rate; only mono PCM16 crosses the local socket. */
export const pcmWorklet = String.raw`
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = sampleRate / 50;
    this.frame = new ArrayBuffer(this.samples * 2);
    this.view = new DataView(this.frame);
    this.offset = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value = Math.max(-1, Math.min(1, value));
      this.energy += value * value;
      this.view.setInt16(this.offset * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      if (++this.offset === this.samples) {
        this.port.postMessage({ frame:this.frame, level:Math.sqrt(this.energy / this.samples) }, [this.frame]);
        this.frame = new ArrayBuffer(this.samples * 2);
        this.view = new DataView(this.frame);
        this.offset = 0;
        this.energy = 0;
      }
    }
    // Outputs remain silent: never play microphone audio through the speakers.
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

/** Embedded in the page, kept separate so lifecycle tests can exercise it. */
export const browserCaptureScript = String.raw`
class BrowserMic {
  constructor(onError, onLevel) {
    this.onError = onError;
    this.onLevel = onLevel;
    this.closed = false;
  }
  check() { if (this.closed) throw new DOMException('Capture stopped', 'AbortError'); }
  async start(deviceId, sampleRate) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Use Chrome on the local Jevis URL to enable microphone access.');
    // Resume from the click gesture, before permission/network awaits.
    this.context = new AudioContext({ sampleRate, latencyHint:'interactive' });
    await this.context.resume();
    this.check();
    if (this.context.sampleRate !== sampleRate) throw new Error('This browser cannot capture at the required sample rate. Use Chrome.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio:{
      deviceId:deviceId && deviceId !== 'default' ? { exact:deviceId } : undefined,
      channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true
    }, video:false });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); this.check(); }
    this.stream = stream;
    for (const track of stream.getTracks()) track.onended = () => this.fail('Microphone disconnected. Choose an available input and start again.');
    await this.context.audioWorklet.addModule('/mic-worklet.js');
    this.check();
    this.input = this.context.createMediaStreamSource(stream);
    this.processor = new AudioWorkletNode(this.context, 'pcm-capture', { channelCount:1, channelCountMode:'explicit' });
    this.processor.onprocessorerror = () => this.fail('Microphone audio processing failed. Start again.');
    const socket = this.socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/audio');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('STT startup timed out. Check the terminal, then start again.')), 30000);
      const finish = error => { clearTimeout(timer); this.cancelReady = null; error ? reject(error) : resolve(); };
      this.cancelReady = () => finish(new DOMException('Capture stopped', 'AbortError'));
      socket.onmessage = event => {
        try {
          const ready = JSON.parse(event.data);
          if (ready.type !== 'ready' || ready.sampleRate !== sampleRate || ready.channels !== 1 || ready.format !== 'pcm16le' || ready.frameMs !== 20) throw new Error();
          socket.onmessage = null;
          finish();
        } catch { finish(new Error('Invalid microphone audio handshake.')); }
      };
      socket.onerror = () => { finish(new Error('Could not connect browser audio. Check the local server.')); this.fail('Browser audio connection failed.'); };
      socket.onclose = () => { finish(new Error('Audio session closed. Check the terminal and start again.')); this.fail('Microphone session ended. Start again to listen.'); };
    });
    this.check();
    this.processor.port.onmessage = event => {
      if (this.closed) return;
      // Bound latency: never deliver seconds of stale speech after congestion.
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > sampleRate * 2) {
        this.fail('Local audio connection fell behind. Start again.'); return;
      }
      socket.send(event.data.frame);
      this.onLevel(event.data.level);
    };
    this.input.connect(this.processor);
    this.processor.connect(this.context.destination);
  }
  fail(message) {
    if (this.closed) return;
    this.stop();
    this.onError(message);
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.cancelReady?.();
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.close(); }
    if (this.processor) { this.processor.port.onmessage = null; this.processor.port.close(); this.processor.disconnect(); }
    this.input?.disconnect();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (this.context) void this.context.close().catch(() => {});
    this.onLevel(0);
  }
}
`;
