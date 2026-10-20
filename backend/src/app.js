import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { sessionMiddleware } from './middleware/auth.js';
import { accessLog, csrfGuard, errorHandler, notFoundHandler } from './middleware/common.js';
import { jsonBody } from './middleware/body.js';
import authRoutes from './routes/auth.js';
import trackerRoutes from './routes/tracker.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import importRoutes from './routes/imports.js';
import brandingRoutes from './routes/branding.js';
import approvalRoutes from './routes/approvals.js';
import exportRoutes from './routes/export.js';
import eventRoutes from './routes/events.js';
import systemRoutes, { health } from './routes/system.js';
import notificationRoutes from './routes/notifications.js';
import deviceRoutes from './routes/devices.js';
import { pairRouter, mobileRouter } from './routes/mobile.js';
import { apiLimiter } from './middleware/ratelimit.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.security.trustProxy);
  app.use(helmet({
    strictTransportSecurity: false,   // HSTS is sent by nginx
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"],
        // only ask browsers to upgrade to HTTPS when the site is actually served over HTTPS
        upgradeInsecureRequests: config.session.secure ? [] : null },
    },
  }));
  app.get('/api/health', health);
  app.use('/api', apiLimiter);   // general per-IP request ceiling (ETS-SEC-003)

  // The Android app (1.9.0, routes/mobile.js): pairing without a session, and /api/m/* with a device token
  // (Authorization: Bearer) only. Mounted before the web API: no cookie is read there, and the web API never
  // accepts a device token (it reads only the session cookie).
  app.use('/api/devices/pair', pairRouter);
  app.use('/api/m', mobileRouter);

  const api = express.Router();
  api.use(jsonBody);       // 100 kB; file uploads are parsed inside their routes after auth (middleware/body.js)
  api.use(cookieParser());
  api.use(sessionMiddleware);
  api.use(accessLog);
  api.use(csrfGuard);
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use('/auth', authRoutes);
  api.use('/tracker', trackerRoutes);
  api.use('/users', userRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/logs', logRoutes);
  api.use('/imports', importRoutes);
  api.use('/branding', brandingRoutes);
  api.use('/approvals', approvalRoutes);
  api.use('/export', exportRoutes);
  api.use('/system', systemRoutes);
  api.use('/events', eventRoutes);   // live updates (Server-Sent Events)
  api.use('/notifications', notificationRoutes);   // the bell, history, preferences (1.9.0)
  api.use('/devices', deviceRoutes);               // own phones: pairing code, list, revoke (1.9.0)
  api.use(notFoundHandler);
  app.use('/api', api);

  // Optional: serve the built frontend (in production nginx serves it directly).
  if (config.staticDir && fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false, maxAge: '7d' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(config.staticDir, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
