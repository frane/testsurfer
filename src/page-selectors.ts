/**
 * Playwright's page.click(selector) family: page methods that take a
 * selector and act on its first match (strict only with `strict:
 * true`). Mixed into Page (see the end of src/page.ts); each one is a
 * Locator call.
 */

import type { Locator } from './locator.ts';
import type { ClickOptions, InputFile, SelectOptionValue } from './locator-options.ts';

/** Not strict unless asked (`strict: true`): the first match acts, as in Playwright. */
function pick(page: SelectorShortcuts, selector: string, options?: object): Locator {
  const l = page.locator(selector);
  return (options as { strict?: boolean } | undefined)?.strict ? l : l.first();
}

export abstract class SelectorShortcuts {
  abstract locator(selector: string): Locator;

  click(selector: string, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).click(options);
  }

  dblclick(selector: string, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).dblclick(options);
  }

  tap(selector: string, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).tap(options);
  }

  hover(selector: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return pick(this, selector, options).hover(options);
  }

  focus(selector: string, options?: { timeout?: number }): Promise<void> {
    return pick(this, selector, options).focus(options);
  }

  fill(selector: string, value: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return pick(this, selector, options).fill(value, options);
  }

  type(selector: string, text: string, options?: { timeout?: number }): Promise<void> {
    return pick(this, selector, options).type(text, options);
  }

  press(selector: string, key: string, options?: { timeout?: number }): Promise<void> {
    return pick(this, selector, options).press(key, options);
  }

  check(selector: string, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).check(options);
  }

  uncheck(selector: string, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).uncheck(options);
  }

  setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    return pick(this, selector, options).setChecked(checked, options);
  }

  selectOption(selector: string, values: SelectOptionValue | SelectOptionValue[] | null, options?: { timeout?: number }): Promise<string[]> {
    return pick(this, selector, options).selectOption(values, options);
  }

  setInputFiles(selector: string, files: InputFile | InputFile[], options?: { timeout?: number }): Promise<void> {
    return pick(this, selector, options).setInputFiles(files, options);
  }

  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: { timeout?: number }): Promise<void> {
    return pick(this, selector, options).dispatchEvent(type, eventInit, options);
  }

  textContent(selector: string, options?: { timeout?: number }): Promise<string> {
    return pick(this, selector, options).textContent(options);
  }

  innerText(selector: string, options?: { timeout?: number }): Promise<string> {
    return pick(this, selector, options).innerText(options);
  }

  innerHTML(selector: string, options?: { timeout?: number }): Promise<string> {
    return pick(this, selector, options).innerHTML(options);
  }

  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null> {
    return pick(this, selector, options).getAttribute(name, options);
  }

  inputValue(selector: string, options?: { timeout?: number }): Promise<string> {
    return pick(this, selector, options).inputValue(options);
  }

  isVisible(selector: string): Promise<boolean> {
    return pick(this, selector).isVisible();
  }

  isHidden(selector: string): Promise<boolean> {
    return pick(this, selector).isHidden();
  }

  isChecked(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return pick(this, selector, options).isChecked(options);
  }

  isDisabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return pick(this, selector, options).isDisabled(options);
  }

  isEnabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return pick(this, selector, options).isEnabled(options);
  }

  isEditable(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return pick(this, selector, options).isEditable(options);
  }
}
