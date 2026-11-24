/**
 * Page videos (Playwright's recordVideo / page.video()). vibesurfer
 * records a page to an H.264 MP4 (`vs_record`); the file lands in the
 * context's video directory when the page closes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class Video {
  private readonly dir: string;
  private file: Promise<string>;
  private settle!: (p: string) => void;

  /** @internal */
  constructor(dir: string) {
    this.dir = dir;
    this.file = new Promise((r) => (this.settle = r));
  }

  /** Where the video is, once the page has closed. */
  path(): Promise<string> {
    return this.file;
  }

  /** Copy the video to `to` (waits for the page to close). */
  async saveAs(to: string): Promise<void> {
    const from = await this.file;
    await fs.promises.mkdir(path.dirname(path.resolve(to)), { recursive: true });
    await fs.promises.copyFile(from, to);
  }

  async delete(): Promise<void> {
    await fs.promises.rm(await this.file, { force: true });
  }

  /** @internal The recording stopped at `recorded`: move it into the video directory. */
  async finish(recorded: string): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const to = path.join(this.dir, `${crypto.randomUUID()}.mp4`);
    try {
      await fs.promises.rename(recorded, to);
    } catch {
      await fs.promises.copyFile(recorded, to);
    }
    this.settle(to);
  }
}
