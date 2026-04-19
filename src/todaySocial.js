import { db, FieldValue } from "../firebaseAdmin.js";

const COMMENTS_COLLECTION = "today_comments";
const LIKES_COLLECTION = "today_likes";
const REPORTS_COLLECTION = "comment_reports";

const COMMENT_STATUS_ACTIVE = "active";
const COMMENT_STATUS_DELETED = "deleted";
const DEFAULT_DISPLAY_NAME = "Traveler";

const MAX_COMMENT_LENGTH = 500;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_REPORT_REASON_LENGTH = 200;

class TodaySocialError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TodaySocialError";
    this.status = status;
  }
}

function commentsCollection() {
  return db.collection(COMMENTS_COLLECTION);
}

function likesCollection() {
  return db.collection(LIKES_COLLECTION);
}

function reportsCollection() {
  return db.collection(REPORTS_COLLECTION);
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== "string") {
    throw new TodaySocialError(400, `${fieldName} is required.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TodaySocialError(400, `${fieldName} is required.`);
  }

  return trimmed;
}

function normalizeCommentText(value) {
  const trimmed = normalizeRequiredString(value, "Comment text");

  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new TodaySocialError(
      400,
      `Comment text must be ${MAX_COMMENT_LENGTH} characters or fewer.`,
    );
  }

  return trimmed;
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return DEFAULT_DISPLAY_NAME;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_DISPLAY_NAME;
  }

  return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function normalizeReportReason(value) {
  const trimmed = normalizeRequiredString(value, "Report reason");

  if (trimmed.length > MAX_REPORT_REASON_LENGTH) {
    throw new TodaySocialError(
      400,
      `Report reason must be ${MAX_REPORT_REASON_LENGTH} characters or fewer.`,
    );
  }

  return trimmed;
}

function toMillis(value) {
  if (!value) return 0;

  if (typeof value?.toMillis === "function") {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toIsoString(value) {
  if (!value) return "";

  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    return value;
  }

  return "";
}

function serializeComment(id, data = {}) {
  return {
    id,
    featuredPlaceId: String(data.featuredPlaceId || ""),
    userId: String(data.userId || ""),
    userDisplayName: normalizeDisplayName(data.userDisplayName),
    text: String(data.text || ""),
    createdAt: toIsoString(data.createdAt),
    status: String(data.status || COMMENT_STATUS_ACTIVE),
  };
}

function getLikeDocumentId(featuredPlaceId, userId) {
  return Buffer.from(`${featuredPlaceId}:${userId}`).toString("base64url");
}

function chunkList(items, size = 10) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function createSocialStateEntry() {
  return {
    likeCount: 0,
    commentCount: 0,
    isLiked: false,
  };
}

export async function buildTodaySocialState(featuredPlaceIds) {
  const normalizedIds = [...new Set(
    (Array.isArray(featuredPlaceIds) ? featuredPlaceIds : [])
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean),
  )];
  const socialStateByPlaceId = new Map(
    normalizedIds.map((id) => [id, createSocialStateEntry()]),
  );

  for (const chunk of chunkList(normalizedIds)) {
    const [commentSnapshot, likeSnapshot] = await Promise.all([
      commentsCollection().where("featuredPlaceId", "in", chunk).get(),
      likesCollection().where("featuredPlaceId", "in", chunk).get(),
    ]);

    for (const doc of commentSnapshot.docs) {
      const data = doc.data() || {};
      const featuredPlaceId = String(data.featuredPlaceId || "");
      if (!socialStateByPlaceId.has(featuredPlaceId)) continue;
      if (String(data.status || COMMENT_STATUS_ACTIVE) !== COMMENT_STATUS_ACTIVE) {
        continue;
      }

      socialStateByPlaceId.get(featuredPlaceId).commentCount += 1;
    }

    for (const doc of likeSnapshot.docs) {
      const data = doc.data() || {};
      const featuredPlaceId = String(data.featuredPlaceId || "");
      if (!socialStateByPlaceId.has(featuredPlaceId)) continue;

      socialStateByPlaceId.get(featuredPlaceId).likeCount += 1;
    }
  }

  return socialStateByPlaceId;
}

export async function listActiveComments(featuredPlaceId) {
  const normalizedFeaturedPlaceId = normalizeRequiredString(
    featuredPlaceId,
    "Featured place id",
  );

  const snapshot = await commentsCollection()
    .where("featuredPlaceId", "==", normalizedFeaturedPlaceId)
    .where("status", "==", COMMENT_STATUS_ACTIVE)
    .get();

  return snapshot.docs
    .map((doc) => {
      const data = doc.data() || {};

      return {
        comment: serializeComment(doc.id, data),
        createdAtMs: toMillis(data.createdAt),
      };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map((entry) => entry.comment);
}

export async function createTodayComment({
  featuredPlaceId,
  userId,
  userDisplayName,
  text,
}) {
  const normalizedFeaturedPlaceId = normalizeRequiredString(
    featuredPlaceId,
    "Featured place id",
  );
  const normalizedUserId = normalizeRequiredString(userId, "User id");
  const normalizedText = normalizeCommentText(text);
  const normalizedDisplayName = normalizeDisplayName(userDisplayName);

  const ref = commentsCollection().doc();
  await ref.set({
    featuredPlaceId: normalizedFeaturedPlaceId,
    userId: normalizedUserId,
    userDisplayName: normalizedDisplayName,
    text: normalizedText,
    status: COMMENT_STATUS_ACTIVE,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snapshot = await ref.get();

  return serializeComment(ref.id, snapshot.data() || {});
}

export async function softDeleteTodayComment({ commentId, userId }) {
  const normalizedCommentId = normalizeRequiredString(commentId, "Comment id");
  const normalizedUserId = normalizeRequiredString(userId, "User id");
  const ref = commentsCollection().doc(normalizedCommentId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new TodaySocialError(404, "Comment not found.");
  }

  const existing = snapshot.data() || {};
  if (String(existing.userId || "") !== normalizedUserId) {
    throw new TodaySocialError(403, "You can only delete your own comment.");
  }

  if (String(existing.status || COMMENT_STATUS_ACTIVE) === COMMENT_STATUS_DELETED) {
    return serializeComment(snapshot.id, existing);
  }

  await ref.update({
    status: COMMENT_STATUS_DELETED,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updatedSnapshot = await ref.get();
  return serializeComment(updatedSnapshot.id, updatedSnapshot.data() || {});
}

export async function createCommentReport({
  commentId,
  reporterUserId,
  reason,
}) {
  const normalizedCommentId = normalizeRequiredString(commentId, "Comment id");
  const normalizedReporterUserId = normalizeRequiredString(
    reporterUserId,
    "Reporter user id",
  );
  const normalizedReason = normalizeReportReason(reason);

  const commentSnapshot = await commentsCollection().doc(normalizedCommentId).get();

  if (!commentSnapshot.exists) {
    throw new TodaySocialError(404, "Comment not found.");
  }

  const comment = commentSnapshot.data() || {};
  const featuredPlaceId = normalizeRequiredString(
    String(comment.featuredPlaceId || ""),
    "Featured place id",
  );

  const ref = reportsCollection().doc();
  await ref.set({
    commentId: normalizedCommentId,
    featuredPlaceId,
    reporterUserId: normalizedReporterUserId,
    reason: normalizedReason,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    id: ref.id,
    commentId: normalizedCommentId,
    featuredPlaceId,
  };
}

export async function toggleTodayLike({ featuredPlaceId, userId }) {
  const normalizedFeaturedPlaceId = normalizeRequiredString(
    featuredPlaceId,
    "Featured place id",
  );
  const normalizedUserId = normalizeRequiredString(userId, "User id");
  const ref = likesCollection().doc(
    getLikeDocumentId(normalizedFeaturedPlaceId, normalizedUserId),
  );

  let liked = false;

  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);

    if (snapshot.exists) {
      tx.delete(ref);
      liked = false;
      return;
    }

    tx.set(ref, {
      featuredPlaceId: normalizedFeaturedPlaceId,
      userId: normalizedUserId,
      createdAt: FieldValue.serverTimestamp(),
    });
    liked = true;
  });

  const likeCountSnapshot = await likesCollection()
    .where("featuredPlaceId", "==", normalizedFeaturedPlaceId)
    .get();

  return {
    liked,
    likeCount: likeCountSnapshot.size,
  };
}

export { COMMENT_STATUS_ACTIVE, TodaySocialError };
