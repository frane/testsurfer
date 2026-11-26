/** Dialogs (alert, confirm, prompt) the page opened. */

/**
 * An `alert`, `confirm` or `prompt` the page is blocked on (proxy
 * mode). A `dialog` listener must accept or dismiss it; with no
 * listener it is dismissed, as in Playwright.
 */
export class Dialog {
  private handled = false;
  private readonly kind: string;
  private readonly text: string;
  private readonly defaultText: string;
  private readonly pageValue: unknown;
  private readonly answer: (accept: boolean, text?: string) => Promise<void>;

  constructor(kind: string, text: string, defaultText: string, page: unknown, answer: (accept: boolean, text?: string) => Promise<void>) {
    this.kind = kind;
    this.text = text;
    this.defaultText = defaultText;
    this.pageValue = page;
    this.answer = answer;
  }

  /** @internal Whether accept() or dismiss() ran. */
  isHandled(): boolean {
    return this.handled;
  }

  type(): string {
    return this.kind;
  }
  message(): string {
    return this.text;
  }
  defaultValue(): string {
    return this.defaultText;
  }
  page(): any {
    return this.pageValue;
  }

  async accept(promptText?: string): Promise<void> {
    if (this.handled) throw new Error('dialog.accept: Cannot accept dialog which is already handled!');
    this.handled = true;
    await this.answer(true, promptText);
  }

  async dismiss(): Promise<void> {
    if (this.handled) throw new Error('dialog.dismiss: Cannot dismiss dialog which is already handled!');
    this.handled = true;
    await this.answer(false);
  }
}
