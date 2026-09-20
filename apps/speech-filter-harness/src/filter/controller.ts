import type { FilterConfig } from '../config.js';
import type { DownstreamModel, FilteredSegment } from '../downstream/types.js';
import type { EvaluationInput, JevEvaluator } from '../jev/types.js';
import { WordAlignment } from '../stt/alignment.js';
import type { Log, Word, WordEvent } from '../stt/types.js';
import { Debounce, systemClock, type Clock } from './debounce.js';
import { confidenceGate, type Gate } from './gate.js';
import { candidateWindows } from './slidingWindow.js';

interface Region {
  id: number;
  seq: number;
  alignment: WordAlignment;
  words: Word[];
  startIndex: number | null;
  excludedBefore: number;
  gate: Gate;
  appliedSeq: number;
  requestedSeq: number;
  wordsSinceRequest: number;
  lastWordAt: number;
  sealed: boolean;
  debounceReady: boolean;
  handledSeq: number;
  debounce: Debounce;
  silence: Debounce;
  expiry: Debounce;
}

interface Job { region: Region; input: EvaluationInput }

export interface FilterCounters {
  jev_inflight_dropped: number;
  jev_stale_ignored: number;
  jev_errors: number;
  segments_emitted: number;
  segments_held: number;
}

/** STT callbacks are synchronous and never await a classifier or downstream. */
export class SpeechFilter {
  readonly counters: FilterCounters = {
    jev_inflight_dropped: 0, jev_stale_ignored: 0, jev_errors: 0,
    segments_emitted: 0, segments_held: 0,
  };
  private connected = false;
  private stopped = false;
  private connectionGeneration = 0;
  private nextRegionId = 1;
  private nextSeq = 1;
  private active?: Region;
  private readonly regions = new Map<number, Region>();
  private sealedEndMs = -Infinity;
  private queued?: Job;
  private flight?: { job: Job; controller: AbortController };
  private running?: Promise<void>;
  private submissions: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: FilterConfig,
    private readonly evaluator: JevEvaluator,
    private readonly downstream: DownstreamModel,
    private readonly log: Log,
    private readonly clock: Clock = systemClock,
  ) {}

  onConnection(connected: boolean): void {
    if (this.stopped) return;
    this.connected = connected;
    if (!connected) {
      this.invalidate('stt_disconnected');
      this.sealedEndMs = -Infinity;
    }
    this.log(connected ? 'stt_connected' : 'stt_disconnected');
  }

  onTranscript(event: WordEvent): void {
    this.log(event.isFinal ? 'stt_final' : 'stt_partial', { text: event.text, words: event.words });
    if (!this.connected || this.stopped) return;
    // Endpoint/final duplicates cannot become a new region. A fresh connection
    // explicitly resets this stream-clock watermark.
    const words = event.words.filter(word => word.startMs >= this.sealedEndMs);
    if (!words.length && !this.active) return;
    if (event.endMs <= this.sealedEndMs) return;
    const region = this.active ?? this.createRegion();
    const update = region.alignment.apply({ ...event, startMs: Math.max(event.startMs, this.sealedEndMs), words });
    region.words = update.words;
    if (!update.contentChanged) {
      this.preview(region);
      return;
    }
    region.seq = this.nextSeq++;
    region.gate = { kind: 'unclear' }; // Any revision revokes permission to submit.
    region.appliedSeq = -1;
    region.lastWordAt = this.clock.now();
    region.debounceReady = false;
    region.wordsSinceRequest += Math.max(1, update.newWordCount);
    // A revision can invalidate a prefix boundary; never move it backwards into
    // already excluded or submitted words.
    region.excludedBefore = Math.min(region.excludedBefore, region.words.length);
    this.dropObsoleteJob();
    region.debounce.schedule(this.config.debounceMs, () => {
      region.debounceReady = true;
      this.log('debounce_fired', { regionId: region.id, seq: region.seq });
      this.preview(region);
      // Profiling N=2/3 must still evaluate the final residual words.
      if (region.requestedSeq !== region.seq) this.request(region);
      this.tryEmit(region);
    });
    region.silence.schedule(this.config.regionSilenceMs, () => this.seal(region, 'silence'));
    if (region.wordsSinceRequest >= this.config.everyNWords || update.newWordCount === 0) this.request(region);
    this.preview(region);
  }

  onBoundary(reason: string, lastWordEndMs?: number): void {
    const region = this.active;
    if (!region) return;
    const latestEnd = region.words.at(-1)?.endMs ?? 0;
    if (lastWordEndMs !== undefined && lastWordEndMs + 1 < latestEnd) return;
    this.seal(region, reason);
  }

  /** Replay EOF waits for the last decision and the ordinary debounce; it never forces an emit. */
  async finish(): Promise<void> {
    this.onBoundary('end_of_input');
    while (this.running) await this.running;
    const remaining = Math.max(0, ...[...this.regions.values()].map(region =>
      region.lastWordAt + this.config.debounceMs - this.clock.now()));
    if (remaining > 0) await new Promise<void>(resolve => this.clock.setTimeout(resolve, remaining));
    while (this.running) await this.running;
    await this.submissions;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.invalidate('shutdown');
    if (this.running) await this.running;
    await this.submissions;
    this.log('filter_counters', { ...this.counters });
  }

  private createRegion(): Region {
    const region: Region = {
      id: this.nextRegionId++, seq: 0, alignment: new WordAlignment(), words: [],
      startIndex: null, excludedBefore: 0, gate: { kind: 'unclear' },
      appliedSeq: -1, requestedSeq: -1, wordsSinceRequest: 0,
      lastWordAt: this.clock.now(), sealed: false, debounceReady: false, handledSeq: -1,
      debounce: new Debounce(this.clock), silence: new Debounce(this.clock), expiry: new Debounce(this.clock),
    };
    this.regions.set(region.id, region);
    this.active = region;
    return region;
  }

  private seal(region: Region, reason: string): void {
    if (region.sealed || !this.regions.has(region.id)) return;
    region.sealed = true;
    region.silence.cancel();
    if (this.active === region) this.active = undefined;
    this.sealedEndMs = Math.max(this.sealedEndMs, region.words.at(-1)?.endMs ?? -Infinity);
    // Seal input immediately but preserve this region's own pending debounce and
    // decision. Endpointing is 300ms, earlier than the 1500ms submit debounce.
    if (region.requestedSeq !== region.seq) this.request(region);
    this.log('region_reset', { regionId: region.id, reason, lastWordEndMs: this.sealedEndMs });
    this.tryEmit(region);
    // Bound held snapshots even if an injected evaluator violates its timeout contract.
    if (this.regions.has(region.id)) region.expiry.schedule(35000, () => this.retire(region));
  }

  private request(region: Region): void {
    if (!this.connected || this.stopped || !this.regions.has(region.id)) return;
    const candidates = candidateWindows(region.words, region.startIndex, region.excludedBefore, this.config.k, this.config.windowMaxWords);
    region.requestedSeq = region.seq;
    region.wordsSinceRequest = 0;
    if (!candidates.length) { this.tryEmit(region); return; }
    const input: EvaluationInput = {
      regionId: region.id, seq: region.seq,
      fullTranscript: region.words.slice(-this.config.windowMaxWords).map(word => word.text).join(' '), candidates,
    };
    if (this.queued) this.countDrop();
    this.queued = { region, input };
    if (this.flight && !this.flight.controller.signal.aborted) {
      this.flight.controller.abort();
      this.countDrop();
    }
    this.pump();
  }

  private dropObsoleteJob(): void {
    // A newer word supersedes even an evaluation from a just-sealed region.
    if (this.queued) { this.queued = undefined; this.countDrop(); }
    if (this.flight && !this.flight.controller.signal.aborted) {
      this.flight.controller.abort();
      this.countDrop();
    }
  }

  private pump(): void {
    if (this.flight || !this.queued || !this.connected || this.stopped) return;
    const job = this.queued;
    this.queued = undefined;
    const controller = new AbortController();
    this.flight = { job, controller };
    // Do not release the slot on abort: wait for settlement, so even a transport
    // slow to cancel never overlaps the next evaluate.
    this.running = (async () => {
      try {
        const result = await Promise.resolve().then(() => {
          this.log('evaluation_requested', {
            regionId: job.input.regionId, seq: job.input.seq,
            fullTranscript: job.input.fullTranscript, candidates: job.input.candidates,
          });
          return this.evaluator.evaluate(job.input, controller.signal);
        });
        if (!this.isCurrent(job, controller.signal)) { this.countStale(job); return; }
        const { region, input } = job;
        region.gate = confidenceGate(result, input.candidates, this.config.directedThreshold, this.config.booleanThreshold);
        region.appliedSeq = input.seq;
        if (result.error) this.counters.jev_errors++;
        if (region.gate.kind === 'directed') region.startIndex = region.gate.startIndex;
        if (region.gate.kind === 'ambient') {
          region.startIndex = null;
          region.excludedBefore = region.words.length;
        }
        this.log('jev_result', {
          regionId: region.id, seq: input.seq, latencyMs: result.latencyMs,
          gate: region.gate.kind, decisions: result.decisions, error: result.error,
          fullTranscript: input.fullTranscript, candidates: input.candidates,
          startIndex: region.startIndex, excludedBefore: region.excludedBefore,
        });
        this.preview(region);
      } catch {
        if (!this.isCurrent(job, controller.signal)) this.countStale(job);
        else {
          job.region.gate = { kind: 'unclear' };
          job.region.appliedSeq = job.input.seq;
          this.counters.jev_errors++;
          this.log('jev_error', { regionId: job.region.id, seq: job.input.seq, gate: 'unclear' });
          this.preview(job.region);
        }
      } finally {
        this.flight = undefined;
        this.running = undefined;
        this.tryEmit(job.region);
        this.pump();
      }
    })();
  }

  private isCurrent(job: Job, signal: AbortSignal): boolean {
    return !signal.aborted && this.connected && !this.stopped
      && this.regions.has(job.region.id) && job.region.seq === job.input.seq;
  }

  private tryEmit(region: Region): void {
    if (!this.connected || this.stopped || !this.regions.has(region.id) || !region.debounceReady) return;
    const pending = this.flight?.job.region === region || this.queued?.region === region;
    if (pending) return;
    if (region.handledSeq === region.seq) {
      if (region.sealed) this.retire(region);
      return;
    }
    region.handledSeq = region.seq;
    if (region.gate.kind === 'directed' && region.appliedSeq === region.seq) {
      const startIndex = region.gate.startIndex;
      const words = region.words.slice(startIndex).map(word => ({ ...word }));
      const text = words.map(word => word.text).join(' ').trim();
      if (text && startIndex >= region.excludedBefore) {
        const segment: FilteredSegment = {
          id: `${region.id}:${region.seq}`, regionId: region.id, text, words,
          startIndex, endIndex: region.words.length - 1,
          emittedAt: new Date(this.clock.now()).toISOString(),
          directedProbability: region.gate.decision.directedProbability,
          isDirectedProbability: region.gate.decision.isDirectedProbability,
        };
        const generation = this.connectionGeneration;
        // Serialization preserves feed order; downstream never blocks STT.
        this.submissions = this.submissions.then(async () => {
          if (!this.connected || this.stopped || generation !== this.connectionGeneration) {
            this.log('queue_suppressed', { id: segment.id, reason: 'disconnected_or_stopped' });
            return;
          }
          await this.downstream.submit(segment);
          this.counters.segments_emitted++;
        }).catch(() => this.log('downstream_error', { id: segment.id }));
        region.excludedBefore = region.words.length;
        region.startIndex = null;
        region.gate = { kind: 'unclear' };
        // A debounce shorter than the silence timeout must still consume the
        // emitted audio range. Later insertions/corrections cannot shift old
        // words across a purely numeric index and submit them twice.
        this.seal(region, 'debounce_emitted');
      }
    } else {
      this.counters.segments_held++;
      this.log('segment_held', { regionId: region.id, gate: region.gate.kind, latestDecision: region.appliedSeq === region.seq });
    }
    if (region.sealed) this.retire(region);
  }

  private preview(region: Region): void {
    this.log('filter_preview', {
      regionId: region.id, seq: region.seq, startIndex: region.startIndex,
      excludedBefore: region.excludedBefore, gate: region.gate.kind,
      fullTranscript: region.words.map(word => word.text).join(' '),
      words: region.words,
      decisionFresh: region.appliedSeq === region.seq,
      debounceDueAt: region.lastWordAt + this.config.debounceMs,
      debounceMs: this.config.debounceMs, debounceReady: region.debounceReady,
      preview: region.gate.kind === 'directed' && region.appliedSeq === region.seq
        ? region.words.slice(region.gate.startIndex).map(word => word.text).join(' ') : '',
    });
  }

  private countDrop(): void {
    this.counters.jev_inflight_dropped++;
    this.log('jev_inflight_dropped', { count: this.counters.jev_inflight_dropped });
  }

  private countStale(job: Job): void {
    this.counters.jev_stale_ignored++;
    this.log('jev_stale_ignored', { regionId: job.region.id, seq: job.input.seq, count: this.counters.jev_stale_ignored });
  }

  private retire(region: Region): void {
    region.debounce.cancel(); region.silence.cancel(); region.expiry.cancel();
    this.regions.delete(region.id);
    if (this.active === region) this.active = undefined;
  }

  private invalidate(reason: string): void {
    this.connectionGeneration++;
    this.queued = undefined;
    if (this.flight && !this.flight.controller.signal.aborted) { this.flight.controller.abort(); this.countDrop(); }
    for (const region of this.regions.values()) this.retire(region);
    this.log('filter_reset', { reason });
  }
}
