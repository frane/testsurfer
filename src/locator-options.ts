/** Option and value types of locator actions (click, fill, selectOption, setInputFiles). */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActionOptions {
  timeout?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  trial?: boolean;
}

export interface ClickOptions extends ActionOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  modifiers?: ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[];
  position?: { x: number; y: number };
}

export type SelectOptionValue = string | { value?: string; label?: string; index?: number };

export type InputFile = string | { name: string; mimeType: string; buffer: Buffer };
