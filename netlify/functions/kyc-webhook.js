/**
 * Netlify Function: kyc-webhook.js
 * Path: netlify/functions/kyc-webhook.js
 *
 * Receives POST webhooks from Didit when a KYC session status changes.
 * Verifies the HMAC-SHA256 signature (X-Signature-V2 header), then:
 *
 *   • Approved  → sets kycStatus = "verified"  in Firestore + success email
 *   • In Review → sets kycStatus = "under-review" in Firestore + review email
 *   • Declined  → sets kycStatus = "declined"  in Firestore + rejection email
 *   • All other statuses are acknowledged and logged but not written.
 *
 * This is the companion to kyc-verify.js. Configure this URL in the Didit
 * console under Settings → API & Webhooks:
 *   https://yourdomain.com/.netlify/functions/kyc-webhook
 *
 * Environment variables required:
 *   DIDIT_WEBHOOK_SECRET    — webhook secret from Didit Console
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON (single-line string)
 *   BREVO_API_KEY           — for transactional emails
 *   PLATFORM_URL            — your live domain e.g. https://kreddlo.com
 *   BREVO_SENDER_EMAIL      — verified sender address in Brevo e.g. noreply@kreddlo.com
 *   BREVO_SENDER_NAME       — display name e.g. Kreddlo
 */

const crypto  = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

/* ── Firebase Admin — initialise once ── */
function getDb() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ── Didit status → our internal kycStatus mapping ── */
const STATUS_MAP = {
  'Approved':   'verified',
  'In Review':  'under-review',
  'Declined':   'declined',
};

/* ── Statuses we silently acknowledge without writing to Firestore ── */
const SILENT_STATUSES = new Set([
  'Not Started',
  'In Progress',
  'Awaiting User',
  'Resubmitted',
  'Abandoned',
  'Expired',
  'Kyc Expired',
]);


exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const rawBody = event.body || '';

  /* ── 2. Verify Didit webhook signature ── */
  const webhookSecret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('DIDIT_WEBHOOK_SECRET is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const signatureV2 = event.headers['x-signature-v2'] || '';
  const timestamp   = event.headers['x-timestamp']    || '';

  if (!signatureV2 || !timestamp) {
    console.warn('Didit webhook missing X-Signature-V2 or X-Timestamp headers.');
    return respond(401, { error: 'Missing signature headers.' });
  }

  // Reject stale webhooks (older than 5 minutes)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) {
    console.warn('Didit webhook timestamp too old — possible replay attack.');
    return respond(401, { error: 'Request timestamp too old.' });
  }

  if (!verifySignature(rawBody, signatureV2, webhookSecret)) {
    console.warn('Didit webhook signature mismatch — rejected.');
    return respond(401, { error: 'Invalid signature.' });
  }

  /* ── 3. Parse verified payload ── */
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    session_id,
    status,           // "Approved" | "Declined" | "In Review" | etc.
    vendor_data,      // the Firebase UID we passed at session creation
    webhook_type,     // "status.updated" is the one we care about
    decision,         // nested object with per-feature results
  } = payload;

  console.log(`Didit webhook — sessionId: ${session_id}, status: ${status}, uid: ${vendor_data}, type: ${webhook_type}`);

  /* ── 4. Only act on status.updated webhooks ── */
  if (webhook_type !== 'status.updated') {
    // session.created and other types — acknowledge and ignore
    return respond(200, { received: true });
  }

  /* ── 5. Silently acknowledge in-progress / noise statuses ── */
  if (SILENT_STATUSES.has(status)) {
    console.log(`KYC session ${session_id} is "${status}" — no action taken.`);
    return respond(200, { received: true });
  }

  /* ── 6. Map Didit status to our kycStatus ── */
  const kycStatus = STATUS_MAP[status];
  if (!kycStatus) {
    console.warn(`Unhandled Didit status "${status}" for session ${session_id}.`);
    return respond(200, { received: true });
  }

  /* ── 7. Resolve the Firebase UID ── */
  // vendor_data = Firebase UID (set at session creation in kyc-verify.js)
  const uid = (vendor_data || '').trim();
  if (!uid) {
    console.error(`Didit webhook for session ${session_id} has no vendor_data (uid). Cannot update Firestore.`);
    return respond(200, { received: true });
  }

  /* ── 8. Update Firestore ── */
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
    console.error(`User document for uid ${uid} not found in Firestore.`);
    return respond(200, { received: true }); // 200 so Didit stops retrying
  }

  const user = userSnap.data();

  // Idempotency: skip if already in a terminal verified / declined state
  if (user.kycStatus === 'verified' && kycStatus === 'verified') {
    console.log(`User ${uid} already verified — skipping duplicate webhook.`);
    return respond(200, { received: true });
  }

  // Build the Firestore update payload
  const updateData = {
    kycStatus,
    kycSessionId:      session_id,
    kycDecision:       decision || null,   // full Didit decision object for audit
    kycResolvedAt:     FieldValue.serverTimestamp(),
    updatedAt:         FieldValue.serverTimestamp(),
  };

  try {
    await userRef.update(updateData);
    console.log(`User ${uid} kycStatus updated to "${kycStatus}".`);
  } catch (err) {
    console.error(`Firestore update failed for uid ${uid}:`, err.message);
    return respond(500, { error: 'Database update failed.' });
  }

  /* ── 9. Send push notification ── */
  await sendPushNotification({
    uid,
    kycStatus,
    platformUrl: (process.env.PLATFORM_URL || '').replace(/\/$/, ''),
  });

  /* ── 10. Send notification email via Brevo ── */
  const emailSent = await sendKycEmail({
    kycStatus,
    userEmail: user.email,
    userName:  user.name || 'there',
    uid,
  });

  if (!emailSent) {
    // Non-fatal — Firestore is updated; log and continue
    console.warn(`Brevo email not sent for uid ${uid} (status: ${kycStatus}).`);
  }

  return respond(200, { received: true });
};


/* ══════════════════════════════════════════════════════════════
   SEND PUSH NOTIFICATION
   Calls the send-push-notification Netlify function so the
   bell dot and in-app notification update in real time.
══════════════════════════════════════════════════════════════ */
async function sendPushNotification({ uid, kycStatus, platformUrl }) {
  if (!platformUrl) return;

  const messages = {
    verified:      { title: 'Identity Verified', body: 'Your KYC has been approved. Your profile is now live.' },
    'under-review':{ title: 'Verification Under Review', body: 'Your documents are being reviewed. We will update you within 1 to 2 business days.' },
    declined:      { title: 'Verification Not Approved', body: 'Your identity verification was not approved. You can resubmit from your dashboard.' },
  };

  const msg = messages[kycStatus];
  if (!msg) return;

  try {
    await fetch(`${platformUrl}/.netlify/functions/send-push-notification`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userUid: uid,
        title:   msg.title,
        body:    msg.body,
        url:     `${platformUrl}/dashboard.html`,
      }),
    });
  } catch (err) {
    console.warn(`kyc-webhook: push notification failed for uid ${uid}:`, err.message);
  }
}


/* ══════════════════════════════════════════════════════════════
   SIGNATURE VERIFICATION
   Didit signs webhooks using HMAC-SHA256 (X-Signature-V2).
   The canonical form: sort top-level keys alphabetically,
   stringify with Unicode preserved (no escaped unicode).
   Docs: https://docs.didit.me/integration/webhooks
══════════════════════════════════════════════════════════════ */
function verifySignature(rawBody, signatureV2, secret) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  // Sort top-level keys alphabetically (Didit's canonical form)
  const canonical = JSON.stringify(
    parsed,
    Object.keys(parsed).sort(),
  );

  const expected = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,      'utf8'),
      Buffer.from(signatureV2,   'utf8'),
    );
  } catch {
    return false; // buffers of different length
  }
}


/* ══════════════════════════════════════════════════════════════
   SEND KYC STATUS EMAIL VIA BREVO
   Three different email templates depending on kycStatus.
══════════════════════════════════════════════════════════════ */
async function sendKycEmail({ kycStatus, userEmail, userName, uid }) {
  if (!userEmail) return false;

  const brevoKey      = process.env.BREVO_API_KEY;
  const senderEmail   = process.env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com';
  const senderName    = process.env.BREVO_SENDER_NAME  || 'Kreddlo';
  const platformUrl   = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

  if (!brevoKey) {
    console.warn('BREVO_API_KEY not set — skipping email.');
    return false;
  }

  /* Build email content based on outcome */
  const templates = {
    verified: {
      subject:     'Your identity has been verified on Kreddlo',
      htmlContent: `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0d2145;">
          <img src="${platformUrl}/assets/kreddlo-logo.png" alt="Kreddlo" width="120" style="margin-bottom:32px;" />
          <h1 style="font-size:22px;font-weight:800;margin:0 0 12px;letter-spacing:-0.5px;">
            You are verified, ${userName}
          </h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:rgba(13,33,69,0.7);">
            Your identity verification has been approved. Your Kreddlo profile is now active
            and you can start receiving work and payments from clients worldwide.
          </p>
          <a href="${platformUrl}/dashboard.html"
             style="display:inline-block;background:#2d8a5e;color:#fff;border-radius:50px;
                    padding:12px 28px;font-weight:600;font-size:15px;text-decoration:none;">
            Go to your dashboard
          </a>
          <p style="font-size:12px;color:rgba(13,33,69,0.4);margin-top:40px;">
            Kreddlo. All rights reserved.
          </p>
        </div>`,
    },

    'under-review': {
      subject:     'Your identity verification is under review',
      htmlContent: `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0d2145;">
          <img src="${platformUrl}/assets/kreddlo-logo.png" alt="Kreddlo" width="120" style="margin-bottom:32px;" />
          <h1 style="font-size:22px;font-weight:800;margin:0 0 12px;letter-spacing:-0.5px;">
            Verification under review
          </h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:rgba(13,33,69,0.7);">
            Hi ${userName}, your identity documents have been submitted and are currently
            being reviewed by our team. This usually takes 1 to 2 business days.
            We will email you as soon as a decision is made.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:rgba(13,33,69,0.7);">
            There is nothing more you need to do right now.
          </p>
          <p style="font-size:12px;color:rgba(13,33,69,0.4);margin-top:40px;">
            Kreddlo. All rights reserved.
          </p>
        </div>`,
    },

    declined: {
      subject:     'Your identity verification was not approved',
      htmlContent: `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0d2145;">
          <img src="${platformUrl}/assets/kreddlo-logo.png" alt="Kreddlo" width="120" style="margin-bottom:32px;" />
          <h1 style="font-size:22px;font-weight:800;margin:0 0 12px;letter-spacing:-0.5px;">
            Verification not approved
          </h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:rgba(13,33,69,0.7);">
            Hi ${userName}, unfortunately we were unable to verify your identity at this time.
            This can happen if the document images were unclear, cropped, or expired.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:rgba(13,33,69,0.7);">
            You may submit your documents again. Make sure both sides of your ID are clearly
            visible and that the selfie matches the photo on your document.
          </p>
          <a href="${platformUrl}/verify.html"
             style="display:inline-block;background:#0d2145;color:#fff;border-radius:50px;
                    padding:12px 28px;font-weight:600;font-size:15px;text-decoration:none;">
            Try again
          </a>
          <p style="font-size:13px;line-height:1.6;margin-top:24px;color:rgba(13,33,69,0.5);">
            If you believe this is an error, reply to this email and our team will assist you.
          </p>
          <p style="font-size:12px;color:rgba(13,33,69,0.4);margin-top:40px;">
            Kreddlo. All rights reserved.
          </p>
        </div>`,
    },
  };

  const template = templates[kycStatus];
  if (!template) {
    console.warn(`No email template for kycStatus "${kycStatus}".`);
    return false;
  }

  const emailPayload = {
    sender:      { name: senderName, email: senderEmail },
    to:          [{ email: userEmail, name: userName }],
    subject:     template.subject,
    htmlContent: template.htmlContent,
  };

  try {
    const res = await fetch(BREVO_SEND_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      brevoKey,
      },
      body: JSON.stringify(emailPayload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Brevo API error ${res.status}:`, errBody);
      return false;
    }

    console.log(`Brevo email sent to ${userEmail} for kycStatus "${kycStatus}".`);
    return true;

  } catch (err) {
    console.error('Network error sending Brevo email:', err.message);
    return false;
  }
}


/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
