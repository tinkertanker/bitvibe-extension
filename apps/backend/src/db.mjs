import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";

const DB_PATH = process.env.VIBBIT_DB_PATH || "./vibbit.db";

let _db;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      join_code      TEXT UNIQUE NOT NULL,
      teacher_token  TEXT NOT NULL,
      max_students   INTEGER DEFAULT 40,
      request_limit  INTEGER DEFAULT 50,
      active         INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS students (
      id             TEXT PRIMARY KEY,
      classroom_id   TEXT NOT NULL REFERENCES classrooms(id),
      display_name   TEXT NOT NULL,
      token          TEXT UNIQUE NOT NULL,
      requests_used  INTEGER DEFAULT 0,
      active         INTEGER DEFAULT 1,
      joined_at      TEXT DEFAULT (datetime('now'))
    );
  `);
}

/* ── helpers ─────────────────────────────────────────────── */

export function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function generateJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/* ── classroom operations ────────────────────────────────── */

export function createClassroom({ name, requestLimit, maxStudents }) {
  const db = getDb();
  const id = nanoid(12);
  const joinCode = generateJoinCode();
  const rawTeacherToken = nanoid(32);
  const hashed = hashToken(rawTeacherToken);

  db.prepare(`
    INSERT INTO classrooms (id, name, join_code, teacher_token, request_limit, max_students)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, joinCode, hashed, requestLimit ?? 50, maxStudents ?? 40);

  return { classroomId: id, joinCode, teacherToken: rawTeacherToken };
}

export function getClassroom(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM classrooms WHERE id = ?").get(id) || null;
}

export function getClassroomByTeacherToken(rawToken) {
  const db = getDb();
  const hashed = hashToken(rawToken);
  return db.prepare("SELECT * FROM classrooms WHERE teacher_token = ?").get(hashed) || null;
}

export function updateClassroom(id, fields) {
  const db = getDb();
  const allowed = ["name", "request_limit", "max_students", "active"];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return false;
  values.push(id);
  return db.prepare(`UPDATE classrooms SET ${sets.join(", ")} WHERE id = ?`).run(...values).changes > 0;
}

export function listClassroomsByTeacher(rawToken) {
  const db = getDb();
  const hashed = hashToken(rawToken);
  return db.prepare("SELECT * FROM classrooms WHERE teacher_token = ?").all(hashed);
}

/* ── student operations ──────────────────────────────────── */

export function joinClassroom({ joinCode, displayName }) {
  const db = getDb();
  const classroom = db.prepare("SELECT * FROM classrooms WHERE join_code = ? AND active = 1").get(joinCode);
  if (!classroom) return { error: "Invalid or inactive join code" };

  const studentCount = db.prepare("SELECT COUNT(*) AS cnt FROM students WHERE classroom_id = ? AND active = 1").get(classroom.id).cnt;
  if (studentCount >= classroom.max_students) return { error: "Classroom is full" };

  const id = nanoid(12);
  const rawToken = nanoid(32);
  const hashed = hashToken(rawToken);

  db.prepare(`
    INSERT INTO students (id, classroom_id, display_name, token)
    VALUES (?, ?, ?, ?)
  `).run(id, classroom.id, displayName, hashed);

  return { studentToken: rawToken, classroomId: classroom.id, classroomName: classroom.name };
}

export function getStudentByToken(rawToken) {
  const db = getDb();
  const hashed = hashToken(rawToken);
  return db.prepare("SELECT * FROM students WHERE token = ?").get(hashed) || null;
}

export function listStudents(classroomId) {
  const db = getDb();
  return db.prepare("SELECT id, display_name, requests_used, active, joined_at FROM students WHERE classroom_id = ? ORDER BY joined_at").all(classroomId);
}

export function incrementStudentUsage(studentId) {
  const db = getDb();
  db.prepare("UPDATE students SET requests_used = requests_used + 1 WHERE id = ?").run(studentId);
}

export function deactivateStudent(studentId, classroomId) {
  const db = getDb();
  return db.prepare("UPDATE students SET active = 0 WHERE id = ? AND classroom_id = ?").run(studentId, classroomId).changes > 0;
}

export function resetStudentUsage(classroomId) {
  const db = getDb();
  db.prepare("UPDATE students SET requests_used = 0 WHERE classroom_id = ?").run(classroomId);
}
