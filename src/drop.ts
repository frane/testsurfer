/** Files for locator.drop(): paths as given, in-memory files written to a temp folder. */

/** A file given as bytes rather than a path. */
export interface DropFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** Paths for the files to drop: in-memory ones written to a temp folder under their names. */
export async function filesOnDisk(list: (string | DropFile)[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  let dir: string | null = null;
  const paths: string[] = [];
  for (const f of list) {
    if (typeof f === 'string') {
      paths.push(path.resolve(f));
      continue;
    }
    dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'testsurfer-drop-'));
    const sub = await fs.mkdtemp(path.join(dir, 'f'));
    const p = path.join(sub, path.basename(f.name));
    await fs.writeFile(p, f.buffer);
    paths.push(p);
  }
  return { paths, cleanup: async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); } };
}
