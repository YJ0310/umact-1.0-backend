/**
 * MongoDB Connection Manager
 * Singleton connection to MongoDB Atlas for the UMACT Hackathon DB.
 */
import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
const dbName = process.env.MONGODB_DB || 'umact_hackathon'

let client = null
let db = null

/**
 * Connect to MongoDB Atlas and return the database instance.
 * Reuses existing connection if already connected.
 */
export async function connectDB() {
  if (db) return db

  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      retryWrites: true,
      retryReads: true,
    })
    await client.connect()
    // Verify connection with a ping
    await client.db('admin').command({ ping: 1 })
    db = client.db(dbName)
    console.log(`  ✅ Connected to MongoDB: ${dbName}`)
    return db
  } catch (err) {
    console.error('  ❌ MongoDB connection failed:', err.message)
    console.error('  💡 If DNS fails, check network or try a different connection string.')
    throw err
  }
}

/**
 * Get the database instance (must call connectDB first).
 */
export function getDB() {
  if (!db) throw new Error('Database not connected. Call connectDB() first.')
  return db
}

/**
 * Close the MongoDB connection gracefully.
 */
export async function closeDB() {
  if (client) {
    await client.close()
    db = null
    client = null
    console.log('  🔌 MongoDB connection closed.')
  }
}
