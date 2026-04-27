/**
 * Database Seeder
 * Imports existing CSV data into MongoDB so the backend has real data to serve.
 *
 * Collections created:
 *   - claims         : from Task1_Cleaned_Dataset.csv (20,000 claims, source: "historical")
 *   - hospitals       : from hospital_tier_assignments.csv (35 hospitals)
 *   - model_results   : from Task3_Model_Results.csv (model predictions)
 *
 * Usage: npm run seed
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { connectDB, closeDB } from './connection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

// ── CSV file paths ──────────────────────────────────────────
const FILES = {
  claims: [
    resolve(ROOT, 'workspace', 'notebooks', 'Task1_Cleaned_Dataset.csv'),
    resolve(ROOT, 'data', 'raw', 'UMACT_HACKATHON_2026_FINALVERSION.csv'),
  ],
  hospitals: [
    resolve(ROOT, 'data', 'output', 'hospital_tier_assignments.csv'),
    resolve(ROOT, 'workspace', 'notebooks', 'Task1_Hospital_Tier_Classification.csv'),
  ],
  modelResults: [
    resolve(ROOT, 'workspace', 'notebooks', 'Task3_Model_Results.csv'),
  ],
  combinedSummary: [
    resolve(ROOT, 'workspace', 'notebooks', 'Task3_Combined_Summary.csv'),
  ],
}

function findFirstExisting(paths) {
  for (const p of paths) {
    try {
      readFileSync(p) // Check if readable
      return p
    } catch { /* skip */ }
  }
  return null
}

function loadCSV(filePath, maxRows = null) {
  const raw = readFileSync(filePath, 'utf-8')
  let records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: (value, context) => {
      if (value === '' || value === 'NA' || value === 'NaN') return null
      // Try numeric conversion for non-header rows
      if (!context.header) {
        const num = Number(value)
        if (!isNaN(num) && value !== '') return num
      }
      return value
    }
  })
  if (maxRows) records = records.slice(0, maxRows)
  return records
}

async function seedCollection(db, name, data, extraFields = {}) {
  if (!data || data.length === 0) {
    console.log(`  ⏭️  ${name}: No data to seed, skipping.`)
    return
  }

  // Drop existing collection
  try { await db.collection(name).drop() } catch { /* collection may not exist */ }

  // Add metadata to each record
  const enriched = data.map(record => ({
    ...record,
    ...extraFields,
    _imported_at: new Date(),
  }))

  const result = await db.collection(name).insertMany(enriched)
  console.log(`  ✅ ${name}: Inserted ${result.insertedCount} documents.`)
}

async function createIndexes(db) {
  // Claims indexes
  await db.collection('claims').createIndex({ hospital_name: 1 })
  await db.collection('claims').createIndex({ sub_category: 1 })
  await db.collection('claims').createIndex({ region: 1 })
  await db.collection('claims').createIndex({ hospital_type: 1 })
  await db.collection('claims').createIndex({ source: 1 })

  // Hospitals index
  await db.collection('hospitals').createIndex({ hospital_name: 1 }, { unique: true })

  // Users index
  await db.collection('users').createIndex({ firebase_uid: 1 }, { unique: true, sparse: true })

  console.log('  ✅ Indexes created.')
}

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('UMACT Hackathon — Database Seeder')
  console.log('═══════════════════════════════════════════')

  const db = await connectDB()

  // ── Seed Claims ──────────────────────────────────────────
  console.log('\n📋 Seeding claims...')
  const claimsPath = findFirstExisting(FILES.claims)
  if (claimsPath) {
    console.log(`  Source: ${claimsPath}`)
    const claims = loadCSV(claimsPath)
    await seedCollection(db, 'claims', claims, { source: 'historical' })
  } else {
    console.log('  ⚠️  No claims CSV found.')
  }

  // ── Seed Hospitals ───────────────────────────────────────
  console.log('\n🏥 Seeding hospitals...')
  const hospPath = findFirstExisting(FILES.hospitals)
  if (hospPath) {
    console.log(`  Source: ${hospPath}`)
    const hospitals = loadCSV(hospPath)
    await seedCollection(db, 'hospitals', hospitals)
  } else {
    console.log('  ⚠️  No hospital tier CSV found.')
  }

  // ── Seed Model Results ───────────────────────────────────
  console.log('\n📊 Seeding model results...')
  const modelPath = findFirstExisting(FILES.modelResults)
  if (modelPath) {
    console.log(`  Source: ${modelPath}`)
    const results = loadCSV(modelPath)
    await seedCollection(db, 'model_results', results)
  } else {
    console.log('  ⚠️  No model results CSV found.')
  }

  // ── Seed Combined Summary ────────────────────────────────
  console.log('\n📋 Seeding policy summary...')
  const summaryPath = findFirstExisting(FILES.combinedSummary)
  if (summaryPath) {
    console.log(`  Source: ${summaryPath}`)
    const summary = loadCSV(summaryPath)
    await seedCollection(db, 'policy_summary', summary)
  } else {
    console.log('  ⚠️  No combined summary CSV found.')
  }

  // ── Create Indexes ───────────────────────────────────────
  console.log('\n🔑 Creating indexes...')
  await createIndexes(db)

  // ── Final Stats ──────────────────────────────────────────
  console.log('\n📊 Final collection stats:')
  for (const name of ['claims', 'hospitals', 'model_results', 'policy_summary']) {
    try {
      const count = await db.collection(name).countDocuments()
      console.log(`  ${name}: ${count.toLocaleString()} documents`)
    } catch { console.log(`  ${name}: (empty)`) }
  }

  await closeDB()
  console.log('\n✅ Seeding complete!')
}

main().catch(err => {
  console.error('❌ Seed failed:', err)
  process.exit(1)
})
