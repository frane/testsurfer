/**
 * Serves the todo app. Import startServer() from tests, or run
 * directly with `npm start` to click around yourself.
 */

import * as http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const htmlPath = fileURLToPath(new URL('./index.html', import.meta.url));

export async function startServer(port = 0) {
  const html = await readFile(htmlPath, 'utf8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(4173);
  console.log(`surf todos running at ${url}`);
}
