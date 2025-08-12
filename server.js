/* server.js — v3.2.1 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env';

// Database (Neon)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ----
const q = (text, params=[]) => pool.query(text, params);
const roundTo1 = (n) => Math.round(n * 10) / 10;

function signToken(user){
  const payload = { sub: user.id, username: user.username, is_admin: user.is_admin, player_id: user.player_id };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '14d' });
}
function setAuthCookie(res, token){
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 14*24*60*60*1000
  });
}

async function initDb(){
  await q(`CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    is_disabled BOOLEAN NOT NULL DEFAULT false,
    player_id UUID UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false`);

  await q(`CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    location TEXT,
    hole_pars SMALLINT[] NOT NULL,
    rating NUMERIC(4,1) NOT NULL DEFAULT 72.0,
    slope SMALLINT NOT NULL DEFAULT 113,
    created_at TIMESTAMPTZ DEFAULT now(),
    CHECK (array_length(hole_pars, 1) = 18)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS rounds (
    id UUID PRIMARY KEY,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    date TIMESTAMPTZ NOT NULL DEFAULT now(),
    holes SMALLINT[] NOT NULL,
    total SMALLINT NOT NULL,
    adj_gross SMALLINT NOT NULL,
    differential NUMERIC(5,1),
    created_at TIMESTAMPTZ DEFAULT now(),
    CHECK (array_length(holes, 1) = 18)
  )`);

  await q(`CREATE INDEX IF NOT EXISTS rounds_player_date_idx ON rounds (player_id, date DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS rounds_course_date_idx ON rounds (course_id, date DESC)`);

  // Seed default courses (no players)
  const { rows: ccount } = await q('SELECT COUNT(*)::int AS n FROM courses');
  if(ccount[0].n === 0){
    const defaultPars = Array.from({length:18}, ()=>4);
    const seedCourses = [
      ['Antill Park Country Golf Club','Picton'],
      ['Georges River Golf Course','Georges Hall'],
      ['Brighton Lakes Recreation & Golf Club','Moorebank'],
      ['The Vale Golf Course','Russell Vale'],
      ['Camden Golf Club','Narellan']
    ];
    for(const [name, loc] of seedCourses){
      await q(`INSERT INTO courses (id,name,location,hole_pars,rating,slope) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (name) DO NOTHING`, [uuidv4(), name, loc, defaultPars, 72.0, 113]);
    }
  }

  // Seed the admin user if missing
  const adminUsername = 'jlogozzo';
  const adminPassword = 'SydneyAbuDhabiParisLosAngeles';
  const { rows: adminExists } = await q('SELECT id FROM users WHERE username=$1', [adminUsername]);
  if(adminExists.length === 0){
    const id = uuidv4();
    const hash = await bcrypt.hash(adminPassword, 12);
    await q('INSERT INTO users (id, username, password_hash, is_admin) VALUES ($1,$2,$3,true)', [id, adminUsername, hash]);
    console.log('Seeded admin user jlogozzo');
  }
}

function authOptional(req,res,next){
  const token = req.cookies.token;
  if(!token) return next();
  try{ req.user = jwt.verify(token, JWT_SECRET); }catch(e){}
  next();
}
function authRequired(req,res,next){
  const token = req.cookies.token;
  if(!token) return res.status(401).json({ error: 'auth required'});
  try{ req.user = jwt.verify(token, JWT_SECRET); return next(); }
  catch(e){ return res.status(401).json({ error: 'invalid token'}); }
}
function adminOnly(req,res,next){
  if(!req.user?.is_admin || req.user.username !== 'jlogozzo') return res.status(403).json({ error: 'admin only'});
  next();
}

app.use(authOptional);

// ---------- Auth ----------
app.post('/api/auth/login', async (req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error: 'username and password required' });
  const { rows } = await q('SELECT * FROM users WHERE username=$1', [username]);
  if(rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
  const user = rows[0];
  if(user.is_disabled) return res.status(403).json({ error: 'account disabled' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if(!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ id: user.id, username: user.username, is_admin: user.is_admin, player_id: user.player_id });
});

app.post('/api/auth/logout', (req,res)=>{ res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/auth/me', (req,res)=>{ if(!req.user) return res.status(200).json(null); res.json(req.user); });

// Admin creates a new user (player + login)
app.post('/api/auth/register', authRequired, adminOnly, async (req,res)=>{
  const { username, password, name } = req.body || {};
  if(!username || !password || !name) return res.status(400).json({ error: 'username, password, and name required'});
  const { rows: u } = await q('SELECT 1 FROM users WHERE username=$1', [username]);
  if(u.length) return res.status(409).json({ error: 'username exists' });
  const playerId = uuidv4(); const userId = uuidv4();
  const hash = await bcrypt.hash(password, 12);
  await q('INSERT INTO players (id, name) VALUES ($1,$2)', [playerId, name]);
  await q('INSERT INTO users (id, username, password_hash, is_admin, player_id) VALUES ($1,$2,$3,false,$4)', [userId, username, hash, playerId]);
  res.json({ id: userId, username, name, player_id: playerId });
});

// ---------- Users/Courses ----------
app.get('/api/players', authRequired, async (req,res)=>{
  const { rows } = await q('SELECT id, name FROM players ORDER BY name');
  res.json(rows);
});
app.get('/api/courses', authRequired, async (req,res)=>{
  const { rows } = await q('SELECT id, name, location, hole_pars AS "holePars", rating, slope FROM courses ORDER BY name');
  res.json(rows);
});
app.post('/api/courses', authRequired, adminOnly, async (req,res)=>{
  const { name, location, holePars, rating=72.0, slope=113 } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name required' });
  const arr = Array.isArray(holePars) && holePars.length===18 ? holePars.map(n=>Number(n)||4) : Array.from({length:18}, ()=>4);
  const id = uuidv4();
  await q('INSERT INTO courses (id, name, location, hole_pars, rating, slope) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, location||null, arr, Number(rating)||72.0, Number(slope)||113]);
  res.json({ id, name, location: location||null, holePars: arr, rating: Number(rating)||72.0, slope: Number(slope)||113 });
});
app.patch('/api/courses/:id', authRequired, adminOnly, async (req,res)=>{
  const { id } = req.params;
  const { holePars, rating, slope } = req.body || {};
  const parts = []; const vals = []; let idx = 1;
  if(Array.isArray(holePars) && holePars.length===18){ parts.push(`hole_pars = $${idx++}`); vals.push(holePars.map(n=>Number(n)||4)); }
  if(rating!=null){ parts.push(`rating = $${idx++}`); vals.push(Number(rating)); }
  if(slope!=null){ parts.push(`slope = $${idx++}`); vals.push(Number(slope)); }
  if(parts.length===0) return res.status(400).json({ error: 'no fields to update' });
  vals.push(id);
  await q(`UPDATE courses SET ${parts.join(', ')} WHERE id = $${idx}`, vals);
  const { rows } = await q('SELECT id, name, location, hole_pars AS "holePars", rating, slope FROM courses WHERE id=$1', [id]);
  res.json(rows[0]);
});

// ---------- Rounds ----------
function computeDifferential(adjGross, rating, slope){
  const diff = ((adjGross - Number(rating)) * 113) / Number(slope || 113);
  return roundTo1(diff);
}

app.get('/api/rounds', authRequired, async (req,res)=>{
  const { playerId, courseId } = req.query;
  const where = []; const vals = [];
  if(playerId){ vals.push(playerId); where.push(`player_id = $${vals.length}`); }
  if(courseId){ vals.push(courseId); where.push(`course_id = $${vals.length}`); }
  const sql = `SELECT r.id, r.player_id AS "playerId", r.course_id AS "courseId", r.date, r.holes, r.total, r.adj_gross AS "adjGross", r.differential
               FROM rounds r ${where.length? 'WHERE '+where.join(' AND ') : ''}
               ORDER BY r.date DESC`;
  const { rows } = await q(sql, vals);
  res.json(rows);
});

app.post('/api/rounds', authRequired, async (req,res)=>{
  const { playerId, courseId, holes, adjGross, date } = req.body || {};
  if(!courseId) return res.status(400).json({ error: 'courseId required' });
  if(!Array.isArray(holes) || holes.length!==18) return res.status(400).json({ error: 'holes must be length 18' });

  let targetPlayer = playerId;
  if(!req.user.is_admin){
    if(!req.user.player_id) return res.status(403).json({ error: 'no player profile' });
    targetPlayer = req.user.player_id;
  }
  if(!targetPlayer) return res.status(400).json({ error: 'playerId required' });

  const { rows: cr } = await q('SELECT rating, slope FROM courses WHERE id=$1', [courseId]);
  if(cr.length===0) return res.status(400).json({ error: 'course not found' });
  const rating = Number(cr[0].rating)||72.0;
  const slope = Number(cr[0].slope)||113;

  const total = holes.reduce((a,b)=> a + (Number(b)||0), 0);
  const ags = Number(adjGross||total);
  const diff = computeDifferential(ags, rating, slope);
  const dateISO = (date && !isNaN(Date.parse(date))) ? new Date(date).toISOString() : new Date().toISOString();

  const id = uuidv4();
  await q(`INSERT INTO rounds (id, player_id, course_id, date, holes, total, adj_gross, differential)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, targetPlayer, courseId, dateISO, holes.map(n=>Number(n)||0), total, ags, diff]);

  res.json({ id, playerId: targetPlayer, courseId, date: dateISO, holes, total, adjGross: ags, differential: diff });
});

// Admin edit (holes/date/adjGross) with recompute
app.patch('/api/rounds/:id', authRequired, adminOnly, async (req,res)=>{
  const { id } = req.params;
  const { holes, adjGross, date } = req.body || {};
  const { rows: r0 } = await q('SELECT course_id FROM rounds WHERE id=$1', [id]);
  if(r0.length===0) return res.status(404).json({ error: 'round not found' });
  const courseId = r0[0].course_id;
  const { rows: cr } = await q('SELECT rating, slope FROM courses WHERE id=$1', [courseId]);
  if(cr.length===0) return res.status(400).json({ error: 'course not found' });
  const rating = Number(cr[0].rating)||72.0; const slope = Number(cr[0].slope)||113;

  const sets = []; const vals = []; let idx = 1;
  let total = null; let ags = null;
  if(Array.isArray(holes)){
    if(holes.length!==18) return res.status(400).json({ error: 'holes must be length 18' });
    const fixed = holes.map(n=> Number(n)||0);
    total = fixed.reduce((a,b)=>a+b,0);
    sets.push(`holes = $${idx++}`); vals.push(fixed);
    sets.push(`total = $${idx++}`); vals.push(total);
  }
  if(adjGross!=null){
    ags = Number(adjGross);
    if(!Number.isFinite(ags)) return res.status(400).json({ error: 'adjGross must be a number' });
    sets.push(`adj_gross = $${idx++}`); vals.push(ags);
  }
  if(date){
    const d = new Date(date); if(isNaN(d)) return res.status(400).json({ error: 'bad date' });
    sets.push(`date = $${idx++}`); vals.push(d.toISOString());
  }
  if(sets.length===0) return res.status(400).json({ error: 'no fields to update' });

  const { rows: cur } = await q('SELECT total, adj_gross FROM rounds WHERE id=$1', [id]);
  let curTotal = total!=null ? total : Number(cur[0].total);
  let curAdj = ags!=null ? ags : Number(cur[0].adj_gross ?? curTotal);
  const diff = computeDifferential(curAdj, rating, slope);
  sets.push(`differential = $${idx++}`); vals.push(diff);
  vals.push(id);
  await q(`UPDATE rounds SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
  const { rows: out } = await q(`SELECT r.id, r.player_id AS "playerId", r.course_id AS "courseId", r.date, r.holes, r.total, r.adj_gross AS "adjGross", r.differential FROM rounds r WHERE r.id=$1`, [id]);
  res.json(out[0]);
});

app.delete('/api/rounds/:id', authRequired, async (req,res)=>{
  const { id } = req.params;
  if(req.user.is_admin){
    const { rowCount } = await q('DELETE FROM rounds WHERE id=$1', [id]);
    if(rowCount===0) return res.status(404).json({ error: 'round not found' });
    return res.json({ ok: true });
  }
  const { rows } = await q('SELECT player_id FROM rounds WHERE id=$1', [id]);
  if(rows.length===0) return res.status(404).json({ error: 'round not found' });
  if(rows[0].player_id !== req.user.player_id) return res.status(403).json({ error: 'not your round' });
  await q('DELETE FROM rounds WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ---------- Stats ----------
app.get('/api/stats/player/:id', authRequired, async (req,res)=>{
  const playerId = req.params.id;
  const { rows: rounds } = await q('SELECT r.*, c.rating, c.slope FROM rounds r JOIN courses c ON c.id=r.course_id WHERE r.player_id=$1 ORDER BY r.date DESC', [playerId]);
  if(rounds.length===0) return res.json({ average: null, bestScore: null, mostPlayedCourse: null, handicap: { value: null, used: 0, total: 0 } });

  const totals = rounds.map(r=> Number(r.total));
  const average = totals.reduce((a,b)=>a+b,0) / totals.length;
  const bestScore = Math.min(...totals);

  const { rows: mp } = await q(`SELECT c.name, COUNT(*) AS n
                                FROM rounds r JOIN courses c ON c.id = r.course_id
                                WHERE r.player_id=$1
                                GROUP BY c.name
                                ORDER BY n DESC, c.name ASC LIMIT 1`, [playerId]);
  const mostPlayedCourse = mp[0]?.name || null;

  const diffs = rounds.slice(0,20).map(r=> Number(r.differential));
  const n = diffs.length;
  const useCount = (n>=20) ? 8 : Math.max(1, Math.round(n * 0.4));
  const best = diffs.sort((a,b)=>a-b).slice(0, useCount);
  const avgBest = best.reduce((a,b)=>a+b,0) / best.length;
  const index = roundTo1(avgBest * 0.96);

  res.json({ average, bestScore, mostPlayedCourse, handicap: { value: index, used: best.length, total: n } });
});

app.get('/api/stats/player/:id/net-curve', authRequired, async (req,res)=>{
  const playerId = req.params.id;
  const { rows } = await q('SELECT r.id, r.date, r.total, r.differential FROM rounds r WHERE r.player_id=$1 ORDER BY r.date ASC', [playerId]);
  const curve = []; const diffsSoFar = [];
  for(const r of rows){
    const n = diffsSoFar.length;
    let hcp = null;
    if(n>0){
      const useCount = (n>=20) ? 8 : Math.max(1, Math.round(n * 0.4));
      const best = diffsSoFar.slice().sort((a,b)=>a-b).slice(0,useCount);
      const avgBest = best.reduce((a,b)=>a+b,0) / best.length;
      hcp = roundTo1(avgBest * 0.96);
    } else { hcp = 0; }
    const net = Number(r.total) - (Math.round(hcp));
    curve.push({ id:r.id, date:r.date, gross:Number(r.total), handicap:hcp, net });
    diffsSoFar.push(Number(r.differential));
  }
  res.json(curve);
});

app.get('/api/stats/course/:id', authRequired, async (req, res) => {
  const courseId = req.params.id;
  const { rows: crows } = await q('SELECT id, name, location, hole_pars AS "holePars", rating, slope FROM courses WHERE id=$1',[courseId]);
  if (crows.length === 0) return res.status(404).json({ error: 'course not found' });
  const course = crows[0];
  const { rows: rrows } = await q(
    `SELECT r.id, r.player_id AS "playerId", r.total, r.holes, r.date, p.name AS "playerName"
       FROM rounds r JOIN players p ON p.id = r.player_id
      WHERE r.course_id = $1 ORDER BY r.date DESC`, [courseId]);
  if (rrows.length === 0) {
    return res.json({ course, averageAtCourse: null, bestAtCourse: null, easiest: null, hardest: null, bestPlayer: null });
  }
  const totals = rrows.map(r => Number(r.total));
  const averageAtCourse = totals.reduce((a,b) => a+b, 0) / totals.length;
  const bestRound = rrows.reduce((m, r) => (r.total < m.total ? r : m), rrows[0]);
  const bestAtCourse = { score: Number(bestRound.total), by: bestRound.playerName, playerId: bestRound.playerId, date: bestRound.date };
  const n = rrows.length;
  const sumsPerHole = Array.from({length: 18}, () => 0);
  rrows.forEach(r => r.holes.forEach((s, i) => { sumsPerHole[i] += Number(s) || 0; }));
  const overPerHole = sumsPerHole.map((sum, i) => (sum / n) - Number(course.holePars[i]));
  let easiestIdx = 0, hardestIdx = 0;
  overPerHole.forEach((ov, i) => { if (ov < overPerHole[easiestIdx]) easiestIdx = i; if (ov > overPerHole[hardestIdx]) hardestIdx = i; });
  const easiest = { hole: easiestIdx + 1, over: overPerHole[easiestIdx] };
  const hardest = { hole: hardestIdx + 1, over: overPerHole[hardestIdx] };
  const byPlayer = new Map();
  rrows.forEach(r => { if (!byPlayer.has(r.playerId)) byPlayer.set(r.playerId, { name: r.playerName, totals: [] }); byPlayer.get(r.playerId).totals.push(Number(r.total)); });
  let bestPlayer = null;
  for (const [playerId, v] of byPlayer.entries()) {
    const avg = v.totals.reduce((a,b)=>a+b,0) / v.totals.length;
    if (!bestPlayer || avg < bestPlayer.avg) bestPlayer = { playerId, name: v.name, avg, n: v.totals.length };
  }
  res.json({ course, averageAtCourse, bestAtCourse, easiest, hardest, bestPlayer });
});

// Milestones
app.get('/api/milestones', authRequired, async (req,res)=>{
  const { rows: rounds } = await q(`SELECT r.*, p.name AS player_name, c.name AS course_name, c.hole_pars AS "holePars"
                                    FROM rounds r
                                    JOIN players p ON p.id=r.player_id
                                    JOIN courses c ON c.id=r.course_id
                                    ORDER BY r.date ASC`);
  const byPlayer = new Map();
  const out = [];
  for(const r of rounds){
    const key = r.player_id;
    if(!byPlayer.has(key)){
      byPlayer.set(key, { u100:false, u90:false, u80:false, uplus5:false, par:0, under:0, eagle:0, alby:0, ace:0 });
    }
    const t = byPlayer.get(key);
    const parTotal = (r.hole_pars || r.holePars).reduce((a,b)=>a+Number(b),0);
    const rel = Number(r.total) - parTotal;
    const push = (date, player, ord, what, course) => out.push({ date, player, ord, what, course });
    if(!t.u100 && r.total < 100){ t.u100 = true; push(r.date, r.player_name, 'first', 'under 100', r.course_name); }
    if(!t.u90  && r.total <  90){ t.u90  = true; push(r.date, r.player_name, 'first', 'under 90',  r.course_name); }
    if(!t.u80  && r.total <  80){ t.u80  = true; push(r.date, r.player_name, 'first', 'under 80',  r.course_name); }
    if(!t.uplus5 && rel <= 5){   t.uplus5 = true; push(r.date, r.player_name, 'first', 'under +5', r.course_name); }
    if(rel === 0){ t.par++;   push(r.date, r.player_name, ordinal(t.par),   'scoring par',       r.course_name); }
    if(rel <  0){ t.under++; push(r.date, r.player_name, ordinal(t.under), 'scoring under par', r.course_name); }
    const pars = r.hole_pars || r.holePars;
    r.holes.forEach((s,i)=>{
      const par = Number(pars[i]); const sc = Number(s);
      if(sc === 1){ t.ace++;  push(r.date, r.player_name, ordinal(t.ace),  'hole in one', r.course_name); }
      if(par - sc === 2){ t.eagle++; push(r.date, r.player_name, ordinal(t.eagle), 'eagle', r.course_name); }
      if(par - sc === 3){ t.alby++;  push(r.date, r.player_name, ordinal(t.alby),  'albatross', r.course_name); }
    });
  }
  out.sort((a,b)=> new Date(b.date) - new Date(a.date));
  res.json(out);
});

function ordinal(n){
  const s = ["th","st","nd","rd"], v = n%100; return n + (s[(v-20)%10] || s[v] || s[0]);
}

// Serve SPA
app.get('/', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(()=> app.listen(PORT, ()=> console.log(`✅ Server running on http://localhost:${PORT}`)) );
