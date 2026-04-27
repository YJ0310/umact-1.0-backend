/**
 * Customer API Routes
 * Handles: quote calculation, claims, medical checkup uploads, profile
 */
import { Router } from 'express'
import multer from 'multer'
import { getDB } from '../db/connection.js'
import { ObjectId } from 'mongodb'

const router = Router()

// ── File upload config (medical checkup & claim receipts) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Only PDF, JPG, PNG, WebP files are allowed'))
  }
})

// ── Premium calculation (mirrors frontend logic) ────────────
function calculatePremium(data) {
  const basePremiums = { Basic: 2400, Silver: 4800, Gold: 7800, Platinum: 14400 }
  let premium = basePremiums[data.planType] || 4800

  const age = data.age || 30
  const ageScore = Math.min(age / 84, 1)
  premium *= (1 + ageScore * 0.75)

  const avgBmi = data.avgBmi || 24
  if (avgBmi >= 30 && avgBmi < 40) premium *= 1.12
  else if (avgBmi >= 40) premium *= 1.28

  if (data.smoker) premium *= 1.18

  const condCount = data.conditionCount || 0
  premium *= (1 + condCount * 0.10)

  const regionFactors = { Central: 1.12, Southern: 1.0, Northern: 0.96, Eastern: 0.92, 'East Malaysia': 0.88 }
  premium *= regionFactors[data.region] || 1.0

  const annual = Math.round(premium)
  return { monthly: Math.round(annual / 12), annual }
}

// ═════════════════════════════════════════════════════════════
// POST /api/customer/quote — Calculate premium estimate
// ═════════════════════════════════════════════════════════════
router.post('/quote', async (req, res) => {
  try {
    const { dobYear, dobMonth, dobDay, gender, heightRange, weightRange, smoker, conditions, state, region, planType } = req.body

    // Calculate age from DOB
    const today = new Date()
    const dob = new Date(dobYear, dobMonth - 1, dobDay)
    let age = today.getFullYear() - dob.getFullYear()
    const mDiff = today.getMonth() - dob.getMonth()
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < dob.getDate())) age--

    // Calculate avg BMI from ranges
    const avgBmi = heightRange && weightRange
      ? (weightRange.min + weightRange.max) / 2 / ((((heightRange.min + heightRange.max) / 2) / 100) ** 2)
      : 24

    const condCount = conditions ? conditions.filter(c => c !== 'none').length : 0
    const premiums = calculatePremium({ age, avgBmi, smoker: smoker === 'Yes', conditionCount: condCount, region, planType })

    // Store quote in DB
    const db = getDB()
    const quoteDoc = {
      firebaseUid: req.body.firebaseUid || null,
      dob: dob.toISOString(),
      age, gender,
      heightRange, weightRange, avgBmi: Math.round(avgBmi * 10) / 10,
      smoker, conditions, conditionCount: condCount,
      state, region, planType,
      premiums,
      verified: false,
      source: 'app',
      created_at: new Date()
    }
    const result = await db.collection('quotes').insertOne(quoteDoc)

    res.json({
      success: true,
      quoteId: result.insertedId,
      premiums,
      age,
      avgBmi: Math.round(avgBmi * 10) / 10
    })
  } catch (err) {
    console.error('Quote error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// POST /api/customer/checkup — Upload medical checkup files
// ═════════════════════════════════════════════════════════════
router.post('/checkup', upload.array('files', 5), async (req, res) => {
  try {
    const files = req.files
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' })
    }

    const db = getDB()
    const { quoteId, firebaseUid } = req.body

    // Store checkup record (files stored as metadata — actual files go to Firebase Storage)
    const checkupDoc = {
      quoteId: quoteId ? new ObjectId(quoteId) : null,
      firebaseUid: firebaseUid || null,
      files: files.map(f => ({
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        // In production: upload to Firebase Storage and store the URL
        storagePath: `checkups/${Date.now()}_${f.originalname}`
      })),
      status: 'pending_review', // pending_review → verified → expired
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 12 months
      submitted_at: new Date()
    }
    const result = await db.collection('checkups').insertOne(checkupDoc)

    res.json({
      success: true,
      checkupId: result.insertedId,
      fileCount: files.length,
      validUntil: checkupDoc.validUntil,
      message: 'Medical checkup uploaded. Verification usually takes 1-2 business days.'
    })
  } catch (err) {
    console.error('Checkup upload error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// POST /api/customer/claim — Submit a new insurance claim
// ═════════════════════════════════════════════════════════════
router.post('/claim', upload.array('receipts', 5), async (req, res) => {
  try {
    const { firebaseUid, hospitalId, hospitalName, admissionType, admissionDate, claimAmount, description, planType } = req.body

    const db = getDB()

    // Look up hospital tier for co-payment calculation
    let hospitalTier = 2
    if (hospitalId) {
      const hosp = await db.collection('hospitals').findOne({ _id: new ObjectId(hospitalId) })
      if (hosp && hosp.tier) hospitalTier = hosp.tier
    }

    // Calculate co-payment (min(20% × claim, RM 3,000))
    const amount = parseFloat(claimAmount) || 0
    const copayment = Math.min(amount * 0.20, 3000)
    const insurerPays = amount - copayment

    // Get user's remaining balance (sum of approved claims this year)
    const yearStart = new Date(new Date().getFullYear(), 0, 1)
    const usedThisYear = await db.collection('claims_submitted').aggregate([
      { $match: { firebaseUid, status: 'approved', submitted_at: { $gte: yearStart } } },
      { $group: { _id: null, total: { $sum: '$claimAmount' } } }
    ]).toArray()
    const totalUsed = usedThisYear[0]?.total || 0
    const annualLimit = { Basic: 50000, Silver: 80000, Gold: 100000, Platinum: 150000 }[planType] || 100000
    const remaining = annualLimit - totalUsed

    const claimDoc = {
      firebaseUid: firebaseUid || null,
      hospitalId, hospitalName, hospitalTier,
      admissionType, admissionDate,
      claimAmount: amount, copayment, insurerPays,
      description,
      planType,
      annualLimit, totalUsedBefore: totalUsed, remainingBefore: remaining,
      receipts: (req.files || []).map(f => ({
        originalName: f.originalname, mimeType: f.mimetype, size: f.size,
        storagePath: `claims/${Date.now()}_${f.originalname}`
      })),
      status: 'pending', // pending → under_review → approved → rejected
      refNumber: `CLM-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
      source: 'app',
      submitted_at: new Date()
    }
    const result = await db.collection('claims_submitted').insertOne(claimDoc)

    res.json({
      success: true,
      claimId: result.insertedId,
      refNumber: claimDoc.refNumber,
      claimAmount: amount,
      copayment,
      insurerPays,
      hospitalTier,
      remainingBalance: remaining - amount,
      message: 'Claim submitted successfully.'
    })
  } catch (err) {
    console.error('Claim submit error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// POST /api/customer/login — Handle Google Auth and return dashboard data
// ═════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { sub: uid, email, name, given_name, picture } = req.body
    if (!uid) return res.status(400).json({ success: false, error: 'Missing UID' })
    const db = getDB()

    // Get or Create user profile
    let user = await db.collection('users').findOne({ firebase_uid: uid })
    if (!user) {
      user = {
        firebase_uid: uid,
        email, name, given_name, picture,
        planType: 'Basic', // Default to Basic until Insurer approves a quote
        annualLimit: 50000,
        created_at: new Date(),
        source: 'app'
      }
      await db.collection('users').insertOne(user)
    } else {
      // Update with latest Google info
      await db.collection('users').updateOne(
        { firebase_uid: uid },
        { $set: { email, name, given_name, picture, last_login: new Date() } }
      )
      user.name = name
      user.email = email
      user.picture = picture
    }

    // Get claims history
    const claims = await db.collection('claims_submitted')
      .find({ firebaseUid: uid })
      .sort({ submitted_at: -1 })
      .limit(20)
      .toArray()

    // Calculate usage
    const yearStart = new Date(new Date().getFullYear(), 0, 1)
    const approvedClaims = await db.collection('claims_submitted').aggregate([
      { $match: { firebaseUid: uid, status: { $in: ['approved', 'pending'] }, submitted_at: { $gte: yearStart } } },
      { $group: { _id: null, total: { $sum: '$claimAmount' } } }
    ]).toArray()
    const totalUsed = approvedClaims[0]?.total || 0
    const annualLimit = user.annualLimit || 50000

    // Get checkup status
    const latestCheckup = await db.collection('checkups')
      .findOne({ firebaseUid: uid }, { sort: { submitted_at: -1 } })

    res.json({
      success: true,
      user: {
        name: user.name,
        email: user.email,
        planType: user.planType || 'Basic',
        annualLimit,
        totalUsed,
        remaining: annualLimit - totalUsed,
        copaymentCap: 3000,
      },
      claims,
      checkup: latestCheckup ? {
        status: latestCheckup.status,
        validUntil: latestCheckup.validUntil,
        isExpired: new Date() > new Date(latestCheckup.validUntil)
      } : null
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/customer/hospitals — List hospitals for claim form
// ═════════════════════════════════════════════════════════════
router.get('/hospitals/list', async (req, res) => {
  try {
    const db = getDB()
    const hospitals = await db.collection('hospitals')
      .find({})
      .project({ hospital_name: 1, tier: 1, region: 1 })
      .sort({ hospital_name: 1 })
      .toArray()

    res.json({ success: true, hospitals })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// PUT /api/customer/:uid/plan — Change plan
// ═════════════════════════════════════════════════════════════
router.put('/:uid/plan', async (req, res) => {
  try {
    const { uid } = req.params
    const { newPlan } = req.body
    const validPlans = ['Basic', 'Silver', 'Gold', 'Platinum']
    if (!validPlans.includes(newPlan)) {
      return res.status(400).json({ success: false, error: 'Invalid plan type' })
    }

    const limits = { Basic: 50000, Silver: 80000, Gold: 100000, Platinum: 150000 }
    const db = getDB()
    await db.collection('users').updateOne(
      { firebase_uid: uid },
      { $set: { planType: newPlan, annualLimit: limits[newPlan], updated_at: new Date() } }
    )

    res.json({ success: true, planType: newPlan, annualLimit: limits[newPlan] })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
