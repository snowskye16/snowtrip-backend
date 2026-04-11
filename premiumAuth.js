import { randomUUID } from "node:crypto";
import { adminAuth, db, FieldValue } from "./firebaseAdmin.js";

class HttpError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extras = extras;
  }
}

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

function getRequestId(req) {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return randomUUID();
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

      const premiumCredits = Number(
        profileSnap.exists ? profileSnap.get("premiumCredits") || 0 : 0,
      );

      if (premiumCredits < 1) {
        throw new HttpError(403, "No premium credits left.", {
          requires_purchase: true,
        });
      }

      const balanceAfter = premiumCredits - 1;
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
        balanceAfter,
        requestId,
      };
    });

    req.premiumCredit = {
      reserved: true,
      balanceAfter: result.balanceAfter,
      requestId: result.requestId,
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
