import { randomUUID } from "node:crypto";
import { adminAuth, db, FieldValue } from "./firebaseAdmin.js";

class HttpError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.status = status;
    this.extras = extras;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== "string") return null;

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  return token.trim();
}

function userRef(uid) {
  return db.collection("users").doc(uid);
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
    };

    return next();
  } catch (error) {
    console.error("verifyIdToken failed:", error);
    return res.status(401).json({
      error: "Invalid or expired Firebase ID token.",
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

  const uid = req.user.uid;
  const profileRef = userRef(uid);
  const ledgerRef = profileRef.collection("creditLedger").doc();
  const requestId = req.headers["x-request-id"] || randomUUID();

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(profileRef);

      if (!snap.exists) {
        throw new HttpError(403, "User profile not found.", {
          requires_login_refresh: true,
        });
      }

      const premiumCredits = Number(snap.get("premiumCredits") || 0);

      if (premiumCredits < 1) {
        throw new HttpError(403, "No premium credits left.", {
          requires_purchase: true,
        });
      }

      const balanceAfter = premiumCredits - 1;

      tx.set(
        profileRef,
        {
          premiumCredits: balanceAfter,
          updatedAt: FieldValue.serverTimestamp(),
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

      return { balanceAfter, requestId };
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

export async function refundPremiumCredit({ uid, requestId, reason = "generate_failed" }) {
  const profileRef = userRef(uid);
  const ledgerRef = profileRef.collection("creditLedger").doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(profileRef);

    if (!snap.exists) {
      throw new Error("User profile not found during refund.");
    }

    const premiumCredits = Number(snap.get("premiumCredits") || 0);
    const balanceAfter = premiumCredits + 1;

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