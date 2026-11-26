/** console.* calls the page made, as ConsoleMessage with its arguments. */

/** A console argument, as a value already copied out of the page. */
export class ConsoleArg {
  private readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
  async jsonValue(): Promise<unknown> {
    return this.value;
  }
  async dispose(): Promise<void> {}
  toString(): string {
    return this.value === undefined ? 'undefined' : typeof this.value === 'object' && this.value !== null ? 'JSHandle@object' : String(this.value);
  }
}

export class ConsoleMessage {
  private readonly kind: string;
  private readonly message: string;
  private readonly values: { v?: unknown; u?: number }[];
  private readonly owner: unknown;
  private readonly at = Date.now();
  private readonly from: unknown;
  constructor(kind: string, message: string, values: { v?: unknown; u?: number }[] = [], owner: unknown = null, worker: unknown = null) {
    this.kind = kind;
    this.message = message;
    this.values = values;
    this.owner = owner;
    this.from = worker;
  }
  /** When the message was logged, in ms since the epoch. */
  timestamp(): number {
    return this.at;
  }
  /** The web worker that logged it, or null for the page. */
  worker(): unknown {
    return this.from;
  }
  /** The arguments passed to console.*, as handles whose jsonValue() is the value. */
  args(): ConsoleArg[] {
    return this.values.map((a) => new ConsoleArg(a.u ? undefined : a.v));
  }
  page(): unknown {
    return this.owner;
  }
  location(): { url: string; lineNumber: number; columnNumber: number } {
    return { url: '', lineNumber: 0, columnNumber: 0 };
  }
  /** `log`, `info`, `warning`, `error` or `debug`. */
  type(): string {
    return this.kind;
  }
  text(): string {
    return this.message;
  }
}
