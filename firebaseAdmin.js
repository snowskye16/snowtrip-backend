import fs from "fs";
import path from "path";
import { getApps, initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function loadServiceAccountInfo() {
  const localKeyPath = path.resolve(process.cwd(), "serviceAccountKey.json");
  if (fs.existsSync(localKeyPath)) {
    return JSON.parse(fs.readFileSync(localKeyPath, "utf8"));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH) {
    const resolvedPath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH);
    return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  }

  return null;
}

const serviceAccountInfo = loadServiceAccountInfo();

function getFirebaseCredential() {
  if (serviceAccountInfo) {
    return cert(serviceAccountInfo);
  }

  return applicationDefault();
}

const adminApp =
  getApps()[0] ||
  initializeApp({
    credential: getFirebaseCredential(),
  });

export const adminAuth = getAuth(adminApp);
export const adminAppCheck = getAppCheck(adminApp);
export const db = getFirestore(adminApp);
export { serviceAccountInfo };
export { FieldValue };
