/**
 * Creates ElementHandles for the modules ElementHandle itself depends
 * on (Locator, JSHandle). ElementHandle extends Locator, so those
 * modules cannot import element-handle.ts at runtime without a load
 * order hazard; element-handle.ts registers its constructor here when
 * it loads instead. Every handle is created for a Page, and page.ts
 * imports element-handle.ts, so the factory is set before first use.
 */

import type { ElementHandle } from './element-handle.ts';
import type { Page } from './page.ts';

let create: ((page: Page, id: number) => ElementHandle) | null = null;

export function registerElementHandle(factory: (page: Page, id: number) => ElementHandle): void {
  create = factory;
}

export function newElementHandle(page: Page, id: number): ElementHandle {
  if (!create) throw new Error('internal: element-handle.ts was not loaded');
  return create(page, id);
}
