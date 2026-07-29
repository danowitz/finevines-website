// Minimal static file server for the built site, so browser tests drive the
// REAL dist/ output over http:// rather than file:// URLs. That matters: the
// portfolio's catalog-index arrives via fetch(), which file:// blocks outright,
// and history.pushState — which portfolio.js uses for all URL state — behaves
// differently on file://. Serving over loopback is the only way the tests
// exercise what a visitor actually gets.
//
// Zero dependencies: node:http + node:fs. Directory URLs resolve to
// index.html, mirroring how Bunny.net serves the storage zone in production,
// so /portfolio/ and /portfolio/page/3/ work in tests exactly as they do live.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// serve starts a loopback server over `root` on an ephemeral port and resolves
// to { origin, close }. Ephemeral (port 0) so parallel test files never collide
// on a fixed port.
export function serve(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // Strip the query string (portfolio.js puts all its state there) and
      // normalise away any ../ before touching the filesystem.
      let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const rel = normalize(pathname).replace(/^[\\/]+/, '');
      const file = join(root, rel);

      // Path traversal guard: the resolved file must still sit under root.
      if (!join(root).length || !file.startsWith(join(root))) {
        res.writeHead(403).end('forbidden');
        return;
      }

      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': TYPES[extname(file)] || 'application/octet-stream',
          // Tests must never see a cached response from a previous build.
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
