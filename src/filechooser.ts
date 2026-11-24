/**
 * File choosers (Playwright's FileChooser). The page shim stops a file
 * input from opening a dialog (a click on it, input.click(),
 * input.showPicker()) and reports the input instead, as a
 * `filechooser` event; setFiles() fills it.
 */

import type { ElementHandle } from './locator.ts';
import type { Page } from './page.ts';

export const FILECHOOSER_SHIM = String.raw`(function () {
  var ts = window.__ts;
  if (!ts || ts.fcHooked) return;
  ts.fcHooked = true;
  // On from the start: a headless page has no dialog to show, and a
  // listener that attaches as the click happens must not miss it.
  ts.fc = true;
  ts.fcEls = {};
  var seq = 0;
  var emit = function (e) { if (ts.ev.length < 2000) ts.ev.push(e); };
  var isFile = function (el) { return el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file' && !el.disabled; };
  var report = function (el) { var id = ++seq; ts.fcEls[id] = el; emit({ t: 'filechooser', id: id, multiple: !!el.multiple }); };
  document.addEventListener('click', function (e) {
    if (!ts.fc) return;
    var el = e.target;
    if (el && el.tagName === 'LABEL' && el.control) el = el.control;
    if (!isFile(el)) return;
    e.preventDefault();
    report(el);
  }, true);
  var click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (ts.fc && isFile(this) && !this.isConnected) { report(this); return; }
    return click.apply(this, arguments);
  };
  if (HTMLInputElement.prototype.showPicker) {
    var show = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (ts.fc && isFile(this)) { report(this); return; }
      return show.apply(this, arguments);
    };
  }
})();`;

export class FileChooser {
  private readonly owner: Page;
  private readonly input: ElementHandle;
  private readonly multiple: boolean;

  /** @internal */
  constructor(page: Page, input: ElementHandle, multiple: boolean) {
    this.owner = page;
    this.input = input;
    this.multiple = multiple;
  }

  page(): Page {
    return this.owner;
  }

  element(): ElementHandle {
    return this.input;
  }

  isMultiple(): boolean {
    return this.multiple;
  }

  setFiles(files: Parameters<ElementHandle['setInputFiles']>[0], options?: Parameters<ElementHandle['setInputFiles']>[1]): Promise<void> {
    return this.input.setInputFiles(files, options);
  }
}
