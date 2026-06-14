/**
 * Netlify Function: kyc-submit.js
 * Path: netlify/functions/kyc-submit.js
 *
 * Receives a POST from verify.html containing base64-encoded images of the
 * user's NIN card (front + back) and a selfie.
 * 
 * What it does:
 *   1. Validates the payload (uid, three images present, size limits).
 *   2. Uploads the three images to Firebase Storage under:
 *        kyc/{uid}/nin-front.jpg
 *        kyc/{uid}/nin-back.jpg
 *        kyc/{uid}/selfie.jpg
 *   3. Updates Firestore users/{uid} with:
 *        kycStatus:        'under-review'
 *        kycSubmittedAt:   server timestamp
 *        kycDocumentType:  'NIN Card'
 *        kycImages: { frontUrl, backUrl, selfieUrl }  ← signed 7-day URLs
 *   4. Returns { ok: true }.
 *   5. Sends an internal admin notification email via Brevo (optional but recommended).
 *
 * Environment variables required (set in Netlify UI → Site settings → Env vars):
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON (single-line string)
 *   FIREBASE_STORAGE_BUCKET   — e.g. "kreddlo.firebasestorage.app"
 *   BREVO_API_KEY             — for admin notification email
 *   BREVO_SENDER_EMAIL        — e.g. noreply@kreddlo.com
 *   BREVO_SENDER_NAME         — e.g. Kreddlo
 *   ADMIN_EMAIL               — email that receives the "new KYC to review" alert
 *   PLATFORM_URL              — e.g. https://kreddlo.com
 *
 * POST body (JSON):
 *   {
 *     uid:          string,   // Firebase Auth UID
 *     frontImage:   string,   // base64 (no data: prefix)
 *     frontType:    string,   // MIME type e.g. "image/jpeg"
 *     backImage:    string,
 *     backType:     string,
 *     selfieImage:  string,
 *     selfieType:   string,
 *   }
 *
 * Response:
 *   200  { ok: true }
 *   400  { error: string }   — validation failure
 *   500  { error: string }   — server failure
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getStorage }                   = require('firebase-admin/storage');

/* ── Singleton Firebase Admin init ── */
function getServices() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    }
    const bucket = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucket) throw new Error('FIREBASE_STORAGE_BUCKET env var is not set.');
    initializeApp({ credential: cert(serviceAccount), storageBucket: bucket });
  }
  return {
    db:      getFirestore(),
    storage: getStorage().bucket(),
  };
}

/* ── MIME → file extension ── */
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

/* ── Max image size: 10 MB decoded ── */
const MAX_BYTES = 10 * 1024 * 1024;

/* ── Upload one base64 image to Storage, return a signed 7-day URL ── */
async function uploadImage(bucket, uid, slot, base64Data, mimeType) {
  const ext  = MIME_EXT[mimeType] || 'jpg';
  const path = `kyc/${uid}/${slot}.${ext}`;
  const buf  = Buffer.from(base64Data, 'base64');

  const file = bucket.file(path);
  await file.save(buf, {
    metadata: {
      contentType: mimeType,
      metadata: { uid, slot, uploadedAt: new Date().toISOString() },
    },
  });

  // Signed URL valid for 7 days — admin reviews within this window
  const [signedUrl] = await file.getSignedUrl({
    action:  'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  return signedUrl;
}

/* ── Optional: send admin notification email via Brevo ── */
async function notifyAdmin({ uid, adminEmail, platformUrl }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey || !adminEmail) return; // silently skip if not configured

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com';
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Kreddlo';
  const reviewUrl   = `${platformUrl || 'https://kreddlo.com'}/admin.html`;

  const body = {
    sender:  { email: senderEmail, name: senderName },
    to:      [{ email: adminEmail }],
    subject: 'New KYC Submission — Action Required',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0d2145;margin:0 0 12px 0;">New KYC Submission</h2>
        <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 20px 0;">
          A freelancer (UID: <code style="background:#f7fafc;padding:2px 6px;border-radius:4px;">${uid}</code>)
          has submitted their NIN card and selfie for identity verification.
        </p>
        <a href="${reviewUrl}" style="display:inline-block;background:#2d8a5e;color:#fff;text-decoration:none;padding:13px 28px;border-radius:50px;font-weight:600;font-size:15px;">
          Review in Admin Panel
        </a>
        <p style="color:#a0aec0;font-size:12px;margin-top:32px;">
          This is an automated notification from Kreddlo. Do not reply to this email.
        </p>
      </div>
    `,
  };

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: {
        'accept':       'application/json',
        'api-key':      apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Non-fatal — log and continue
    console.warn('Admin notification email failed:', err.message);
  }
}


/* ════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════ */
exports.handler = async function (event) {
  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  /* ── 1. Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { uid, frontImage, frontType, backImage, backType, selfieImage, selfieType } = payload;

  /* ── 2. Validate ── */
  if (!uid || typeof uid !== 'string' || uid.length < 4) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid uid' }) };
  }

  const slots = [
    { name: 'frontImage',  data: frontImage,  type: frontType  },
    { name: 'backImage',   data: backImage,   type: backType   },
    { name: 'selfieImage', data: selfieImage, type: selfieType },
  ];

  for (const s of slots) {
    if (!s.data || typeof s.data !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: `${s.name} is missing` }) };
    }
    if (!MIME_EXT[s.type]) {
      return { statusCode: 400, body: JSON.stringify({ error: `${s.name} has unsupported type: ${s.type}` }) };
    }
    const byteLen = Math.ceil(s.data.length * 0.75); // base64 → approximate bytes
    if (byteLen > MAX_BYTES) {
      return { statusCode: 400, body: JSON.stringify({ error: `${s.name} exceeds 10 MB limit` }) };
    }
  }

  /* ── 3. Firebase ── */
  let db, bucket;
  try {
    ({ db, storage: bucket } = getServices());
  } catch (err) {
    console.error('Firebase init error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  /* ── 4. Check that the user exists and isn't already verified ── */
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return { statusCode: 400, body: JSON.stringify({ error: 'User not found' }) };
    }
    const currentStatus = userSnap.data().kycStatus;
    if (currentStatus === 'verified') {
      return { statusCode: 400, body: JSON.stringify({ error: 'User is already verified' }) };
    }
  } catch (err) {
    console.error('Firestore user lookup failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Database error checking user' }) };
  }

  /* ── 5. Upload images in parallel ── */
  let frontUrl, backUrl, selfieUrl;
  try {
    [frontUrl, backUrl, selfieUrl] = await Promise.all([
      uploadImage(bucket, uid, 'nin-front',  frontImage,  frontType),
      uploadImage(bucket, uid, 'nin-back',   backImage,   backType),
      uploadImage(bucket, uid, 'selfie',     selfieImage, selfieType),
    ]);
  } catch (err) {
    console.error('Storage upload error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload images. Please try again.' }) };
  }

  /* ── 6. Write Firestore ── */
  try {
    await db.collection('users').doc(uid).update({
      kycStatus:       'under-review',
      kycDocumentType: 'NIN Card',
      kycSubmittedAt:  FieldValue.serverTimestamp(),
      kycImages: {
        frontUrl,
        backUrl,
        selfieUrl,
      },
      // Clear any previous rejection reason
      kycRejectionReason: FieldValue.delete(),
    });
  } catch (err) {
    console.error('Firestore update error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to record submission. Please try again.' }) };
  }

  /* ── 7. Notify admin (non-blocking) ── */
  await notifyAdmin({
    uid,
    adminEmail:  process.env.ADMIN_EMAIL,
    platformUrl: process.env.PLATFORM_URL,
  });

  /* ── 8. Done ── */
  console.log(`KYC submitted successfully for uid: ${uid}`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
