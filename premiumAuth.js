import { createHash, createSign, randomUUID } from "node:crypto";
import { adminAuth, db, FieldValue, serviceAccountInfo } from "./firebaseAdmin.js";

class HttpError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extras = extras;
  }
}

const PURCHASE_PRODUCTS = new Map([
  [
    "snowtrip_premium_10",
    {
      kind: "credits",
      credits: 10,
    },
  ],
  [
    "snowtrip_premium_30",
    {
      kind: "credits",
      credits: 30,
    },
  ],
  [
    "snowtrip_trip_pass",
    {
      kind: "trip_pass",
      days: 14,
    },
  ],
]);

const PURCHASE_VERIFICATION_MODE = (() => {
  const configured = (
    process.env.PURCHASE_VERIFICATION_MODE ||
    (process.env.NODE_ENV === "production" ? "strict" : "trusted_test")
  )
    .trim()
    .toLowerCase();

  if (configured === "trusted_test" && process.env.NODE_ENV !== "production") {
    return "trusted_test";
  }

  return "strict";
})();

const GOOGLE_PLAY_PACKAGE_NAME =
  process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim() || "app.snowtrip.planner";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

function getBearerToken(req) {
  const header = req.headers.authorization ?? req.headers.Authorization;

  if (typeof header !== "string" || !header.trim()) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return null;
  }

  return match[1].trim();
}

function userRef(uid) {
  return db.collection("users").doc(uid);
}

function ledgerCollectionRef(uid) {
  return userRef(uid).collection("creditLedger");
}

function purchaseReceiptRef(fingerprint) {
  return db.collection("premiumPurchases").doc(fingerprint);
}

function getRequestId(req) {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return randomUUID();
}

function normalizeCreditCount(value) {
  const premiumCredits = Number(value);
  if (!Number.isFinite(premiumCredits) || premiumCredits <= 0) {
    return 0;
  }
  return Math.floor(premiumCredits);
}

function normalizeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value?.toDate === "function") {
    return normalizeDate(value.toDate());
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoStringOrNull(value) {
  const date = normalizeDate(value);
  return date ? date.toISOString() : null;
}

function getPremiumStatusFromProfileSnap(profileSnap) {
  const premiumCredits = normalizeCreditCount(
    profileSnap.exists ? profileSnap.get("premiumCredits") || 0 : 0,
  );
  const tripPassExpiresAt = normalizeDate(
    profileSnap.exists ? profileSnap.get("tripPassExpiresAt") : null,
  );
  const hasTripPass =
    tripPassExpiresAt != null && tripPassExpiresAt.getTime() > Date.now();

  return {
    premiumCredits,
    tripPassExpiresAt,
    hasTripPass,
    hasPremiumAccess: hasTripPass || premiumCredits > 0,
  };
}

function buildPremiumStatusResponse(status, extras = {}) {
  return {
    premiumCredits: status.premiumCredits,
    tripPassExpiresAt: toIsoStringOrNull(status.tripPassExpiresAt),
    hasTripPass: status.hasTripPass,
    hasPremiumAccess: status.hasPremiumAccess,
    entitlementSource: "firestore",
    ...extras,
  };
}

function cleanString(value, { maxLength = 4000 } = {}) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  if (!cleaned) return "";
  return cleaned.slice(0, maxLength);
}

function createPurchaseFingerprint({
  productId,
  purchaseId,
  verificationSource,
  serverVerificationData,
}) {
  const raw = [
    productId,
    purchaseId,
    verificationSource,
    serverVerificationData,
  ].join("|");

  return createHash("sha256").update(raw).digest("hex");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function getGooglePlayServiceAccount() {
  const clientEmail = serviceAccountInfo?.client_email?.trim();
  const privateKey = serviceAccountInfo?.private_key;

  if (!clientEmail || !privateKey) {
    throw new HttpError(
      503,
      "Google Play purchase verification is not configured yet.",
      {
        verification_not_configured: true,
        purchase_verification_mode: PURCHASE_VERIFICATION_MODE,
      },
    );
  }

  return {
    clientEmail,
    privateKey,
  };
}

async function getGooglePlayAccessToken() {
  const { clientEmail, privateKey } = getGooglePlayServiceAccount();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertionHeader = encodeBase64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const assertionPayload = encodeBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: GOOGLE_ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    }),
  );
  const unsignedAssertion = `${assertionHeader}.${assertionPayload}`;
  const signer = createSign("RSA-SHA256");

  signer.update(unsignedAssertion);
  signer.end();

  const signature = signer.sign(privateKey, "base64url");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsignedAssertion}.${signature}`,
  });

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Google OAuth token request failed:", details);
    throw new HttpError(
      503,
      "Google Play purchase verification is unavailable right now.",
      {
        verification_temporarily_unavailable: true,
      },
    );
  }

  const payload = await response.json();
  const accessToken = cleanString(payload?.access_token, { maxLength: 4096 });

  if (!accessToken) {
    throw new HttpError(
      503,
      "Google Play purchase verification is unavailable right now.",
      {
        verification_temporarily_unavailable: true,
      },
    );
  }

  return accessToken;
}

function validateAndroidPurchasePayload(purchase) {
  const platform = purchase.platform.toLowerCase();
  const verificationSource = purchase.verificationSource.toLowerCase();
  const purchaseStatus = purchase.purchaseStatus.toLowerCase();

  if (platform && platform !== "android") {
    throw new HttpError(400, "Only Android Google Play purchases are supported.");
  }

  if (verificationSource && !verificationSource.includes("play")) {
    throw new HttpError(400, "Unsupported purchase verification source.");
  }

  if (
    purchaseStatus &&
    purchaseStatus !== "purchased" &&
    purchaseStatus !== "restored"
  ) {
    throw new HttpError(409, "Purchase is not ready to verify yet.", {
      purchase_not_ready: true,
      purchase_status: purchase.purchaseStatus,
    });
  }
}

async function verifyAndroidPurchaseWithGooglePlay(purchase) {
  validateAndroidPurchasePayload(purchase);

  const accessToken = await getGooglePlayAccessToken();
  const encodedPackage = encodeURIComponent(GOOGLE_PLAY_PACKAGE_NAME);
  const encodedProductId = encodeURIComponent(purchase.productId);
  const encodedToken = encodeURIComponent(purchase.serverVerificationData);
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodedPackage}/purchases/products/${encodedProductId}/tokens/${encodedToken}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (response.status === 404) {
    throw new HttpError(400, "Google Play could not find this purchase.");
  }

  if (!response.ok) {
    const details = await response.text();
    console.error("Google Play product verification failed:", details);
    throw new HttpError(
      503,
      "Google Play purchase verification is unavailable right now.",
      {
        verification_temporarily_unavailable: true,
      },
    );
  }

  const payload = await response.json();
  const purchaseState = Number(payload?.purchaseState);

  if (!Number.isFinite(purchaseState) || purchaseState !== 0) {
    throw new HttpError(
      purchaseState === 2 ? 409 : 400,
      purchaseState === 2
        ? "Purchase is still pending in Google Play."
        : "Google Play did not confirm this purchase.",
      {
        purchase_not_ready: purchaseState === 2,
        purchase_state: purchaseState,
      },
    );
  }

  return {
    verificationStatus: "google_play_verified",
    verificationDetails: {
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      orderId: cleanString(payload?.orderId, { maxLength: 256 }),
      purchaseState,
      purchaseTimeMillis: cleanString(payload?.purchaseTimeMillis, {
        maxLength: 64,
      }),
      acknowledgementState: Number(payload?.acknowledgementState ?? -1),
      consumptionState: Number(payload?.consumptionState ?? -1),
      kind: cleanString(payload?.kind, { maxLength: 128 }),
    },
  };
}

function normalizePurchasePayload(payload) {
  const productId = cleanString(payload?.productId, { maxLength: 128 });
  const purchaseId = cleanString(payload?.purchaseId, { maxLength: 256 });
  const verificationSource = cleanString(payload?.verificationSource, {
    maxLength: 64,
  });
  const serverVerificationData = cleanString(payload?.serverVerificationData, {
    maxLength: 6000,
  });
  const localVerificationData = cleanString(payload?.localVerificationData, {
    maxLength: 6000,
  });
  const transactionDate = cleanString(payload?.transactionDate, {
    maxLength: 64,
  });
  const platform = cleanString(payload?.platform, { maxLength: 32 });
  const purchaseStatus = cleanString(payload?.purchaseStatus, {
    maxLength: 64,
  });

  if (!PURCHASE_PRODUCTS.has(productId)) {
    throw new HttpError(400, "Unknown premium product.");
  }

  if (!purchaseId && !serverVerificationData) {
    throw new HttpError(400, "Purchase proof is missing.");
  }

  if (!verificationSource) {
    throw new HttpError(400, "Purchase verification source is missing.");
  }

  return {
    productId,
    purchaseId,
    verificationSource,
    serverVerificationData,
    localVerificationData,
    transactionDate,
    platform,
    purchaseStatus,
  };
}

function ensurePurchaseVerificationIsConfigured() {
  if (PURCHASE_VERIFICATION_MODE === "trusted_test") {
    return {
      verificationStatus: "trusted_test_unverified",
      verificationDetails: null,
    };
  }

  if (!GOOGLE_PLAY_PACKAGE_NAME) {
    throw new HttpError(
      503,
      "Google Play purchase verification is not configured yet.",
      {
        verification_not_configured: true,
        purchase_verification_mode: PURCHASE_VERIFICATION_MODE,
      },
    );
  }

  return null;
}

export function getPurchaseVerificationMode() {
  return PURCHASE_VERIFICATION_MODE;
}

export async function getPremiumStatus(uid) {
  const profileSnap = await userRef(uid).get();
  return getPremiumStatusFromProfileSnap(profileSnap);
}

export function serializePremiumStatus(status, extras = {}) {
  return buildPremiumStatusResponse(status, extras);
}

export async function optionalFirebaseAuth(req, res, next) {
  const idToken = getBearerToken(req);

  if (!idToken) {
    req.user = null;
    return next();
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      displayName: decoded.name || null,
      isAnonymous: decoded.firebase?.sign_in_provider === "anonymous",
    };

    return next();
  } catch (error) {
    console.error("verifyIdToken failed:", error);

    return res.status(401).json({
      error: "Invalid or expired Firebase ID token.",
      requires_login_refresh: true,
    });
  }
}

export async function reservePremiumCreditIfNeeded(req, res, next) {
  const premium = req.body?.premium === true;

  if (!premium) {
    req.premiumCredit = null;
    return next();
  }

  if (!req.user?.uid) {
    return res.status(401).json({
      error: "Premium requests require login.",
      requires_login: true,
    });
  }

  if (req.user.isAnonymous) {
    return res.status(401).json({
      error: "Please sign in with a real account to use premium.",
      requires_login: true,
    });
  }

  const uid = req.user.uid;
  const profileRef = userRef(uid);
  const requestId = getRequestId(req);

  try {
    const result = await db.runTransaction(async (tx) => {
      const profileSnap = await tx.get(profileRef);

      const status = getPremiumStatusFromProfileSnap(profileSnap);

      if (status.hasTripPass) {
        tx.set(
          profileRef,
          {
            updatedAt: FieldValue.serverTimestamp(),
            email: req.user.email ?? null,
          },
          { merge: true },
        );

        return {
          reserved: false,
          balanceAfter: status.premiumCredits,
          requestId,
          tripPassExpiresAt: status.tripPassExpiresAt,
          hasTripPass: true,
        };
      }

      if (status.premiumCredits < 1) {
        throw new HttpError(403, "No premium credits left.", {
          requires_purchase: true,
        });
      }

      const balanceAfter = status.premiumCredits - 1;
      const ledgerRef = ledgerCollectionRef(uid).doc();

      tx.set(
        profileRef,
        {
          premiumCredits: balanceAfter,
          updatedAt: FieldValue.serverTimestamp(),
          email: req.user.email ?? null,
        },
        { merge: true },
      );

      tx.set(ledgerRef, {
        type: "generate_consume",
        amount: -1,
        balanceAfter,
        requestId,
        route: "/generate",
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        reserved: true,
        balanceAfter,
        requestId,
        tripPassExpiresAt: status.tripPassExpiresAt,
        hasTripPass: false,
      };
    });

    req.premiumCredit = {
      reserved: result.reserved,
      balanceAfter: result.balanceAfter,
      requestId: result.requestId,
      tripPassExpiresAt: toIsoStringOrNull(result.tripPassExpiresAt),
      hasTripPass: result.hasTripPass,
    };

    return next();
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({
        error: error.message,
        ...error.extras,
      });
    }

    console.error("reservePremiumCreditIfNeeded failed:", error);

    return res.status(503).json({
      error: "Could not verify premium credits.",
    });
  }
}

export async function refundPremiumCredit({
  uid,
  requestId,
  reason = "generate_failed",
}) {
  const profileRef = userRef(uid);

  return db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(profileRef);

    if (!profileSnap.exists) {
      throw new Error("User profile not found during refund.");
    }

    const premiumCredits = Number(profileSnap.get("premiumCredits") || 0);
    const balanceAfter = premiumCredits + 1;
    const ledgerRef = ledgerCollectionRef(uid).doc();

    tx.set(
      profileRef,
      {
        premiumCredits: balanceAfter,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    tx.set(ledgerRef, {
      type: "generate_refund",
      amount: 1,
      balanceAfter,
      requestId,
      reason,
      route: "/generate",
      createdAt: FieldValue.serverTimestamp(),
    });

    return balanceAfter;
  });
}

export async function verifyAndGrantPremiumPurchase({
  uid,
  email = null,
  payload,
}) {
  const purchase = normalizePurchasePayload(payload);
  const product = PURCHASE_PRODUCTS.get(purchase.productId);
  const trustedTestVerification = ensurePurchaseVerificationIsConfigured();
  const verifiedPurchase = trustedTestVerification ??
    (await verifyAndroidPurchaseWithGooglePlay(purchase));
  const verificationStatus = verifiedPurchase.verificationStatus;
  const verificationDetails = verifiedPurchase.verificationDetails;
  const fingerprint = createPurchaseFingerprint(purchase);
  const profileRef = userRef(uid);
  const receiptRef = purchaseReceiptRef(fingerprint);
  const verificationTokenHash = createHash("sha256")
    .update(purchase.serverVerificationData)
    .digest("hex");

  return db.runTransaction(async (tx) => {
    const [profileSnap, receiptSnap] = await Promise.all([
      tx.get(profileRef),
      tx.get(receiptRef),
    ]);

    if (receiptSnap.exists) {
      const existingUid = receiptSnap.get("uid");

      if (typeof existingUid === "string" && existingUid && existingUid !== uid) {
        throw new HttpError(
          409,
          "This purchase is already linked to another account.",
        );
      }

      return {
        ...getPremiumStatusFromProfileSnap(profileSnap),
        alreadyProcessed: true,
        grantedProductId: receiptSnap.get("productId") || purchase.productId,
        verificationStatus:
          receiptSnap.get("verificationStatus") || verificationStatus,
        googlePlayOrderId: receiptSnap.get("googlePlayOrderId") || null,
      };
    }

    const currentStatus = getPremiumStatusFromProfileSnap(profileSnap);
    let premiumCredits = currentStatus.premiumCredits;
    let tripPassExpiresAt = currentStatus.tripPassExpiresAt;

    if (product.kind === "credits") {
      premiumCredits += product.credits;
    } else {
      const now = new Date();
      const base =
        tripPassExpiresAt != null && tripPassExpiresAt.getTime() > now.getTime()
          ? tripPassExpiresAt
          : now;

      tripPassExpiresAt = new Date(
        base.getTime() + product.days * 24 * 60 * 60 * 1000,
      );
    }

    const balanceAfter = premiumCredits;
    const ledgerRef = ledgerCollectionRef(uid).doc();

    tx.set(
      profileRef,
      {
        premiumCredits,
        tripPassExpiresAt: tripPassExpiresAt ?? null,
        updatedAt: FieldValue.serverTimestamp(),
        email,
      },
      { merge: true },
    );

    tx.set(ledgerRef, {
      type:
        product.kind === "credits" ? "purchase_credit" : "purchase_trip_pass",
      amount: product.kind === "credits" ? product.credits : 0,
      balanceAfter,
      productId: purchase.productId,
      purchaseId: purchase.purchaseId || null,
      purchaseStatus: purchase.purchaseStatus || null,
      verificationSource: purchase.verificationSource,
      verificationStatus,
      googlePlayOrderId: verificationDetails?.orderId || null,
      googlePlayPurchaseState: verificationDetails?.purchaseState ?? null,
      googlePlayConsumptionState:
        verificationDetails?.consumptionState ?? null,
      googlePlayAcknowledgementState:
        verificationDetails?.acknowledgementState ?? null,
      tripPassExpiresAt: tripPassExpiresAt ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(receiptRef, {
      uid,
      productId: purchase.productId,
      productKind: product.kind,
      purchaseId: purchase.purchaseId || null,
      purchaseStatus: purchase.purchaseStatus || null,
      platform: purchase.platform || null,
      transactionDate: purchase.transactionDate || null,
      verificationSource: purchase.verificationSource,
      verificationStatus,
      verificationPackageName: verificationDetails?.packageName || null,
      googlePlayOrderId: verificationDetails?.orderId || null,
      googlePlayPurchaseState: verificationDetails?.purchaseState ?? null,
      googlePlayPurchaseTimeMillis:
        verificationDetails?.purchaseTimeMillis || null,
      googlePlayConsumptionState:
        verificationDetails?.consumptionState ?? null,
      googlePlayAcknowledgementState:
        verificationDetails?.acknowledgementState ?? null,
      verificationTokenHash,
      grantedCredits: product.kind === "credits" ? product.credits : 0,
      grantedTripPassDays: product.kind === "trip_pass" ? product.days : 0,
      tripPassExpiresAt: tripPassExpiresAt ?? null,
      verifiedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      premiumCredits,
      tripPassExpiresAt,
      hasTripPass:
        tripPassExpiresAt != null && tripPassExpiresAt.getTime() > Date.now(),
      hasPremiumAccess:
        premiumCredits > 0 ||
        (tripPassExpiresAt != null &&
            tripPassExpiresAt.getTime() > Date.now()),
      alreadyProcessed: false,
      grantedProductId: purchase.productId,
      verificationStatus,
      googlePlayOrderId: verificationDetails?.orderId || null,
    };
  });
}
