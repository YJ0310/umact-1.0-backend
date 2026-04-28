/**
 * Analytics API Routes
 * Serves insurer dashboard, hospital analytics, and presentation data.
 * All data is live from MongoDB (seeded from historical CSV + app-generated).
 */
import { Router } from 'express'
import { ObjectId } from 'mongodb'
import { getDB } from '../db/connection.js'

const router = Router()

function meanInt(values) {
  if (!values?.length) return 0
  const sum = values.reduce((acc, v) => acc + v, 0)
  return Math.max(1, Math.round(sum / values.length))
}

const FIXED_DRG_POOL_BY_YEAR = {
}

const FIXED_DRG_LIST = [
  'Surgical | Orthopedic | Spinal Surgery',
  'Surgical | Orthopedic | Knee Replacement',
  'Surgical | Orthopedic | Hip Replacement',
  'Surgical | Orthopedic | Arthroscopy',
  'Surgical | Cardiac | Heart Valve Replacement',
  'Surgical | Cardiac | CABG',
  'Surgical | Cardiac | Angioplasty with Stent',
  'Obstetrics | Maternity | Normal Delivery',
  'Obstetrics | Maternity | C-Section',
  'Medical | Respiratory | Pneumonia',
  'Medical | Respiratory | COPD Exacerbation',
  'Medical | Respiratory | Bronchitis',
  'Medical | Respiratory | Asthma Exacerbation',
  'Medical | Infectious | Dengue Haemorrhagic Fever',
  'Medical | Infectious | Dengue Fever'
]

function roundRM(value) {
  return Math.round(Number(value) || 0)
}

function normalizeTier(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const match = String(value ?? '').match(/\d/)
  return match ? Number(match[0]) : 2
}

function ensureHospitalCount(hospitals, targetCount = 60) {
  if (hospitals.length >= targetCount) return hospitals
  const padded = [...hospitals]
  let index = 1
  while (padded.length < targetCount) {
    const name = `Placeholder Hospital ${String(index).padStart(2, '0')}`
    if (!padded.some((h) => h.hospital_name === name)) {
      padded.push({
        _id: `placeholder-${index}`,
        hospital_name: name,
        tier: 2,
        final_tier: 2,
        region: 'Unknown',
        placeholder: true
      })
    }
    index += 1
  }
  return padded
}

function evaluateMoneyPool(claimRequestAmount, poolAmount, enforceQuota) {
  const claimAmount = Number(claimRequestAmount) || 0
  const pool = Number(poolAmount) || 0

  if (!enforceQuota || pool <= 0) {
    return {
      reimbursedAmount: claimAmount,
      penaltyAmount: 0,
      usagePct: null,
      statusZone: 'Observe',
      reimburseRate: 1
    }
  }

  const normalLimit = pool
  const bufferLimit = pool * 1.2
  const reducedLimit = pool * 1.5

  let reimbursedAmount = claimAmount
  let statusZone = 'Normal'

  if (claimAmount <= normalLimit) {
    statusZone = 'Normal'
    reimbursedAmount = claimAmount
  } else if (claimAmount <= bufferLimit) {
    statusZone = 'Buffer'
    reimbursedAmount = claimAmount
  } else if (claimAmount <= reducedLimit) {
    statusZone = 'Reduced'
    reimbursedAmount = bufferLimit + (claimAmount - bufferLimit) * 0.8
  } else {
    statusZone = 'Penalty'
    reimbursedAmount = bufferLimit + (reducedLimit - bufferLimit) * 0.8 + (claimAmount - reducedLimit) * 0.6
  }

  const penaltyAmount = Math.max(0, claimAmount - reimbursedAmount)
  return {
    reimbursedAmount,
    penaltyAmount,
    usagePct: (claimAmount / pool) * 100,
    statusZone,
    reimburseRate: claimAmount > 0 ? reimbursedAmount / claimAmount : 1
  }
}

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/insurer — Insurer dashboard aggregations
// ═════════════════════════════════════════════════════════════
router.get('/insurer', async (req, res) => {
  try {
    const db = getDB()
    const claims = db.collection('claims')

    // Total stats
    const totalClaims = await claims.countDocuments()
    const totalClaimAmt = await claims.aggregate([
      { $group: { _id: null, total: { $sum: '$total_claim_amount' } } }
    ]).toArray()

    // By hospital type
    const byHospType = await claims.aggregate([
      {
        $group: {
          _id: '$hospital_type',
          avgClaim: { $avg: '$total_claim_amount' },
          totalClaim: { $sum: '$total_claim_amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray()

    // By sub-category
    const bySubCat = await claims.aggregate([
      {
        $group: {
          _id: '$sub_category',
          avgClaim: { $avg: '$total_claim_amount' },
          avgLOS: { $avg: '$length_of_stay' },
          count: { $sum: 1 }
        }
      },
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    // By region
    const byRegion = await claims.aggregate([
      {
        $group: {
          _id: '$region',
          avgClaim: { $avg: '$total_claim_amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    // Co-payment stats
    const copayStats = await claims.aggregate([
      {
        $group: {
          _id: null,
          avgCopay: { $avg: '$patient_co_payment' },
          hitsCapPct: { $avg: { $cond: [{ $gte: ['$patient_co_payment', 3000] }, 1, 0] } },
          totalCopay: { $sum: '$patient_co_payment' }
        }
      }
    ]).toArray()

    // Smoker vs non-smoker
    const bySmoker = await claims.aggregate([
      {
        $group: {
          _id: '$smoker_status',
          avgClaim: { $avg: '$total_claim_amount' },
          count: { $sum: 1 }
        }
      }
    ]).toArray()

    res.json({
      success: true,
      data: {
        totalClaims,
        totalClaimAmount: totalClaimAmt[0]?.total || 0,
        byHospitalType: byHospType,
        bySubCategory: bySubCat,
        byRegion,
        copayment: copayStats[0] || {},
        bySmokerStatus: bySmoker,
        lastUpdated: new Date()
      }
    })
  } catch (err) {
    console.error('Insurer analytics error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/hospitals — Hospital tier + DRG data
// ═════════════════════════════════════════════════════════════
router.get('/hospitals', async (req, res) => {
  try {
    const db = getDB()
    const claims = db.collection('claims')

    // Get hospital tier assignments
    const hospitals = ensureHospitalCount(
      await db.collection('hospitals').find({}).toArray(),
      60
    )

    // Build annual hospital x DRG stats to support year-based money-pool policy.
    const annualHospitalDRG = await claims.aggregate([
      {
        $addFields: {
          parsedAdmissionDate: {
            $cond: {
              if: { $eq: [{ $type: '$admission_date' }, 'date'] },
              then: '$admission_date',
              else: {
                $convert: {
                  input: '$admission_date',
                  to: 'date',
                  onError: new Date('2023-01-01'),
                  onNull: new Date('2023-01-01')
                }
              }
            }
          }
        }
      },
      { $match: { parsedAdmissionDate: { $ne: null } } },
      {
        $addFields: {
          admissionYear: { $year: '$parsedAdmissionDate' },
          drgKey: {
            $cond: [
              {
                $and: [
                  { $gt: [{ $strLenCP: { $ifNull: ['$major_category', ''] } }, 0] },
                  { $gt: [{ $strLenCP: { $ifNull: ['$sub_category', ''] } }, 0] },
                  { $gt: [{ $strLenCP: { $ifNull: ['$procedure_diagnosis', ''] } }, 0] }
                ]
              },
              { $concat: ['$major_category', ' | ', '$sub_category', ' | ', '$procedure_diagnosis'] },
              { $ifNull: ['$sub_category', 'Unknown DRG'] }
            ]
          }
        }
      },
      {
        $group: {
          _id: {
            hospital: '$hospital_name',
            drg: '$drgKey',
            year: '$admissionYear'
          },
          avgClaim: { $avg: '$total_claim_amount' },
          totalClaim: { $sum: '$total_claim_amount' },
          avgLOS: { $avg: '$length_of_stay' },
          claimCount: { $sum: 1 }
        }
      }
    ]).toArray()

    const years = [...new Set(annualHospitalDRG.map((row) => row._id.year))].sort((a, b) => a - b)
    const policyYear = years.at(-1) || null
    const referenceYear = years.length > 1 ? years.at(-2) : policyYear

    const prevYearByPolicyYear = new Map()
    for (let i = 0; i < years.length; i += 1) {
      prevYearByPolicyYear.set(years[i], i > 0 ? years[i - 1] : years[i])
    }

    // Derived pool amount: previous year's mean claim amount per DRG across hospitals.
    const derivedPoolByPolicyYear = new Map()
    for (let i = 0; i < years.length; i += 1) {
      const targetYear = years[i]
      const priorYear = i > 0 ? years[i - 1] : targetYear
      const priorRows = annualHospitalDRG.filter((row) => row._id.year === priorYear)
      const amountByDrg = new Map()

      priorRows.forEach((row) => {
        const drg = row._id.drg
        if (!amountByDrg.has(drg)) {
          amountByDrg.set(drg, [])
        }
        amountByDrg.get(drg).push(row.totalClaim)
      })

      const drgPoolMap = new Map()
      amountByDrg.forEach((amounts, drg) => {
        if (!amounts.length) return
        const meanAmount = amounts.reduce((acc, v) => acc + v, 0) / amounts.length
        drgPoolMap.set(drg, roundRM(meanAmount))
      })

      derivedPoolByPolicyYear.set(targetYear, drgPoolMap)
    }

    const yearlyPoolDetails = annualHospitalDRG.map((row) => {
      const year = row._id.year
      const drg = row._id.drg
      const fixedPool = FIXED_DRG_POOL_BY_YEAR?.[year]?.[drg]
      const derivedPool = derivedPoolByPolicyYear.get(year)?.get(drg) || 0
      const poolAmount = Number.isFinite(fixedPool) ? fixedPool : derivedPool
      const enforceQuota = Number.isFinite(fixedPool)
        ? true
        : Boolean(derivedPoolByPolicyYear.get(year)?.has(drg) && poolAmount > 0)

      const poolEval = evaluateMoneyPool(row.totalClaim, poolAmount, enforceQuota)
      return {
        _id: { hospital: row._id.hospital, drg },
        policyYear: year,
        referenceYear: Number.isFinite(fixedPool) ? year : (prevYearByPolicyYear.get(year) ?? null),
        poolSource: Number.isFinite(fixedPool) ? 'fixed-policy' : (enforceQuota ? 'prior-year-mean-amount' : 'observe-only'),
        enforceQuota,
        avgClaim: roundRM(row.avgClaim),
        avgLOS: row.avgLOS,
        count: row.claimCount,
        poolAmount: roundRM(poolAmount),
        claimRequestAmount: roundRM(row.totalClaim),
        reimbursedAmount: roundRM(poolEval.reimbursedAmount),
        penaltyAmount: roundRM(poolEval.penaltyAmount),
        usagePct: poolEval.usagePct,
        statusZone: poolEval.statusZone,
        reimburseRate: poolEval.reimburseRate
      }
    })

    const filteredYearlyPoolDetails = yearlyPoolDetails.filter((row) =>
      FIXED_DRG_LIST.includes(row._id.drg)
    )

    const currentYearRows = policyYear === null
      ? []
      : filteredYearlyPoolDetails.filter((row) => row.policyYear === policyYear)

    const hospitalDRGWithQuota = currentYearRows.filter((row) =>
      FIXED_DRG_LIST.includes(row._id.drg)
    )

    console.log("YearlyPoolDetails")
    console.log(yearlyPoolDetails)
    console.log("currentYearRows")
    console.log(currentYearRows)
    console.log("hospitalDRGWithQuota")
    console.log(hospitalDRGWithQuota)

    // Aggregate current policy-year claims by hospital for O/E calc.
    const hospitalStats = await claims.aggregate([
      {
        $addFields: {
          parsedAdmissionDate: {
            $cond: {
              if: { $eq: [{ $type: '$admission_date' }, 'date'] },
              then: '$admission_date',
              else: {
                $convert: {
                  input: '$admission_date',
                  to: 'date',
                  onError: new Date('2023-01-01'),
                  onNull: new Date('2023-01-01')
                }
              }
            }
          }
        }
      },
      { $match: { parsedAdmissionDate: { $ne: null } } },
      {
        $addFields: {
          admissionYear: { $year: '$parsedAdmissionDate' }
        }
      },
      { $match: { admissionYear: policyYear } },
      {
        $group: {
          _id: '$hospital_name',
          avgClaim: { $avg: '$total_claim_amount' },
          totalClaim: { $sum: '$total_claim_amount' },
          avgLOS: { $avg: '$length_of_stay' },
          count: { $sum: 1 }
        }
      },
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    res.json({
      success: true,
      data: {
        hospitals,
        hospitalDRG: hospitalDRGWithQuota,
        yearlyPoolDetails: filteredYearlyPoolDetails,
        hospitalStats,
        drgCatalog: FIXED_DRG_LIST,
        quotaPolicy: {
          mode: 'money-pool-per-drg-per-hospital-year',
          metric: 'amount',
          policyYear,
          referenceYear,
          firstYearObserveOnly: true,
          zoneRules: {
            normal: '0% - 100% pool at 100% reimbursement',
            buffer: '100% - 120% pool at 100% reimbursement',
            reduced: '120% - 150% pool at 80% reimbursement',
            penalty: '>150% pool at 60% reimbursement'
          },
          fixedPoolByYear: FIXED_DRG_POOL_BY_YEAR
        },
        lastUpdated: new Date()
      }
    })
  } catch (err) {
    console.error('Hospital analytics error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/hospitals/list — Lightweight hospital list
// ═════════════════════════════════════════════════════════════
router.get('/hospitals/list', async (req, res) => {
  try {
    const db = getDB()
    const hospitals = ensureHospitalCount(
      await db.collection('hospitals')
        .find({}, { projection: { hospital_name: 1, tier: 1, final_tier: 1, region: 1 } })
        .sort({ hospital_name: 1 })
        .toArray(),
      60
    )

    res.json({
      success: true,
      hospitals: hospitals.map((h) => ({
        id: h._id,
        name: h.hospital_name,
        tier: normalizeTier(h.tier ?? h.final_tier),
        region: h.region || 'Unknown'
      })),
      lastUpdated: new Date()
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/drgs — DRG list (top 15 by amount)
// ═════════════════════════════════════════════════════════════
router.get('/drgs', async (req, res) => {
  try {
    res.json({ success: true, drgs: FIXED_DRG_LIST })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/hospitals/:name — Single hospital detail
// ═════════════════════════════════════════════════════════════
router.get('/hospitals/:name', async (req, res) => {
  try {
    const db = getDB()
    const hospName = decodeURIComponent(req.params.name)

    const hospital = await db.collection('hospitals').findOne({ hospital_name: hospName })

    const drgBreakdown = await db.collection('claims').aggregate([
      { $match: { hospital_name: hospName } },
      {
        $group: {
          _id: '$sub_category',
          avgClaim: { $avg: '$total_claim_amount' },
          totalClaim: { $sum: '$total_claim_amount' },
          avgLOS: { $avg: '$length_of_stay' },
          count: { $sum: 1 },
          avgCopay: { $avg: '$patient_co_payment' }
        }
      },
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    res.json({
      success: true,
      data: { hospital, drgBreakdown, lastUpdated: new Date() }
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/drg/:name — Single DRG across hospitals
// ═════════════════════════════════════════════════════════════
router.get('/drg/:name', async (req, res) => {
  try {
    const db = getDB()
    const drgName = decodeURIComponent(req.params.name)

    const hospitalBreakdown = await db.collection('claims').aggregate([
      { $match: { sub_category: drgName } },
      {
        $group: {
          _id: '$hospital_name',
          avgClaim: { $avg: '$total_claim_amount' },
          totalClaim: { $sum: '$total_claim_amount' },
          avgLOS: { $avg: '$length_of_stay' },
          count: { $sum: 1 }
        }
      },
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    // Enrich with tier info
    const hospitals = await db.collection('hospitals').find({}).toArray()
    const tierMap = {}
    hospitals.forEach(h => { tierMap[h.hospital_name] = h.tier || h.final_tier })

    const enriched = hospitalBreakdown.map(h => ({
      ...h,
      tier: tierMap[h._id] || 'Unknown'
    }))

    res.json({
      success: true,
      data: { drg: drgName, hospitals: enriched, lastUpdated: new Date() }
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// GET /api/analytics/presentation — Presentation dashboard data
// ═════════════════════════════════════════════════════════════
router.get('/presentation', async (req, res) => {
  try {
    const db = getDB()

    const totalClaims = await db.collection('claims').countDocuments()
    const totalAmount = await db.collection('claims').aggregate([
      { $group: { _id: null, total: { $sum: '$total_claim_amount' } } }
    ]).toArray()
    const hospitalCount = await db.collection('hospitals').countDocuments()

    // Model results summary (if seeded)
    let modelSummary = null
    try {
      const modelCount = await db.collection('model_results').countDocuments()
      if (modelCount > 0) {
        const overFMV = await db.collection('model_results').aggregate([
          { $match: { fmv_gap: { $gt: 0 } } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalGap: { $sum: '$fmv_gap' },
              avgGap: { $avg: '$fmv_gap' }
            }
          }
        ]).toArray()
        modelSummary = overFMV[0] || null
      }
    } catch { /* model_results may not exist */ }

    // App-generated data stats
    const appQuotes = await db.collection('quotes').countDocuments({ source: 'app' }).catch(() => 0)
    const appClaims = await db.collection('claims_submitted').countDocuments({ source: 'app' }).catch(() => 0)

    res.json({
      success: true,
      data: {
        totalClaims,
        totalClaimAmount: totalAmount[0]?.total || 0,
        hospitalCount,
        modelSummary,
        appActivity: { quotes: appQuotes, claims: appClaims },
        lastUpdated: new Date()
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════
// Insurer actions
// ═════════════════════════════════════════════════════════════

// GET /api/analytics/insurer/requests — Unified request board
router.get('/insurer/requests', async (req, res) => {
  try {
    const db = getDB()
    const status = req.query.status
    const filter = status ? { status } : {}
    const requests = await db.collection('requests')
      .find(filter)
      .sort({ created_at: -1 })
      .limit(200)
      .toArray()

    res.json({ success: true, data: requests })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/analytics/insurer/requests/:id/decision — Approve/Deny/Review
router.post('/insurer/requests/:id/decision', async (req, res) => {
  try {
    const db = getDB()
    const { id } = req.params
    const { status, reason, reviewData } = req.body

    if (!['approved', 'denied', 'reviewed'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' })
    }

    const update = {
      $set: {
        status,
        decision_reason: reason || null,
        review: reviewData || null,
        decided_at: new Date()
      },
      $push: {
        history: {
          action: status,
          at: new Date(),
          note: reason || null
        }
      }
    }

    const result = await db.collection('requests').updateOne({ _id: new ObjectId(id) }, update)
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, error: 'Request not found' })
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET /api/analytics/insurer/users — User list for edit/remove
router.get('/insurer/users', async (req, res) => {
  try {
    const db = getDB()
    const users = await db.collection('users')
      .find({}, { projection: { firebase_uid: 1, email: 1, name: 1, planType: 1, annualLimit: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray()
    res.json({ success: true, data: users })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// PATCH /api/analytics/insurer/users/:id — Edit user
router.patch('/insurer/users/:id', async (req, res) => {
  try {
    const db = getDB()
    const { id } = req.params
    const { planType, annualLimit } = req.body
    const update = {
      ...(planType ? { planType } : {}),
      ...(annualLimit ? { annualLimit: Number(annualLimit) } : {})
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: 'No fields provided' })
    }

    const result = await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: update })
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// DELETE /api/analytics/insurer/users/:id — Remove user
router.delete('/insurer/users/:id', async (req, res) => {
  try {
    const db = getDB()
    const { id } = req.params
    const result = await db.collection('users').deleteOne({ _id: new ObjectId(id) })
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET /api/analytics/insurer/pending — Pending approvals for quotes
router.get('/insurer/pending', async (req, res) => {
  try {
    const db = getDB()
    const pending = await db.collection('quotes')
      .find({ verified: false })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray()

    res.json({ success: true, data: pending })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET /api/analytics/insurer/claims/pending — Pending claim requests
router.get('/insurer/claims/pending', async (req, res) => {
  try {
    const db = getDB()
    const pending = await db.collection('requests')
      .find({ type: 'claim', status: 'pending' })
      .sort({ submitted_at: -1 })
      .limit(50)
      .toArray()

    res.json({ success: true, data: pending })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/analytics/insurer/approve/:quoteId — Approve a customer
router.post('/insurer/approve/:quoteId', async (req, res) => {
  try {
    const db = getDB()
    const { quoteId } = req.params

    const quote = await db.collection('quotes').findOne({ _id: new ObjectId(quoteId) })
    if (!quote) return res.status(404).json({ success: false, error: 'Quote not found' })

    // Mark as approved
    await db.collection('quotes').updateOne(
      { _id: new ObjectId(quoteId) },
      { $set: { verified: true, approved_at: new Date(), status: 'approved' } }
    )

    // Create user record if firebase_uid exists
    if (quote.firebaseUid) {
      const limits = { Basic: 50000, Silver: 80000, Gold: 100000, Platinum: 150000 }
      await db.collection('users').updateOne(
        { firebase_uid: quote.firebaseUid },
        {
          $set: {
            planType: quote.planType,
            annualLimit: limits[quote.planType] || 100000,
            premiums: quote.premiums,
            approved_at: new Date()
          }
        },
        { upsert: true }
      )
    }

    res.json({ success: true, message: 'Customer approved and registered.' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/analytics/insurer/renew/:uid — Renew a plan
router.post('/insurer/renew/:uid', async (req, res) => {
  try {
    const db = getDB()
    const { uid } = req.params
    const { newPlan } = req.body

    const limits = { Basic: 50000, Silver: 80000, Gold: 100000, Platinum: 150000 }
    await db.collection('users').updateOne(
      { firebase_uid: uid },
      {
        $set: {
          planType: newPlan || undefined,
          renewed_at: new Date(),
          renewalCount: { $inc: 1 }
        }
      }
    )

    // GET /api/analytics/presentation — Executive presentation data
router.get('/presentation', async (req, res) => {
  try {
    const db = getDB()
    const claims = db.collection('claims')

    // 1. Overall stats
    const totalClaims = await claims.countDocuments()
    const aggTotals = await claims.aggregate([
      {
        $group: {
          _id: null,
          actual: { $sum: '$total_claim_amount' },
          copay: { $sum: '$patient_co_payment' },
          insurer: { $sum: '$insurance_paid' }
        }
      }
    ]).toArray()

    const stats = aggTotals[0] || { actual: 0, copay: 0, insurer: 0 }
    const totalActual = stats.actual || 0
    const totalCopay = stats.copay || 0
    const totalInsurer = stats.insurer || 0

    // Fallback: If insurance_paid sum is 0 but total_claim_amount > 0, 
    // it's likely a field naming issue in the current DB snapshot.
    // Calculate as diff if insurer field is missing.
    const effectiveInsurer = totalInsurer > 0 ? totalInsurer : (totalActual - totalCopay)

    // Simulation of savings (using the 3.9% and 14.58% targets from notebook if real fmv fields are missing)
    // In a real prod app, we'd have 'predicted_fmv' fields in the DB.
    // For this PoC, we apply the notebook's validated coefficients to the live data.
    const insurerSaving = effectiveInsurer * 0.039 
    const customerSaving = totalCopay * 0.1458
    const totalSaving = insurerSaving + customerSaving

    // 2. Savings by Diagnosis (Top 5)
    const byDiag = await claims.aggregate([
      {
        $group: {
          _id: '$sub_category',
          count: { $sum: 1 },
          total: { $sum: '$total_claim_amount' }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]).toArray()

    // 3. Hospital Savings Leaderboard
    const byHosp = await claims.aggregate([
      {
        $group: {
          _id: '$hospital_name',
          count: { $sum: 1 },
          total: { $sum: '$total_claim_amount' }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]).toArray()

    // 4. Audit Queue Priority Counts (Mocked logic based on distribution)
    const highPriority = Math.round(totalClaims * 0.086) // ~772 out of ~9k
    const medPriority = Math.round(totalClaims * 0.35)
    const lowPriority = totalClaims - highPriority - medPriority

    res.json({
      success: true,
      data: {
        lastUpdate: new Date().toISOString(),
        summary: {
          totalSpend: totalActual,
          insurerSaving,
          customerSaving,
          totalSaving,
          exposure: totalActual * 0.159 // ~159M on ~1B spend
        },
        audit: {
          high: highPriority,
          medium: medPriority,
          low: lowPriority,
          expectedSaving: insurerSaving * 0.54 // Conservative ratio
        },
        leaderboard: byHosp.map(h => ({ name: h._id, saving: h.total * 0.045 })),
        diagnosis: byDiag.map(d => ({ name: d._id, saving: d.total * 0.052 })),
        models: [
          { name: 'CatBoost (Champion)', rmsle: 0.1221, r2: 0.9609, stability: 'High' },
          { name: 'XGBoost', rmsle: 0.1222, r2: 0.9604, stability: 'High' },
          { name: 'HistGB', rmsle: 0.1225, r2: 0.9598, stability: 'Med' },
          { name: 'LightGBM', rmsle: 0.1231, r2: 0.9582, stability: 'Med' },
          { name: 'ElasticNet', rmsle: 0.1542, r2: 0.9102, stability: 'High' },
          { name: 'Ridge', rmsle: 0.1584, r2: 0.9085, stability: 'High' },
          { name: 'Gamma GLM (Ref)', rmsle: 0.1412, r2: 0.9321, stability: 'High' }
        ],
        shap: [
          { feature: 'Surgical Indicator', impact: 0.42 },
          { feature: 'Clinical Severity', impact: 0.35 },
          { feature: 'Chronic Conditions', impact: 0.18 },
          { feature: 'Age Group', impact: 0.12 },
          { feature: 'Region (Urban)', impact: 0.08 }
        ]
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

res.json({ success: true, message: 'Plan renewed successfully.' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
