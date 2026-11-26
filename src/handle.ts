/** JSHandle: a reference to a value that lives in the page. */

import { newElementHandle } from './element-factory.ts';
import type { ElementHandle } from './element-handle.ts';
import type { Page } from './page.ts';
import { serializeValue } from './serialize.ts';

/** A page value held by the test (Playwright's JSHandle). */
export class JSHandle {
  readonly handleId: number;
  readonly ownerPage: Page;

  constructor(page: Page, id: number) {
    this.ownerPage = page;
    this.handleId = id;
  }

  /** Call `fn(value, arg)` in the page. */
  async evaluate<R, A = unknown>(fn: string | ((v: any, arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return (await this.ownerPage.engineCall(
      `(${fn.toString()})(E.h(${this.handleId}),E.des(${JSON.stringify(serializeValue(arg))}))`,
    )) as R;
  }

  async evaluateHandle<A = unknown>(fn: string | ((v: any, arg: A) => unknown), arg?: A): Promise<JSHandle> {
    return this.ownerPage.adoptResult(
      `(${fn.toString()})(E.h(${this.handleId}),E.des(${JSON.stringify(serializeValue(arg))}))`,
    );
  }

  /** The value, serialized back. */
  async jsonValue<T = unknown>(): Promise<T> {
    return (await this.ownerPage.engineCall(`E.h(${this.handleId})`)) as T;
  }

  async getProperty(name: string): Promise<JSHandle> {
    return this.ownerPage.adoptResult(
      `(function(v){return v==null?undefined:v[${JSON.stringify(name)}];})(E.h(${this.handleId}))`,
    );
  }

  async getProperties(): Promise<Map<string, JSHandle>> {
    const rows = (await this.ownerPage.engineCall(`E.props(${this.handleId})`)) as [string, number, boolean][];
    return new Map(
      rows.map(([k, id, el]) => [k, el ? newElementHandle(this.ownerPage, id) : new JSHandle(this.ownerPage, id)]),
    );
  }

  asElement(): ElementHandle | null {
    return null;
  }

  async dispose(): Promise<void> {
    await this.ownerPage.engineCall(`E.drop(${this.handleId})`).catch(() => {});
  }

  /** @internal What the page showed for the value when it was adopted. */
  previewText = '';

  toString(): string {
    return `JSHandle@${this.previewText}`;
  }
}
