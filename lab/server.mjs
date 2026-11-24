// Static server for the lab fixtures, plus the few dynamic routes the
// network cases need. Serves every host on its port, so
// http://127.0.0.1:PORT and http://localhost:PORT are two origins of
// the same server.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const root = path.join(import.meta.dirname, 'fixtures');
const port = Number(process.env.LAB_PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

const routes = {
  '/api/items': (req, res) => json(res, { items: ['alpha', 'bravo', 'charlie'] }),
  '/api/echo-headers': (req, res) => json(res, req.headers),
  '/api/slow': (req, res) => setTimeout(() => json(res, { slow: true }), 800),
  '/redirect': (req, res) => {
    res.writeHead(302, { location: '/redirect-2' });
    res.end();
  },
  '/redirect-2': (req, res) => {
    res.writeHead(301, { location: '/network/landed.html' });
    res.end();
  },
  '/set-cookie': (req, res) => {
    res.writeHead(200, { 'set-cookie': 'lab=1; Path=/', 'content-type': 'text/plain' });
    res.end('ok');
  },
  '/cookies': (req, res) => json(res, { cookie: req.headers.cookie ?? '' }),
};

function json(res, v) {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(v));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[url.pathname];
    if (route) return route(req, res);
    let file = path.join(root, path.normalize(url.pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`lab on http://127.0.0.1:${port}`));
