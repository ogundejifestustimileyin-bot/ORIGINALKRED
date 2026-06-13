/**
 * Netlify Function: create-payout.js
 * Path: netlify/functions/create-payout.js
 *
 * Handles all freelancer withdrawal requests.
 *
 * Routes to one of two payout paths based on the `method` field in the
 * request body:
 *
 *   method: 'bank'
 *     — Withdraws fiat earnings (fiatBalance) to a real bank account.
 *     — Uses Paystack Transfer API for Nigeria and supported African countries.
 *     — Uses Stripe Payouts API for international bank accounts (USD/EUR/GBP).
 *     — Deducts from fiatBalance on success.
 *
 *   method: 'crypto'
 *     — Withdraws crypto earnings (cryptoBalance) to a wallet address.
 *     — Uses NOWPayments Mass Payout API (unchanged from previous version).
 *     — Deducts from cryptoBalance on success.
 *     — Falls back to availableBalance for legacy accounts with no cryptoBalance.
 *
 * Both paths:
 *   1. Validate + parse request body
 *   2. Verify user exists, role = freelancer, KYC = verified
 *   3. Check sufficient balance in the correct field
 *   4. Create a pending /payouts Firestore document
 *   5. Call the appropriate external payout API
 *   6. Update the payout document to 'sent' or 'failed'
 *   7. Deduct the amount from the correct balance field
 *   8. Send withdrawal confirmation email
 *   9. Return success response to client
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key (crypto path)
 *   PAYSTACK_SECRET_KEY       — Paystack secret key (bank path, African accounts)
 *   STRIPE_SECRET_KEY         — Stripe secret key (bank path, international accounts)
 *   PLATFORM_URL              — Live domain e.g. https://kreddlo.com
 */

'use strict';

const https = require('https');

/* ═══════════════════════════════════════════════════════════════
   FIREBASE ADMIN — lazy singleton
   Uses firebase-admin pattern consistent with all other functions.
═══════════════════════════════════════════════════════════════ */
let _db  = null;
let _fv  = null; // FieldValue

function getDb() {
  if (_db) return _db;

  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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
  _fv = FieldValue;
  return _db;
}

function getFieldValue() {
  if (!_fv) getDb(); // ensures _fv is populated
  return _fv;
}

/* ═══════════════════════════════════════════════════════════════
   SHARED HELPERS
═══════════════════════════════════════════════════════════════ */

/** Format a number as a USD display string */
function usd(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Truncate a wallet address for safe display in emails */
function shortWallet(addr) {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-6);
}

/** Mask a bank account number for safe display — shows last 4 digits only */
function maskAccount(accountNumber) {
  if (!accountNumber) return '****';
  const s = String(accountNumber).replace(/\s/g, '');
  return '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}

/**
 * Low-level HTTPS POST — returns { status, body }.
 * Used for NOWPayments (which needs raw https, not fetch).
 */
function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(data);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Call a sibling Netlify function by name.
 * Non-fatal — logs errors but never throws.
 */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`[create-payout] PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[create-payout] ${functionName} returned ${res.status}: ${txt}`);
    }
  } catch (err) {
    console.error(`[create-payout] Failed to call ${functionName}:`, err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   CRYPTO PATH — NOWPayments Mass Payout API
   Docs: https://documenter.getpostman.com/view/7907941/2s93JqTRWN
═══════════════════════════════════════════════════════════════ */
async function initiateNowPaymentsPayout({
  walletAddress,
  currency,    // e.g. "USDT", "BTC"
  coinId,      // e.g. "trc20", "btc" — NOWPayments currency code
  amountCoin,  // exact coin amount to send
  uid,
  payoutDocId,
}) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  const nowCurrency = (coinId || currency || 'usdttrc20').toLowerCase();

  const result = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    {
      withdrawals: [{
        address:            walletAddress,
        currency:           nowCurrency,
        amount:             amountCoin,
        unique_external_id: `kreddlo-${uid}-${Date.now()}`,
        extra_id:           payoutDocId || '',
      }],
    },
    { 'x-api-key': apiKey },
  );

  if (result.status !== 200 && result.status !== 201) {
    const errMsg =
      (typeof result.body === 'object' && (result.body.message || result.body.error))
        || `NOWPayments returned status ${result.status}`;
    throw new Error(`NOWPayments error: ${errMsg}`);
  }

  const batchId      = result.body.id || null;
  const withdrawal   = Array.isArray(result.body.withdrawals) ? result.body.withdrawals[0] : null;
  const withdrawalId = withdrawal?.id     || null;
  const nowStatus    = withdrawal?.status || 'WAITING';

  return { batchId, withdrawalId, nowStatus };
}

/* ═══════════════════════════════════════════════════════════════
   BANK PATH — PAYSTACK TRANSFER API
   Used for Nigerian and other supported African bank accounts.
   Docs: https://paystack.com/docs/transfers/single-transfers/

   Flow:
     1. Create a Transfer Recipient (or reuse cached recipientCode)
     2. Initiate the Transfer
═══════════════════════════════════════════════════════════════ */
async function initiatePaystackBankPayout({
  accountNumber,
  accountName,
  bankCode,      // Paystack bank code — e.g. "044" for Access Bank Nigeria
  bankName,
  amountUsd,
  currency,      // e.g. "NGN", "GHS", "KES"
  uid,
  payoutDocId,
  cachedRecipientCode, // if user already has one saved in Firestore
}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set.');

  /*
   * Paystack Transfer amounts are in the smallest currency unit.
   * For NGN: multiply by 100 (kobo). For GHS, KES: also multiply by 100.
   * The frontend sends amountUsd; for simplicity we treat it as the local
   * currency amount since the freelancer's fiatBalance is stored in their
   * local currency equivalent. The frontend is responsible for showing the
   * correct currency to the user before they confirm.
   */
  const amountSmallest = Math.round(amountUsd * 100);

  /* ── Step 1: Create or reuse Transfer Recipient ── */
  let recipientCode = cachedRecipientCode || null;

  if (!recipientCode) {
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        type:           'nuban',        // Nigerian bank account number
        name:           accountName,
        account_number: accountNumber,
        bank_code:      bankCode,
        currency:       currency || 'NGN',
        description:    `Kreddlo payout - ${uid}`,
        metadata: {
          kreddlo_uid:      uid,
          kreddlo_payout_id: payoutDocId,
        },
      }),
    });

    const recipientData = await recipientRes.json();

    if (!recipientRes.ok || !recipientData.status) {
      const detail = recipientData?.message || 'Unknown error creating transfer recipient.';
      throw new Error(`Paystack recipient error: ${detail}`);
    }

    recipientCode = recipientData?.data?.recipient_code;
    if (!recipientCode) {
      throw new Error('Paystack did not return a recipient_code.');
    }
  }

  /* ── Step 2: Initiate Transfer ── */
  const transferRes = await fetch('https://api.paystack.co/transfer', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      source:    'balance',
      amount:    amountSmallest,
      recipient: recipientCode,
      reason:    `Kreddlo earnings withdrawal — ${payoutDocId}`,
      reference: `kreddlo-bank-${uid}-${Date.now()}`,
    }),
  });

  const transferData = await transferRes.json();

  if (!transferRes.ok || !transferData.status) {
    const detail = transferData?.message || 'Unknown error initiating transfer.';
    throw new Error(`Paystack transfer error: ${detail}`);
  }

  const transferCode = transferData?.data?.transfer_code || null;
  const transferStatus = transferData?.data?.status      || 'pending';
  const reference      = transferData?.data?.reference   || null;

  return { recipientCode, transferCode, transferStatus, reference };
}

/* ═══════════════════════════════════════════════════════════════
   BANK PATH — STRIPE PAYOUTS API
   Used for international bank accounts (USD, EUR, GBP, etc.)
   Docs: https://stripe.com/docs/payouts

   Note: Stripe Payouts require the platform to have a verified
   Stripe account with a positive balance in the target currency.
   The amount is debited from the Stripe platform balance and
   sent to the bank account registered on the connected account,
   or to an external bank account object created below.
═══════════════════════════════════════════════════════════════ */
async function initiateStripeBankPayout({
  accountNumber,
  routingNumber,   // required for USD (ABA routing). For IBAN, pass as accountNumber.
  accountHolderName,
  country,         // ISO 3166-1 alpha-2 e.g. "US", "GB", "DE"
  currency,        // ISO 4217 lowercase e.g. "usd", "gbp", "eur"
  amountUsd,
  uid,
  payoutDocId,
}) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const amountSmallest = Math.round(amountUsd * 100); // Stripe uses cents/pence/etc.

  /*
   * Create an external bank account token, then create a payout to it.
   * For production, this requires the Stripe account to have sufficient
   * balance in the target currency. Stripe will debit the platform balance.
   */

  /* ── Step 1: Create external bank account token ── */
  const tokenParams = new URLSearchParams({
    'bank_account[country]':              country.toUpperCase(),
    'bank_account[currency]':             currency.toLowerCase(),
    'bank_account[account_holder_name]':  accountHolderName,
    'bank_account[account_holder_type]':  'individual',
    'bank_account[account_number]':       accountNumber,
  });

  // Routing number is required for US accounts; optional/absent for IBAN-based accounts
  if (routingNumber && routingNumber.trim()) {
    tokenParams.append('bank_account[routing_number]', routingNumber.trim());
  }

  const tokenRes = await fetch('https://api.stripe.com/v1/tokens', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: tokenParams.toString(),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    const detail = tokenData?.error?.message || 'Unknown error creating bank account token.';
    throw new Error(`Stripe token error: ${detail}`);
  }

  const bankToken = tokenData.id;

  /* ── Step 2: Create Stripe Payout ── */
  const payoutParams = new URLSearchParams({
    amount:      amountSmallest,
    currency:    currency.toLowerCase(),
    method:      'standard',
    description: `Kreddlo earnings withdrawal — ${payoutDocId}`,
    metadata:    JSON.stringify({ kreddlo_uid: uid, kreddlo_payout_id: payoutDocId }),
    destination: bankToken,
    statement_descriptor: 'KREDDLO PAYOUT',
  });

  const payoutRes = await fetch('https://api.stripe.com/v1/payouts', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: payoutParams.toString(),
  });

  const payoutData = await payoutRes.json();

  if (!payoutRes.ok) {
    const detail = payoutData?.error?.message || 'Unknown error creating Stripe payout.';
    throw new Error(`Stripe payout error: ${detail}`);
  }

  const stripePayoutId = payoutData.id     || null;
  const stripeStatus   = payoutData.status || 'pending';
  const arrivalDate    = payoutData.arrival_date || null;

  return { stripePayoutId, stripeStatus, arrivalDate, bankToken };
}

/* ═══════════════════════════════════════════════════════════════
   CORS HEADERS — reused in every response
═══════════════════════════════════════════════════════════════ */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body:    JSON.stringify(body),
  };
}

/* ═══════════════════════════════════════════════════════════════
   MAIN HANDLER
═══════════════════════════════════════════════════════════════ */
exports.handler = async function (event) {

  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  /* ── Read method — determines which payout path to take ── */
  const method = (payload.method || '').toLowerCase(); // 'bank' | 'crypto'

  if (method !== 'bank' && method !== 'crypto') {
    return respond(400, { error: 'method must be "bank" or "crypto".' });
  }

  /* ── Common required fields ── */
  const { uid, amount } = payload;

  if (!uid || typeof uid !== 'string') {
    return respond(400, { error: 'Missing user ID.' });
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) < 5) {
    return respond(400, { error: 'Minimum withdrawal amount is $5.00.' });
  }

  const amtUsd = Number(amount);

  /* ════════════════════════════════════════════════════════════
     VALIDATE METHOD-SPECIFIC FIELDS BEFORE HITTING THE DATABASE
  ════════════════════════════════════════════════════════════ */
  if (method === 'crypto') {
    const { currency, coinId, walletAddress, amountCoin } = payload;
    if (!currency || !coinId) {
      return respond(400, { error: 'Missing coin selection.' });
    }
    if (!walletAddress || walletAddress.trim().length < 10) {
      return respond(400, { error: 'Invalid wallet address.' });
    }
    if (!amountCoin || Number(amountCoin) <= 0) {
      return respond(400, { error: 'Coin amount must be greater than zero.' });
    }
  }

  if (method === 'bank') {
    const { accountNumber, accountName, bankName, bankProvider } = payload;
    if (!accountNumber || String(accountNumber).trim().length < 4) {
      return respond(400, { error: 'Invalid account number.' });
    }
    if (!accountName || accountName.trim().length < 2) {
      return respond(400, { error: 'Account holder name is required.' });
    }
    if (!bankName || bankName.trim().length < 2) {
      return respond(400, { error: 'Bank name is required.' });
    }
    // bankProvider: 'paystack' | 'stripe'
    if (bankProvider !== 'paystack' && bankProvider !== 'stripe') {
      return respond(400, { error: 'bankProvider must be "paystack" or "stripe".' });
    }
  }

  /* ════════════════════════════════════════════════════════════
     DATABASE — verify user, role, KYC, and balance
  ════════════════════════════════════════════════════════════ */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[create-payout] Firebase init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const FieldValue = getFieldValue();

  const userRef  = db.collection('users').doc(uid);
  let   userSnap;
  try {
    userSnap = await userRef.get();
  } catch (err) {
    console.error('[create-payout] Firestore read failed:', err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    return respond(404, { error: 'User not found.' });
  }

  const userData = userSnap.data();

  /* Role guard */
  if (userData.role !== 'freelancer') {
    return respond(403, { error: 'Only freelancers can withdraw funds.' });
  }

  /* KYC guard */
  if (userData.kycStatus !== 'verified') {
    return respond(403, { error: 'KYC verification required before withdrawing.' });
  }

  /* ── Resolve the correct balance field and current balance ── */
  /*
   * crypto path → reads from cryptoBalance; falls back to availableBalance
   *               for legacy accounts that pre-date the dual-balance schema.
   * bank path   → reads from fiatBalance exclusively.
   */
  let balanceField;
  let currentBalance;

  if (method === 'crypto') {
    const cryptoBal    = Number(userData.cryptoBalance    ?? null);
    const legacyBal    = Number(userData.availableBalance ?? 0);
    const hasCryptoBal = userData.cryptoBalance !== undefined && userData.cryptoBalance !== null;

    balanceField    = hasCryptoBal ? 'cryptoBalance' : 'availableBalance';
    currentBalance  = hasCryptoBal ? cryptoBal       : legacyBal;
  } else {
    balanceField   = 'fiatBalance';
    currentBalance = Number(userData.fiatBalance || 0);
  }

  if (currentBalance < amtUsd) {
    const balanceLabel = method === 'bank' ? 'Fiat balance' : 'Crypto balance';
    return respond(400, {
      error: `Insufficient balance. ${balanceLabel}: ${usd(currentBalance)}, Requested: ${usd(amtUsd)}.`,
    });
  }

  /* ════════════════════════════════════════════════════════════
     CREATE PENDING PAYOUT DOCUMENT
     Created before calling the external API so we have a doc ID
     to pass as a reconciliation reference.
  ════════════════════════════════════════════════════════════ */
  const basePayoutData = {
    userUid:       uid,
    userName:      userData.name  || '',
    userEmail:     userData.email || '',
    amount:        amtUsd,
    payoutType:    method,           // 'bank' | 'crypto'
    balanceField,                    // which Firestore field was debited
    status:        'pending',
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };

  /* Merge method-specific fields into the document */
  let payoutDocData;

  if (method === 'crypto') {
    const { currency, coinId, network, walletAddress, amountCoin,
            exchangeRate, usdtRate, fees, amountUsdt } = payload;

    payoutDocData = {
      ...basePayoutData,
      currency:      currency.toUpperCase(),
      coinId,
      network:       network       || '',
      walletAddress: walletAddress.trim(),
      amountCoin:    Number(amountCoin),
      amountUsdt:    Number(amountUsdt    || 0),
      exchangeRate:  Number(exchangeRate  || 0),
      usdtRate:      Number(usdtRate      || 0),
      fees: {
        nowpaymentsFee: Number(fees?.nowpaymentsFee || 0),
        platformFee:    Number(fees?.platformFee    || 0),
      },
      batchId:      null,
      withdrawalId: null,
      nowStatus:    null,
    };
  } else {
    const { accountNumber, accountName, bankName, bankCode,
            routingNumber, country, currency, bankProvider,
            recipientCode } = payload;

    payoutDocData = {
      ...basePayoutData,
      bankProvider:  bankProvider,                    // 'paystack' | 'stripe'
      accountNumber: String(accountNumber).trim(),
      accountName:   accountName.trim(),
      bankName:      bankName.trim(),
      bankCode:      bankCode      || '',
      routingNumber: routingNumber || '',
      country:       country       || '',
      currency:      (currency     || 'USD').toUpperCase(),
      recipientCode: recipientCode || null,           // Paystack only; cached if available
      transferCode:  null,
      transferRef:   null,
      providerPayoutId: null,
    };
  }

  let payoutRef;
  try {
    payoutRef = await db.collection('payouts').add(payoutDocData);
  } catch (err) {
    console.error('[create-payout] Failed to create payout document:', err.message);
    return respond(500, { error: 'Failed to record withdrawal request.' });
  }

  const payoutId = payoutRef.id;
  console.log(`[create-payout] Payout doc created: ${payoutId} (method: ${method})`);

  /* ════════════════════════════════════════════════════════════
     CALL THE EXTERNAL PAYOUT API
  ════════════════════════════════════════════════════════════ */

  if (method === 'crypto') {
    /* ── CRYPTO PATH ── */
    const { currency, coinId, walletAddress, amountCoin } = payload;
    const coinAmt = Number(amountCoin);

    let batchId, withdrawalId, nowStatus;

    try {
      ({ batchId, withdrawalId, nowStatus } = await initiateNowPaymentsPayout({
        walletAddress: walletAddress.trim(),
        currency,
        coinId,
        amountCoin: coinAmt,
        uid,
        payoutDocId: payoutId,
      }));
    } catch (nowErr) {
      console.error('[create-payout] NOWPayments error:', nowErr.message);
      await payoutRef.update({
        status:    'failed',
        errorMsg:  nowErr.message,
        updatedAt: new Date(),
      }).catch(() => {});
      return respond(502, { error: nowErr.message });
    }

    /* Update payout doc to sent */
    await payoutRef.update({
      status:       'sent',
      batchId:      batchId      || null,
      withdrawalId: withdrawalId || null,
      nowStatus:    nowStatus    || null,
      updatedAt:    new Date(),
    }).catch(err => console.error('[create-payout] payout doc update failed:', err.message));

    /* Deduct from the correct crypto balance */
    const newBalance = Math.max(0, currentBalance - amtUsd);
    try {
      await userRef.update({
        [balanceField]: newBalance,
        totalWithdrawn: FieldValue.increment(amtUsd),
        updatedAt:      new Date(),
      });
    } catch (err) {
      console.error('[create-payout] Balance deduction failed:', err.message);
      // Non-fatal at this point — payout is already sent; admin must reconcile
    }

    /* Send confirmation email */
    await callFunction('send-email', {
      templateId:    'withdrawal-initiated',
      to:            userData.email,
      data: {
        name:          userData.name || 'Freelancer',
        amount:        usd(amtUsd),
        coinAmount:    coinAmt.toFixed(coinAmt < 0.01 ? 8 : 4),
        currency:      currency.toUpperCase(),
        network:       payload.network || '',
        walletAddress: shortWallet(walletAddress.trim()),
        payoutId,
        newBalance:    usd(newBalance),
      },
    });

    console.log(`[create-payout] Crypto withdrawal sent — payoutId: ${payoutId}, uid: ${uid}, amount: ${usd(amtUsd)}`);

    return respond(200, {
      success:      true,
      payoutId,
      batchId:      batchId      || null,
      withdrawalId: withdrawalId || null,
      nowStatus:    nowStatus    || null,
      newBalance,
      message:      `Crypto withdrawal of ${usd(amtUsd)} initiated successfully.`,
    });

  } else {
    /* ── BANK PATH ── */
    const {
      accountNumber, accountName, bankName, bankCode,
      routingNumber, country, currency, bankProvider,
      recipientCode: cachedRecipientCode,
    } = payload;

    let providerResult;

    if (bankProvider === 'paystack') {
      /* ── Paystack Transfer (Nigeria / supported African countries) ── */
      try {
        providerResult = await initiatePaystackBankPayout({
          accountNumber: String(accountNumber).trim(),
          accountName:   accountName.trim(),
          bankCode:      bankCode || '',
          bankName:      bankName.trim(),
          amountUsd,
          currency:      currency || 'NGN',
          uid,
          payoutDocId:   payoutId,
          cachedRecipientCode: cachedRecipientCode || null,
        });
      } catch (psErr) {
        console.error('[create-payout] Paystack error:', psErr.message);
        await payoutRef.update({
          status:    'failed',
          errorMsg:  psErr.message,
          updatedAt: new Date(),
        }).catch(() => {});
        return respond(502, { error: psErr.message });
      }

      /* Update payout doc */
      await payoutRef.update({
        status:           'sent',
        recipientCode:    providerResult.recipientCode   || null,
        transferCode:     providerResult.transferCode    || null,
        transferRef:      providerResult.reference       || null,
        providerStatus:   providerResult.transferStatus  || null,
        updatedAt:        new Date(),
      }).catch(err => console.error('[create-payout] payout doc update failed:', err.message));

      /*
       * Cache the Paystack recipient code on the user document so future
       * withdrawals to the same account skip the recipient creation step.
       * Stored under bankDetails.recipientCode — only updated if we just
       * created a fresh one (i.e. cachedRecipientCode was absent).
       */
      if (!cachedRecipientCode && providerResult.recipientCode) {
        await userRef.update({
          'bankDetails.recipientCode': providerResult.recipientCode,
          updatedAt: new Date(),
        }).catch(err => console.warn('[create-payout] Failed to cache recipientCode:', err.message));
      }

    } else {
      /* ── Stripe Payout (international bank accounts) ── */
      try {
        providerResult = await initiateStripeBankPayout({
          accountNumber:     String(accountNumber).trim(),
          routingNumber:     routingNumber || '',
          accountHolderName: accountName.trim(),
          country:           country   || 'US',
          currency:          currency  || 'usd',
          amountUsd,
          uid,
          payoutDocId: payoutId,
        });
      } catch (stripeErr) {
        console.error('[create-payout] Stripe error:', stripeErr.message);
        await payoutRef.update({
          status:    'failed',
          errorMsg:  stripeErr.message,
          updatedAt: new Date(),
        }).catch(() => {});
        return respond(502, { error: stripeErr.message });
      }

      /* Update payout doc */
      await payoutRef.update({
        status:           'sent',
        providerPayoutId: providerResult.stripePayoutId || null,
        providerStatus:   providerResult.stripeStatus   || null,
        arrivalDate:      providerResult.arrivalDate     || null,
        updatedAt:        new Date(),
      }).catch(err => console.error('[create-payout] payout doc update failed:', err.message));
    }

    /* ── Deduct from fiatBalance ── */
    const newBalance = Math.max(0, currentBalance - amtUsd);
    try {
      await userRef.update({
        fiatBalance:    newBalance,
        totalWithdrawn: FieldValue.increment(amtUsd),
        updatedAt:      new Date(),
      });
    } catch (err) {
      console.error('[create-payout] fiatBalance deduction failed:', err.message);
    }

    /* ── Send confirmation email ── */
    await callFunction('send-email', {
      templateId: 'withdrawal-initiated',
      to:         userData.email,
      data: {
        name:          userData.name || 'Freelancer',
        amount:        usd(amtUsd),
        bankName:      bankName.trim(),
        accountNumber: maskAccount(accountNumber),
        accountName:   accountName.trim(),
        payoutId,
        newBalance:    usd(newBalance),
        provider:      bankProvider,
      },
    });

    console.log(
      `[create-payout] Bank withdrawal sent — payoutId: ${payoutId}, ` +
      `uid: ${uid}, amount: ${usd(amtUsd)}, provider: ${bankProvider}`
    );

    return respond(200, {
      success:    true,
      payoutId,
      newBalance,
      provider:   bankProvider,
      message:    `Bank withdrawal of ${usd(amtUsd)} initiated successfully.`,
    });
  }
};
