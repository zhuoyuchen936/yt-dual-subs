// Integration harness: a fake YouTube watch page that runs the unmodified extension sources.
//   node test/harness/server.mjs   ->  http://localhost:8800/watch?v=demo0000001
// /api/timedtext behaves like YouTube's (empty body without a pot token); /llm/* proxies to LM Studio
// so the page can reach it same-origin.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { manualJson3, asrJson3 } from '../helpers.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const LLM = process.env.LLM_ORIGIN || 'http://localhost:1234';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/watch') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(ROOT, 'test/harness/index.html')));
      }
      if (url.pathname === '/api/timedtext') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!url.searchParams.get('pot')) return res.end('');
        return res.end(JSON.stringify(url.searchParams.get('kind') === 'asr' ? asrJson3() : manualJson3()));
      }
      if (url.pathname.startsWith('/llm/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const upstream = await fetch(LLM + url.pathname.slice(4), {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: req.method === 'POST' ? Buffer.concat(chunks) : undefined
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        for await (const c of upstream.body) res.write(c);
        return res.end();
      }
      const file = path.join(ROOT, path.normalize(url.pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  })
  .listen(8800, () => console.log('harness on http://localhost:8800/watch?v=demo0000001'));
