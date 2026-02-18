# Classroom Micro:bit Backend — Implementation Plan

## Goal
Enable teachers to run a class using Vibbit + micro:bit without distributing API keys to students. The backend holds the LLM key; students get scoped, revocable access through classroom join codes.

## Design Principles
- **Single process, zero external deps** — SQLite via `better-sqlite3`, no Redis/Postgres
- **Self-hostable** — teacher runs `npm install && npm start`, configures `.env`, done
- **Backward-compatible** — existing `/vibbit/generate` with `SERVER_APP_TOKEN` still works
- **Minimal client changes** — extension learns a new "classroom" mode alongside "managed" and "byok"

---

## Step 1: Add SQLite + Schema (`apps/backend/src/db.mjs`)

Add `better-sqlite3` dependency. Create a `db.mjs` module that:
- Opens/creates `vibbit.db` (path configurable via `VIBBIT_DB_PATH` env var, default `./vibbit.db`)
- Runs migrations on startup (WAL mode, foreign keys on)

**Tables:**

```sql
classrooms (
  id            TEXT PRIMARY KEY,   -- nanoid
  name          TEXT NOT NULL,
  join_code     TEXT UNIQUE NOT NULL, -- 6-char alphanumeric, teacher gives to students
  teacher_token TEXT NOT NULL,       -- hashed, used to manage the classroom
  max_students  INTEGER DEFAULT 40,
  request_limit INTEGER DEFAULT 50,  -- per-student per-session
  active        INTEGER DEFAULT 1,   -- teacher can pause the whole class
  created_at    TEXT DEFAULT (datetime('now'))
)

students (
  id            TEXT PRIMARY KEY,   -- nanoid
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id),
  display_name  TEXT NOT NULL,
  token         TEXT UNIQUE NOT NULL, -- hashed, sent with generate requests
  requests_used INTEGER DEFAULT 0,
  active        INTEGER DEFAULT 1,   -- teacher can kick individual students
  joined_at     TEXT DEFAULT (datetime('now'))
)
```

---

## Step 2: Classroom API Endpoints

All return JSON. Teacher endpoints require `Authorization: Bearer <teacher_token>`.

### Teacher endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/classroom/create` | Create classroom. Body: `{ name, requestLimit?, maxStudents? }`. Returns `{ classroomId, joinCode, teacherToken }`. |
| `GET` | `/classroom/:id` | Get classroom details + student list + usage stats. |
| `PATCH` | `/classroom/:id` | Update settings (name, requestLimit, active). |
| `DELETE` | `/classroom/:id/students/:studentId` | Remove/deactivate a student. |

### Student endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/classroom/join` | Join with `{ joinCode, displayName }`. Returns `{ studentToken, classroomName }`. |

### Modified existing endpoint

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/vibbit/generate` | Accept student token in `Authorization: Bearer`. Look up student, check classroom active + student active + under request limit. Increment `requests_used`. Fall through to existing generation logic. |

---

## Step 3: Auth Middleware Refactor

Refactor the auth check in `/vibbit/generate` to support three token types:
1. **`SERVER_APP_TOKEN`** — legacy static token (existing behavior, unchanged)
2. **Student token** — looked up in `students` table, validates classroom is active, student is active, under limit
3. **No token** — rejected if `SERVER_APP_TOKEN` is set or classrooms exist

Order: try `SERVER_APP_TOKEN` match first, then student token lookup. This keeps backward compatibility.

---

## Step 4: Teacher Dashboard (served by backend)

A simple HTML page served at `GET /dashboard`. No build step — inline HTML/CSS/JS.

**Features:**
- Create a new classroom → shows join code prominently
- View classroom: student list with usage counts, active/inactive status
- Toggle classroom active/inactive (pause all students)
- Kick individual students
- Adjust request limit

Since this is a single HTML file with fetch calls to the API, it stays simple and ships with the server.

---

## Step 5: Extension Client Changes (`work.js`)

Add a third mode: **"classroom"** alongside "managed" and "byok".

- Settings panel gets a "Classroom" mode option
- When selected, shows: "Join Code" + "Your Name" fields, and a "Join" button
- On join, calls `POST /classroom/join`, stores returned `studentToken` in localStorage
- When generating, sends `Authorization: Bearer <studentToken>` to the backend
- If the server returns 403 (limit reached or deactivated), shows a clear message

---

## Step 6: Configuration & Docs

- Update `.env.example` with `VIBBIT_DB_PATH`
- Update `apps/backend/README.md` with classroom setup instructions

---

## File Changes Summary

| File | Action |
|------|--------|
| `apps/backend/package.json` | Add `better-sqlite3`, `nanoid` deps |
| `apps/backend/src/db.mjs` | **New** — SQLite init + migrations + query helpers |
| `apps/backend/src/server.mjs` | Add classroom routes, refactor auth middleware, serve dashboard |
| `apps/backend/src/dashboard.html` | **New** — teacher dashboard SPA |
| `apps/backend/.env.example` | Add `VIBBIT_DB_PATH` |
| `work.js` | Add classroom mode to settings + join flow + token storage |

---

## What This Does NOT Include (future work)
- Teacher accounts / login (teacher token is the auth — simpler for v1)
- Assignment tracking or code submission history
- Multi-classroom per teacher in a single dashboard session
- WebSocket real-time updates on dashboard
- Password/email-based student accounts
