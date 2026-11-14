import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Forward /api/kiosk/* to the kiosk backend. The browser can't call it directly because
 * the backend doesn't send CORS headers; same-origin requests through here avoid that.
 * (During `ng serve`, proxy.conf.json does the same job.)
 */
const KIOSK_API = process.env['KIOSK_API'] || 'http://192.168.10.94:18080';

app.use('/api/kiosk', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body);
    const upstream = await fetch(KIOSK_API + req.originalUrl, {
      method: req.method,
      headers: { 'content-type': req.get('content-type') ?? 'application/json' },
      body: hasBody ? req.body : undefined,
    });
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('Kiosk API unreachable', err);
    res.status(502).json({ error: 'Kiosk API unreachable' });
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
