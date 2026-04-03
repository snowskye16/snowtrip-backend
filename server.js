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

// Free = cheaper model
const FREE_MODEL = process.env.FREE_MODEL || "gpt-5-mini";

// Premium = stronger model
const PREMIUM_MODEL = process.env.PREMIUM_MODEL || "gpt-5.4";

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 18000);
const MAX_PROMPT_LENGTH = 2000;

// ── Middleware ─────────────────────────────────────────────────

app.use(express.json({ limit: "20kb" }));

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
    allowedHeaders: ["Content-Type"],
  })
);

// ── Rate Limit ────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
});

app.use("/generate", limiter);

// ── Prompt Rules ──────────────────────────────────────────────

const DEVELOPER_PROMPT = `
You are SnowTrip AI, a premium Korea travel planner.

Rules:
- Make the output practical, clean, and mobile-friendly.
- Use Day 1 / Day 2 / Day 3 headings.
- Under each day, use Morning / Afternoon / Evening.
- Suggest realistic Korea-friendly routes.
- Keep each day geographically efficient.
- Include estimated budget notes in KRW when helpful.
- Include transport tips.
- Include 1-2 hidden gems only when relevant.
- Keep the answer concise but useful.
- Avoid filler text.
- Do not invent exact prices or times when uncertain; use estimates.
`;

// ── Helpers ───────────────────────────────────────────────────

function validateRequest(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return "Invalid prompt.";
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return "Prompt too long.";
  }

  return null;
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text =
    data?.output
      ?.flatMap((item) => item?.content || [])
      ?.filter((part) => part?.type === "output_text")
      ?.map((part) => part?.text || "")
      ?.join("\n")
      ?.trim() || "";

  return text;
}

async function callOpenAI({ prompt, premium }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const model = premium ? PREMIUM_MODEL : FREE_MODEL;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        instructions: DEVELOPER_PROMPT,
        input: prompt,
        reasoning: {
          effort: premium ? "medium" : "low",
        },
        max_output_tokens: premium ? 900 : 650,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data?.error?.message || "AI request failed.",
      };
    }

    const text = extractResponseText(data);

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
      tokens: data?.usage?.total_tokens || 0,
      inputTokens: data?.usage?.input_tokens || 0,
      outputTokens: data?.usage?.output_tokens || 0,
      responseId: data?.id || null,
    };
  } catch (error) {
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
      error: "Server error. Try again later.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Routes ────────────────────────────────────────────────────

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
  });
});

app.post("/generate", async (req, res) => {
  const startedAt = Date.now();

  const prompt = req.body?.prompt;
  const premium = req.body?.premium === true;

  const validationError = validateRequest(prompt);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing API key." });
  }

  const result = await callOpenAI({ prompt, premium });

  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      latency_ms: Date.now() - startedAt,
    });
  }

  return res.json({
    result: result.result,
    model: result.model,
    tokens: result.tokens,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    latency_ms: Date.now() - startedAt,
    response_id: result.responseId,
  });
});

// ── Startup ───────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 SnowTrip API running on ${PORT}`);
});