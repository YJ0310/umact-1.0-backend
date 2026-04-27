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
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:4173'],
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
