export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Debounce {
  private timer: unknown;
  constructor(private readonly clock: Clock = systemClock) {}
  schedule(delayMs: number, callback: () => void): void {
    this.cancel();
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; callback(); }, Math.max(0, delayMs));
  }
  cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
