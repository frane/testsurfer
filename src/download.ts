/**
 * Downloads (Playwright's Download). vibesurfer captures every file a
 * page saves (a download link, an attachment response, a blob the page
 * hands to a link); `vs_download --list` lists them and `vs_download
 * --id` writes one to disk.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Page } from './page.ts';

export interface DownloadEntry {
  id: number;
  size: number;
  ready: boolean;
  mime: string;
  filename: string;
  url: string;
  error: string | null;
}

/** Parse `vs_download --list` body lines (`dl\tid\tsize\tstate\tmime\tname\turl|err=...`). */
export function parseDownloadList(lines: string[]): DownloadEntry[] {
  const out: DownloadEntry[] = [];
  for (const l of lines) {
    const p = l.split('\t');
    if (p[0] !== 'dl' || p.length < 7) continue;
    const last = p.slice(6).join('\t');
    out.push({
      id: Number(p[1]),
      size: Number(p[2]),
      ready: p[3] === 'ready',
      mime: p[4] ?? '',
      filename: p[5] ?? '',
      url: last.startsWith('err=') ? '' : last,
      error: last.startsWith('err=') ? last.slice(4) : null,
    });
  }
  return out;
}

export class Download {
  private readonly owner: Page;
  private readonly entry: DownloadEntry;
  private saved: Promise<string> | null = null;
  private readonly fetchFile: (id: number, dest: string) => Promise<string>;

  /** @internal */
  constructor(page: Page, entry: DownloadEntry, fetchFile: (id: number, dest: string) => Promise<string>) {
    this.owner = page;
    this.entry = entry;
    this.fetchFile = fetchFile;
  }

  page(): Page {
    return this.owner;
  }

  url(): string {
    return this.entry.url;
  }

  suggestedFilename(): string {
    return this.entry.filename;
  }

  /** Where the file is on disk, once it is there. */
  path(): Promise<string> {
    this.saved ??= (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsurfer-dl-'));
      return this.fetchFile(this.entry.id, path.join(dir, this.entry.filename || `download-${this.entry.id}`));
    })();
    return this.saved;
  }

  /** Copy the file to `to`. */
  async saveAs(to: string): Promise<void> {
    const from = await this.path();
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(from, to);
  }

  /** Why the download failed, or null. */
  async failure(): Promise<string | null> {
    return this.entry.error;
  }

  async createReadStream(): Promise<fs.ReadStream> {
    return fs.createReadStream(await this.path());
  }

  async delete(): Promise<void> {
    if (!this.saved) return;
    await fs.promises.rm(await this.saved, { force: true }).catch(() => {});
  }

  /** A captured download is complete when it is reported; nothing to cancel. */
  async cancel(): Promise<void> {}
}
