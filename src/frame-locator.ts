/** frameLocator(): locators scoped to an iframe's document. */

import { Locator } from './locator.ts';
import { step, type ByRoleOptions, type ByTextOptions, type LocatorOptions } from './query.ts';

/** Locators inside an iframe (Playwright's FrameLocator). */
export class FrameLocator {
  private readonly frame: Locator;

  constructor(frame: Locator) {
    this.frame = frame;
  }

  /** The iframe element itself. */
  owner(): Locator {
    return this.frame;
  }

  private inside(): Locator {
    return this.frame.extendWith([step({ kind: 'frame' })]);
  }

  first(): FrameLocator {
    return new FrameLocator(this.frame.first());
  }
  last(): FrameLocator {
    return new FrameLocator(this.frame.last());
  }
  nth(index: number): FrameLocator {
    return new FrameLocator(this.frame.nth(index));
  }
  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    return this.inside().locator(selector, options);
  }
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.inside().locator(selector));
  }
  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return this.inside().getByRole(role, options);
  }
  getByText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByText(text, options);
  }
  getByLabel(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByLabel(text, options);
  }
  getByTestId(id: string | RegExp): Locator {
    return this.inside().getByTestId(id);
  }
  getByPlaceholder(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByPlaceholder(text, options);
  }
  getByAltText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByAltText(text, options);
  }
  getByTitle(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByTitle(text, options);
  }
}
