import type { Word } from '../stt/types.js';

export interface FilteredSegment {
  id: string;
  regionId: number;
  text: string;
  words: Word[];
  startIndex: number;
  endIndex: number;
  emittedAt: string;
  directedProbability: number;
  isDirectedProbability: number;
}

export interface DownstreamModel {
  submit(segment: FilteredSegment): Promise<void>;
}
