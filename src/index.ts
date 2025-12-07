import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { scoreRoutes } from './routes/score';
import { startScheduler, stopScheduler, getSchedulerStatus } from './jobs/scheduler';
import { checkDatabaseConnection, closeDatabaseConnection } from './db/client';

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'Viral Score Server',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      scores: '/api/score',
    },
  });
});

// Health check with details
app.get('/health', async (c) => {
  const dbHealthy = await checkDatabaseConnection();
  const schedulerStatus = getSchedulerStatus();

  return c.json({
    status: dbHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbHealthy ? 'connected' : 'disconnected',
    scheduler: schedulerStatus,
  });
});

// API Routes
app.route('/api/score', scoreRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('[Server] Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Server configuration
const PORT = parseInt(process.env.PORT || '3001');

// Initialize database connection and start scheduler (only once)
let initialized = false;
async function initialize() {
  if (initialized) return;
  initialized = true;

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    VIRAL SCORE SERVER                          ║
║                        v2.0.0                                  ║
╠═══════════════════════════════════════════════════════════════╣
║  Collecting social data from Memex                            ║
║  Calculating viral scores for meme tokens                     ║
║  Submitting top performers to ViralScoreReporter              ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Initialize database connection check
  const dbConnected = await checkDatabaseConnection();
  if (!dbConnected) {
    console.error('[Server] ❌ Database connection failed!');
    console.error('[Server] Make sure DATABASE_URL is set correctly');
    process.exit(1);
  }
  console.log('[Server] ✅ Database connected');

  // Start scheduler
  startScheduler();
}

// Graceful shutdown handler
async function gracefulShutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  stopScheduler();
  await closeDatabaseConnection();
  console.log('[Server] Goodbye!');
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Initialize on module load
await initialize();

// Server configuration for Bun
const serverConfig = {
  port: PORT,
  fetch: app.fetch,
};

console.log(`[Server] 🚀 HTTP server running on http://localhost:${PORT}`);
console.log('[Server] Ready to collect viral scores!');

export default serverConfig;

