import type { Log } from '../stt/types.js';
import type { DownstreamModel, FilteredSegment } from './types.js';

export class ConsoleDownstream implements DownstreamModel {
  constructor(private readonly log: Log) {}
  async submit(segment: FilteredSegment): Promise<void> { this.log('queue_submit', { ...segment }); }
}

export class MemoryQueueDownstream implements DownstreamModel {
  readonly segments: FilteredSegment[] = [];
  constructor(private readonly log: Log = () => {}, private readonly capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Queue capacity must be positive');
  }
  async submit(segment: FilteredSegment): Promise<void> {
    if (this.segments.length === this.capacity) {
      this.segments.shift();
      this.log('queue_evicted', { capacity: this.capacity });
    }
    this.segments.push(structuredClone(segment));
    this.log('queue_submit', { ...segment, queueSize: this.segments.length });
  }
}
