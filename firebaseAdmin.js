import fs from "fs";
import path from "path";
import { getApps, initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function getFirebaseCredential() {
  const localKeyPath = path.resolve(process.cwd(), "serviceAccountKey.json");
  if (fs.existsSync(localKeyPath)) {
    const raw = fs.readFileSync(localKeyPath, "utf8");
    return cert(JSON.parse(raw));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return cert(parsed);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH) {
    const resolvedPath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    return cert(JSON.parse(raw));
  }

  return applicationDefault();
}

const adminApp =
  getApps()[0] ||
  initializeApp({
    credential: getFirebaseCredential(),
  });

export const adminAuth = getAuth(adminApp);
export const db = getFirestore(adminApp);
export { FieldValue };
