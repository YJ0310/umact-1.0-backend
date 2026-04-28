/**
 * Analytics API Routes
 * Serves insurer dashboard, hospital analytics, and presentation data.
 * All data is live from MongoDB (seeded from historical CSV + app-generated).
 */
import { Router } from 'express'
import { getDB } from '../db/connection.js'

const router = Router()

function meanInt(values) {
  if (!values?.length) return 0
  const sum = values.reduce((acc, v) => acc + v, 0)
  return Math.max(1, Math.round(sum / values.length))
}

const FIXED_DRG_POOL_BY_YEAR = {
  2023: {
    'Surgical | Orthopedic | Arthroscopy': 10_000_000
  }
}

function roundRM(value) {
  return Math.round(Number(value) || 0)
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
      { $group: {
        _id: '$hospital_type',
        avgClaim: { $avg: '$total_claim_amount' },
        totalClaim: { $sum: '$total_claim_amount' },
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]).toArray()

    // By sub-category
    const bySubCat = await claims.aggregate([
      { $group: {
        _id: '$sub_category',
        avgClaim: { $avg: '$total_claim_amount' },
        avgLOS: { $avg: '$length_of_stay' },
        count: { $sum: 1 }
      }},
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    // By region
    const byRegion = await claims.aggregate([
      { $group: {
        _id: '$region',
        avgClaim: { $avg: '$total_claim_amount' },
        count: { $sum: 1 }
      }},
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    // Co-payment stats
    const copayStats = await claims.aggregate([
      { $group: {
        _id: null,
        avgCopay: { $avg: '$patient_co_payment' },
        hitsCapPct: { $avg: { $cond: [{ $gte: ['$patient_co_payment', 3000] }, 1, 0] } },
        totalCopay: { $sum: '$patient_co_payment' }
      }}
    ]).toArray()

    // Smoker vs non-smoker
    const bySmoker = await claims.aggregate([
      { $group: {
        _id: '$smoker_status',
        avgClaim: { $avg: '$total_claim_amount' },
        count: { $sum: 1 }
      }}
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
    const hospitals = await db.collection('hospitals').find({}).toArray()

    // Build annual hospital x DRG stats to support year-based money-pool policy.
    const annualHospitalDRG = await claims.aggregate([
      {
        $addFields: {
          parsedAdmissionDate: {
            $convert: {
              input: '$admission_date',
              to: 'date',
              onError: null,
              onNull: null
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
                  { $gt: [{ $strLenCP: { $ifNull: ['$diagnosis', ''] } }, 0] }
                ]
              },
              { $concat: ['$major_category', ' | ', '$sub_category', ' | ', '$diagnosis'] },
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
    const referenceYear = years.length > 1 ? years.at(-2) : null

    const prevYearByPolicyYear = new Map()
    for (let i = 1; i < years.length; i += 1) {
      prevYearByPolicyYear.set(years[i], years[i - 1])
    }

    // Derived pool amount: previous year's mean claim amount per DRG across hospitals.
    const derivedPoolByPolicyYear = new Map()
    for (let i = 1; i < years.length; i += 1) {
      const targetYear = years[i]
      const priorYear = years[i - 1]
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

    const currentYearRows = policyYear === null
      ? []
      : yearlyPoolDetails.filter((row) => row.policyYear === policyYear)

    const drgTotals = new Map()
    currentYearRows.forEach((row) => {
      const drg = row._id.drg
      drgTotals.set(drg, (drgTotals.get(drg) || 0) + row.claimRequestAmount)
    })

    const top15Drgs = [...drgTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([drg]) => drg)

    const hospitalDRGWithQuota = currentYearRows.filter((row) => top15Drgs.includes(row._id.drg))

    // Aggregate current policy-year claims by hospital for O/E calc.
    const hospitalStats = await claims.aggregate([
      {
        $addFields: {
          parsedAdmissionDate: {
            $convert: {
              input: '$admission_date',
              to: 'date',
              onError: null,
              onNull: null
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
      { $group: {
        _id: '$hospital_name',
        avgClaim: { $avg: '$total_claim_amount' },
        totalClaim: { $sum: '$total_claim_amount' },
        avgLOS: { $avg: '$length_of_stay' },
        count: { $sum: 1 }
      }},
      { $sort: { avgClaim: -1 } }
    ]).toArray()

    res.json({
      success: true,
      data: {
        hospitals,
        hospitalDRG: hospitalDRGWithQuota,
        yearlyPoolDetails,
        hospitalStats,
        drgCatalog: top15Drgs,
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
// GET /api/analytics/hospitals/:name — Single hospital detail
// ═════════════════════════════════════════════════════════════
router.get('/hospitals/:name', async (req, res) => {
  try {
    const db = getDB()
    const hospName = decodeURIComponent(req.params.name)

    const hospital = await db.collection('hospitals').findOne({ hospital_name: hospName })

    const drgBreakdown = await db.collection('claims').aggregate([
      { $match: { hospital_name: hospName } },
      { $group: {
        _id: '$sub_category',
        avgClaim: { $avg: '$total_claim_amount' },
        totalClaim: { $sum: '$total_claim_amount' },
        avgLOS: { $avg: '$length_of_stay' },
        count: { $sum: 1 },
        avgCopay: { $avg: '$patient_co_payment' }
      }},
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
      { $group: {
        _id: '$hospital_name',
        avgClaim: { $avg: '$total_claim_amount' },
        totalClaim: { $sum: '$total_claim_amount' },
        avgLOS: { $avg: '$length_of_stay' },
        count: { $sum: 1 }
      }},
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
          { $group: {
            _id: null,
            count: { $sum: 1 },
            totalGap: { $sum: '$fmv_gap' },
            avgGap: { $avg: '$fmv_gap' }
          }}
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
    const pending = await db.collection('claims_submitted')
      .find({ status: 'pending' })
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
        { $set: {
          planType: quote.planType,
          annualLimit: limits[quote.planType] || 100000,
          premiums: quote.premiums,
          approved_at: new Date()
        }},
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
      { $set: {
        planType: newPlan || undefined,
        renewed_at: new Date(),
        renewalCount: { $inc: 1 }
      }}
    )

    res.json({ success: true, message: 'Plan renewed successfully.' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
