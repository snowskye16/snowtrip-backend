import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

function getFirebaseCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  return applicationDefault();
}

const adminApp =
  getApps()[0] ||
  initializeApp({
    credential: getFirebaseCredential(),
  });

const adminAuth = getAuth(adminApp);
const db = getFirestore(adminApp);

export { adminAuth, db, FieldValue };