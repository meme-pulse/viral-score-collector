import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { scoreRoutes } from './routes/score';
import { merkleRoutes } from './routes/merkle';
import { startScheduler, stopScheduler, getSchedulerStatus } from './jobs/scheduler';
import { websocketHandlers, getWebSocketStats } from './ws/stream';
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
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      scores: '/api/score',
      merkle: '/api/merkle',
      websocket: '/ws',
    },
  });
});

// Health check with details
app.get('/health', async (c) => {
  const dbHealthy = await checkDatabaseConnection();
  const schedulerStatus = getSchedulerStatus();
  const wsStats = getWebSocketStats();

  return c.json({
    status: dbHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbHealthy ? 'connected' : 'disconnected',
    scheduler: schedulerStatus,
    websocket: wsStats,
  });
});

// API Routes
app.route('/api/score', scoreRoutes);
app.route('/api/merkle', merkleRoutes);

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

// Global server instance for WebSocket upgrades (set by Bun's HMR)
declare global {
  var __serverInstance: ReturnType<typeof Bun.serve> | undefined;
}

// Create fetch handler that wraps app.fetch and handles WebSocket upgrades
function createFetchHandler(server: ReturnType<typeof Bun.serve>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Handle WebSocket upgrades
    if (url.pathname === '/ws') {
      const success = server.upgrade(request, {
        data: {
          subscribedPools: new Set<string>(),
          subscribeAll: false,
        },
      });
      if (success) {
        return undefined as any; // Bun handles the response
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // Handle regular HTTP requests
    return app.fetch(request);
  };
}

// Initialize database connection and start scheduler (only once)
let initialized = false;
async function initialize() {
  if (initialized) return;
  initialized = true;

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    VIRAL SCORE SERVER                          ║
║                        v1.0.0                                  ║
╠═══════════════════════════════════════════════════════════════╣
║  Collecting social data from Memex                            ║
║  Calculating viral scores for DeFi pools                      ║
║  Providing signed scores for on-chain verification            ║
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

  // Start scheduler (includes initial backfill)
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

// Server configuration
// Bun will automatically start the server with this config (both in dev and production)
const serverConfig = {
  port: PORT,
  fetch: (request: Request, server: ReturnType<typeof Bun.serve>) => {
    // Store server instance globally for WebSocket upgrades
    globalThis.__serverInstance = server;
    // Use the fetch handler that wraps app.fetch
    return createFetchHandler(server)(request);
  },
  websocket: websocketHandlers,
};

console.log(`[Server] 🚀 HTTP server running on http://localhost:${PORT}`);
console.log(`[Server] 🔌 WebSocket server running on ws://localhost:${PORT}/ws`);
console.log('[Server] Ready to collect viral scores!');

// Export server config - Bun will automatically start the server
// In watch mode, Bun's HMR will manage server restarts
export default serverConfig;
