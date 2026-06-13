/**
 * Netlify Function: kyc-verify.js
 * Path: netlify/functions/kyc-verify.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW DIDIT v3 KYC WORKS (important — read before editing)
 * ─────────────────────────────────────────────────────────────────────────────
 * Didit does NOT accept raw base64 images via a direct API call.
 * The correct flow is:
 *
 *   1. Frontend calls THIS function → we create a Didit session server-side.
 *   2. We return the hosted `session_url` to the frontend.
 *   3. Frontend redirects the user to `session_url` on verify.didit.me.
 *   4. User completes the guided flow (ID upload + liveness selfie) on Didit's
 *      own UI — no images ever pass through our server.
 *   5. Didit calls our webhook (kyc-webhook.js) when the result is ready.
 *   6. The webhook updates Firestore and emails the user.
 *
 * This function handles step 1–2 only.
 * The webhook at /.netlify/functions/kyc-webhook handles steps 5–6.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIDIT CONSOLE SETUP (one-time, before going live)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Sign up at https://business.didit.me
 *   2. Create a Workflow: KYC template → enable ID Verification + Passive
 *      Liveness + Face Match. Copy the Workflow ID.
 *   3. Settings → API & Webhooks:
 *      - Copy API Key  → DIDIT_API_KEY env var
 *      - Copy Webhook Secret → DIDIT_WEBHOOK_SECRET env var
 *      - Set Webhook URL → https://yourdomain.com/.netlify/functions/kyc-webhook
 *   4. Add DIDIT_WORKFLOW_ID env var with the workflow UUID from step 2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Environment variables required:
 *   DIDIT_API_KEY          — from Didit Console → Settings → API & Webhooks
 *   DIDIT_WORKFLOW_ID      — UUID of the KYC workflow you configured in Console
 *   DIDIT_WEBHOOK_SECRET   — for signature verification in kyc-webhook.js
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON (single-line string)
 *   PLATFORM_URL           — your live domain e.g. https://kreddlo.com
 *
 * Expected POST body (JSON):
 *   { uid: string }        — the Firebase UID of the user starting KYC
 *
 * Success response (200):
 *   { sessionUrl: "https://verify.didit.me/session/..." }
 *   → frontend redirects user to this URL
 *
 * Error response (4xx / 5xx):
 *   { error: "human-readable message" }
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

const DIDIT_API_BASE = 'https://verification.didit.me/v3';

/* ── Firebase Admin — initialise once across warm Lambda invocations ── */
function getDb() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}


exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { uid } = body;

  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return respond(400, { error: 'uid is required.' });
  }

  /* ── 3. Check environment variables ── */
  const apiKey     = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

  if (!apiKey) {
    console.error('DIDIT_API_KEY environment variable is not set.');
    return respond(500, { error: 'KYC service is not configured. Please contact support.' });
  }
  if (!workflowId) {
    console.error('DIDIT_WORKFLOW_ID environment variable is not set.');
    return respond(500, { error: 'KYC workflow is not configured. Please contact support.' });
  }
  if (!platformUrl) {
    console.error('PLATFORM_URL environment variable is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  /* ── 4. Fetch user details from Firestore to prefill Didit session ── */
  let userEmail = null;
  let userName  = null;

  try {
    const db       = getDb();
    const userSnap = await db.collection('users').doc(uid).get();

    if (!userSnap.exists) {
      return respond(404, { error: 'User not found. Please sign in again.' });
    }

    const user = userSnap.data();

    // Guard: don't let already-verified users re-submit
    if (user.kycStatus === 'verified') {
      return respond(409, { error: 'Your identity is already verified.' });
    }

    userEmail = user.email  || null;
    userName  = user.name   || null;

  } catch (err) {
    console.error('Firestore read error:', err.message);
    return respond(500, { error: 'Could not load your account. Please try again.' });
  }

  /* ── 5. Create a Didit verification session ── */
  const sessionPayload = {
    workflow_id: workflowId,

    // After completing verification the user lands back on our platform
    callback: `${platformUrl}/verify.html?kyc=complete`,

    // vendor_data is echoed back in every webhook — we use the Firebase UID
    // to correlate the Didit result with the correct Firestore user document
    vendor_data: uid,

    // Pre-fill the user's email so Didit can send them status emails
    ...(userEmail && {
      contact_details: {
        email:                     userEmail,
        email_lang:                'en',
        send_notification_emails:  false, // we handle our own emails via Brevo
      },
    }),

    // Optional metadata stored in the Didit console for your reference
    metadata: {
      platform: 'kreddlo',
      uid,
      ...(userName && { name: userName }),
    },
  };

  let diditResponse;
  try {
    diditResponse = await fetch(`${DIDIT_API_BASE}/session/`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
      },
      body: JSON.stringify(sessionPayload),
    });
  } catch (networkErr) {
    console.error('Network error reaching Didit API:', networkErr.message);
    return respond(502, { error: 'Could not reach the identity verification service. Please try again.' });
  }

  let diditData;
  try {
    diditData = await diditResponse.json();
  } catch {
    console.error('Didit returned non-JSON response, HTTP status:', diditResponse.status);
    return respond(502, { error: 'Unexpected response from identity verification service.' });
  }

  if (!diditResponse.ok) {
    console.error('Didit session creation failed:', {
      status:  diditResponse.status,
      payload: diditData,
    });
    const detail = diditData?.detail || diditData?.message || 'Unknown error.';
    return respond(502, { error: `KYC service error: ${detail}` });
  }

  // `url` is the hosted verification page on verify.didit.me
  const sessionUrl = diditData.url;
  const sessionId  = diditData.session_id;

  if (!sessionUrl || !sessionId) {
    console.error('Didit response missing url or session_id:', diditData);
    return respond(502, { error: 'KYC service did not return a verification URL.' });
  }

  /* ── 6. Record the pending session in Firestore ── */
  // Storing the session_id lets kyc-webhook.js correlate results,
  // and lets admin staff look up sessions in the Didit console.
  try {
    const db = getDb();
    await db.collection('users').doc(uid).update({
      kycStatus:      'pending',
      kycSessionId:   sessionId,
      kycSubmittedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Non-fatal — session is created on Didit's side; log and continue
    console.warn('Failed to record kycSessionId in Firestore:', err.message);
  }

  console.log(`Didit KYC session created — uid: ${uid}, sessionId: ${sessionId}`);

  /* ── 7. Return the hosted verification URL to the frontend ── */
  return respond(200, {
    sessionUrl,
    sessionId,
  });
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
