const main = document.querySelector('#main');
const logoutButton = document.querySelector('#logout-btn');
let selectedRole = 'elder';
let dashboard = null;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
const roleCopy = { elder: ['ELDER PORTAL','Own your care, on your terms.'], caregiver: ['CAREGIVER PORTAL','Coordinate routines without taking control away.'], family: ['FAMILY PORTAL','Stay informed, not overbearing.'] };

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type':'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function renderLogin() {
  main.innerHTML = `
    <section class="login-grid">
      <div class="login-info">
        <div class="kicker">ELDER-FIRST / CARE COORDINATION</div>
        <h1 class="section-title">Care, <span>connected.</span></h1>
        <p class="copy">A shared care mesh for medication routines, appointments and trusted family or caregiver access — with the older adult always at the center of the decision.</p>
        <div class="decor-rule"></div>
        <div class="role-list" role="tablist" aria-label="Choose portal role">
          ${Object.entries(roleCopy).map(([role, [label, desc]]) => `<button class="role-card ${role===selectedRole?'active':''}" data-role="${role}" role="tab" aria-selected="${role===selectedRole}"><small>${label}</small><strong>${desc}</strong></button>`).join('')}
        </div>
      </div>
      <div class="login-panel">
        <div class="panel" style="width:100%;max-width:520px;margin:auto">
          <div class="panel-inner">
            <div class="panel-label">Secure access</div>
            <h2>${escapeHtml(roleCopy[selectedRole][0])}</h2>
            <p class="hint">Passcode-based access. This demo uses synthetic data only.</p>
            <form id="login-form" style="margin-top:1.5rem">
              <div class="field"><label for="passcode">4-digit access code</label><input id="passcode" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" placeholder="••••" required /></div>
              <button class="pill primary" type="submit">Enter care space ↗</button>
            </form>
            <div class="decor-rule"></div>
            <div class="hint">Demo access codes: Elder 1234 · Caregiver 2468 · Family 1357</div>
          </div>
        </div>
      </div>
    </section>`;

  document.querySelectorAll('[data-role]').forEach((button) => button.addEventListener('click', () => { selectedRole = button.dataset.role; renderLogin(); }));
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/auth/login', { method:'POST', body: JSON.stringify({ role:selectedRole, passcode:document.querySelector('#passcode').value }) }); await loadDashboard(); }
    catch (error) { toast(error.message, true); }
  });
}

async function loadDashboard() {
  try { dashboard = await api('/api/dashboard'); logoutButton.classList.remove('hidden'); renderDashboard('overview'); }
  catch { logoutButton.classList.add('hidden'); renderLogin(); }
}

function renderDashboard(view='overview') {
  const user = dashboard.user;
  main.innerHTML = `
    <section class="dashboard-shell">
      <aside class="sidebar">
        <div class="side-user"><div class="avatar">${escapeHtml(user.initials)}</div><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.role.toUpperCase())} · CARE CIRCLE</span></div>
        ${navButton('overview','Overview','01')}${navButton('medications','Medications','02')}${navButton('appointments','Appointments','03')}${navButton('care-team','Care circle','04')}${navButton('timeline','Timeline','05')}
      </aside>
      <section class="content">${viewMarkup(view)}</section>
    </section>`;
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => renderDashboard(button.dataset.view)));
  bindInteractions(view);
}

function navButton(id,label,num){return `<button class="nav-btn ${location.hash==='#'+id?'active':''}" data-view="${id}"><span>${label}</span><small>${num} ↗</small></button>`}

function viewMarkup(view){
  const data = dashboard;
  const pending = data.medications.filter(m=>m.status==='pending').length;
  const taken = data.medications.filter(m=>m.status==='taken').length;
  const upcoming = data.appointments.length;
  if(view==='medications') return medicationsView();
  if(view==='appointments') return appointmentsView();
  if(view==='care-team') return teamView();
  if(view==='timeline') return timelineView();
  return overviewView(pending,taken,upcoming);
}

function overviewView(pending,taken,upcoming){return `
  <div class="content-head"><div class="title">Good morning, <span>${escapeHtml(dashboard.profile.name.split(' ')[0])}.</span></div><div class="meta">CAREMESH / ${new Date().toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'}).toUpperCase()}<br>ONE SHARED VIEW. ELDER-LED.</div></div>
  <div class="grid-12">
    <div class="cell span-4"><div class="card"><div class="card-title"><h3>Today’s medication state</h3><span class="micro">CARE PULSE</span></div><div class="big-stat">${taken}/${dashboard.medications.length}</div><p class="muted">scheduled confirmations complete</p><div class="decor-rule"></div><span class="tag ${pending ? 'pending':'ok'}">${pending ? pending+' PENDING':'ON TRACK'}</span></div></div>
    <div class="cell span-4"><div class="card"><div class="card-title"><h3>Appointments</h3><span class="micro">NEXT</span></div><div class="big-stat">${upcoming}</div><p class="muted">upcoming care events</p><div class="decor-rule"></div><strong>${escapeHtml(dashboard.appointments[0]?.doctor || 'No appointments')}</strong><div class="micro">${dashboard.appointments[0] ? `${formatDate(dashboard.appointments[0].date)} · ${dashboard.appointments[0].time}` : '—'}</div></div></div>
    <div class="cell span-4"><div class="card"><div class="card-title"><h3>Care circle</h3><span class="micro">TRUSTED ACCESS</span></div><div class="big-stat">${dashboard.careTeam.length}</div><p class="muted">people with active access</p><div class="decor-rule"></div><div class="micro">${dashboard.careTeam.map((member)=>escapeHtml(member.name)).join(' · ')}</div></div></div>
    <div class="cell span-7"><div class="card"><div class="card-title"><h3>CarePulse · live routine</h3><span class="micro">ACTIVITY</span></div>${dashboard.events.slice(0,4).map(eventRow).join('')}</div></div>
    <div class="cell span-5"><div class="card"><div class="card-title"><h3>AI Care Brief</h3><span class="micro">GEMINI / FALLBACK SAFE</span></div><div class="brief">${escapeHtml(dashboard.careBrief)}</div><div class="hero-mini" style="margin-top:1.2rem"><div class="micro">DESIGN PRINCIPLE</div><div style="font-size:.85rem;line-height:1.5">The elder stays in control. Care teams receive the right signal, not every detail.</div></div></div></div>
  </div>`}

function eventRow(event){return `<div class="timeline-item"><div class="timeline-time">${escapeHtml(event.at)}</div><div><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.actor)} · ${escapeHtml(event.detail)}</p></div></div>`}

function medicationsView(){const editable=dashboard.user.role!=='family';return `<div class="content-head"><div class="title">Medication <span>control.</span></div><div class="meta">SCHEDULES · ADHERENCE · REMINDERS<br>TRACK ROUTINES WITHOUT TAKING CONTROL AWAY.</div></div><div class="hero-mini" style="margin-bottom:1rem"><div class="card-title"><h3>CarePulse</h3><span class="tag ${dashboard.medications.some(m=>m.status==='pending')?'pending':'ok'}">${dashboard.medications.some(m=>m.status==='pending')?'ACTION NEEDED':'ON TRACK'}</span></div><p class="muted" style="margin:0">The system can detect a missed routine, notify the designated caregiver, and surface the event in the shared timeline.</p></div><div class="cell"><div class="card">${dashboard.medications.map(medRow).join('')}${editable?`<div style="margin-top:1rem;display:flex;gap:10px"><button class="pill" id="add-med-btn">Add medication ↗</button><button class="pill subtle" id="run-reminders-btn">Run reminder check ↗</button></div>`:`<div class="hint" style="margin-top:1rem">Family access is read-only. The elder and designated caregiver manage medication schedules.</div>`}</div></div>`}
function medRow(m){const editable=dashboard.user.role!=='family';return `<div class="med-row"><div><strong>${escapeHtml(m.name)}</strong><div class="micro">${escapeHtml(m.frequency)} · ${escapeHtml(m.instructions)}</div></div><div><div class="micro">DUE ${escapeHtml(m.schedule)}</div><span class="med-status ${m.status}">${escapeHtml(m.status.toUpperCase())}</span></div><div>${editable&&m.status==='pending'?`<button class="action-mini" data-take="${m.id}">Mark taken</button>`:''}</div></div>`}
function appointmentsView(){const editable=dashboard.user.role!=='family';return `<div class="content-head"><div class="title">Care <span>calendar.</span></div><div class="meta">APPOINTMENTS · PREPARATION · FOLLOW-THROUGH</div></div><div class="cell"><div class="card">${dashboard.appointments.map(apptRow).join('')}${editable?`<div style="margin-top:1rem"><button class="pill" id="add-appt-btn">Add appointment ↗</button></div>`:`<div class="hint" style="margin-top:1rem">Family access is read-only for appointment changes.</div>`}</div></div>`}
function apptRow(a){return `<div class="appt-row"><div><strong>${escapeHtml(a.doctor)}</strong><div class="micro">${escapeHtml(a.specialty)} · ${escapeHtml(a.location)}</div></div><div><div class="micro">${formatDate(a.date)} · ${escapeHtml(a.time)}</div><span class="tag ${a.status==='confirmed'?'ok':'pending'}">${escapeHtml(a.status.toUpperCase())}</span></div><div class="micro">${escapeHtml(a.notes)}</div></div>`}
function teamView(){return `<div class="content-head"><div class="title">Care <span>circle.</span></div><div class="meta">ROLE-BASED ACCESS<br>ELDER-CONTROLLED PERMISSIONS</div></div><div class="cell"><div class="card">${dashboard.careTeam.map(member=>`<div class="team-row"><div><strong>${escapeHtml(member.name)}</strong><div class="micro">${escapeHtml(member.role)}</div></div><div><span class="tag ok">ACTIVE</span></div><div class="micro">${escapeHtml(member.access)}</div></div>`).join('')}<div class="hero-mini" style="margin-top:1.2rem"><div class="micro">ACCESS PRINCIPLE</div><div style="font-size:.85rem;line-height:1.5">Every protected write is authorized server-side. The elder controls who can view, edit, or receive alerts.</div></div></div></div>`}
function timelineView(){return `<div class="content-head"><div class="title">Care <span>timeline.</span></div><div class="meta">AUDIT TRAIL · SHARED CONTEXT</div></div><div class="cell"><div class="card timeline">${dashboard.events.map(eventRow).join('')}</div></div>`}

function bindInteractions(view){
  document.querySelectorAll('[data-take]').forEach(btn=>btn.addEventListener('click', async()=>{try{await api(`/api/medications/${btn.dataset.take}`,{method:'PATCH',body:JSON.stringify({status:'taken'})});await loadDashboard();toast('Medication confirmed.');}catch(e){toast(e.message,true)}}));
  document.querySelector('#add-med-btn')?.addEventListener('click',()=>modal('Add medication',`
    <form id="med-form" class="form-grid"><div class="field full"><label>Name</label><input name="name" class="input" required placeholder="Amlodipine 5 mg" /></div><div class="field"><label>Time</label><input name="schedule" type="time" class="input" required /></div><div class="field"><label>Frequency</label><input name="frequency" class="input" value="Daily" /></div><div class="field full"><label>Instructions</label><input name="instructions" class="input" value="Take after food." /></div><div class="full"><button class="pill primary" type="submit">Create schedule ↗</button></div></form>`));
  document.querySelector('#add-appt-btn')?.addEventListener('click',()=>modal('Add appointment',`
    <form id="appt-form" class="form-grid"><div class="field"><label>Doctor</label><input name="doctor" class="input" required placeholder="Dr. A. Mehta" /></div><div class="field"><label>Specialty</label><input name="specialty" class="input" value="General Medicine" /></div><div class="field"><label>Date</label><input name="date" type="date" class="input" required /></div><div class="field"><label>Time</label><input name="time" type="time" class="input" required /></div><div class="field full"><label>Location</label><input name="location" class="input" placeholder="Clinic / hospital" /></div><div class="field full"><label>Notes</label><textarea name="notes" class="input" rows="3"></textarea></div><div class="full"><button class="pill primary" type="submit">Add appointment ↗</button></div></form>`));
  document.querySelector('#run-reminders-btn')?.addEventListener('click',async()=>{try{const result=await api('/api/reminders/run',{method:'POST',body:'{}'}); toast(result.results.length?`Reminder check complete: ${result.results.length} pending item(s).`:'No pending reminders.');await loadDashboard();}catch(e){toast(e.message,true)}});
}

function modal(title, body){const wrapper=document.createElement('div');wrapper.className='modal-backdrop';wrapper.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-head"><strong>${escapeHtml(title)}</strong><button class="action-mini" data-close>Close</button></div><div class="modal-body">${body}</div></div>`;document.body.appendChild(wrapper);wrapper.querySelector('[data-close]').onclick=()=>wrapper.remove();const form=wrapper.querySelector('form');if(form){form.addEventListener('submit',async(e)=>{e.preventDefault();const payload=Object.fromEntries(new FormData(form));try{if(form.id==='med-form')await api('/api/medications',{method:'POST',body:JSON.stringify(payload)});else await api('/api/appointments',{method:'POST',body:JSON.stringify(payload)});wrapper.remove();await loadDashboard();toast('Saved.');}catch(error){toast(error.message,true)}})}}
function toast(message,error=false){const node=document.createElement('div');node.className='toast';node.innerHTML=`<strong>${error?'CHECK':'DONE'}</strong><br>${escapeHtml(message)}`;document.body.appendChild(node);setTimeout(()=>node.remove(),3500)}

logoutButton.addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST',body:'{}'});logoutButton.classList.add('hidden');dashboard=null;renderLogin();});
loadDashboard();
