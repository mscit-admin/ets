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
import presenceRoutes from './routes/presence.js';
import dashboardRoutes from './routes/dashboard.js';
import backupRoutes from './routes/backups.js';
import releaseRoutes from './routes/release.js';
import messageRoutes from './routes/messages.js';
import countRoutes from './routes/counts.js';
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

  // The Android app (1.9.0, routes/mobile.js): pairing without a session, and /api/m/* with a device token
  // (Authorization: Bearer) only. Mounted before the web API: no cookie is read there, and the web API never
  // accepts a device token (it reads only the session cookie). These paths resolve no session, so the general
  // ceiling keys them by IP (ETS-SEC-003); pairing additionally has its own tight per-IP limit (PAIR_RATE_LIMIT).
  app.use('/api/devices/pair', apiLimiter, pairRouter);
  app.use('/api/m', apiLimiter, mobileRouter);

  const api = express.Router();
  api.use(jsonBody);       // 100 kB; file uploads are parsed inside their routes after auth (middleware/body.js)
  api.use(cookieParser());
  api.use(sessionMiddleware);
  // General request ceiling, AFTER sessionMiddleware so req.user is known: per authenticated user, else per IP
  // (ETS-SEC-003). A shared-office NAT address no longer puts the whole office in one bucket.
  api.use(apiLimiter);
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
  api.use('/presence', presenceRoutes);            // online users: own reports, the administrators' list (1.11.0)
  api.use('/dashboard', dashboardRoutes);          // dashboard aggregates: users overview (admins only, 1.12.9)
  api.use('/backups', backupRoutes);               // Settings → «النسخ الاحتياطي»: configuration, jobs, restore (1.12.0)
  api.use('/release', releaseRoutes);              // Settings → «الترقية والنشر»: promotion intent (Phase 1, 1.12.18)
  api.use('/messages', messageRoutes);             // in-app messaging: compose, inbox, sent, threads, replies (1.12.26)
  api.use('/counts', countRoutes);                 // consolidated sidebar badge counts (1.12.30)
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
