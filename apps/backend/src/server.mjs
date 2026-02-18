import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createClassroom, getClassroom, getClassroomByTeacherToken,
  updateClassroom, listClassroomsByTeacher,
  joinClassroom, getStudentByToken, listStudents,
  incrementStudentUsage, deactivateStudent, resetStudentUsage, hashToken
} from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.VIBBIT_ALLOW_ORIGIN || "*";
const REQUEST_TIMEOUT_MS = Number(process.env.VIBBIT_REQUEST_TIMEOUT_MS || 60000);
const SERVER_APP_TOKEN = process.env.SERVER_APP_TOKEN || "";
const PROVIDER = (process.env.VIBBIT_PROVIDER || "openai").trim().toLowerCase();

function modelFor(provider) {
  if (provider === "openai") return process.env.VIBBIT_OPENAI_MODEL || process.env.VIBBIT_MODEL || "gpt-4o-mini";
  if (provider === "gemini") return process.env.VIBBIT_GEMINI_MODEL || process.env.VIBBIT_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return process.env.VIBBIT_OPENROUTER_MODEL || process.env.VIBBIT_MODEL || "openrouter/auto";
  return process.env.VIBBIT_MODEL || "gpt-4o-mini";
}

function apiKeyFor(provider) {
  if (provider === "openai") return process.env.VIBBIT_OPENAI_API_KEY || process.env.VIBBIT_API_KEY || "";
  if (provider === "gemini") return process.env.VIBBIT_GEMINI_API_KEY || process.env.VIBBIT_API_KEY || "";
  if (provider === "openrouter") return process.env.VIBBIT_OPENROUTER_API_KEY || process.env.VIBBIT_API_KEY || "";
  return process.env.VIBBIT_API_KEY || "";
}

const CORS_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";

function respondJson(res, status, body, origin = "") {
  const allowOrigin = ALLOW_ORIGIN === "*" ? "*" : (origin || ALLOW_ORIGIN);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(body));
}

function respondHtml(res, status, html, origin = "") {
  const allowOrigin = ALLOW_ORIGIN === "*" ? "*" : (origin || ALLOW_ORIGIN);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin
  });
  res.end(html);
}

function handleOptions(req, res) {
  const allowOrigin = ALLOW_ORIGIN === "*" ? "*" : (req.headers.origin || ALLOW_ORIGIN);
  res.writeHead(204, {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  });
  res.end();
}

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const wrapped = promise(controller.signal)
    .finally(() => clearTimeout(timeoutId));

  return wrapped;
}

function sanitizeMakeCode(input) {
  if (!input) return "";
  let text = String(input);
  if (/^```/.test(text)) text = text.replace(/^```[\s\S]*?\n/, "").replace(/```\s*$/, "");
  text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
  text = text.replace(/^`+|`+$/g, "");
  return text.trim();
}

function separateFeedback(raw) {
  const feedback = [];
  if (!raw) return { feedback, body: "" };
  const lines = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const bodyLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^FEEDBACK:/i.test(trimmed)) {
      feedback.push(trimmed.replace(/^FEEDBACK:\s*/i, "").trim());
    } else {
      bodyLines.push(line);
    }
  }
  return { feedback, body: bodyLines.join("\n").trim() };
}

function extractCode(raw) {
  if (!raw) return "";
  const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
  const code = match ? match[1] : raw;
  return sanitizeMakeCode(code);
}

function stubForTarget(target) {
  if (target === "arcade") {
    return [
      "controller.A.onEvent(ControllerButtonEvent.Pressed, function () {",
      "    game.splash(\"Start!\")",
      "})",
      "game.onUpdate(function () {",
      "})"
    ].join("\n");
  }
  if (target === "maker") {
    return ["loops.forever(function () {", "})"].join("\n");
  }
  return [
    "basic.onStart(function () {",
    "    basic.showString(\"Hi\")",
    "})"
  ].join("\n");
}

function extractGeminiText(response) {
  try {
    if (!response) return "";
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];
      if (candidate.finishReason && String(candidate.finishReason).toUpperCase().includes("BLOCK")) return "";
      const parts = (candidate.content && candidate.content.parts) || [];
      let text = "";
      for (const part of parts) {
        if (part.text) text += part.text;
      }
      return (text || "").trim();
    }
  } catch {
    return "";
  }
  return "";
}

function systemPromptFor(target) {
  let namespaces = "basic,input,music,led,radio,pins,loops,logic,variables,math,functions,arrays,text,game,images,serial,control";
  let targetName = "micro:bit";
  if (target === "arcade") {
    namespaces = "controller,game,scene,sprites,info,music,effects";
    targetName = "Arcade";
  }
  if (target === "maker") {
    namespaces = "pins,input,loops,music";
    targetName = "Maker";
  }

  return [
    "ROLE: You are a Microsoft MakeCode assistant.",
    `HARD REQUIREMENT: Return ONLY Microsoft MakeCode Static JavaScript that the MakeCode decompiler can convert to BLOCKS for ${targetName} with ZERO errors.`,
    "OPTIONAL FEEDBACK: You may send brief notes before the code. Prefix each note with FEEDBACK: .",
    "RESPONSE FORMAT: After any feedback lines, output ONLY Microsoft MakeCode Static TypeScript with no markdown fences or extra prose.",
    "NO COMMENTS inside the code.",
    `ALLOWED APIS: ${namespaces}. Prefer event handlers and forever/update loops.`,
    "FORBIDDEN IN OUTPUT: arrow functions (=>), classes, new constructors, async/await/Promise, import/export, template strings (`), higher-order array methods (map/filter/reduce/forEach/find/some/every), namespaces/modules, enums, interfaces, type aliases, generics, timers (setTimeout/setInterval), console calls, markdown, escaped newlines, onstart functions.",
    `TARGET-SCOPE: Use ONLY APIs valid for ${targetName}. Never mix Arcade APIs into micro:bit/Maker or vice versa.`,
    "STYLE: Straight quotes, ASCII only, real newlines, use function () { } handlers.",
    `IF UNSURE: Return a minimal program that is guaranteed to decompile to BLOCKS for ${targetName}. Code only.`
  ].join("\n");
}

function userPromptFor(request, currentCode) {
  const header = "USER_REQUEST:\n" + request.trim();
  if (currentCode && String(currentCode).trim()) {
    return header + "\n\n<<<CURRENT_CODE>>>\n" + currentCode + "\n<<<END_CURRENT_CODE>>>";
  }
  return header;
}

async function callOpenAI(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenAI error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callOpenRouter(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callGemini(key, model, system, user, signal) {
  const url = "https://generativelanguage.googleapis.com/v1/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
  const body = {
    contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3072
    }
  };

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Gemini error (${response.status})`);
  }

  const data = await response.json();
  return extractGeminiText(data);
}

async function generateManaged({ target, request, currentCode }) {
  const provider = PROVIDER;
  const key = apiKeyFor(provider);
  const model = modelFor(provider);

  if (!key) {
    throw new Error(`Missing API key for provider '${provider}'. Set VIBBIT_API_KEY or provider-specific key.`);
  }

  const system = systemPromptFor(target);
  const user = userPromptFor(request, currentCode || "");

  const raw = await withTimeout(async (signal) => {
    if (provider === "openai") return callOpenAI(key, model, system, user, signal);
    if (provider === "gemini") return callGemini(key, model, system, user, signal);
    if (provider === "openrouter") return callOpenRouter(key, model, system, user, signal);
    throw new Error(`Unsupported VIBBIT_PROVIDER '${provider}'`);
  }, REQUEST_TIMEOUT_MS);

  const parts = separateFeedback(raw);
  const code = extractCode(parts.body);

  if (!code) {
    return {
      code: stubForTarget(target),
      feedback: [...parts.feedback, "Model returned no code; provided fallback stub."]
    };
  }

  return {
    code,
    feedback: parts.feedback
  };
}

function extractBearerToken(headerValue) {
  if (!headerValue) return "";
  const match = String(headerValue).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function validatePayload(payload) {
  const target = payload && typeof payload.target === "string" ? payload.target.trim() : "";
  const request = payload && typeof payload.request === "string" ? payload.request.trim() : "";
  const currentCode = payload && typeof payload.currentCode === "string" ? payload.currentCode : "";

  if (!request) {
    return { ok: false, error: "'request' is required" };
  }

  const safeTarget = ["microbit", "arcade", "maker"].includes(target) ? target : "microbit";

  return {
    ok: true,
    value: {
      target: safeTarget,
      request,
      currentCode
    }
  };
}

/* ── route helpers ────────────────────────────────────────── */

function matchRoute(method, pathname, pattern) {
  if (method !== pattern.method) return null;
  const patternParts = pattern.path.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function requireTeacherAuth(req, res, origin) {
  const raw = extractBearerToken(req.headers.authorization);
  if (!raw) {
    respondJson(res, 401, { error: "Missing teacher token" }, origin);
    return null;
  }
  const classroom = getClassroomByTeacherToken(raw);
  if (!classroom) {
    respondJson(res, 401, { error: "Invalid teacher token" }, origin);
    return null;
  }
  return classroom;
}

/* ── request server ──────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    handleOptions(req, res);
    return;
  }

  /* ── health check ────────────────────────────────────── */

  if (pathname === "/healthz" && req.method === "GET") {
    respondJson(res, 200, {
      ok: true,
      provider: PROVIDER,
      model: modelFor(PROVIDER),
      tokenRequired: Boolean(SERVER_APP_TOKEN)
    }, origin);
    return;
  }

  /* ── teacher dashboard ───────────────────────────────── */

  if (pathname === "/dashboard" && req.method === "GET") {
    try {
      const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
      respondHtml(res, 200, html, origin);
    } catch {
      respondHtml(res, 500, "<h1>Dashboard not found</h1>", origin);
    }
    return;
  }

  /* ── classroom: create ───────────────────────────────── */

  if (pathname === "/classroom/create" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const name = (body.name || "").trim();
      if (!name) {
        respondJson(res, 400, { error: "'name' is required" }, origin);
        return;
      }
      const result = createClassroom({
        name,
        requestLimit: body.requestLimit != null ? Number(body.requestLimit) : undefined,
        maxStudents: body.maxStudents != null ? Number(body.maxStudents) : undefined
      });
      respondJson(res, 201, result, origin);
    } catch (error) {
      respondJson(res, 500, { error: error.message || "Failed to create classroom" }, origin);
    }
    return;
  }

  /* ── classroom: join (student) ───────────────────────── */

  if (pathname === "/classroom/join" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const joinCode = (body.joinCode || "").trim().toUpperCase();
      const displayName = (body.displayName || "").trim();
      if (!joinCode || !displayName) {
        respondJson(res, 400, { error: "'joinCode' and 'displayName' are required" }, origin);
        return;
      }
      const result = joinClassroom({ joinCode, displayName });
      if (result.error) {
        respondJson(res, 400, { error: result.error }, origin);
        return;
      }
      respondJson(res, 200, result, origin);
    } catch (error) {
      respondJson(res, 500, { error: error.message || "Failed to join classroom" }, origin);
    }
    return;
  }

  /* ── classroom: get details (teacher) ────────────────── */

  if (pathname === "/classroom/mine" && req.method === "GET") {
    const classroom = requireTeacherAuth(req, res, origin);
    if (!classroom) return;
    const students = listStudents(classroom.id);
    respondJson(res, 200, {
      id: classroom.id,
      name: classroom.name,
      joinCode: classroom.join_code,
      requestLimit: classroom.request_limit,
      maxStudents: classroom.max_students,
      active: Boolean(classroom.active),
      createdAt: classroom.created_at,
      students
    }, origin);
    return;
  }

  /* ── classroom: list all for teacher ─────────────────── */

  if (pathname === "/classroom/list" && req.method === "GET") {
    const raw = extractBearerToken(req.headers.authorization);
    if (!raw) {
      respondJson(res, 401, { error: "Missing teacher token" }, origin);
      return;
    }
    const classrooms = listClassroomsByTeacher(raw);
    respondJson(res, 200, { classrooms: classrooms.map(c => ({
      id: c.id,
      name: c.name,
      joinCode: c.join_code,
      active: Boolean(c.active),
      requestLimit: c.request_limit,
      maxStudents: c.max_students,
      createdAt: c.created_at
    })) }, origin);
    return;
  }

  /* ── classroom: update (teacher) ─────────────────────── */

  if (pathname === "/classroom/mine" && req.method === "PATCH") {
    const classroom = requireTeacherAuth(req, res, origin);
    if (!classroom) return;
    try {
      const body = await readJson(req);
      const fields = {};
      if (body.name !== undefined) fields.name = String(body.name).trim();
      if (body.requestLimit !== undefined) fields.request_limit = Number(body.requestLimit);
      if (body.maxStudents !== undefined) fields.max_students = Number(body.maxStudents);
      if (body.active !== undefined) fields.active = body.active ? 1 : 0;
      updateClassroom(classroom.id, fields);
      respondJson(res, 200, { ok: true }, origin);
    } catch (error) {
      respondJson(res, 500, { error: error.message || "Failed to update" }, origin);
    }
    return;
  }

  /* ── classroom: reset usage (teacher) ────────────────── */

  if (pathname === "/classroom/mine/reset" && req.method === "POST") {
    const classroom = requireTeacherAuth(req, res, origin);
    if (!classroom) return;
    resetStudentUsage(classroom.id);
    respondJson(res, 200, { ok: true }, origin);
    return;
  }

  /* ── classroom: remove student (teacher) ─────────────── */

  {
    const params = matchRoute(req.method, pathname, { method: "DELETE", path: "/classroom/students/:studentId" });
    if (params) {
      const classroom = requireTeacherAuth(req, res, origin);
      if (!classroom) return;
      const ok = deactivateStudent(params.studentId);
      respondJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Student not found" }, origin);
      return;
    }
  }

  /* ── generate (managed + classroom) ──────────────────── */

  if (pathname === "/vibbit/generate" && req.method === "POST") {
    try {
      const bearerToken = extractBearerToken(req.headers.authorization);

      // Auth: try SERVER_APP_TOKEN first, then student token
      if (SERVER_APP_TOKEN && bearerToken === SERVER_APP_TOKEN) {
        // Authorized via static app token — proceed
      } else if (bearerToken) {
        // Try as student token
        const student = getStudentByToken(bearerToken);
        if (!student) {
          respondJson(res, 401, { error: "Unauthorized" }, origin);
          return;
        }
        if (!student.active) {
          respondJson(res, 403, { error: "Your access has been deactivated by the teacher" }, origin);
          return;
        }
        const classroom = getClassroom(student.classroom_id);
        if (!classroom || !classroom.active) {
          respondJson(res, 403, { error: "Classroom is currently paused" }, origin);
          return;
        }
        if (student.requests_used >= classroom.request_limit) {
          respondJson(res, 429, { error: `Request limit reached (${classroom.request_limit}). Ask your teacher for more.` }, origin);
          return;
        }
        incrementStudentUsage(student.id);
      } else if (SERVER_APP_TOKEN) {
        // Token required but not provided
        respondJson(res, 401, { error: "Unauthorized" }, origin);
        return;
      }
      // If no SERVER_APP_TOKEN and no bearer token, allow through (open mode)

      const payload = await readJson(req);
      const validated = validatePayload(payload);

      if (!validated.ok) {
        respondJson(res, 400, { error: validated.error }, origin);
        return;
      }

      const result = await generateManaged(validated.value);
      respondJson(res, 200, result, origin);
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? `Generation timed out after ${REQUEST_TIMEOUT_MS}ms`
        : (error && error.message ? error.message : "Internal server error");
      respondJson(res, 500, { error: message }, origin);
    }
    return;
  }

  respondJson(res, 404, { error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`[Vibbit backend] Listening on http://localhost:${PORT}`);
  console.log(`[Vibbit backend] Provider=${PROVIDER} model=${modelFor(PROVIDER)}`);
  if (SERVER_APP_TOKEN) {
    console.log("[Vibbit backend] SERVER_APP_TOKEN auth enabled");
  }
  console.log("[Vibbit backend] Teacher dashboard at /dashboard");
});
