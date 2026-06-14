/**
 * Netlify Function: kyc-check-result.js
 * Path: netlify/functions/kyc-check-result.js
 *
 * Polls the Didit API for the result of a KYC session.
 * Called by the frontend (verify.html) after the user returns from the
 * Didit hosted verification flow, as a fallback in case the webhook
 * (kyc-webhook.js) has not fired yet or was missed.
 *
 * POST body:
 *   { uid: string, sessionId: string }
 *
 * Didit status → our kycStatus mapping:
 *   Approved   → verified
 *   Declined   → declined
 *   In Review  → under-review
 *   Anything else → returns { status: 'pending' } without writing Firestore
 *
 * On terminal statuses (verified / declined / under-review):
 *   - Updates Firestore users/{uid}.kycStatus
 *   - Calls send-smart-notification with emailMode 'always'
 *
 * Environment variables required:
 *   DIDIT_API_KEY             — from Didit Console → Settings → API & Webhooks
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON (single-line string)
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

const DIDIT_API_BASE = 'https://verification.didit.me/v3';

/* ── Didit status → our kycStatus mapping ── */
const STATUS_MAP = {
  'Approved':  'verified',
  'Declined':  'declined',
  'In Review': 'under-review',
};

/* ── Statuses we treat as still-in-progress (return pending, no Firestore write) ── */
const PENDING_STATUSES = new Set([
  'Not Started',
  'In Progress',
  'Awaiting User',
  'Resubmitted',
  'Abandoned',
  'Expired',
  'Kyc Expired',
]);

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb() {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

/* ── Call a sibling Netlify function ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return;
  }
  try {
    await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { uid, sessionId } = body;

  if (!uid || typeof uid !== 'string') {
    return respond(400, { error: 'uid is required.' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return respond(400, { error: 'sessionId is required.' });
  }

  /* ── Check env vars ── */
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) {
    console.error('DIDIT_API_KEY is not set.');
    return respond(500, { error: 'KYC service is not configured.' });
  }

  /* ── Fetch session result from Didit ── */
  let diditData;
  try {
    const res = await fetch(`${DIDIT_API_BASE}/session/${sessionId}/`, {
      method:  'GET',
      headers: { 'x-api-key': apiKey },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Didit session fetch failed for ${sessionId} (${res.status}):`, errText);
      return respond(502, { error: 'Could not fetch verification result. Please try again.' });
    }

    diditData = await res.json();
  } catch (err) {
    console.error('Network error reaching Didit API:', err.message);
    return respond(502, { error: 'Could not reach the identity verification service.' });
  }

  const diditStatus = diditData.status || '';
  console.log(`kyc-check-result: uid=${uid}, sessionId=${sessionId}, diditStatus="${diditStatus}"`);

  /* ── Map Didit status ── */
  const kycStatus = STATUS_MAP[diditStatus];

  /* ── Still pending — return without writing Firestore ── */
  if (!kycStatus || PENDING_STATUSES.has(diditStatus)) {
    return respond(200, { status: 'pending', diditStatus });
  }

  /* ── Terminal status — update Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const userRef = db.collection('users').doc(uid);

  let userSnap;
  try {
    userSnap = await userRef.get();
  } catch (err) {
    console.error(`Firestore read failed for uid ${uid}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.error(`User document for uid ${uid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const user = userSnap.data();

  /* ── Idempotency: skip if already in the same terminal state ── */
  if (user.kycStatus === kycStatus) {
    console.log(`User ${uid} already has kycStatus="${kycStatus}" — skipping duplicate write.`);
    return respond(200, { status: kycStatus, updated: false });
  }

  /* ── Write to Firestore ── */
  try {
    await userRef.update({
      kycStatus,
      kycSessionId:  sessionId,
      kycResolvedAt: FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`User ${uid} kycStatus updated to "${kycStatus}" via poll.`);
  } catch (err) {
    console.error(`Firestore update failed for uid ${uid}:`, err.message);
    return respond(500, { error: 'Database update failed.' });
  }

  /* ── Notify the user via send-smart-notification ── */
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

  const kycMessages = {
    verified: {
      title:      'Identity Verified',
      body:       'Your KYC has been approved. Your profile is now live.',
      templateId: 'kyc-approved',
    },
    'under-review': {
      title:      'Verification Under Review',
      body:       'Your documents are being reviewed. We will update you within 1 to 2 business days.',
      templateId: 'kyc-under-review',
    },
    declined: {
      title:      'Verification Not Approved',
      body:       'Your identity verification was not approved. You can resubmit from your dashboard.',
      templateId: 'kyc-declined',
    },
  };

  const kycMsg = kycMessages[kycStatus];
  if (kycMsg) {
    await callFunction('send-smart-notification', {
      userUid:    uid,
      title:      kycMsg.title,
      body:       kycMsg.body,
      url:        `${platformUrl}/dashboard.html`,
      templateId: kycMsg.templateId,
      emailMode:  'always',
      emailData: {
        to:   user.email || null,
        name: user.name  || 'there',
      },
    });
  }

  return respond(200, { status: kycStatus, updated: true });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
