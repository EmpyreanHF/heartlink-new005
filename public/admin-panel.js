/* =====================================================================================================
   HEART LINK ADMIN CONTROL PANEL  (public/admin.html loads this file; matchmaking-admin.js is loaded when you open Matchmaking)
   One sign-in (ADMIN_SECRET). Sections: Overview, Users, Activity, Withdrawals, Complaints, Verification, Flags, Adverts, Matchmaking, Moderation.
   Existing server routes are used for withdrawals, complaints, verification, flags, adverts, moderation. New ones come from admin-server.js.
   ===================================================================================================== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = t => t ? new Date(t).toLocaleString() : '—';
  const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  const url = u => /^https:\/\//.test(String(u || '')) ? esc(u) : '';
  const num = n => Number(n || 0).toLocaleString();
  let SECRET = sessionStorage.getItem('flc_adm') || '', CUR = 'overview', BADGE = {};
  const NAMES = {};

  async function call(path, method, body, raw) {
    const r = await fetch(path, { method: method || 'GET', headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (raw && r.ok) return r;
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j;
  }
  async function names(ids) {
    const need = [...new Set(ids.filter(i => i && !(i in NAMES)))]; if (!need.length) return;
    try { Object.assign(NAMES, (await call('/admin/names', 'POST', { ids: need })).names); } catch {}
    need.forEach(i => { if (!(i in NAMES)) NAMES[i] = i.slice(0, 8); });
  }
  const nm = id => esc(NAMES[id] || (id || '').slice(0, 8));
  const spin = t => `<div class="empty">${esc(t || 'Loading...')}</div>`;
  const stat = (n, l, go, hot) => `<button class="stat${hot ? ' hot' : ''}" data-go="${go || ''}"><b>${num(n)}</b><span>${esc(l)}</span></button>`;
  const bars = rows => { const mx = Math.max(1, ...rows.map(r => r.n)); return `<div class="bars" role="img" aria-label="Chart of the last 30 days">${rows.map(r => `<i style="height:${Math.max(2, Math.round(r.n * 100 / mx))}%" title="${esc(r.day)}: ${r.n}"></i>`).join('')}</div><div class="axis"><span>${esc(rows[0].day)}</span><span>${esc(rows[rows.length - 1].day)}</span></div>`; };
  const kv = o => `<div class="kv">${Object.entries(o).map(([k, v]) => `<span>${esc(k)}</span><span>${v === '' || v == null ? '—' : esc(v)}</span>`).join('')}</div>`;
  const shrink = file => new Promise((ok, no) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { const m = Math.min(1, 1200 / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * m); c.height = Math.round(im.height * m); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u); c.toBlob(b => b ? ok(b) : no(new Error('Could not read the picture')), 'image/jpeg', .85); }; im.onerror = () => no(new Error('Could not read the picture')); im.src = u; });

  const SECS = [['overview', 'Overview'], ['users', 'Users'], ['activity', 'Activity'], ['withdrawals', 'Withdrawals'], ['complaints', 'Complaints'], ['verify', 'Verification'], ['flags', 'Flags'], ['ads', 'Adverts'], ['mm', 'Matchmaking'], ['mod', 'Moderation']];
  const BADGEKEY = { withdrawals: 'pendingWithdrawals', complaints: 'openReports', verify: 'pendingKyc', flags: 'frozen', mm: 'mmLeads', mod: 'appeals' };
  function drawNav() { $('nav').innerHTML = SECS.map(([k, n]) => `<button data-sec="${k}" class="${CUR === k ? 'on' : ''}">${n}${BADGE[BADGEKEY[k]] ? `<span class="n">${BADGE[BADGEKEY[k]]}</span>` : ''}</button>`).join(''); }
  async function go(sec) {
    CUR = sec; drawNav(); const v = $('view'); v.innerHTML = spin(); window.scrollTo(0, 0);
    try { await ({ overview, users, activity, withdrawals, complaints, verify, flags, ads, mm, mod }[sec])(v); } catch (e) { v.innerHTML = `<div class="card"><b>${esc(e.message)}</b><div class="row"><button data-sec="${sec}">Try again</button></div></div>`; }
  }

  // ---------- Overview ----------
  async function overview(v) {
    const [o, e] = await Promise.all([call('/admin/overview'), call('/admin/economy/summary').catch(() => null)]);
    const c = o.counts, m = o.money; BADGE = c; drawNav();
    v.innerHTML = `<h1>Overview</h1><div class="grid">${stat(c.users, 'Members')}${stat(c.new24, 'Joined in 24 hours')}${stat(c.new7, 'Joined in 7 days')}${stat(c.active24, 'Active in 24 hours')}${stat(c.active7, 'Active in 7 days')}${stat(c.verified, 'Verified')}${stat(c.male, 'Men')}${stat(c.female, 'Women')}</div>
      <h2>Needs your attention</h2><div class="grid">${stat(c.pendingWithdrawals, 'Withdrawals waiting', 'withdrawals', c.pendingWithdrawals)}${stat(c.openReports, 'Complaints open', 'complaints', c.openReports)}${stat(c.pendingKyc, 'ID checks waiting', 'verify', c.pendingKyc)}${stat(c.pendingSelfies, 'Selfie checks waiting', 'verify', c.pendingSelfies)}${stat(c.frozen, 'Frozen accounts', 'flags', c.frozen)}${stat(c.appeals, 'Moderation appeals', 'mod', c.appeals)}${stat(c.mmLeads, 'Matchmaking introductions', 'mm', c.mmLeads)}</div>
      <h2>New sign-ups, last 30 days</h2>${bars(o.signups)}<h2>Coins bought, last 30 days</h2>${bars(o.purchases)}
      <h2>Money</h2><div class="card">${kv({ 'Withdrawals waiting': `${num(m.pendingTokens)} coins (about $${num(m.pendingUsd)})`, 'Withdrawals paid, 30 days': '$' + num(m.paidUsd30), 'Purchases, 30 days': num(m.purchases30), 'Coins sold, 30 days': num(m.coinsSold30), 'Purchase value, 30 days': m.usd30 ? '$' + num(m.usd30) : 'not recorded' })}<p class="mute">Purchases show the last 3,000 recorded.</p></div>
      <h2>Matchmaking and adverts</h2><div class="card">${kv({ 'Matchmaking profiles': num(c.mmProfiles), 'With access': num(c.mmPaid), 'Adverts running': num(c.ads) })}</div>
      ${e ? `<h2>Economy settings</h2><div class="card">${kv(Object.fromEntries(Object.entries(e).filter(([, x]) => typeof x !== 'object').slice(0, 14)))}</div>` : ''}`;
  }

  // ---------- Users ----------
  let UQ = { q: '', sort: 'new', next: 0 };
  const urow = u => `<button class="card" style="width:100%;text-align:left" data-user="${esc(u.id)}"><b>${esc(u.name || '(no name)')}</b> ${u.verified ? '<span class="tag ok">Verified</span>' : ''}${u.disabled ? '<span class="tag bad">Suspended</span>' : ''}<div class="mute">${esc(u.email || 'no email')} · ${esc(u.gender)} ${esc(u.age)} · ${esc([u.city, u.state, u.country].filter(Boolean).join(', '))}</div><div class="mute">Joined ${when(u.createdAt)} · seen ${ago(u.lastSeen)} · ${num(u.tokens)} coins · balance ${num(u.balance)}</div></button>`;
  async function users(v) {
    v.innerHTML = `<h1>Users</h1><div class="card"><div class="g2"><div><label for="uq">Search name, email or ID</label><input id="uq" value="${esc(UQ.q)}"></div><div><label for="us">Show</label><select id="us"><option value="new"${UQ.sort === 'new' ? ' selected' : ''}>Newest sign-ups</option><option value="active"${UQ.sort === 'active' ? ' selected' : ''}>Recently active</option></select></div></div><div class="row"><button class="p" data-a="usearch">Search</button><button data-a="uexport">Download all as CSV</button></div></div><div id="ulist"></div><div class="row"><button id="umore" data-a="umore" hidden>Load more</button></div>`;
    UQ.next = 0; await loadUsers(false);
  }
  async function loadUsers(more) {
    const q = new URLSearchParams({ q: UQ.q, sort: UQ.sort, ...(more && UQ.next ? { cursor: UQ.next } : {}) });
    const r = await call('/admin/users?' + q); UQ.next = r.next;
    const l = $('ulist'); if (!l) return; const html = r.users.map(urow).join('');
    l.innerHTML = more ? l.innerHTML + html : (r.users.length ? (r.total != null ? `<div class="mute">${num(r.total)} members in total</div>` : '') + html : '<div class="empty">No members found.</div>');
    $('umore').hidden = !r.next;
  }
  async function userDetail(uid) {
    const v = $('view'); v.innerHTML = spin();
    const r = await call('/admin/user/' + encodeURIComponent(uid)), u = r.user;
    await names([...r.reportsAgainst, ...r.reportsBy].flatMap(x => [x.from, x.to]));
    const list = (a, f, none) => a.length ? `<table>${a.map(f).join('')}</table>` : `<div class="empty">${none}</div>`;
    v.innerHTML = `<div class="row"><button data-sec="users">&larr; Back to users</button></div><h1>${esc(u.name || '(no name)')}</h1>
      <div class="card">${kv({ Email: u.email, 'Sign-in methods': r.auth && r.auth.providers, 'Account created': when(r.auth ? r.auth.created : u.createdAt), 'Last sign-in': when(u.lastSignIn), 'Last seen in app': when(u.lastSeen), Gender: u.gender, Age: u.age, Occupation: u.occupation, 'Looking for': u.goal, Location: [u.neighborhood, u.city, u.state, u.country].filter(Boolean).join(', '), Followers: u.followers, Following: u.following, Photos: u.photos, Coins: num(u.tokens), 'Creator balance': num(u.balance), 'Invited by': u.referredBy ? (NAMES[u.referredBy] || u.referredBy) : '', ID: u.id })}
      ${u.bio ? `<p>${esc(u.bio)}</p>` : ''}<div>${u.verified ? '<span class="tag ok">Verified</span>' : ''}${u.disabled ? '<span class="tag bad">Suspended</span>' : '<span class="tag ok">Can sign in</span>'}${r.kyc ? `<span class="tag">ID check: ${esc(r.kyc.status)}</span>` : ''}${r.flags && r.flags.frozen ? '<span class="tag bad">Frozen: ' + esc(r.flags.reasons.join('; ')) + '</span>' : ''}${r.matchmaking ? `<span class="tag">Matchmaking${r.matchmaking.subscribed ? ' (active)' : ''}</span>` : ''}</div>
      <div class="row"><button class="${u.disabled ? 'ok' : 'd'}" data-a="ustatus" data-id="${esc(u.id)}" data-dis="${u.disabled ? '0' : '1'}">${u.disabled ? 'Allow sign-in again' : 'Suspend this account'}</button></div></div>
      <h2>Purchases, gifts and coin movements</h2>${list(r.transactions, t => `<tr><td>${when(t.createdAt)}</td><td>${esc(t.type)}</td><td>${num(t.tokens)} coins${t.usd ? ' · $' + esc(t.usd) : ''}</td></tr>`, 'Nothing yet.')}
      <h2>Withdrawals</h2>${list(r.withdrawals, w => `<tr><td>${when(w.createdAt)}</td><td>${num(w.tokens)} coins · $${esc(w.usd)}</td><td><span class="tag ${w.status === 'paid' ? 'ok' : w.status === 'rejected' ? 'bad' : 'warn'}">${esc(w.status)}</span></td></tr>`, 'None.')}
      <h2>Complaints against this member</h2>${list(r.reportsAgainst, x => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.reason)} by ${nm(x.from)}</td><td>${esc(x.details || '')}</td></tr>`, 'None.')}
      <h2>Complaints made by this member</h2>${list(r.reportsBy, x => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.reason)} about ${nm(x.to)}</td><td>${esc(x.details || '')}</td></tr>`, 'None.')}
      <h2>Calls</h2>${list(r.calls, c => `<tr><td>${when(c.createdAt)}</td><td>${esc(c.kind || 'call')} to ${nm(c.to)}</td><td>${esc(c.status || '')}</td></tr>`, 'None.')}`;
  }

  // ---------- Activity ----------
  async function activity(v) {
    const r = await call('/admin/activity'); await names(r.items.map(i => i.uid));
    v.innerHTML = `<h1>Activity</h1><p class="mute">The latest purchases, gifts and coin movements across the app.</p>${r.items.length ? `<div class="card"><table>${r.items.map(i => `<tr><td>${when(i.createdAt)}</td><td><a href="#" data-user="${esc(i.uid)}">${nm(i.uid)}</a></td><td>${esc(i.type)}</td><td>${num(i.tokens)} coins${i.usd ? ' · $' + esc(i.usd) : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">No activity yet.</div>'}`;
  }

  // ---------- Withdrawals ----------
  let WS = 'pending';
  async function withdrawals(v) {
    const r = await call('/admin/withdrawals?status=' + WS); await names(r.items.map(i => i.uid));
    v.innerHTML = `<h1>Withdrawals</h1><div class="row">${['pending', 'paid', 'rejected'].map(s => `<button class="${WS === s ? 'p' : ''}" data-a="wstatus" data-s="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
      ${r.items.length ? r.items.map(w => `<div class="card"><b>${esc(w.name || nm(w.uid))}</b> ${w.frozen ? '<span class="tag bad">Account frozen</span>' : ''}<span class="tag ${w.status === 'paid' ? 'ok' : w.status === 'rejected' ? 'bad' : 'warn'}">${esc(w.status)}</span>
        ${kv({ Requested: when(w.createdAt), Coins: num(w.tokens), 'Amount (USD)': '$' + esc(w.usd), 'Pay in': w.local ? esc(w.local) + ' ' + esc(w.currency || '') : esc(w.currency || ''), 'Fee': w.feePct != null ? w.feePct + '%' : '', ...(w.swift && typeof w.swift === 'object' ? Object.fromEntries(Object.entries(w.swift).map(([k, x]) => ['Bank ' + k, x])) : {}), Note: w.note, Resolved: w.resolvedAt ? when(w.resolvedAt) : '' })}
        <div class="row"><button data-user="${esc(w.uid)}">View member</button>${w.status === 'pending' ? `<button class="ok" data-a="wpay" data-id="${esc(w.id)}">Mark as paid</button><button class="d" data-a="wrej" data-id="${esc(w.id)}">Reject and return coins</button>` : ''}</div></div>`).join('') : '<div class="empty">Nothing here.</div>'}`;
  }

  // ---------- Complaints ----------
  let CALL = false;
  async function complaints(v) {
    const r = await call('/admin/reports' + (CALL ? '?all=1' : '')); await names(r.items.flatMap(i => [i.from, i.to]));
    v.innerHTML = `<h1>Complaints</h1><div class="row"><button class="${CALL ? '' : 'p'}" data-a="rall" data-v="0">Open</button><button class="${CALL ? 'p' : ''}" data-a="rall" data-v="1">All</button></div>
      ${r.items.length ? r.items.map(x => `<div class="card"><b>${esc(x.reason)}</b> ${x.reviewed ? '<span class="tag ok">Handled</span>' : '<span class="tag warn">Open</span>'}<div class="mute">${when(x.createdAt)} · ${nm(x.from)} reported ${nm(x.to)}</div>${x.details ? `<p>${esc(x.details)}</p>` : ''}
        <div class="row"><button data-user="${esc(x.to)}">View reported member</button>${x.reviewed ? '' : `<button class="d" data-a="rsus" data-id="${esc(x.id)}">Suspend them</button><button data-a="rdis" data-id="${esc(x.id)}">Dismiss</button>`}</div></div>`).join('') : '<div class="empty">No complaints.</div>'}`;
  }

  // ---------- Verification ----------
  async function verify(v) {
    const [k, s] = await Promise.all([call('/admin/kyc?status=pending'), call('/admin/verifications')]); await names(s.items.map(i => i.id));
    const imgs = o => Object.entries(o).filter(([, x]) => /^https:\/\//.test(String(x))).map(([key, x]) => `<a href="${url(x)}" target="_blank" rel="noopener"><img class="img" src="${url(x)}" alt="${esc(key)}"></a>`).join('');
    v.innerHTML = `<h1>Verification</h1><h2>ID checks for withdrawals (${k.items.length})</h2>${k.items.length ? k.items.map(i => `<div class="card"><b>${esc(i.legalName)}</b> <span class="tag">${esc(i.idType)}</span>${i.duplicates && i.duplicates.length ? '<span class="tag bad">Same ID on another account</span>' : ''}
      ${kv({ 'ID number': i.idNumber, DOB: i.dob, Submitted: when(i.createdAt), Note: i.note })}<div>${imgs({ id: i.idUrl, selfie: i.selfieUrl, profile: i.profilePhoto })}</div>
      <div class="row"><button data-user="${esc(i.id)}">View member</button><button class="ok" data-a="kapp" data-id="${esc(i.id)}">Approve</button><button class="d" data-a="krej" data-id="${esc(i.id)}">Reject</button></div></div>`).join('') : '<div class="empty">None waiting.</div>'}
      <h2>Selfie verification badges (${s.items.length})</h2>${s.items.length ? s.items.map(i => `<div class="card"><b>${nm(i.id)}</b><div class="mute">${when(i.createdAt)}</div><div>${imgs(i)}</div><div class="row"><button data-user="${esc(i.id)}">View member</button><button class="ok" data-a="sapp" data-id="${esc(i.id)}">Approve</button><button class="d" data-a="srej" data-id="${esc(i.id)}">Reject</button></div></div>`).join('') : '<div class="empty">None waiting.</div>'}`;
  }

  // ---------- Flags ----------
  async function flags(v) {
    const r = await call('/admin/abuse');
    v.innerHTML = `<h1>Flags</h1><p class="mute">Accounts the system froze because their earnings look suspicious.</p>${r.items.length ? r.items.map(i => `<div class="card"><b>${esc(i.name)}</b> <span class="tag bad">Frozen</span>${kv({ Balance: num(i.balance) + ' coins', 'ID check': i.kycStatus, 'Name on ID': i.kycName, Reasons: (i.reasons || []).join('; '), 'Shares a device with': (i.deviceMates || []).length ? i.deviceMates.length + ' other accounts' : '' })}
      <div class="row"><button data-user="${esc(i.id)}">View member</button><button class="ok" data-a="fclr" data-id="${esc(i.id)}">Clear the flag</button><button class="d" data-a="fsus" data-id="${esc(i.id)}">Suspend account</button></div></div>`).join('') : '<div class="empty">No frozen accounts.</div>'}`;
  }

  // ---------- Adverts ----------
  const PLACES = ['lightbox', 'nearby', 'live', 'status'];
  let AIMG = '';
  async function ads(v) {
    const r = await call('/admin/ads'); AIMG = '';
    v.innerHTML = `<h1>Adverts</h1><h2>New advert</h2><div class="card"><div class="g2"><div><label for="at">Title</label><input id="at" maxlength="80"></div><div><label for="as">Sponsor name</label><input id="as" maxlength="40"></div><div><label for="ac">Button text</label><input id="ac" maxlength="24" placeholder="Learn more"></div><div><label for="aw">Weight (1 to 10, higher shows more)</label><input id="aw" type="number" min="1" max="10" value="1"></div></div>
      <label for="ab">Text</label><textarea id="ab" rows="2" maxlength="200"></textarea><label for="ai">Picture</label><input id="ai" type="file" accept="image/*"><div class="mute" id="ast"></div><label for="aiu">...or a picture link (https)</label><input id="aiu" placeholder="https://"><label for="al">Where it opens when tapped (https link)</label><input id="al" placeholder="https://">
      <label>Show it in</label><div class="row" style="margin-top:0">${PLACES.map(p => `<label class="chk"><input type="checkbox" data-place="${p}" ${p === 'nearby' ? 'checked' : ''}>${p}</label>`).join('')}</div>
      <div class="g2"><div><label for="asd">Starts (optional)</label><input id="asd" type="date"></div><div><label for="aed">Ends (optional)</label><input id="aed" type="date"></div></div><div class="row"><button class="p" data-a="adsave">Publish advert</button></div></div>
      <h2>Your adverts (${r.items.length})</h2>${r.items.length ? r.items.map(a => `<div class="card"><div class="who">${a.imageUrl ? `<img class="pic" src="${url(a.imageUrl)}" alt="">` : ''}<div><b>${esc(a.title)}</b> <span class="tag ${a.status === 'active' ? 'ok' : 'warn'}">${esc(a.status)}</span><div class="mute">${esc(a.sponsor || '')} · ${esc((a.placements || []).join(', '))}</div><div class="mute">${num(a.views)} views · ${num(a.clicks)} taps${a.endsAt ? ' · ends ' + when(a.endsAt) : ''}</div></div></div>
      <div class="row"><button data-a="${a.status === 'active' ? 'apause' : 'ares'}" data-id="${esc(a.id)}">${a.status === 'active' ? 'Pause' : 'Resume'}</button><button class="d" data-a="adel" data-id="${esc(a.id)}">Delete</button></div></div>`).join('') : '<div class="empty">No adverts yet.</div>'}`;
    $('ai').onchange = async e => { const f = e.target.files[0]; if (!f) return; $('ast').textContent = 'Uploading...';
      try { const b = await shrink(f), fd = new FormData(); fd.append('file', b); fd.append('upload_preset', 'ml_default'); fd.append('folder', 'ads');
        const j = await (await fetch('https://api.cloudinary.com/v1_1/mi7osvee/image/upload', { method: 'POST', body: fd })).json(); if (!j.secure_url) throw new Error('Upload failed'); AIMG = j.secure_url; $('ast').textContent = 'Picture ready'; } catch (x) { $('ast').textContent = x.message; } };
  }

  // ---------- Matchmaking ----------
  async function mm(v) {
    v.innerHTML = '<div id="mmAdmin"></div>';
    if (!window.mmAdminMount) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'matchmaking-admin.js'; s.onload = ok; s.onerror = () => no(new Error('matchmaking-admin.js was not found next to this page. Upload it to the same folder.')); document.head.appendChild(s); });
    window.mmAdminMount($('mmAdmin'));
  }

  // ---------- Moderation ----------
  async function mod(v) {
    const r = await call('/admin/moderation');
    v.innerHTML = `<h1>Moderation</h1><div class="grid">${stat(r.appeals.length, 'Appeals waiting', '', r.appeals.length)}${stat(r.critical.length, 'Critical reports', '', r.critical.length)}${stat(r.incidents.length, 'Recent incidents')}</div>
      <div class="card">${kv({ Scanner: r.provider, Profile: r.profile, Mode: r.shadow ? 'Shadow (logging only)' : 'Enforcing', '18+ check for private rooms': r.ageGate ? 'on' : 'off' })}<p class="mute">Handle appeals, critical reports and strikes on the live moderation page.</p><div class="row"><a href="moderation.html" target="_blank" rel="noopener"><button class="p">Open live moderation</button></a></div></div>`;
  }

  // ---------- clicks ----------
  const done = (m, sec) => { if (m) alert(m); return go(sec || CUR); };
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-sec],[data-go],[data-user],[data-a]'); if (!t) return;
    if (t.tagName === 'A') e.preventDefault();
    const d = t.dataset;
    try {
      if (d.sec) return go(d.sec);
      if (d.go) return go(d.go);
      if (d.user) return await userDetail(d.user);
      const a = d.a; if (!a) return;
      if (a === 'usearch') { UQ.q = $('uq').value.trim(); UQ.sort = $('us').value; UQ.next = 0; return await loadUsers(false); }
      if (a === 'umore') return await loadUsers(true);
      if (a === 'uexport') { t.disabled = true; try { const r = await call('/admin/users/export', 'GET', null, true), b = await r.blob(), l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = 'heartlink-users-' + new Date().toISOString().slice(0, 10) + '.csv'; l.click(); } finally { t.disabled = false; } return; }
      if (a === 'ustatus') { if (d.dis === '1' && !confirm('Suspend this account? They will not be able to sign in.')) return; await call('/admin/user/' + d.id + '/status', 'POST', { disabled: d.dis === '1' }); return await userDetail(d.id); }
      if (a === 'wstatus') { WS = d.s; return go('withdrawals'); }
      if (a === 'wpay') { if (!confirm('Mark as paid? Only do this after you have sent the money.')) return; const note = prompt('Optional note (for example the transfer reference)') || ''; await call('/admin/withdrawals/' + d.id, 'POST', { action: 'paid', note }); return go('withdrawals'); }
      if (a === 'wrej') { const note = prompt('Why is it rejected? The coins go back to the member.'); if (note === null) return; await call('/admin/withdrawals/' + d.id, 'POST', { action: 'reject', note }); return go('withdrawals'); }
      if (a === 'rall') { CALL = d.v === '1'; return go('complaints'); }
      if (a === 'rsus') { if (!confirm('Suspend the reported member? They will not be able to sign in.')) return; await call('/admin/reports/' + d.id, 'POST', { action: 'suspend' }); return go('complaints'); }
      if (a === 'rdis') { await call('/admin/reports/' + d.id, 'POST', { action: 'dismiss' }); return go('complaints'); }
      if (a === 'kapp') { await call('/admin/kyc/' + d.id, 'POST', { action: 'approve' }); return go('verify'); }
      if (a === 'krej') { const note = prompt('Tell the member why. They will see this.'); if (note === null) return; await call('/admin/kyc/' + d.id, 'POST', { action: 'reject', note }); return go('verify'); }
      if (a === 'sapp' || a === 'srej') { await call('/admin/verifications/' + d.id, 'POST', { action: a === 'sapp' ? 'approve' : 'reject' }); return go('verify'); }
      if (a === 'fclr') { await call('/admin/abuse/' + d.id, 'POST', { action: 'clear' }); return go('flags'); }
      if (a === 'fsus') { if (!confirm('Suspend this account?')) return; await call('/admin/abuse/' + d.id, 'POST', { action: 'suspend' }); return go('flags'); }
      if (a === 'apause' || a === 'ares') { await call('/admin/ads/' + d.id, 'POST', { action: a === 'apause' ? 'pause' : 'resume' }); return go('ads'); }
      if (a === 'adel') { if (!confirm('Delete this advert?')) return; await call('/admin/ads/' + d.id, 'POST', { action: 'delete' }); return go('ads'); }
      if (a === 'adsave') {
        const day = id => { const x = $(id).value; return x ? new Date(x + 'T00:00:00').getTime() : 0; };
        await call('/admin/ads', 'POST', { title: $('at').value, body: $('ab').value, sponsor: $('as').value, cta: $('ac').value, imageUrl: AIMG || $('aiu').value, linkUrl: $('al').value, weight: $('aw').value,
          placements: [...document.querySelectorAll('[data-place]')].filter(x => x.checked).map(x => x.dataset.place), startsAt: day('asd'), endsAt: day('aed') });
        return done('Advert published.', 'ads');
      }
    } catch (err) { alert(err.message); }
  });

  // ---------- sign in ----------
  async function open() {
    try { const o = await call('/admin/overview'); BADGE = o.counts; sessionStorage.setItem('flc_adm', SECRET); $('login').hidden = true; $('app').hidden = false; go(CUR); }
    catch (e) { $('err').textContent = e.message; $('login').hidden = false; $('app').hidden = true; sessionStorage.removeItem('flc_adm'); }
  }
  $('go').onclick = () => { SECRET = $('sec').value.trim(); $('err').textContent = ''; open(); };
  $('sec').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });
  $('out').onclick = () => { sessionStorage.removeItem('flc_adm'); location.reload(); };
  if (SECRET) open();
})();