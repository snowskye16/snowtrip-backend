import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

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

// In-memory quota store for MVP / single server.
const freeUsageByClient = new Map();

// ── Middleware ─────────────────────────────────────────────────

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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  }),
);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
});

app.use("/generate", limiter);

// ── Prompting ──────────────────────────────────────────────────

const BASE_DEVELOPER_PROMPT = `
You are SnowTrip AI, a Korea travel planner.

Output rules:
- Make the itinerary practical, clean, and mobile-friendly.
- Use exactly: Day 1, Day 2, ... up to the requested number of days.
- Under each day, always use: Morning, Afternoon, Evening.
- Keep the route geographically efficient.
- If there are multiple cities, clearly account for transfer time.
- Include concise KRW budget notes.
- Include transport tips.
- Do not invent exact opening hours, train times, or exact prices when uncertain.
- Prefer estimates and practical language.
- Use short bullet points.
- End with a short total trip budget estimate.
- Never stop halfway through a day. If space is tight, simplify the plan instead of truncating it.
`.trim();

function buildDeveloperPrompt({ premium, requestedDays, isMultiCity }) {
  if (premium) {
    return `${BASE_DEVELOPER_PROMPT}

Premium mode rules:
- Provide fuller detail, smoother flow, and slightly richer food or hidden gem suggestions.
- Keep the answer concise enough to fit fully.
- Respect the requested trip length of ${requestedDays} day(s).
- Multi-city mode: ${isMultiCity ? "yes" : "no"}.`;
  }

  return `${BASE_DEVELOPER_PROMPT}

Free mode rules:
- Keep the answer compact but complete.
- Use at most 2 bullets per time block.
- Prioritize the best-value stops.
- Avoid extra commentary.
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

function validateStructuredRequest({ days, city, cities, budget_krw }) {
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

  return {
    requestedDays,
    cities: normalizedCities,
    budgetKrw,
  };
}

function buildUserPrompt({ requestedDays, cities, budgetKrw, premium }) {
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

function getMaxOutputTokens({ requestedDays, premium, isMultiCity }) {
  if (premium) {
    const base = isMultiCity ? 1200 : 950;
    const perDay = isMultiCity ? 220 : 180;
    return Math.min(2600, base + requestedDays * perDay);
  }

  // Give free mode enough room to finish instead of clipping mid-plan.
  return Math.min(1600, 900 + requestedDays * 220);
}

function getClientId(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
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
  requestedDays,
  isMultiCity,
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const model = premium ? PREMIUM_MODEL : FREE_MODEL;
  const instructions = buildDeveloperPrompt({
    premium,
    requestedDays,
    isMultiCity,
  });
  const maxOutputTokens = getMaxOutputTokens({
    requestedDays,
    premium,
    isMultiCity,
  });
  const reasoningEffort = premium ? "medium" : "low";

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
        input:
          "Continue from the exact point where the itinerary stopped. Do not repeat earlier text. Finish the remaining days and end with a short total trip budget estimate.",
        previousResponseId: data.id,
        reasoningEffort: premium ? "low" : "low",
        maxOutputTokens: premium ? 900 : 700,
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

// ── Routes ─────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "SnowTrip API",
    status: "running",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    hasKey: Boolean(OPENAI_API_KEY),
    freeModel: FREE_MODEL,
    premiumModel: PREMIUM_MODEL,
    timeout_ms: OPENAI_TIMEOUT_MS,
    free_max_days: FREE_MAX_DAYS,
    free_requests_per_day: FREE_REQUESTS_PER_DAY,
    max_days: MAX_DAYS,
    max_cities: MAX_CITIES,
  });
});

app.post("/generate", async (req, res) => {
  const startedAt = Date.now();
  const premium = req.body?.premium === true;

  const structured = validateStructuredRequest({
    days: req.body?.days,
    city: req.body?.city,
    cities: req.body?.cities,
    budget_krw: req.body?.budget_krw,
  });

  if (structured.error) {
    return res.status(400).json({
      error: structured.error,
      latency_ms: Date.now() - startedAt,
    });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Missing API key.",
      latency_ms: Date.now() - startedAt,
    });
  }

  const { requestedDays, cities, budgetKrw } = structured;
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
  });

  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({
      error: "Prompt too long.",
      latency_ms: Date.now() - startedAt,
    });
  }

  const result = await callOpenAI({
    userPrompt,
    premium,
    requestedDays,
    isMultiCity,
  });

  if (!result.ok) {
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
    tokens: result.tokens,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    incomplete_reason: result.incompleteReason,
    latency_ms: Date.now() - startedAt,
    response_id: result.responseId,
    free_quota: updatedFreeQuota,
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
