// ===== Utilities & API =====
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const pad2 = n => String(n).padStart(2,'0');
const formatDateAU = iso => { const d = new Date(iso); return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`; };
const ordinal = n => { const s=["th","st","nd","rd"], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };

async function api(path, opts={}){
  const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type':'application/json', ...(opts.headers||{}) }, ...opts });
  if(!res.ok){
    let msg = '';
    try{ msg = (await res.json()).error || res.statusText; }catch{ msg = res.statusText; }
    throw new Error(msg);
  }
  return res.json();
}
const me = ()=> api('/api/auth/me');
const login = (username,password)=> api('/api/auth/login',{ method:'POST', body: JSON.stringify({ username, password }) });
const logout = ()=> api('/api/auth/logout',{ method:'POST' });

const getPlayers = ()=> api('/api/players');
const getCourses = ()=> api('/api/courses');
const getRounds = (params={})=> api('/api/rounds'+(params.playerId||params.courseId?`?${new URLSearchParams(params)}`:''));
const postRound  = (body)=> api('/api/rounds', { method:'POST', body: JSON.stringify(body) });
const patchRound = (id, body)=> api(`/api/rounds/${id}`, { method:'PATCH', body: JSON.stringify(body) });
const deleteRound = (id)=> api(`/api/rounds/${id}`, { method:'DELETE' });

const statsPlayer= (id)=> api(`/api/stats/player/${id}`);
const statsCourse= (id)=> api(`/api/stats/course/${id}`);
const getMilestones= ()=> api('/api/milestones');
const netCurve = (id)=> api(`/api/stats/player/${id}/net-curve`);

const adminApi = {
  registerUser: (payload)=> api('/api/auth/register', { method:'POST', body: JSON.stringify(payload) }),
  addCourse: (payload)=> api('/api/courses', { method:'POST', body: JSON.stringify(payload) }),
  updateCourse: (id, payload)=> api(`/api/courses/${id}`, { method:'PATCH', body: JSON.stringify(payload) }),
  listUsers: ()=> api('/api/admin/users'),
  updateUser: (id, payload)=> api(`/api/admin/users/${id}`, { method:'PATCH', body: JSON.stringify(payload) }),
  deleteUser: (id)=> api(`/api/admin/users/${id}`, { method:'DELETE' }),
};

// ===== Router & Auth Gating =====
let currentUser = null;
const PAGES=[ ['page-home','Home'], ['page-person','Personal stats'], ['page-course','Course stats'], ['page-log','Log score'], ['page-admin','Admin'] ];
function initNav(){
  const nav = $('#nav'); nav.innerHTML='';
  PAGES.forEach(([id,label],i)=>{
    const b = document.createElement('button'); b.className='tab'; b.textContent=label; b.onclick=()=>showPage(id,b); nav.appendChild(b);
  });
}
function showPage(id, btn){
  $$('.page').forEach(s=> s.hidden = (s.id !== id));
  $$('#nav .tab').forEach(b=> b.classList.toggle('active', b===btn));
  if(id==='page-home') renderHome();
  if(id==='page-person') renderPersonPage();
  if(id==='page-course') renderCoursePage();
  if(id==='page-log') renderLogPage();
  if(id==='page-admin') renderAdminPage();
}

async function ensureAuth(){
  try{ currentUser = await me(); }catch{ currentUser = null; }
  if(!currentUser){
    $$('.page').forEach(s=> s.hidden = (s.id !== 'page-login'));
    $('#nav').innerHTML='';
    $('#login-btn').onclick = async ()=>{
      const u = $('#login-username').value.trim();
      const p = $('#login-password').value;
      $('#login-msg').textContent = 'Signing in...';
      try{ await login(u,p); $('#login-msg').textContent = ''; start(); }
      catch(e){ $('#login-msg').textContent = e.message || 'Login failed'; }
    };
    return false;
  } else {
    initNav();
    const isAdmin = currentUser.is_admin && currentUser.username==='jlogozzo';
    const tabs = $$('#nav .tab');
    tabs.forEach((t)=>{ if(t.textContent==='Admin') t.style.display = isAdmin? 'inline-flex' : 'none'; });
    showPage('page-home', $$('#nav .tab')[0]);
    return true;
  }
}

// ===== 18Birdies OCR upload (client-side via Tesseract.js) =====
function textToCandidates(txt){
  // Normalize and collect digits
  const t = txt.replace(/[|,]/g,' ').replace(/\s+/g,' ').trim();
  const nums = t.match(/\d+/g) || [];

  // Sliding windows of 18 numbers, each 1..15 → likely a score row
  const scores = [];
  for(let i=0;i<=nums.length-18;i++){
    const slice = nums.slice(i, i+18).map(n=>Number(n));
    if(slice.every(n=> n>=1 && n<=15)){
      const total = slice.reduce((a,b)=>a+b,0);
      scores.push({ kind:'scores', values: slice, total });
    }
  }
  // Deduplicate and sort
  const seen = new Set(); const out = [];
  for(const c of scores){
    const k = c.values.join('-');
    if(seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  out.sort((a,b)=> a.total - b.total);
  return out.slice(0, 10);
}

// Use this if you only need the plain text:
async function ocrImage(file, onProgress){
  const dataUrl = await new Promise((resolve,reject)=>{
    const fr = new FileReader(); fr.onload = ()=> resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file);
  });
  const ret = await Tesseract.recognize(dataUrl, 'eng', {
    logger: m => onProgress?.(m.status ? `${m.status}${m.progress!=null ? ' — '+Math.round(m.progress*100)+'%' : ''}` : '')
  });
  return ret.data.text || '';
}

// Use this if you also need word boxes (for the 2x9 scores parser):
async function ocrFull(file, onProgress){
  const dataUrl = await new Promise((resolve,reject)=>{
    const fr = new FileReader(); fr.onload = ()=> resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file);
  });
  const ret = await Tesseract.recognize(dataUrl, 'eng', {
    logger: m => onProgress?.(m.status ? `${m.status}${m.progress!=null ? ' — '+Math.round(m.progress*100)+'%' : ''}` : '')
  });
  return ret; // has ret.data.text and ret.data.words
}

function setupScorecardUploader(){
  const fileIn = document.getElementById('scorecard-file');
  const btn = document.getElementById('scorecard-ocr-btn');
  const res = document.getElementById('scorecard-results');
  if(!fileIn || !btn || !res) return;

  btn.onclick = async ()=>{
    if(!fileIn.files || !fileIn.files[0]){
      res.innerHTML = '<div class="hint">Choose an image first.</div>'; 
      return;
    }
    try{
      res.innerHTML = '<div class="hint">Running OCR…</div>';

      // Uses the helpers from Step 3 (parse18BirdiesAndApply)
      const out = await parse18BirdiesAndApply(
        fileIn.files[0], 
        { onStatus: s => res.innerHTML = `<div class="hint">${s}</div>` }
      );

      // Show what we detected
      const msgs = [];
      if(out.courseText) msgs.push(`Course detected: <strong>${out.courseText}</strong>`);
      if(out.day && out.month && out.year) msgs.push(
        `Date detected: <strong>${String(out.day).padStart(2,'0')}/${String(out.month).padStart(2,'0')}/${out.year}</strong>`
      );
      if(out.scores18) msgs.push(`Scores detected: <code>${out.scores18.join(', ')}</code>`);
      res.innerHTML = `<div class="hint">${msgs.length? msgs.join('<br>') : 'Parsed, but could not detect the fields.'}</div>`;

      // Apply course (fuzzy match)
      if(out.pickedCourseId){
        const sel = document.getElementById('log-course');
        if(sel){
          sel.value = out.pickedCourseId;
          buildLogTable(); // rebuild score table for that course
        }
      }

      // Apply date
      if(out.day && out.month && out.year){
        const d = document.getElementById('log-day');
        const m = document.getElementById('log-month');
        const y = document.getElementById('log-year');
        if(d&&m&&y){ d.value = out.day; m.value = out.month; y.value = out.year; }
      }

      // Apply 18 scores
      if(out.scores18){
        const wrap = document.getElementById('log-table-wrap');
        const selects = Array.from(wrap.querySelectorAll('.score-in'));
        if(selects.length === 18){
          selects.forEach((sel,i)=> sel.value = String(out.scores18[i]));
          updateLogTotals();
          res.innerHTML += '<div class="hint" style="margin-top:8px">Applied scores — review and Save round.</div>';
        }else{
          res.innerHTML += '<div class="hint" style="margin-top:8px">Could not find the 18 score inputs (is the course selected?).</div>';
        }
      }else{
        res.innerHTML += '<div class="hint" style="margin-top:8px">Couldn’t confidently read the 18 scores. You can still use manual entry.</div>';
      }
    }catch(e){
      res.innerHTML = `<div class="hint">OCR failed: ${e.message || e}</div>`;
    }
  };
}

// ===== 18Birdies parser (exact layout) =====
const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();

// Simple Levenshtein distance for fuzzy course match
function lev(a,b){
  a = norm(a); b = norm(b);
  const m=a.length, n=b.length;
  if(!m||!n) return Math.max(m,n);
  const dp = Array.from({length:m+1}, (_,i)=>[i].concat(Array(n).fill(0)));
  for(let j=1;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

async function ocrFull(file, onProgress){
  const dataUrl = await new Promise((resolve,reject)=>{
    const fr = new FileReader(); fr.onload = ()=>resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file);
  });
  const { createWorker } = Tesseract;
  const worker = await createWorker('eng', 1, { logger: onProgress? (m)=>onProgress(m) : undefined });
  const out = await worker.recognize(dataUrl);
  await worker.terminate();
  return out; // out.data.text and out.data.words
}

function extractCourseAndDate(text){
  // Course name = first non-empty line; date like 25/10/2024 (or 25/10/24)
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const courseLine = lines[0] || '';
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  let day=null, month=null, year=null;
  if(m){
    day = +m[1]; month = +m[2]; year = +m[3]; if(year<100) year += 2000;
  }
  return { courseText: courseLine, day, month, year };
}

function extractTwoRowsOfNineNumbers(words){
  // Keep numeric tokens and their midpoints
  const items = words
    .filter(w => /^\d+$/.test(w.text))
    .map(w => ({ n: +w.text, x: (w.bbox.x0 + w.bbox.x1)/2, y: (w.bbox.y0 + w.bbox.y1)/2 }));
  if(items.length < 18) return null;

  // Cluster by Y to identify text rows
  items.sort((a,b)=> a.y - b.y);
  const rows=[]; let cur=[];
  const rowGap = Math.max(18, (items[items.length-1].y - items[0].y) * 0.03);
  for(const it of items){
    if(!cur.length || Math.abs(it.y - cur[cur.length-1].y) < rowGap){ cur.push(it); }
    else { rows.push(cur); cur=[it]; }
  }
  if(cur.length) rows.push(cur);

  // For each row, left→right, keep 1..15, drop the last if there are 10 (9 holes + total)
  const scoreRows = rows.map(r=>{
    const nums = r.slice().sort((a,b)=> a.x - b.x).map(z=>z.n);
    // Keep only valid hole scores
    const onlyScores = nums.filter(v => v>=1 && v<=15);
    // If row has 10 numbers, drop the rightmost (9-hole total)
    if(onlyScores.length >= 10) onlyScores.pop();
    return onlyScores;
  }).filter(arr => arr.length >= 9);

  // Pick the two rows with the most valid numbers
  scoreRows.sort((a,b)=> b.length - a.length);
  if(scoreRows.length < 2) return null;
  const first9  = scoreRows[0].slice(0,9);
  const second9 = scoreRows[1].slice(0,9);
  if(first9.length!==9 || second9.length!==9) return null;
  return first9.concat(second9); // 18 scores
}

async function parse18BirdiesAndApply(file, { onStatus } = {}){
  onStatus?.('OCR starting…');
  const result = await ocrFull(file, (m)=> onStatus?.(`${m.status || 'working'} ${m.progress!=null? '— '+Math.round(m.progress*100)+'%':''}`));
  const text = result.data.text || '';
  const words = result.data.words || [];

  // 1) course + date
  const { courseText, day, month, year } = extractCourseAndDate(text);

  // 2) scores
  const scores18 = extractTwoRowsOfNineNumbers(words);

  // 3) try to pick the course
  let pickedCourseId = null;
  try{
    const courses = await getCourses();
    if(courses?.length){
      // Best fuzzy match by Levenshtein distance; also accept substring match as a tie-breaker
      const target = norm(courseText);
      // small hand-fix: your Neon has "Antill Park Country Golf Club"
      const aliases = {
        'antill park golf club':'antill park country golf club'
      };
      const targetAdj = aliases[target] || target;

      let best = null;
      courses.forEach(c=>{
        const cand = norm(c.name);
        const d = Math.min(lev(targetAdj, cand), lev(cand, targetAdj));
        const bonus = (cand.includes(targetAdj) || targetAdj.includes(cand)) ? 0 : 0.25; // prefer substrings
        const score = d + bonus;
        if(!best || score < best.score) best = { id: c.id, score, name: c.name };
      });
      pickedCourseId = best?.id || null;
    }
  }catch{}

  return { text, words, courseText, day, month, year, scores18, pickedCourseId };
}

// ===== Pages =====

// Home
async function renderHome(){
  const [players, courses, rounds, milestones] = await Promise.all([ getPlayers(), getCourses(), getRounds(), getMilestones() ]);
  const tbody = $('#home-last-table tbody'); tbody.innerHTML='';
  players.forEach(pl=>{
    const r = rounds.filter(x=>x.playerId===pl.id)[0];
    const tr = document.createElement('tr');
    const courseName = r ? (courses.find(c=>c.id===r.courseId)?.name || '—') : '—';
    tr.innerHTML = `<td>${pl.name}</td><td>${r?formatDateAU(r.date):'<span class="muted">—</span>'}</td><td>${r? r.total : '<span class="muted">—</span>'}</td><td>${courseName}</td>`;
    tbody.appendChild(tr);
  });

  const area = $('#milestones'); area.innerHTML='';
  if(milestones.length===0){ area.innerHTML='<div class="hint">No milestones yet.</div>'; return; }
  milestones.forEach(ev=>{
    const line = document.createElement('div'); line.className='milestone';
    line.textContent = `| ${formatDateAU(ev.date)} : ${ev.player} achieved their ${ev.ord||ev.ordinal||'—'} ${ev.what} at ${ev.course}`;
    area.appendChild(line);
  });
}

// Personal stats + graph
let psChart = null;
async function renderPersonPage(){
  const players = await getPlayers(); const sel = $('#person-select');
  sel.innerHTML = players.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  sel.onchange = ()=> renderPersonStats(sel.value);
  const initial = currentUser?.player_id || players[0]?.id;
  if(initial) sel.value = initial;
  if(initial) renderPersonStats(initial);
}
async function renderPersonStats(playerId){
  const [rounds, s, courses, curve] = await Promise.all([ getRounds({playerId}), statsPlayer(playerId), getCourses(), netCurve(playerId) ]);
  if(!rounds.length){
    $('#ps-avg').textContent='—'; $('#ps-best').textContent='—'; $('#ps-most').textContent='—'; $('#ps-hcp').textContent='—'; $('#ps-hcp-hint').textContent='';
    $('#person-rounds').innerHTML = '<div class="hint">No rounds yet for this player.</div>';
    if(psChart){ psChart.destroy(); psChart=null; }
    const ctx = $('#ps-chart').getContext('2d');
    psChart = new Chart(ctx,{ type:'line', data:{labels:[], datasets:[{label:'Over/under Par', data:[]}]}, options:{responsive:true}});
    return;
  }
  $('#ps-avg').textContent = s.average.toFixed(1);
  $('#ps-best').textContent = String(s.bestScore);
  $('#ps-most').textContent = s.mostPlayedCourse || '—';
  $('#ps-hcp').textContent = s.handicap.value!=null ? s.handicap.value.toFixed(1) : '—';
  $('#ps-hcp-hint').textContent = s.handicap.value!=null ? `(based on ${s.handicap.used} of ${s.handicap.total} rounds)` : '';

  const sorted = rounds.slice().sort((a,b)=> new Date(a.date) - new Date(b.date));
const labels = sorted.map(r=> formatDateAU(r.date));
const overData = sorted.map(r=>{
  const crs = courses.find(c=> c.id===r.courseId);
  const parTotal = (crs?.holePars||[]).reduce((a,b)=>a+Number(b),0);
  return Number(r.total) - Number(parTotal||0); // over/under par
});
if(psChart){ psChart.destroy(); }
const ctx = $('#ps-chart').getContext('2d');
psChart = new Chart(ctx, {
  type: 'line',
  data: { labels, datasets: [ { label: 'Over/under par', data: overData } ] },
  options: {
    responsive: true,
    interaction: { mode: 'nearest', intersect: false },
    plugins: { legend: { display: true } },
    scales: {
      y: { title: { display: true, text: 'Strokes vs par' }, suggestedMin: -10, suggestedMax: 20 },
      x: { title: { display: true, text: 'Date' } }
    }
  }
});

  const list = $('#person-rounds'); list.innerHTML='';
  rounds.forEach(r=>{
    const el = document.createElement('details'); el.className='round';
    const course = courses.find(c=>c.id===r.courseId);
    const parTotal = (course?.holePars||[]).reduce((a,b)=>a+Number(b),0);
    const rel = r.total - parTotal; const relTxt = rel===0? 'E' : (rel>0? '+'+rel : String(rel));
    el.innerHTML = `<summary>${formatDateAU(r.date)} — ${course?.name||''} — <strong>${r.total}</strong> (<span class="${rel<0?'good':(rel>0?'bad':'')}">${relTxt}</span>)</summary>`;
    const inner = document.createElement('div'); inner.className='bd';
    const rows = r.holes.map((s,i)=>`<tr><td>${i+1}</td><td>${course?.holePars[i]}</td><td>${s}</td></tr>`).join('');
    const table = `<table class="score-compact"><thead><tr><th>Hole</th><th>Par</th><th>Score</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>Total</th><th>${parTotal}</th><th>${r.total}</th></tr></tfoot></table>`;
    const rating = course?.rating ?? 72; const slope = course?.slope ?? 113;
    inner.innerHTML = `<div class="hint">Adj. Gross: <code>${r.adjGross}</code> · Course Rating: <code>${rating}</code> · Slope: <code>${slope}</code> · Differential: <code>${r.differential?.toFixed? r.differential.toFixed(1) : r.differential}</code></div><div style="height:8px"></div>${table}`;

    const canDelete = (currentUser?.is_admin && currentUser?.username==='jlogozzo') || (currentUser?.player_id === r.playerId);
    if(canDelete){
      const spacer = document.createElement('div'); spacer.style.height='8px';
      const rowBtns = document.createElement('div'); rowBtns.className='row';
      const del = document.createElement('button'); del.className='btn secondary'; del.textContent='Delete round';
      del.onclick = async ()=>{
        const ok = confirm(`Delete round on ${formatDateAU(r.date)} at ${course?.name}?`);
        if(!ok) return;
        await deleteRound(r.id);
        await renderPersonStats(playerId);
        renderHome();
      };
      rowBtns.appendChild(del);

      if(currentUser?.is_admin && currentUser?.username==='jlogozzo'){
        const edit = document.createElement('button'); edit.className='btn'; edit.textContent='Edit round';
        edit.onclick = ()=> toggleEdit(el, r, course, playerId);
        rowBtns.appendChild(edit);
      }

      inner.appendChild(spacer); inner.appendChild(rowBtns);
    }

    el.appendChild(inner); list.appendChild(el);
  });
}

// Build edit UI for a round (admin)
function toggleEdit(container, round, course, playerId){
  let wrap = container.querySelector('.edit-wrap');
  if(wrap){ wrap.remove(); return; }
  wrap = document.createElement('div'); wrap.className='edit-wrap';

  const d = new Date(round.date);
  const dayOpts = Array.from({length:31}, (_,i)=>`<option ${d.getUTCDate()===(i+1)?'selected':''} value="${i+1}">${i+1}</option>`).join('');
  const monOpts = Array.from({length:12}, (_,i)=>`<option ${d.getUTCMonth()===(i)?'selected':''} value="${i+1}">${i+1}</option>`).join('');
  const years=[]; for(let y=2020;y<=2030;y++) years.push(y);
  const yrOpts = years.map(y=>`<option ${d.getUTCFullYear()===y?'selected':''} value="${y}">${y}</option>`).join('');

  const scoreRow = (i)=>{
    const opts = Array.from({length:15}, (_,k)=>`<option ${round.holes[i]===(k+1)?'selected':''} value="${k+1}">${k+1}</option>`).join('');
    return `<tr><td>${i+1}</td><td>${course.holePars[i]}</td><td><select class="edit-score" data-idx="${i}">${opts}</select></td></tr>`;
  };
  const rows = Array.from({length:18}, (_,i)=> scoreRow(i)).join('');

  wrap.innerHTML = `
    <div class="row">
      <div class="field"><label>Day</label><select class="edit-day">${dayOpts}</select></div>
      <div class="field"><label>Month</label><select class="edit-mon">${monOpts}</select></div>
      <div class="field"><label>Year</label><select class="edit-yr">${yrOpts}</select></div>
      <div class="field"><label>Adjusted Gross (optional)</label><input class="edit-ags" type="number" step="1" value="${round.adjGross??''}"></div>
    </div>
    <div style="height:8px"></div>
    <table class="score-compact"><thead><tr><th>Hole</th><th>Par</th><th>Score</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><th>Total</th><th>${course.holePars.reduce((a,b)=>a+Number(b),0)}</th><th class="edit-total">0</th></tr></tfoot>
    </table>
    <div style="height:10px"></div>
    <div class="row">
      <button class="btn" id="edit-save">Save changes</button>
      <button class="btn secondary" id="edit-cancel">Cancel</button>
      <span class="hint" id="edit-msg"></span>
    </div>
  `;
  container.appendChild(wrap);

  const updateTotal = ()=>{
    const scores = $$('.edit-score', wrap).map(s=> Number(s.value)||0);
    const total = scores.reduce((a,b)=>a+b,0);
    $('.edit-total', wrap).textContent = total;
  };
  $$('.edit-score', wrap).forEach(s=> s.addEventListener('change', updateTotal));
  updateTotal();

  $('#edit-cancel', wrap).onclick = ()=> wrap.remove();
  $('#edit-save', wrap).onclick = async ()=>{
    const day = Number($('.edit-day', wrap).value);
    const mon = Number($('.edit-mon', wrap).value);
    const yr  = Number($('.edit-yr', wrap).value);
    const date = new Date(Date.UTC(yr, mon-1, day, 12, 0, 0)).toISOString();
    const holes = $$('.edit-score', wrap).map(s=> Number(s.value)||0);
    const agsVal = $('.edit-ags', wrap).value;
    const adjGross = agsVal ? Number(agsVal) : undefined;

    try{
      await patchRound(round.id, { holes, adjGross, date });
      $('#edit-msg', wrap).textContent = 'Saved';
      setTimeout(()=> { wrap.remove(); renderPersonStats(playerId); renderHome(); }, 400);
    }catch(e){
      $('#edit-msg', wrap).textContent = e.message || 'Failed to save';
    }
  };
}

// Course stats
async function renderCoursePage(){
  const courses = await getCourses(); const sel = $('#course-select');
  sel.innerHTML = courses.map(c=>`<option value="${c.id}">${c.name} — ${c.location||''}</option>`).join('');
  sel.onchange = ()=> renderCourseStats(sel.value);
  if(courses[0]) renderCourseStats(courses[0].id);
}
async function renderCourseStats(courseId){
  const s = await statsCourse(courseId);
  const c = s.course; const parTotal = (c.holePars||[]).reduce((a,b)=>a+Number(b),0);
  $('#cs-name').textContent = c.name; $('#cs-loc').textContent = c.location||'—';
  $('#cs-par').textContent = String(parTotal); $('#cs-rating').textContent = Number(c.rating).toFixed(1);
  if(s.averageAtCourse==null){
    $('#cs-avg').textContent='—'; $('#cs-best').textContent='—'; $('#cs-easiest').textContent='—'; $('#cs-hardest').textContent='—'; $('#cs-bestplayer').textContent='—'; return;
  }
  $('#cs-avg').textContent = s.averageAtCourse.toFixed(1);
  $('#cs-best').textContent = `${s.bestAtCourse.score} by ${s.bestAtCourse.by}`;
  const fmt = (o)=> `Hole ${o.hole} (avg ${(o.over>=0?'+':'')}${o.over.toFixed(2)} vs par)`;
  $('#cs-easiest').textContent = fmt(s.easiest);
  $('#cs-hardest').textContent = fmt(s.hardest);
  $('#cs-bestplayer').textContent = `${s.bestPlayer.name} (avg ${s.bestPlayer.avg.toFixed(1)} over ${s.bestPlayer.n} rounds)`;
}

// Log score
let coursesCache = [];
async function renderLogPage(){
  const [players, courses] = await Promise.all([ getPlayers(), getCourses() ]);
  coursesCache = courses;
  const pSel = $('#log-player'); const cSel = $('#log-course');
  const playerRow = $('#log-player-row');

  if(currentUser?.is_admin && currentUser?.username==='jlogozzo'){
    playerRow.style.display = 'flex';
    pSel.innerHTML = players.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  }else{
    playerRow.style.display = 'flex';
    const self = players.find(p=> p.id === currentUser?.player_id);
    pSel.innerHTML = self ? `<option value="${self.id}">${self.name}</option>` : '<option>(no profile)</option>';
    pSel.disabled = true;
  }

  cSel.innerHTML = courses.map(c=>`<option value="${c.id}">${c.name} — ${c.location||''}</option>`).join('');
  cSel.onchange = buildLogTable; buildLogTable();
initDateSelectors();
setupScorecardUploader();
$('#log-save').onclick = saveLoggedRound;
}

function initDateSelectors(){
  const day = $('#log-day'), mon = $('#log-month'), yr = $('#log-year');
  day.innerHTML = Array.from({length:31}, (_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
  mon.innerHTML = Array.from({length:12}, (_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
  const years = []; for(let y=2020;y<=2030;y++) years.push(y);
  yr.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  const d = new Date(); day.value = d.getDate(); mon.value = d.getMonth()+1; yr.value = d.getFullYear();
}
function buildLogTable(){
  const c = coursesCache.find(x=> x.id === $('#log-course').value);
  const wrap = $('#log-table-wrap'); if(!c){ wrap.innerHTML = '<div class="hint">Select a course</div>'; return; }
  const rows=[]; rows.push('<tr><th>Hole</th><th>Par</th><th>Score</th></tr>');
  for(let i=0;i<18;i++){
    const opts = Array.from({length:15}, (_,k)=>`<option value="${k+1}">${k+1}</option>`).join('');
    rows.push(`<tr><td>${i+1}</td><td>${c.holePars[i]}</td><td><select class="score-in" data-hole="${i}"><option value="">—</option>${opts}</select></td></tr>`);
  }
  const parTotal = c.holePars.reduce((a,b)=>a+Number(b),0);
  rows.push(`<tr><th>Total</th><th>${parTotal}</th><th id="log-total-cell">0</th></tr>`);
  wrap.innerHTML = `<table id="log-table"><tbody>${rows.join('')}</tbody></table>`;
  $$('.score-in', wrap).forEach(sel=> sel.addEventListener('change', updateLogTotals));
  updateLogTotals();
}
function updateLogTotals(){
  const c = coursesCache.find(x=> x.id === $('#log-course').value);
  const scores = $$('.score-in').map(s=> Number(s.value)||0);
  const total = scores.reduce((a,b)=>a+b,0);
  $('#log-total-cell').textContent = total; $('#log-total').value = total;
  const rating = Number(c?.rating ?? 72); const slope = Number(c?.slope ?? 113) || 113;
  const agsRaw = Number($('#log-ags').value); const ags = isNaN(agsRaw) || !$('#log-ags').value ? total : agsRaw;
  const diff = ((ags - rating) * 113) / slope;
  $('#log-diff').value = Number.isFinite(diff) ? (Math.round(diff*10)/10).toFixed(1) : '';
}
$('#log-ags')?.addEventListener?.('input', updateLogTotals);
async function saveLoggedRound(){
  const playerId = $('#log-player').value; const courseId = $('#log-course').value;
  const scores = $$('.score-in').map(s=> Number(s.value)||0);
  if(scores.filter(Boolean).length < 18){ $('#log-msg').textContent='Please enter all 18 hole scores.'; return; }
  const adjGross = $('#log-ags').value ? Number($('#log-ags').value) : undefined;
  const day = Number($('#log-day').value), mon = Number($('#log-month').value), yr = Number($('#log-year').value);
  const date = new Date(Date.UTC(yr, mon-1, day, 12, 0, 0)).toISOString();
  await postRound({ playerId, courseId, holes: scores, adjGross, date });
  $('#log-msg').textContent = 'Round saved!'; setTimeout(()=> $('#log-msg').textContent='', 1500);
  $$('.score-in').forEach(s=> s.value=''); $('#log-ags').value=''; updateLogTotals();
  renderHome();
}

// Admin
async function renderAdminPage(){
  const badge = $('#admin-badge');
  const isAdmin = currentUser?.is_admin && currentUser?.username==='jlogozzo';
  if(!isAdmin){
    badge.textContent = 'Restricted';
    $('#sec-users').innerHTML = '<div class="hint">Only the admin user can access this page.</div>';
    $('#sec-courses').innerHTML = '';
    $('#sec-profiles').innerHTML = '';
    return;
  }
  badge.textContent = `Signed in as ${currentUser.username}`;

  const items = $$('.sidemenu .item');
  items.forEach(it=> it.onclick = ()=>{
    items.forEach(x=> x.classList.remove('active'));
    it.classList.add('active');
    const sec = it.dataset.sec;
    $$('.section').forEach(s=> s.classList.remove('active'));
    if(sec==='users') { $('#sec-users').classList.add('active'); renderAdminUsers(); }
    if(sec==='courses') { $('#sec-courses').classList.add('active'); renderAdminCourses(); }
    if(sec==='profiles') { $('#sec-profiles').classList.add('active'); renderAdminProfiles(); }
  });
  items[0].click();
}

// Section: User List
async function renderAdminUsers(){
  const target = $('#sec-users');
  target.innerHTML = '<div class="hint">Loading users…</div>';
  const users = await adminApi.listUsers();
  const rows = users.map(u=>{
    const role = u.is_admin ? 'Admin' : 'User';
    const status = u.is_disabled ? 'Disabled' : 'Active';
    const actions = u.username==='jlogozzo' ? '' : `
      <button class="btn secondary" data-act="toggle" data-id="${u.id}">${u.is_disabled?'Enable':'Disable'}</button>
      <button class="btn secondary" data-act="reset" data-id="${u.id}">Reset Password</button>
      <button class="btn" data-act="delete" data-id="${u.id}">Delete</button>`;
    return `<tr>
      <td>${u.username}</td><td>${u.name||'—'}</td><td>${role}</td><td>${status}</td><td>${u.rounds}</td>
      <td class="row" style="gap:8px">${actions}</td>
    </tr>`;
  }).join('');
  target.innerHTML = `
    <div class="row" style="justify-content:flex-end;gap:12px"><button class="btn secondary" id="refresh-users">Refresh</button></div>
    <table>
      <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Rounds</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="hint" style="margin-top:8px">Delete removes the login, the player profile, and all of their rounds (cascade). You cannot delete/disable the core admin account.</div>
  `;
  $('#refresh-users').onclick = renderAdminUsers;
  target.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.dataset.id, act = btn.dataset.act;
      try{
        if(act==='toggle'){
          const user = users.find(x=>x.id===id);
          await adminApi.updateUser(id, { is_disabled: !user.is_disabled });
        } else if(act==='reset'){
          const pwd = prompt('Enter a new password for this user:');
          if(!pwd) return;
          await adminApi.updateUser(id, { password: pwd });
        } else if(act==='delete'){
          const ok = confirm('Delete this user, their player, and ALL their rounds? This cannot be undone.');
          if(!ok) return;
          await adminApi.deleteUser(id);
        }
        renderAdminUsers();
      }catch(e){ alert(e.message); }
    };
  });
}

// Section: Create / Edit Course
async function renderAdminCourses(){
  const target = $('#sec-courses');
  target.innerHTML = `
    <div class="row" style="max-width:720px">
      <div class="field" style="flex:2"><label>Course name</label><input id="new-course-name" type="text"></div>
      <div class="field" style="flex:2"><label>Location</label><input id="new-course-loc" type="text"></div>
      <div><label>&nbsp;</label><button class="btn" id="add-course-btn">Add course</button></div>
    </div>
    <div class="hint">Default rating 72.0, slope 113, all pars 4 — you can edit below.</div>
    <div style="height:16px"></div>
    <div class="row" style="max-width:860px">
      <div class="field" style="flex:2"><label>Select course</label><select id="edit-course"></select></div>
      <div class="field"><label>Course rating</label><input id="edit-rating" type="number" step="0.1" min="60" max="80"></div>
      <div class="field"><label>Slope rating</label><input id="edit-slope" type="number" step="1" min="55" max="155"></div>
      <div style="align-self:flex-end"><button class="btn secondary" id="save-course-meta">Save meta</button></div>
    </div>
    <div style="height:12px"></div>
    <div id="pars-grid" class="grid"></div>
    <div style="height:12px"></div>
    <button class="btn" id="save-pars">Save pars</button>
  `;
  $('#add-course-btn').onclick = async ()=>{
    const name = $('#new-course-name').value.trim(); const location = $('#new-course-loc').value.trim();
    if(!name) return alert('Enter a course name');
    try{ await adminApi.addCourse({ name, location }); alert('Course added'); $('#new-course-name').value=''; $('#new-course-loc').value=''; refreshEditCourse(); }
    catch(e){ alert(e.message); }
  };
  async function refreshEditCourse(){
    const courses = await getCourses();
    const sel = $('#edit-course'); sel.innerHTML = courses.map(c=>`<option value="${c.id}">${c.name} — ${c.location||''}</option>`).join('');
    const c = courses[0]; if(!c) return; $('#edit-rating').value = c.rating; $('#edit-slope').value = c.slope;
    const grid = $('#pars-grid'); grid.innerHTML='';
    for(let i=0;i<18;i++){
      const block = document.createElement('div'); block.className='col-3';
      block.innerHTML = `<div class="field"><label>Hole ${i+1} par</label><select class="par-pick">${[3,4,5,6].map(v=>`<option ${c.holePars[i]===v?'selected':''}>${v}</option>`).join('')}</select></div>`;
      grid.appendChild(block);
    }
    sel.onchange = async ()=>{
      const cid = sel.value; const cc = (await getCourses()).find(x=>x.id===cid);
      $('#edit-rating').value = cc.rating; $('#edit-slope').value = cc.slope;
      $$('.par-pick').forEach((el,i)=> el.value = cc.holePars[i]);
    };
    $('#save-course-meta').onclick = async ()=>{
      const cid = $('#edit-course').value; const rating = Number($('#edit-rating').value); const slope = Number($('#edit-slope').value);
      try{ await adminApi.updateCourse(cid, { rating, slope }); alert('Saved'); } catch(e){ alert(e.message); }
    };
    $('#save-pars').onclick = async ()=>{
      const cid = $('#edit-course').value; const pars = $$('.par-pick').map(s=> Number(s.value));
      try{ await adminApi.updateCourse(cid, { holePars: pars }); alert('Saved'); } catch(e){ alert(e.message); }
    };
  }
  refreshEditCourse();
}

// Section: Create Profile / Log Score
async function renderAdminProfiles(){
  const target = $('#sec-profiles');
  target.innerHTML = `
    <div class="card"><div class="hd"><h2>Create user profile</h2></div>
      <div class="bd">
        <div class="row" style="max-width:720px">
          <div class="field" style="flex:2"><label>Display name</label><input id="new-name" type="text" placeholder="e.g. Joshua Logozzo"></div>
          <div class="field" style="flex:2"><label>Username</label><input id="new-username" type="text" placeholder="e.g. josh"></div>
          <div class="field" style="flex:2"><label>Password</label><input id="new-password" type="password" placeholder="Set a secure password"></div>
          <div><label>&nbsp;</label><button class="btn" id="create-user-btn">Create</button></div>
        </div>
        <div class="hint">Creates a player + login. Only admin can create/delete users.</div>
      </div>
    </div>

    <div style="height:16px"></div>

    <div class="card"><div class="hd"><h2>Log a score (any player)</h2></div>
      <div class="bd">
        <div class="row" id="adm-log-player-row">
          <div class="field"><label>Player</label><select id="adm-log-player"></select></div>
          <div class="field"><label>Course</label><select id="adm-log-course"></select></div>
        </div>
        <div style="height:8px"></div>
        <div class="row">
          <div class="field"><label>Date — Day</label><select id="adm-log-day"></select></div>
          <div class="field"><label>Month</label><select id="adm-log-month"></select></div>
          <div class="field"><label>Year</label><select id="adm-log-year"></select></div>
        </div>
        <div style="height:12px"></div>
        <div id="adm-log-table-wrap"></div>
        <div style="height:12px"></div>
        <div class="grid">
          <div class="col-4"><div class="field"><label>Computed total</label><input id="adm-log-total" type="number" readonly></div></div>
          <div class="col-4"><div class="field"><label>Adjusted Gross Score (optional)</label><input id="adm-log-ags" type="number" step="1"/></div></div>
          <div class="col-4"><div class="field"><label>Handicap Differential</label><input id="adm-log-diff" type="text" readonly></div></div>
        </div>
        <div class="hint">Differential = ((Adjusted Gross Score − Course Rating) × 113) ÷ Slope Rating</div>
        <div style="height:14px"></div>
        <button class="btn" id="adm-log-save">Save round</button>
        <span class="hint" id="adm-log-msg" style="margin-left:12px"></span>
      </div>
    </div>
  `;

  $('#create-user-btn').onclick = async ()=>{
    const name = $('#new-name').value.trim();
    const username = $('#new-username').value.trim();
    const password = $('#new-password').value;
    if(!name || !username || !password) return alert('Fill all fields');
    try{
      await adminApi.registerUser({ name, username, password });
      alert('User created');
      $('#new-name').value=''; $('#new-username').value=''; $('#new-password').value='';
      renderAdminUsers();
      initAdminLog();
    }catch(e){ alert(e.message); }
  };

  async function initAdminLog(){
    const [players, courses] = await Promise.all([ getPlayers(), getCourses() ]);
    $('#adm-log-player').innerHTML = players.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    $('#adm-log-course').innerHTML = courses.map(c=>`<option value="${c.id}">${c.name} — ${c.location||''}</option>`).join('');
    $('#adm-log-course').onchange = buildAdmLogTable;
    buildAdmLogTable();
    initDateSelectors('adm-log-day','adm-log-month','adm-log-year');
    $('#adm-log-save').onclick = saveAdminLoggedRound;
  }
  function initDateSelectors(dayId, monId, yrId){
    const day = document.getElementById(dayId), mon = document.getElementById(monId), yr = document.getElementById(yrId);
    day.innerHTML = Array.from({length:31}, (_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
    mon.innerHTML = Array.from({length:12}, (_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
    const years = []; for(let y=2020;y<=2030;y++) years.push(y);
    yr.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
    const d = new Date(); day.value = d.getDate(); mon.value = d.getMonth()+1; yr.value = d.getFullYear();
  }
  let coursesCache = [];
  async function buildAdmLogTable(){
    const courses = await getCourses(); coursesCache = courses;
    const c = courses.find(x=> x.id === $('#adm-log-course').value) || courses[0];
    const wrap = $('#adm-log-table-wrap'); if(!c){ wrap.innerHTML = '<div class="hint">Select a course</div>'; return; }
    const rows=[]; rows.push('<tr><th>Hole</th><th>Par</th><th>Score</th></tr>');
    for(let i=0;i<18;i++){
      const opts = Array.from({length:15}, (_,k)=>`<option value="${k+1}">${k+1}</option>`).join('');
      rows.push(`<tr><td>${i+1}</td><td>${c.holePars[i]}</td><td><select class="adm-score-in" data-hole="${i}"><option value="">—</option>${opts}</select></td></tr>`);
    }
    const parTotal = c.holePars.reduce((a,b)=>a+Number(b),0);
    rows.push(`<tr><th>Total</th><th>${parTotal}</th><th id="adm-log-total-cell">0</th></tr>`);
    wrap.innerHTML = `<table class="score-compact"><tbody>${rows.join('')}</tbody></table>`;
    $$('.adm-score-in', wrap).forEach(sel=> sel.addEventListener('change', updateAdmLogTotals));
    updateAdmLogTotals();
  }
  function updateAdmLogTotals(){
    const c = coursesCache.find(x=> x.id === $('#adm-log-course').value);
    const scores = $$('.adm-score-in').map(s=> Number(s.value)||0);
    const total = scores.reduce((a,b)=>a+b,0);
    $('#adm-log-total-cell').textContent = total; $('#adm-log-total').value = total;
    const rating = Number(c?.rating ?? 72); const slope = Number(c?.slope ?? 113) || 113;
    const agsRaw = Number($('#adm-log-ags').value); const ags = isNaN(agsRaw) || !$('#adm-log-ags').value ? total : agsRaw;
    const diff = ((ags - rating) * 113) / slope;
    $('#adm-log-diff').value = Number.isFinite(diff) ? (Math.round(diff*10)/10).toFixed(1) : '';
  }
  $('#adm-log-ags')?.addEventListener?.('input', updateAdmLogTotals);
  async function saveAdminLoggedRound(){
    const playerId = $('#adm-log-player').value; const courseId = $('#adm-log-course').value;
    const scores = $$('.adm-score-in').map(s=> Number(s.value)||0);
    if(scores.filter(Boolean).length < 18){ $('#adm-log-msg').textContent='Please enter all 18 hole scores.'; return; }
    const adjGross = $('#adm-log-ags').value ? Number($('#adm-log-ags').value) : undefined;
    const day = Number($('#adm-log-day').value), mon = Number($('#adm-log-month').value), yr = Number($('#adm-log-year').value);
    const date = new Date(Date.UTC(yr, mon-1, day, 12, 0, 0)).toISOString();
    await postRound({ playerId, courseId, holes: scores, adjGross, date });
    $('#adm-log-msg').textContent = 'Round saved!'; setTimeout(()=> $('#adm-log-msg').textContent='', 1500);
    $$('.adm-score-in').forEach(s=> s.value=''); $('#adm-log-ags').value=''; updateAdmLogTotals();
  }

  initAdminLog();
}

// ===== Boot =====
async function start(){
  const ok = await ensureAuth();
  if(!ok) return;
}
start();
