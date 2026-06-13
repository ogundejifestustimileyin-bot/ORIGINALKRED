/**
 * Netlify Scheduled Function: scheduled-subscriptions.js
 * Path: netlify/functions/scheduled-subscriptions.js
 *
 * Runs daily at midnight UTC (schedule defined in netlify.toml).
 * Finds all users whose premium plan has expired and:
 *   1. Sets premiumStatus → "inactive"
 *   2. Sends a push notification
 *   3. Sends a "premium-expired" email
 *
 * netlify.toml entry required:
 *   [[plugins]]
 *   package = "@netlify/plugin-functions-install-core"
 *
 *   [functions."scheduled-subscriptions"]
 *   schedule = "0 0 * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 *   PLATFORM_URL             — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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

/* ── Internal function caller ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
   Netlify scheduled functions receive a special context object.
   The handler signature accepts (event, context) but we only
   need event for the trigger check.
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  console.log('scheduled-subscriptions: running at', new Date().toISOString());

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = new Date();

  /* ── Query for expired active subscriptions ── */
  let snapshot;
  try {
    snapshot = await db.collection('users')
      .where('premiumStatus',  '==',  'active')
      .where('premiumEndDate', '<=', now)
      .get();
  } catch (err) {
    console.error('Firestore query failed:', err.message);
    return respond(500, { error: 'Database query failed.' });
  }

  if (snapshot.empty) {
    console.log('scheduled-subscriptions: no expired subscriptions found.');
    return respond(200, { processed: 0 });
  }

  console.log(`scheduled-subscriptions: found ${snapshot.size} expired subscription(s).`);

  const results = { processed: 0, failed: 0 };

  /* ── Process each expired user ── */
  for (const docSnap of snapshot.docs) {
    const uid  = docSnap.id;
    const user = docSnap.data();

    try {
      /* 1. Update Firestore */
      await db.collection('users').doc(uid).update({
        premiumStatus: 'inactive',
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`uid ${uid} — premiumStatus set to inactive.`);

      /* 2. Push notification */
      await callFunction('send-push-notification', {
        userUid: uid,
        title:   'Subscription Ended',
        body:    'Your Kreddlo Pro plan has ended. Renew anytime from your settings.',
        url:     `${(process.env.PLATFORM_URL || '').replace(/\/$/, '')}/dashboard-settings.html`,
      });

      /* 3. Email */
      if (user.email) {
        await callFunction('send-email', {
          to:   user.email,
          type: 'premium-expired',
          data: { name: user.name || 'there' },
        });
      }

      results.processed++;

    } catch (err) {
      console.error(`Failed to process uid ${uid}:`, err.message);
      results.failed++;
    }
  }

  console.log(`scheduled-subscriptions: complete — processed: ${results.processed}, failed: ${results.failed}`);

  return respond(200, results);
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
