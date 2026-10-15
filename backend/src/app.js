import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { sessionMiddleware } from './middleware/auth.js';
import { accessLog, csrfGuard, errorHandler, notFoundHandler } from './middleware/common.js';
import authRoutes from './routes/auth.js';
import trackerRoutes from './routes/tracker.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import importRoutes from './routes/imports.js';
import brandingRoutes from './routes/branding.js';
import approvalRoutes from './routes/approvals.js';
import systemRoutes, { health } from './routes/system.js';

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

  const api = express.Router();
  api.use(express.json({ limit: '5mb' }));
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
  api.use('/system', systemRoutes);
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
