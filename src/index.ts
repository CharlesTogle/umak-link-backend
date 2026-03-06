import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { errorHandler } from './middleware/error-handler.js';
import logger, { loggerOptions } from './utils/logger.js';

// Import routes
import authRoutes from './routes/auth.js';
import postsRoutes from './routes/posts.js';
import claimsRoutes from './routes/claims.js';
import fraudReportsRoutes from './routes/fraud-reports.js';
import searchRoutes from './routes/search.js';
import notificationsRoutes from './routes/notifications.js';
import announcementsRoutes from './routes/announcements.js';
import jobsRoutes from './routes/jobs.js';
import storageRoutes from './routes/storage.js';
import usersRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import itemsRoutes from './routes/items.js';
import pendingMatchesRoutes from './routes/pending-matches.js';
import emailRoutes from './routes/email.js';
import aiRoutes from './routes/ai.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const isDevelopment = process.env.NODE_ENV !== 'production';
const ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS ||
  (isDevelopment ? 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173' : '');
const ALLOWED_ORIGIN_LIST = ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function validateStartupConfig() {
  if (!process.env.GOOGLE_CLIENT_ID) {
    logger.error('Missing GOOGLE_CLIENT_ID. Google authentication will fail.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    logger.error('Missing JWT_SECRET. Server startup will fail where JWT is required.');
  } else if (jwtSecret.length < 32 || jwtSecret === 'replace_with_strong_secret') {
    logger.warn('JWT_SECRET appears weak or default. Use a long random secret in non-local environments.');
  }

  if (ALLOWED_ORIGIN_LIST.length === 0) {
    logger.error('Missing ALLOWED_ORIGINS. Configure comma-separated allowed origins.');
  }

  if (ALLOWED_ORIGIN_LIST.includes('*')) {
    logger.error('ALLOWED_ORIGINS contains *. This is not allowed for authenticated APIs.');
  }
}

validateStartupConfig();

const server = Fastify({
  logger: loggerOptions,
  trustProxy: true,
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'reqId',
});

// Register plugins
await server.register(helmet, {
  contentSecurityPolicy: false,
});

await server.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (ALLOWED_ORIGIN_LIST.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS origin not allowed'), false);
  },
  credentials: true,
});

await server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// Health check route
server.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
});

// Register routes
await server.register(authRoutes, { prefix: '/auth' });
await server.register(postsRoutes, { prefix: '/posts' });
await server.register(claimsRoutes, { prefix: '/claims' });
await server.register(fraudReportsRoutes, { prefix: '/fraud-reports' });
await server.register(searchRoutes, { prefix: '/search' });
await server.register(notificationsRoutes, { prefix: '/notifications' });
await server.register(announcementsRoutes, { prefix: '/announcements' });
await server.register(jobsRoutes, { prefix: '/jobs' });
await server.register(storageRoutes, { prefix: '/storage' });
await server.register(usersRoutes, { prefix: '/users' });
await server.register(adminRoutes, { prefix: '/admin' });
await server.register(itemsRoutes, { prefix: '/items' });
await server.register(pendingMatchesRoutes, { prefix: '/pending-matches' });
await server.register(emailRoutes, { prefix: '/email' });
await server.register(aiRoutes, { prefix: '/ai' });

// Error handler
server.setErrorHandler(errorHandler);

// Start server
try {
  await server.listen({ port: PORT, host: HOST });
  logger.info(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
  logger.error({ error: err }, 'Error starting server');
  process.exit(1);
}

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, closing server...`);
    await server.close();
    process.exit(0);
  });
});
