// Static server for the lab fixtures, plus the few dynamic routes the
// network cases need. Serves every host on its port, so
// http://127.0.0.1:PORT and http://localhost:PORT are two origins of
// the same server.
import * as crypto from 'node:crypto';
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
  '/download-file': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' });
    res.end('lab report');
  },
  '/basic-auth': (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('lab:secret').toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="lab"', 'content-type': 'text/plain' });
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>auth</title><p id="who">signed in</p>');
  },
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
  .on('upgrade', (req, sock) => {
    // A minimal WebSocket echo server (RFC 6455), for the websocket cases.
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const send = (op, data) => {
      const len = data.length;
      const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]);
      sock.write(Buffer.concat([head, data]));
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { send(8, data.subarray(0, 2)); sock.end(); return; }
        if (op === 1) send(1, Buffer.from('echo:' + data.toString()));
      }
    });
    sock.on('error', () => {});
  })
  .listen(port, '127.0.0.1', () => console.log(`lab on http://127.0.0.1:${port}`));
