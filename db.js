// 帧语 · 数据层（node:sqlite，零外部依赖）
//
// 替换掉原来"整份 projects.json 读进内存、改完再整体写回磁盘"的方案——那种方案
// 在多个请求并发写入时会互相覆盖，也没办法安全地给"项目归属哪个用户"这种关系建模。
// 这里换成真正的 SQLite（Node 22.5+ 内置的 node:sqlite，不需要 npm install 任何东西），
// 每个项目、每个用户、每个登录会话都是独立的行，按主键读写，天然并发安全。
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'projects.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;'); // readers don't block the (single) writer

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    mode TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    meta TEXT NOT NULL,
    thumb_hue INTEGER NOT NULL,
    status TEXT NOT NULL,
    done_steps TEXT NOT NULL,
    current_step TEXT,
    shots TEXT NOT NULL,
    voice TEXT NOT NULL,
    bgm TEXT NOT NULL,
    total_duration INTEGER NOT NULL,
    exported INTEGER NOT NULL DEFAULT 0,
    script TEXT NOT NULL DEFAULT '',
    timeline TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`);

// ---------- projects: row <-> plain-object shape used throughout server.js ----------
// Kept field-for-field identical to the old in-memory project objects (same
// property names, doneSteps/shots/timeline still plain JS arrays once loaded)
// so none of the existing pipeline/business logic in server.js has to change —
// only how a project gets read from and written to disk.

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id, // null = public demo/seed project, not owned by any user
    mode: row.mode,
    title: row.title,
    prompt: row.prompt,
    meta: row.meta,
    thumbHue: row.thumb_hue,
    status: row.status,
    doneSteps: JSON.parse(row.done_steps),
    currentStep: row.current_step,
    shots: JSON.parse(row.shots),
    voice: row.voice,
    bgm: row.bgm,
    totalDuration: row.total_duration,
    exported: !!row.exported,
    script: row.script || '',
    timeline: JSON.parse(row.timeline),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const upsertProjectStmt = db.prepare(`
  INSERT INTO projects (id, user_id, mode, title, prompt, meta, thumb_hue, status, done_steps, current_step, shots, voice, bgm, total_duration, exported, script, timeline, created_at, updated_at)
  VALUES (@id, @userId, @mode, @title, @prompt, @meta, @thumbHue, @status, @doneSteps, @currentStep, @shots, @voice, @bgm, @totalDuration, @exported, @script, @timeline, @createdAt, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    user_id=excluded.user_id, mode=excluded.mode, title=excluded.title, prompt=excluded.prompt,
    meta=excluded.meta, thumb_hue=excluded.thumb_hue, status=excluded.status, done_steps=excluded.done_steps,
    current_step=excluded.current_step, shots=excluded.shots, voice=excluded.voice, bgm=excluded.bgm,
    total_duration=excluded.total_duration, exported=excluded.exported, script=excluded.script,
    timeline=excluded.timeline, updated_at=excluded.updated_at
`);

function saveProject(p) {
  upsertProjectStmt.run({
    id: p.id,
    userId: p.userId === undefined ? null : p.userId,
    mode: p.mode,
    title: p.title,
    prompt: p.prompt,
    meta: p.meta,
    thumbHue: p.thumbHue,
    status: p.status,
    doneSteps: JSON.stringify(p.doneSteps),
    currentStep: p.currentStep === undefined ? null : p.currentStep,
    shots: JSON.stringify(p.shots),
    voice: p.voice,
    bgm: p.bgm,
    totalDuration: p.totalDuration,
    exported: p.exported ? 1 : 0,
    script: p.script || '',
    timeline: JSON.stringify(p.timeline),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  });
}

const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
function getProject(id) {
  return rowToProject(getProjectStmt.get(id));
}

// Sidebar list: a user's own projects plus the public demo/seed ones
// (user_id IS NULL) everyone can browse; logged-out visitors see only demos.
const listProjectsForUserStmt = db.prepare('SELECT * FROM projects WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC');
const listPublicProjectsStmt = db.prepare('SELECT * FROM projects WHERE user_id IS NULL ORDER BY updated_at DESC');
function listProjectsFor(userId) {
  var rows = userId ? listProjectsForUserStmt.all(userId) : listPublicProjectsStmt.all();
  return rows.map(rowToProject);
}

const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
function deleteProject(id) { deleteProjectStmt.run(id); }

const countProjectsStmt = db.prepare('SELECT COUNT(*) AS n FROM projects');
function projectCount() { return countProjectsStmt.get().n; }

// ---------- users / auth ----------

function hashPassword(password) {
  var salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: hash, salt: salt };
}

function verifyPassword(password, hash, salt) {
  var expected = Buffer.from(hash, 'hex');
  var actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const insertUserStmt = db.prepare('INSERT INTO users (id, email, password_hash, password_salt, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

function createUser(email, password, displayName) {
  var existing = getUserByEmailStmt.get(email);
  if (existing) return { error: 'EMAIL_TAKEN' };
  var hp = hashPassword(password);
  var id = crypto.randomUUID();
  insertUserStmt.run(id, email, hp.hash, hp.salt, displayName || email.split('@')[0], new Date().toISOString());
  return { user: publicUser(getUserByIdStmt.get(id)) };
}

function verifyLogin(email, password) {
  var row = getUserByEmailStmt.get(email);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash, row.password_salt)) return null;
  return publicUser(row);
}

// ---------- sessions (cookie-based) ----------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const insertSessionStmt = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpiredSessionsStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

function createSession(userId) {
  var token = crypto.randomBytes(32).toString('hex');
  var now = new Date();
  var expires = new Date(now.getTime() + SESSION_TTL_MS);
  insertSessionStmt.run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

function getUserBySessionToken(token) {
  if (!token) return null;
  deleteExpiredSessionsStmt.run(new Date().toISOString());
  var session = getSessionStmt.get(token);
  if (!session) return null;
  var row = getUserByIdStmt.get(session.user_id);
  return publicUser(row);
}

function destroySession(token) { if (token) deleteSessionStmt.run(token); }

// ---------- one-time migration from the old data/projects.json (if present
// and the new DB is still empty) so nobody loses their local dev history
// switching over to this ----------

function migrateLegacyJsonIfNeeded() {
  if (projectCount() > 0) return;
  if (!fs.existsSync(LEGACY_JSON_FILE)) return;
  try {
    var old = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf8'));
    if (!Array.isArray(old.projects) || !old.projects.length) return;
    old.projects.forEach(function (p) {
      saveProject({
        id: p.id, userId: null, mode: p.mode, title: p.title, prompt: p.prompt, meta: p.meta,
        thumbHue: p.thumbHue, status: p.status, doneSteps: p.doneSteps || [], currentStep: p.currentStep,
        shots: p.shots || [], voice: p.voice, bgm: p.bgm, totalDuration: p.totalDuration,
        exported: p.exported, script: p.script || '', timeline: p.timeline || [],
        createdAt: p.createdAt || new Date().toISOString(), updatedAt: p.updatedAt || new Date().toISOString()
      });
    });
    console.log('已从旧的 data/projects.json 迁移 ' + old.projects.length + ' 个项目到 SQLite（作为公开演示项目）。');
  } catch (e) {
    console.error('迁移旧数据失败（忽略，将只使用新数据库）：', e.message);
  }
}

module.exports = {
  saveProject: saveProject,
  getProject: getProject,
  listProjectsFor: listProjectsFor,
  deleteProject: deleteProject,
  createUser: createUser,
  verifyLogin: verifyLogin,
  createSession: createSession,
  getUserBySessionToken: getUserBySessionToken,
  destroySession: destroySession,
  migrateLegacyJsonIfNeeded: migrateLegacyJsonIfNeeded
};
