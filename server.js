import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { adminAppCheck } from "./firebaseAdmin.js";
import { listTodayItems } from './src/airtableToday.js';
import {
  buildTodaySocialState,
  TodaySocialError,
  createCommentReport,
  createTodayComment,
  listActiveComments,
  softDeleteTodayComment,
  toggleTodayLike,
} from "./src/todaySocial.js";
import {
  getPremiumStatus,
  optionalFirebaseAuth,
  reservePremiumCreditIfNeeded,
  refundPremiumCredit,
  serializePremiumStatus,
  verifyAndGrantPremiumPurchase,
} from "./premiumAuth.js";


dotenv.config();

const app = express();
app.set("trust proxy", 1);

// ── Config ─────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const FREE_MODEL = process.env.FREE_MODEL || "gpt-5-mini";
const PREMIUM_MODEL = process.env.PREMIUM_MODEL || "gpt-5.4";

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000);
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 3000);
const MIN_DAYS = 1;
const MAX_DAYS = 8;

const FREE_MAX_DAYS = Number(process.env.FREE_MAX_DAYS || 2);
const FREE_REQUESTS_PER_DAY = Number(process.env.FREE_REQUESTS_PER_DAY || 5);
const FREE_WINDOW_MS = Number(
  process.env.FREE_WINDOW_MS || 24 * 60 * 60 * 1000,
);
const MAX_CITIES = Number(process.env.MAX_CITIES || 3);
const APP_CHECK_MODE = (
  process.env.FIREBASE_APP_CHECK_MODE ||
  (process.env.NODE_ENV === "production" ? "warn" : "off")
)
  .trim()
  .toLowerCase();

// In-memory quota store for MVP / single server.
const freeUsageByClient = new Map();

const TRAVELER_PRESET_GUIDANCE = new Map([
  [
    "First-time traveler",
    "Prioritize Korea's most memorable first-visit highlights, easy orientation, and low-friction routing.",
  ],
  [
    "Couple",
    "Favor romantic pacing, scenic neighborhoods, sunset timing, cozy cafes, and date-friendly dinners.",
  ],
  [
    "Budget traveler",
    "Favor strong value, low-cost transport, free viewpoints, market meals, and smarter spend tradeoffs.",
  ],
  [
    "Food lover",
    "Anchor the day around signature local dishes, food streets, markets, cafes, and timing meals well.",
  ],
  [
    "Family",
    "Keep the day family-friendly with easy transitions, flexible timing, kid-friendly stops, and practical breaks.",
  ],
  [
    "Luxury traveler",
    "Favor polished neighborhoods, elevated dining, premium experiences, quieter pacing, and comfort-first flow.",
  ],
]);

// ── Middleware upgrade ─────────────────────────────────────────────────

app.use(express.json({ limit: "25kb" }));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const allowedExact = new Set([
        "https://snowtrip.app",
        "https://www.snowtrip.app",
      ]);

      const isLocalhost =
        /^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);

      if (allowedExact.has(origin) || isLocalhost) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Firebase-AppCheck",
    ],
  }),
);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
});

const premiumLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many premium requests. Slow down." },
});

const socialLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
});

app.use("/generate", limiter);
app.use("/premium", premiumLimiter);
app.use("/comments", socialLimiter);
app.use("/today-items", socialLimiter);

// ── Prompting ──────────────────────────────────────────────────

const BASE_DEVELOPER_PROMPT = `
You are SnowTrip AI, a Korea travel planner.

Output rules:
- Make the itinerary practical, clean, and mobile-friendly.
- Use exactly: Day 1, Day 2, ... up to the requested number of days.
- Under each day, always use: Morning, Afternoon, Evening.
- Keep the route geographically efficient.
- If there are multiple cities, clearly account for transfer time.
- Do not invent exact opening hours, train times, or exact prices when uncertain.
- Prefer estimates and practical language.
- Keep activities realistic for the time of day and transfer distance.
- Group nearby places by area whenever possible.
- Reduce unnecessary cross-neighborhood or cross-city backtracking.
- Match the plan to the stated budget and traveler profile.
- Always include at least one food suggestion per day.
- Always include concise transport guidance.
- End with a short total trip budget estimate.
- Never stop halfway through a day. If space is tight, simplify the plan instead of truncating it.
`.trim();

function buildDeveloperPrompt({
  premium,
  isTailored,
  requestedDays,
  isMultiCity,
}) {
  if (premium && isTailored) {
    return `${BASE_DEVELOPER_PROMPT}

Premium tailored mode rules:
- This is the premium Trip Pass experience. Personalization depth matters.
- Generate a Korea-specific itinerary tailored to travelerType, pace, interests, travelCompanions, specialNeeds, days, city/cities, and budget_krw.
- Reflect premium trip style when the profile suggests it, while still staying realistic for the stated budget.
- Include hidden gems or smart local picks when they improve the route.
- Optimize transport flow and minimize wasteful transfers.
- Honor Less walking, Near subway only, Rain-friendly, Indoor options, Kid-friendly, Late-night friendly, and Airport-day optimized whenever requested.
- Keep the answer structured and easy to parse.
- Start with exactly this block:
Trip Summary
- Tailored for: ...
- Budget: ...
- Route logic: ...
- Then for every day use exactly this shape:
Day N - [City]
Morning:
- ...
Afternoon:
- ...
Evening:
- ...
Food pick: ...
Transport tip: ...
Estimated spend: ...
Why this fits you: ...
Rain backup: ...
- Morning, Afternoon, and Evening should each have 1 to 2 short bullet points.
- Use one city label in each day heading, even for single-city trips.
- Respect the requested trip length of ${requestedDays} day(s).
- Multi-city mode: ${isMultiCity ? "yes" : "no"}.
- End with a short total trip budget estimate.`;
  }

  return `${BASE_DEVELOPER_PROMPT}

Free basic mode rules:
- Keep the answer simpler and more compact, but still complete.
- Free mode should still use clear Day headings.
- Under each day, use Morning, Afternoon, and Evening only.
- Keep each time block to 1 to 2 short bullet points.
- Do not include premium-only sections like Trip Summary, Why this fits you, or Rain backup.
- Prioritize the best-value stops.
- Free requests are for short single-city plans only.
- Respect the requested trip length of ${requestedDays} day(s).`;
}

// ── Helpers ────────────────────────────────────────────────────

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeCityName(value) {
  if (typeof value !== "string") return null;

  const cleaned = value.trim();
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  const aliases = new Map([
    ["seoul", "Seoul"],
    ["busan", "Busan"],
    ["pusan", "Busan"],
    ["jeju", "Jeju"],
    ["jeju island", "Jeju"],
    ["gwangju", "Gwangju"],
    ["daegu", "Daegu"],
    ["incheon", "Incheon"],
    ["suwon", "Suwon"],
    ["gyeongju", "Gyeongju"],
  ]);

  if (aliases.has(lower)) return aliases.get(lower);

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeCities({ city, cities }) {
  const raw = [];

  if (Array.isArray(cities)) raw.push(...cities);
  if (typeof city === "string" && city.trim()) raw.push(city);

  const normalized = raw.map(normalizeCityName).filter(Boolean);
  const unique = [];

  for (const item of normalized) {
    if (!unique.includes(item)) unique.push(item);
  }

  return unique;
}

function sanitizeText(value, maxLength = 80) {
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  return cleaned.slice(0, maxLength);
}

function sanitizeList(value, { maxItems = 6, maxItemLength = 40 } = {}) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const items = [];

  for (const rawItem of rawItems) {
    const cleaned = sanitizeText(rawItem, maxItemLength);
    if (!cleaned) continue;
    if (items.includes(cleaned)) continue;
    items.push(cleaned);
    if (items.length >= maxItems) break;
  }

  return items;
}

function normalizeTravelerType(value) {
  const cleaned = sanitizeText(value, 60);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  const aliases = new Map([
    ["first-time traveler", "First-time traveler"],
    ["first time traveler", "First-time traveler"],
    ["first timer", "First-time traveler"],
    ["couple", "Couple"],
    ["budget traveler", "Budget traveler"],
    ["budget traveller", "Budget traveler"],
    ["food lover", "Food lover"],
    ["family", "Family"],
    ["luxury traveler", "Luxury traveler"],
    ["luxury traveller", "Luxury traveler"],
  ]);

  return aliases.get(lower) || cleaned;
}

function normalizePace(value) {
  const cleaned = sanitizeText(value, 30);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (["slow", "relaxed", "easy"].includes(lower)) return "Relaxed";
  if (["moderate", "balanced", "medium"].includes(lower)) return "Balanced";
  if (["fast", "packed", "active"].includes(lower)) return "Packed";

  return cleaned;
}

function normalizeTravelCompanions(value) {
  const cleaned = sanitizeText(value, 40);
  if (!cleaned) return "Solo";

  const lower = cleaned.toLowerCase();
  const aliases = new Map([
    ["solo", "Solo"],
    ["couple", "Couple"],
    ["friends", "Friends"],
    ["friend group", "Friends"],
    ["family", "Family"],
  ]);

  return aliases.get(lower) || "Solo";
}

function normalizeSpecialNeeds(value) {
  const normalized = [];

  for (const item of sanitizeList(value, { maxItems: 6, maxItemLength: 50 })) {
    const lower = item.toLowerCase();

    if (lower.includes("less walking")) {
      if (!normalized.includes("Less walking")) normalized.push("Less walking");
      continue;
    }

    if (lower.includes("near subway")) {
      if (!normalized.includes("Near subway only")) {
        normalized.push("Near subway only");
      }
      continue;
    }

    if (lower.includes("rain-friendly") || lower.includes("rain friendly")) {
      if (!normalized.includes("Rain-friendly")) {
        normalized.push("Rain-friendly");
      }
      continue;
    }

    if (lower.includes("indoor")) {
      if (!normalized.includes("Indoor options")) {
        normalized.push("Indoor options");
      }
      continue;
    }

    if (lower.includes("kid-friendly") || lower.includes("kid friendly")) {
      if (!normalized.includes("Kid-friendly")) {
        normalized.push("Kid-friendly");
      }
      continue;
    }

    if (
      lower.includes("late-night friendly") ||
      lower.includes("late night friendly")
    ) {
      if (!normalized.includes("Late-night friendly")) {
        normalized.push("Late-night friendly");
      }
      continue;
    }

    if (
      lower.includes("airport-day optimized") ||
      lower.includes("airport day optimized")
    ) {
      if (!normalized.includes("Airport-day optimized")) {
        normalized.push("Airport-day optimized");
      }
      continue;
    }

    normalized.push(item);
  }

  return normalized;
}

function normalizePremiumProfile({
  travelerType,
  pace,
  interests,
  travelCompanions,
  specialNeeds,
}) {
  return {
    travelerType: normalizeTravelerType(travelerType),
    pace: normalizePace(pace),
    interests: sanitizeList(interests, { maxItems: 8, maxItemLength: 32 }),
    travelCompanions: normalizeTravelCompanions(travelCompanions),
    specialNeeds: normalizeSpecialNeeds(specialNeeds),
  };
}

function validateStructuredRequest({
  days,
  city,
  cities,
  budget_krw,
  travelerType,
  pace,
  interests,
  travelCompanions,
  specialNeeds,
  isTailored,
}) {
  const requestedDays = clampNumber(days, MIN_DAYS, MAX_DAYS, NaN);
  if (!Number.isFinite(requestedDays)) {
    return { error: "Invalid days value." };
  }

  const normalizedCities = normalizeCities({ city, cities });
  if (normalizedCities.length === 0) {
    return { error: "Please provide at least one city." };
  }

  if (normalizedCities.length > MAX_CITIES) {
    return { error: `Maximum ${MAX_CITIES} cities per trip request.` };
  }

  const budgetKrw = clampNumber(budget_krw ?? 0, 0, 50000000, 0);
  const premiumProfile = normalizePremiumProfile({
    travelerType,
    pace,
    interests,
    travelCompanions,
    specialNeeds,
  });

  return {
    requestedDays,
    cities: normalizedCities,
    budgetKrw,
    isTailored: isTailored === true,
    premiumProfile,
  };
}

function legacyBuildUserPrompt({ requestedDays, cities, budgetKrw, premium }) {
  const isMultiCity = cities.length > 1;

  return `
Plan a ${requestedDays}-day Korea trip.

Cities: ${cities.join(", ")}
Trip type: ${isMultiCity ? "Multi-city" : "Single-city"}
Traveler style: ${
    premium ? "premium / comfort / aesthetic" : "budget / smart / efficient"
  }
Budget: ${budgetKrw > 0 ? `₩${Math.round(budgetKrw)}` : "Not set"}

Required format:
- Day 1 to Day ${requestedDays}
- Morning / Afternoon / Evening
- Practical route flow
- KRW budget notes
- Transport tips
- Mention intercity transport if multiple cities are included
- End with a short total trip budget estimate
`.trim();
}

function describeBudget({ budgetKrw, requestedDays }) {
  if (!budgetKrw) return "Flexible or not set";

  const dailyBudget = Math.round(budgetKrw / Math.max(1, requestedDays));

  if (dailyBudget < 80000) {
    return `Budget-conscious (about KRW ${dailyBudget.toLocaleString()} per day)`;
  }

  if (dailyBudget < 180000) {
    return `Mid-range (about KRW ${dailyBudget.toLocaleString()} per day)`;
  }

  return `Higher-spend (about KRW ${dailyBudget.toLocaleString()} per day)`;
}

function buildPremiumProfileBlock(profile) {
  const lines = [];

  if (profile.travelerType) {
    lines.push(`Traveler preset: ${profile.travelerType}`);

    const presetGuidance = TRAVELER_PRESET_GUIDANCE.get(profile.travelerType);
    if (presetGuidance) {
      lines.push(`Preset guidance: ${presetGuidance}`);
    }
  }

  if (profile.pace) lines.push(`Pace: ${profile.pace}`);
  if (profile.interests.length > 0) {
    lines.push(`Interests: ${profile.interests.join(", ")}`);
  }
  if (profile.travelCompanions) {
    lines.push(`Travel companions: ${profile.travelCompanions}`);
  }
  if (profile.specialNeeds.length > 0) {
    lines.push(`Special needs: ${profile.specialNeeds.join(", ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No extra premium profile inputs provided.";
}

function buildUserPrompt({
  requestedDays,
  cities,
  budgetKrw,
  premium,
  isTailored,
  premiumProfile,
}) {
  const isMultiCity = cities.length > 1;
  const budgetLabel =
    budgetKrw > 0 ? `KRW ${Math.round(budgetKrw).toLocaleString()}` : "Not set";
  const budgetDescription = describeBudget({ budgetKrw, requestedDays });

  if (premium && isTailored) {
    return `
Create a tailored ${requestedDays}-day Korea itinerary for a Trip Pass premium user.

Trip basics:
- Cities: ${cities.join(", ")}
- Trip type: ${isMultiCity ? "Multi-city" : "Single-city"}
- Total budget: ${budgetLabel}
- Budget level: ${budgetDescription}

Premium traveler profile:
${buildPremiumProfileBlock(premiumProfile)}

Generation rules:
- Group places by area whenever possible.
- Reduce unnecessary cross-city or cross-neighborhood movement.
- Avoid unrealistic schedules and leave enough transit and meal time.
- Align activity choice and pacing to the traveler profile.
- Match the itinerary to the real budget level.
- Include food suggestions every day.
- Include concise transport tips every day.
- Honor Less walking, Near subway only, Rain-friendly, Indoor options, Kid-friendly, Late-night friendly, and Airport-day optimized when requested.
- Build rainy-day fallbacks that still fit the same area or route.
- Explain "Why this fits you" using the actual premium profile instead of generic praise.
- Use Korea-specific neighborhoods, landmarks, food streets, museums, cafes, markets, and scenic spots.

Required premium output format:
Trip Summary
- Tailored for: ...
- Budget: ...
- Route logic: ...

Day 1 - [City]
Morning:
- ...
Afternoon:
- ...
Evening:
- ...
Food pick: ...
Transport tip: ...
Estimated spend: ...
Why this fits you: ...
Rain backup: ...

Repeat that exact day structure through Day ${requestedDays}.
End with: Total trip budget estimate: ...
`.trim();
  }

  return `
Plan a ${requestedDays}-day Korea trip.

Trip basics:
- Cities: ${cities.join(", ")}
- Trip type: ${isMultiCity ? "Multi-city" : "Single-city"}
- Traveler style: basic / value / practical
- Total budget: ${budgetLabel}
- Budget level: ${budgetDescription}

Required format:
- Day 1 to Day ${requestedDays}
- Use clear Day headings
- Under each day, use Morning / Afternoon / Evening
- Use 1 to 2 short bullet points per time block
- Include Food pick: ...
- Include Transport tip: ...
- Include Budget note: ...
- End with Total trip budget estimate: ...
`.trim();
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  return (
    data?.output
      ?.flatMap((item) => item?.content || [])
      ?.filter((part) => part?.type === "output_text")
      ?.map((part) => part?.text || "")
      ?.join("\n")
      ?.trim() || ""
  );
}

function getMaxOutputTokens({ requestedDays, premium, isTailored, isMultiCity }) {
  if (premium && isTailored) {
    const base = isMultiCity ? 1500 : 1250;
    const perDay = isMultiCity ? 260 : 220;
    return Math.min(3600, base + requestedDays * perDay);
  }

  return Math.min(1700, 950 + requestedDays * 190);
}

function buildContinuationPrompt({ premium, isTailored, requestedDays }) {
  if (premium && isTailored) {
    return `Continue from the exact point where the itinerary stopped. Do not repeat earlier text. Keep the same premium structure for the remaining days through Day ${requestedDays}. For each remaining day, include Morning, Afternoon, Evening, Food pick, Transport tip, Estimated spend, Why this fits you, and Rain backup. End with "Total trip budget estimate: ...".`;
  }

  return `Continue from the exact point where the itinerary stopped. Do not repeat earlier text. Finish the remaining Day blocks through Day ${requestedDays}. Keep Morning, Afternoon, Evening, Food pick, Transport tip, and Budget note. End with "Total trip budget estimate: ...".`;
}

function getClientId(req) {
  if (req.user?.uid) {
    return `uid:${req.user.uid}`;
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

async function optionalAppCheck(req, res, next) {
  if (APP_CHECK_MODE === "off") {
    req.appCheck = { verified: false, present: false, mode: APP_CHECK_MODE };
    return next();
  }

  const rawToken =
    req.headers["x-firebase-appcheck"] ?? req.headers["X-Firebase-AppCheck"];

  if (typeof rawToken !== "string" || !rawToken.trim()) {
    req.appCheck = { verified: false, present: false, mode: APP_CHECK_MODE };

    if (APP_CHECK_MODE === "required") {
      return res.status(401).json({
        error: "App integrity check failed. Update Snowtrip and try again.",
        requires_app_check: true,
      });
    }

    return next();
  }

  try {
    const decoded = await adminAppCheck.verifyToken(rawToken.trim());
    req.appCheck = {
      verified: true,
      present: true,
      mode: APP_CHECK_MODE,
      appId: decoded.app_id || decoded.sub || null,
    };
    return next();
  } catch (error) {
    console.error("verifyAppCheckToken failed:", error?.message || error);
    req.appCheck = { verified: false, present: true, mode: APP_CHECK_MODE };

    if (APP_CHECK_MODE === "required") {
      return res.status(401).json({
        error: "App integrity check failed. Update Snowtrip and try again.",
        requires_app_check: true,
      });
    }

    return next();
  }
}

function pruneOldFreeUsage(clientId) {
  const now = Date.now();
  const cutoff = now - FREE_WINDOW_MS;

  const existing = freeUsageByClient.get(clientId) || [];
  const recent = existing.filter((timestamp) => timestamp > cutoff);

  if (recent.length > 0) {
    freeUsageByClient.set(clientId, recent);
  } else {
    freeUsageByClient.delete(clientId);
  }

  return recent;
}

function getFreeQuotaStatus(clientId) {
  const recent = pruneOldFreeUsage(clientId);
  const used = recent.length;
  const remaining = Math.max(0, FREE_REQUESTS_PER_DAY - used);

  return {
    used,
    remaining,
    limit: FREE_REQUESTS_PER_DAY,
    window_ms: FREE_WINDOW_MS,
  };
}

function consumeFreeQuota(clientId) {
  const recent = pruneOldFreeUsage(clientId);
  recent.push(Date.now());
  freeUsageByClient.set(clientId, recent);
  return getFreeQuotaStatus(clientId);
}

function looksIncomplete({ text, requestedDays }) {
  if (!text || typeof text !== "string") return true;

  const trimmed = text.trim();
  if (trimmed.length < 80) return true;

  const hasLastDay = trimmed.includes(`Day ${requestedDays}`);
  const hasBudgetEnding = /total trip budget estimate/i.test(trimmed);
  const endsCleanly = /[.!?)]$/.test(trimmed) || trimmed.endsWith("KRW");

  if (!hasLastDay) return true;
  if (!hasBudgetEnding && !endsCleanly) return true;

  return false;
}

async function createResponse({
  model,
  instructions,
  input,
  reasoningEffort,
  maxOutputTokens,
  previousResponseId,
  signal,
}) {
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      previous_response_id: previousResponseId,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
    }),
  });
}

async function callOpenAI({
  userPrompt,
  premium,
  isTailored,
  requestedDays,
  isMultiCity,
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const model = premium ? PREMIUM_MODEL : FREE_MODEL;
  const instructions = buildDeveloperPrompt({
    premium,
    isTailored,
    requestedDays,
    isMultiCity,
  });
  const maxOutputTokens = getMaxOutputTokens({
    requestedDays,
    premium,
    isTailored,
    isMultiCity,
  });
  const reasoningEffort = premium && isTailored ? "medium" : "low";

  try {
    const response = await createResponse({
      model,
      instructions,
      input: userPrompt,
      reasoningEffort,
      maxOutputTokens,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("OpenAI error status:", response.status);
      console.error("OpenAI error body:", JSON.stringify(data, null, 2));
      return {
        ok: false,
        status: response.status,
        error: data?.error?.message || "AI request failed.",
      };
    }

    let text = extractResponseText(data);
    let finalData = data;

    const incompleteReason = data?.incomplete_details?.reason || null;
    const shouldContinue =
      incompleteReason === "max_output_tokens" ||
      looksIncomplete({ text, requestedDays });

    if (shouldContinue && data?.id) {
      const continuationResponse = await createResponse({
        model,
        instructions,
        input: buildContinuationPrompt({ premium, isTailored, requestedDays }),
        previousResponseId: data.id,
        reasoningEffort: "low",
        maxOutputTokens: premium && isTailored ? 900 : 700,
        signal: controller.signal,
      });

      const continuationData = await continuationResponse
        .json()
        .catch(() => ({}));

      if (continuationResponse.ok) {
        const continuedText = extractResponseText(continuationData);
        if (continuedText) {
          text = `${text}\n${continuedText}`.trim();
          finalData = continuationData;
        }
      } else {
        console.error(
          "OpenAI continuation error:",
          continuationResponse.status,
          JSON.stringify(continuationData, null, 2),
        );
      }
    }

    if (!text) {
      return {
        ok: false,
        status: 502,
        error: "Invalid AI response.",
      };
    }

    return {
      ok: true,
      result: text,
      model,
      tokens:
        (data?.usage?.total_tokens || 0) +
        ((finalData !== data ? finalData?.usage?.total_tokens : 0) || 0),
      inputTokens:
        (data?.usage?.input_tokens || 0) +
        ((finalData !== data ? finalData?.usage?.input_tokens : 0) || 0),
      outputTokens:
        (data?.usage?.output_tokens || 0) +
        ((finalData !== data ? finalData?.usage?.output_tokens : 0) || 0),
      responseId: finalData?.id || data?.id || null,
      incompleteReason,
    };
  } catch (error) {
    console.error("callOpenAI crashed:", error);

    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        error: "OpenAI request timed out.",
      };
    }

    return {
      ok: false,
      status: 503,
      error: error?.message || "Server error. Try again later.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function runMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    try {
      const maybePromise = middleware(req, res, done);

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => done()).catch(reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

async function premiumOnlyGuards(req, res, next) {
  try {
    await runMiddleware(req, res, optionalAppCheck);
    if (res.headersSent) return;

    const premium = req.body?.premium === true;
    if (!premium) {
      req.user = null;
      req.premiumCredit = null;
      return next();
    }

    await runMiddleware(req, res, optionalFirebaseAuth);
    if (res.headersSent) return;

    await runMiddleware(req, res, reservePremiumCreditIfNeeded);
    if (res.headersSent) return;

    if (!req.user?.uid) {
      return res.status(401).json({
        error: "Premium requires a valid Firebase sign-in.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

// ── Routes ─────────────────────────────────────────────────────

function requireAuthenticatedUser(req, res, next) {
  if (req.user?.uid) {
    return next();
  }

  return res.status(401).json({
    error: "Authentication required.",
    requires_login: true,
  });
}

function requirePremiumEligibleUser(req, res, next) {
  if (!req.user?.uid) {
    return res.status(401).json({
      error: "Authentication required.",
      requires_login: true,
    });
  }

  if (req.user.isAnonymous) {
    return res.status(401).json({
      error: "Please sign in with a real account to use premium.",
      requires_login: true,
    });
  }

  return next();
}

function getUserDisplayName(req) {
  const displayName = req.user?.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    return displayName.trim();
  }

  const email = req.user?.email;
  if (typeof email === "string" && email.includes("@")) {
    const localPart = email.split("@")[0]?.trim();
    if (localPart) return localPart;
  }

  return "Traveler";
}

function handleTodaySocialError(res, error, fallbackMessage) {
  if (error instanceof TodaySocialError) {
    return res.status(error.status).json({
      error: error.message,
    });
  }

  console.error(fallbackMessage, error);
  return res.status(500).json({
    error: fallbackMessage,
  });
}

app.get("/", (_req, res) => {
  res.json({
    name: "SnowTrip API",
    status: "running",
  });
});
app.get('/today-items', async (req, res) => {
  try {
    const items = await listTodayItems({ city: req.query.city });
    try {
      const socialStateByPlaceId = await buildTodaySocialState(
        items.map((item) => item.recordId),
      );

      return res.json({
        items: items.map((item) => ({
          ...item,
          ...(socialStateByPlaceId.get(item.recordId) || {}),
        })),
        socialStateAvailable: true,
      });
    } catch (socialError) {
      console.error("Could not load today social state:", socialError);

      return res.json({
        items,
        socialStateAvailable: false,
      });
    }
  } catch (error) {
    console.error('Could not load today items:', error);
    const response = {
      error: 'Could not load today items',
    };

    if (process.env.NODE_ENV !== "production") {
      response.details = error?.message;
    }

    res.status(500).json(response);
  }
});

app.get("/today-items/:id/comments", async (req, res) => {
  try {
    const comments = await listActiveComments(req.params.id);
    return res.json({ comments });
  } catch (error) {
    console.error(error?.stack || error);

    if (error instanceof TodaySocialError) {
      return res.status(error.status).json({
        error: error.message,
      });
    }

    const response = {
      error: "Could not load comments.",
    };

    if (process.env.NODE_ENV !== "production") {
      response.details = error?.message;
    }

    return res.status(500).json(response);
  }
});

app.post(
  "/today-items/:id/comments",
  optionalAppCheck,
  optionalFirebaseAuth,
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const comment = await createTodayComment({
        featuredPlaceId: req.params.id,
        userId: req.user.uid,
        userDisplayName: getUserDisplayName(req),
        text: req.body?.text,
      });

      return res.status(201).json({ comment });
    } catch (error) {
      return handleTodaySocialError(res, error, "Could not create comment.");
    }
  },
);

app.delete(
  "/comments/:id",
  optionalAppCheck,
  optionalFirebaseAuth,
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      await softDeleteTodayComment({
        commentId: req.params.id,
        userId: req.user.uid,
      });

      return res.json({ ok: true });
    } catch (error) {
      return handleTodaySocialError(res, error, "Could not delete comment.");
    }
  },
);

app.post(
  "/comments/:id/report",
  optionalAppCheck,
  optionalFirebaseAuth,
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      await createCommentReport({
        commentId: req.params.id,
        reporterUserId: req.user.uid,
        reason: req.body?.reason,
      });

      return res.json({ ok: true });
    } catch (error) {
      return handleTodaySocialError(res, error, "Could not report comment.");
    }
  },
);

app.post(
  "/today-items/:id/like",
  optionalAppCheck,
  optionalFirebaseAuth,
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const result = await toggleTodayLike({
        featuredPlaceId: req.params.id,
        userId: req.user.uid,
      });

      return res.json(result);
    } catch (error) {
      return handleTodaySocialError(res, error, "Could not update like.");
    }
  },
);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get(
  "/premium/status",
  optionalAppCheck,
  optionalFirebaseAuth,
  requirePremiumEligibleUser,
  async (req, res) => {
    try {
      const status = await getPremiumStatus(req.user.uid);

      return res.json(
        serializePremiumStatus(status, {
          uid: req.user.uid,
        }),
      );
    } catch (error) {
      console.error("Could not load premium status:", error);
      return res.status(503).json({
        error: "Could not load premium status.",
      });
    }
  },
);

app.post(
  "/premium/verify-purchase",
  optionalAppCheck,
  optionalFirebaseAuth,
  requirePremiumEligibleUser,
  async (req, res) => {
    try {
      const status = await verifyAndGrantPremiumPurchase({
        uid: req.user.uid,
        email: req.user.email ?? null,
        payload: req.body,
      });

      return res.json(
        serializePremiumStatus(status, {
          uid: req.user.uid,
          grantedProductId: status.grantedProductId,
          alreadyProcessed: status.alreadyProcessed,
          verificationStatus: status.verificationStatus,
          googlePlayOrderId: status.googlePlayOrderId ?? null,
        }),
      );
    } catch (error) {
      if (error?.status) {
        return res.status(error.status).json({
          error: error.message,
          ...(error.extras || {}),
        });
      }

      console.error("Could not verify purchase:", error);
      return res.status(503).json({
        error: "Could not verify purchase.",
      });
    }
  },
);

app.post("/generate", premiumOnlyGuards, async (req, res) => {
  const startedAt = Date.now();
  const premium = req.body?.premium === true;

  const structured = validateStructuredRequest({
    days: req.body?.days,
    city: req.body?.city,
    cities: req.body?.cities,
    budget_krw: req.body?.budget_krw,
    travelerType: req.body?.travelerType,
    pace: req.body?.pace,
    interests: req.body?.interests,
    travelCompanions: req.body?.travelCompanions,
    specialNeeds: req.body?.specialNeeds,
    isTailored: req.body?.isTailored,
  });

  const refundIfNeeded = async (reason) => {
    if (premium && req.premiumCredit?.reserved && req.user?.uid) {
      try {
        await refundPremiumCredit({
          uid: req.user.uid,
          requestId: req.premiumCredit.requestId,
          reason,
        });
      } catch (error) {
        console.error("refund failed:", error);
      }
    }
  };

  if (structured.error) {
    await refundIfNeeded("validation_failed");
    return res.status(400).json({
      error: structured.error,
      latency_ms: Date.now() - startedAt,
    });
  }

  if (!OPENAI_API_KEY) {
    await refundIfNeeded("missing_api_key");
    return res.status(500).json({
      error: "Missing API key.",
      latency_ms: Date.now() - startedAt,
    });
  }

  const { requestedDays, cities, budgetKrw, premiumProfile } = structured;
  const isTailored = premium ? req.body?.isTailored !== false : false;
  const isMultiCity = cities.length > 1;

  if (!premium && requestedDays > FREE_MAX_DAYS) {
    return res.status(403).json({
      error: `Free plan supports up to ${FREE_MAX_DAYS} days only. Upgrade to premium for ${requestedDays}-day trips.`,
      requested_days: requestedDays,
      cities,
      requires_premium: true,
      latency_ms: Date.now() - startedAt,
    });
  }

  if (!premium && isMultiCity) {
    return res.status(403).json({
      error:
        "Multi-city trips require premium. Free plan supports single-city trips only.",
      requested_days: requestedDays,
      cities,
      requires_premium: true,
      latency_ms: Date.now() - startedAt,
    });
  }

  let freeQuota = null;
  let clientId = null;

  if (!premium) {
    clientId = getClientId(req);
    freeQuota = getFreeQuotaStatus(clientId);

    if (freeQuota.remaining <= 0) {
      return res.status(429).json({
        error: `Free plan limit reached. You can generate up to ${FREE_REQUESTS_PER_DAY} free plans every 24 hours.`,
        requested_days: requestedDays,
        cities,
        free_quota: freeQuota,
        latency_ms: Date.now() - startedAt,
      });
    }
  }

  const userPrompt = buildUserPrompt({
    requestedDays,
    cities,
    budgetKrw,
    premium,
    isTailored,
    premiumProfile,
  });

  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    await refundIfNeeded("prompt_too_long");
    return res.status(400).json({
      error: "Prompt too long.",
      latency_ms: Date.now() - startedAt,
    });
  }

  const result = await callOpenAI({
    userPrompt,
    premium,
    isTailored,
    requestedDays,
    isMultiCity,
  });

  if (!result.ok) {
    await refundIfNeeded("generate_failed");
    return res.status(result.status).json({
      error: result.error,
      requested_days: requestedDays,
      cities,
      latency_ms: Date.now() - startedAt,
    });
  }

  let updatedFreeQuota = null;
  if (!premium && clientId) {
    updatedFreeQuota = consumeFreeQuota(clientId);
  }

  return res.json({
    result: result.result,
    model: result.model,
    requested_days: requestedDays,
    cities,
    is_multi_city: isMultiCity,
    plan_type: premium ? "premium" : "free",
    is_tailored: isTailored,
    premium_profile: premium ? premiumProfile : null,
    tokens: result.tokens,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    incomplete_reason: result.incompleteReason,
    latency_ms: Date.now() - startedAt,
    response_id: result.responseId,
    free_quota: updatedFreeQuota,
    premium_credits_remaining: premium
      ? req.premiumCredit?.balanceAfter ?? null
      : null,
    trip_pass_expires_at: premium
      ? req.premiumCredit?.tripPassExpiresAt ?? null
      : null,
    has_trip_pass: premium ? req.premiumCredit?.hasTripPass === true : false,
    has_premium_access: premium
      ? req.premiumCredit?.hasTripPass === true ||
          (req.premiumCredit?.balanceAfter ?? 0) > 0
      : false,
    premium_entitlement_source: premium ? "firestore" : null,
    uid: req.user?.uid ?? null,
  });
});

// ── Error Handler ──────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("EXPRESS ERROR:", err);

  if (res.headersSent) return;

  return res.status(err?.status || 500).json({
    error: err?.message || "Server error.",
  });
});

// ── Crash Logging ──────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// ── Startup ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 SnowTrip API running on ${PORT}`);
});
