/**
 * ═══════════════════════════════════════════════════════════
 * UMACT Hackathon 2026 — RiskByte Backend API
 * ═══════════════════════════════════════════════════════════
 * Express server with MongoDB Atlas, file upload (multer),
 * and API routes for customer, analytics, and insurer actions.
 *
 * Start: npm run dev   (with --watch for auto-reload)
 * Seed:  npm run seed  (import CSVs into MongoDB)
 * ═══════════════════════════════════════════════════════════
 */
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { connectDB, closeDB } from './db/connection.js'
import customerRoutes from './routes/customer.js'
import analyticsRoutes from './routes/analytics.js'

const app = express()
const PORT = process.env.PORT || 3001

// ── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:4173',
    'https://umact-1-0-frontend.vercel.app',
    'https://umact-hackathon.vercel.app'
  ],
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ── Request logging ─────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const color = res.statusCode < 400 ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${color}${req.method}\x1b[0m ${req.path} → ${res.statusCode} (${duration}ms)`)
  })
  next()
})

// ── Lazy reconnect middleware ───────────────────────────────
app.use('/api/customer', async (req, res, next) => {
  try { const { getDB } = await import('./db/connection.js'); getDB(); next() }
  catch { try { await connectDB(); next() } catch(e) { res.status(503).json({ success: false, error: 'Database unavailable. Please try again.' }) } }
})
app.use('/api/analytics', async (req, res, next) => {
  try { const { getDB } = await import('./db/connection.js'); getDB(); next() }
  catch { try { await connectDB(); next() } catch(e) { res.status(503).json({ success: false, error: 'Database unavailable. Please try again.' }) } }
})

// ── API Routes ──────────────────────────────────────────────
app.use('/api/customer', customerRoutes)
app.use('/api/analytics', analyticsRoutes)

// ── API Root Landing Page ──────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>UMACT RiskByte API — Service Status</title>
      <style>
        :root {
          --bg: #0f172a;
          --card: #1e293b;
          --accent: #38bdf8;
          --success: #10b981;
          --text: #f8fafc;
          --text-dim: #94a3b8;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: var(--bg);
          color: var(--text);
          font-family: 'Inter', -apple-system, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 2rem;
        }
        .container {
          max-width: 640px;
          width: 100%;
          text-align: center;
        }
        .card {
          background: var(--card);
          padding: 3rem;
          border-radius: 1.5rem;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(10px);
          position: relative;
          overflow: hidden;
          animation: slideUp 0.6s ease-out;
        }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0; height: 4px;
          background: linear-gradient(90deg, var(--accent), var(--success));
        }
        h1 { font-size: 2.25rem; font-weight: 800; margin-bottom: 0.5rem; letter-spacing: -0.025em; }
        .badge {
          display: inline-flex;
          align-items: center;
          background: rgba(16, 185, 129, 0.1);
          color: var(--success);
          padding: 0.5rem 1rem;
          border-radius: 9999px;
          font-weight: 600;
          font-size: 0.875rem;
          margin-bottom: 2rem;
        }
        .dot { width: 8px; height: 8px; background: currentColor; border-radius: 50%; margin-right: 0.75rem; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        
        p { color: var(--text-dim); margin-bottom: 2rem; line-height: 1.6; }
        
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; text-align: left; }
        .stat-card {
          background: rgba(15, 23, 42, 0.5);
          padding: 1.25rem;
          border-radius: 1rem;
          border: 1px solid rgba(255,255,255,0.05);
        }
        .label { font-size: 0.75rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; margin-bottom: 0.25rem; }
        .val { font-size: 1.125rem; font-weight: 600; font-family: monospace; color: var(--accent); }
        
        .footer { margin-top: 3rem; font-size: 0.875rem; color: var(--text-dim); }
        a { color: var(--accent); text-decoration: none; font-weight: 600; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <h1>RiskByte API</h1>
          <div class="badge"><div class="dot"></div> System Operational</div>
          
          <p>The UMACT Hackathon 2026 Core Engine is running. This server handles actuarial modeling, claims processing, and hospital analytics.</p>
          
          <div class="grid">
            <div class="stat-card">
              <div class="label">Status</div>
              <div class="val">200 OK</div>
            </div>
            <div class="stat-card">
              <div class="label">Version</div>
              <div class="val">v1.0.0</div>
            </div>
            <div class="stat-card">
              <div class="label">Uptime</div>
              <div class="val">Live</div>
            </div>
            <div class="stat-card">
              <div class="label">Deployment</div>
              <div class="val">Vercel</div>
            </div>
          </div>
          
          <div class="footer">
            Powered by <a href="https://umact-1-0-frontend.vercel.app">UMACT Dashboard</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `)
})

// ── Health check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'umact-riskbyte-api',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  })
})

// ── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('  ❌ Unhandled error:', err.message)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large. Maximum 10 MB per file.' })
  }
  if (err.message && err.message.includes('Only PDF')) {
    return res.status(400).json({ success: false, error: err.message })
  }
  res.status(500).json({ success: false, error: 'Internal server error' })
})

// ── Start server ────────────────────────────────────────────
async function start() {
  console.log('═══════════════════════════════════════════')
  console.log('  UMACT Hackathon 2026 — RiskByte API')
  console.log('═══════════════════════════════════════════')

  // Connect to MongoDB (non-fatal on failure)
  try {
    await connectDB()
  } catch (err) {
    console.warn(`  ⚠️  MongoDB not available: ${err.message}`)
    console.warn('  ⚠️  Server will start but DB routes will fail until reconnected.')
    console.warn('  💡  Try running "npm run seed" once network is available.\n')
  }

  app.listen(PORT, () => {
    console.log(`\n  🚀 API running at http://localhost:${PORT}`)
    console.log(`  📋 Health:     http://localhost:${PORT}/api/health`)
    console.log(`  👤 Customer:   http://localhost:${PORT}/api/customer`)
    console.log(`  📊 Analytics:  http://localhost:${PORT}/api/analytics`)
    console.log('═══════════════════════════════════════════\n')
  })
}

// ── Graceful shutdown ───────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...')
  await closeDB()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await closeDB()
  process.exit(0)
})

start().catch(err => {
  console.error('❌ Server failed to start:', err)
  process.exit(1)
})
