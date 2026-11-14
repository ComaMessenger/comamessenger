export type AutosavePhase = "idle" | "dirty" | "saving" | "saved" | "error";

export type AutosaveState = { phase: AutosavePhase; error: string };

export type AutosaveOptions<T> = {
  save(value: T): Promise<T>;
  fingerprint(value: T): string;
  onSaved?(result: T, snapshot: T): void;
  /** Text of a failed save, shown next to «Retry». */
  describeError(cause: unknown): string;
  delay: number;
};

/**
 * Saves a form draft a moment after the last change, the way settings pages
 * of the web and the phone do it. One save runs at a time; a change made
 * while it runs is saved right after it. Framework-free: the web and the
 * phone wrap it in a hook that calls `update` when the draft changes.
 */
export class Autosave<T> {
  private state: AutosaveState = { phase: "idle", error: "" };
  private initialized = false;
  private committed = "";
  private signature: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private latest: T | null = null;

  constructor(
    private options: AutosaveOptions<T>,
    private readonly onChange: (state: AutosaveState) => void,
  ) {}

  /** Latest callbacks; call on every render so saves see current closures. */
  configure(options: AutosaveOptions<T>) {
    this.options = options;
  }

  /**
   * The draft as it is now, without scheduling a save: a draft that took a
   * new version after a save keeps its fingerprint but must send the version.
   */
  track(value: T | null) {
    this.latest = value;
  }

  get current(): AutosaveState {
    return this.state;
  }

  /**
   * The draft as it is now. The first non-empty value is the saved
   * baseline; later ones schedule a save when their fingerprint changes.
   */
  update(value: T | null) {
    this.latest = value;
    if (!value) return;
    const signature = this.options.fingerprint(value);
    if (signature === this.signature) return;
    this.signature = signature;
    this.clearTimer();
    if (!this.initialized) {
      this.initialized = true;
      this.committed = signature;
      return;
    }
    if (signature === this.committed) return;
    this.set({ phase: "dirty" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist(value);
    }, this.options.delay);
  }

  retry() {
    if (this.latest) void this.persist(this.latest);
  }

  dispose() {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(change: Partial<AutosaveState>) {
    this.state = { ...this.state, ...change };
    this.onChange(this.state);
  }

  private async persist(snapshot: T) {
    if (this.inFlight) return;
    this.inFlight = true;
    let succeeded = false;
    this.set({ phase: "saving", error: "" });
    try {
      const result = await this.options.save(snapshot);
      succeeded = true;
      this.committed = this.options.fingerprint(result);
      this.options.onSaved?.(result, snapshot);
      setTimeout(() => {
        if (!this.inFlight && this.timer === null) this.set({ phase: "saved" });
      }, 50);
    } catch (cause) {
      this.set({ phase: "error", error: this.options.describeError(cause) });
    } finally {
      this.inFlight = false;
      const current = this.latest;
      if (
        succeeded &&
        current &&
        this.options.fingerprint(current) !== this.committed
      ) {
        this.clearTimer();
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.persist(current);
        }, this.options.delay);
        if (this.state.phase !== "error") this.set({ phase: "dirty" });
      }
    }
  }
}
