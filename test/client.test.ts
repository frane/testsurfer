import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WireClient } from '../src/client.ts';
import { TimeoutError } from '../src/errors.ts';

/** A daemon that accepts connections and never answers. */
async function silentDaemon(): Promise<{ address: string; close: () => void }> {
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\testsurfer-silent-${process.pid}`
      : path.join(os.tmpdir(), `testsurfer-silent-${process.pid}.sock`);
  const held: net.Socket[] = [];
  const server = net.createServer((s) => held.push(s));
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return {
    address,
    close: () => {
      for (const s of held) s.destroy();
      server.close();
    },
  };
}

test('after a daemon stops answering, later calls fail at once', async () => {
  const daemon = await silentDaemon();
  try {
    const client = await WireClient.connect({ socketPath: daemon.address, requestTimeout: 300 });
    await assert.rejects(client.call('vs_status'), TimeoutError);
    // A teardown closing many pages used to wait out the timeout once per call.
    const started = Date.now();
    await assert.rejects(client.call('vs_close', ['p1']), /not responding: no response to vs_status/);
    await assert.rejects(client.call('vs_close', ['p2']), /not responding/);
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
    client.close();
  } finally {
    daemon.close();
  }
});
