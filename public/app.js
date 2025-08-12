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
    psChart = new Chart(ctx,{ type:'line', data:{labels:[], datasets:[{label:'Gross score', data:[]}]}, options:{responsive:true}});
    return;
  }
  $('#ps-avg').textContent = s.average.toFixed(1);
  $('#ps-best').textContent = String(s.bestScore);
  $('#ps-most').textContent = s.mostPlayedCourse || '—';
  $('#ps-hcp').textContent = s.handicap.value!=null ? s.handicap.value.toFixed(1) : '—';
  $('#ps-hcp-hint').textContent = s.handicap.value!=null ? `(based on ${s.handicap.used} of ${s.handicap.total} rounds)` : '';

  const labels = curve.map(d=> formatDateAU(d.date));
  const grossData = curve.map(d=> d.gross);
  if(psChart){ psChart.destroy(); }
  const ctx = $('#ps-chart').getContext('2d');
  psChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [ { label: 'Gross score', data: grossData } ] },
    options: { responsive: true, interaction: { mode: 'nearest', intersect: false }, plugins: { legend: { display: true } }, scales: { y: { title: { display: true, text: 'Strokes' } }, x: { title: { display: true, text: 'Date' } } } }
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
