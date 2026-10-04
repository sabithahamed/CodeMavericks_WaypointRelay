import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import { HttpError, requireAuth, signToken, type AuthUser } from './auth.js';
import { one, q } from './db.js';
import { dispatch } from './routes/dispatch.js';
import { driver, loader } from './routes/field.js';
import { store } from './routes/store.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', async (_req, res) => {
    await q('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { email, password } = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
      const u = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
      if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
      const user: AuthUser = { id: u.id, email: u.email, role: u.role, name: u.name, depot: u.depot, outlet_id: u.outlet_id, vehicle_id: u.vehicle_id };
      res.json({ token: signToken(user), user });
    } catch (e) {
      next(e);
    }
  });

  app.use('/api', requireAuth);
  app.get('/api/me', (req, res) => res.json({ user: req.user }));
  app.get('/api/orders/:id/events', async (req, res, next) => {
    try {
      const order = await one('SELECT outlet_id FROM orders WHERE id = $1', [req.params.id]);
      if (!order) throw new HttpError(404, 'Order not found.');
      if (req.user.role === 'store' && order.outlet_id !== req.user.outlet_id) throw new HttpError(403, 'Not your outlet.');
      res.json({ events: await q('SELECT * FROM events WHERE order_id = $1 ORDER BY at', [req.params.id]) });
    } catch (e) {
      next(e);
    }
  });
  app.use('/api/dispatch', dispatch);
  app.use('/api/loader', loader);
  app.use('/api/driver', driver);
  app.use('/api/store', store);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Serve the built web app (single deployable unit).
  const web = process.env.WEB_DIST ?? resolve(here, '../../web/dist');
  if (existsSync(web)) {
    app.use(express.static(web, { index: false, maxAge: '1h', setHeaders: (res, p) => p.endsWith('sw.js') && res.setHeader('Cache-Control', 'no-cache') }));
    app.get('*', (_req, res) => res.sendFile(resolve(web, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid request.', issues: err.issues });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.details as object) });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Your input was not saved.' });
  });
  return app;
}
