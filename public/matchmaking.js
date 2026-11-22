/* =====================================================================================================
   MATCHMAKING  (separate browser module; put it next to index.html as /matchmaking.js)
   index.html loads it with one line. It draws into its own tab, <section id="tab-match"> (bottom nav: Match), laid out like the ValourMatch reference:
   1. My Profile & Criteria   2. Auto-Match Queue   3. Browse & Express Interest   4. Matches & Chat.
   It uses the same bridge as missions.js: window.HL = { api, me, meData, toast, fbPhoto }.
   Every rule (pledge, fee, who you can see, phone reveal) is decided by the server (matchmaking-server.js).
   PAYING happens on the WEB only. Inside the Android / Play Store app this file shows no price and no pay button.
   ===================================================================================================== */
(function () {
  'use strict';
  const H = () => window.HL || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = m => { try { H().toast(m); } catch { alert(m); } };
  const api = (p, b) => H().api(p, Object.assign({}, b || {}, { app: IN_APP }));
  const naira = n => '₦' + Number(n || 0).toLocaleString('en-NG');
  // true inside the Android / Play Store app (same detection as index.html: flc_twa is set there before this file runs)
  const IN_APP = (() => { try { if (sessionStorage.getItem('flc_twa') === '1') return true; } catch {} return document.referrer.startsWith('android-app://'); })();      // only the Play Store app (TWA); a normal browser is the website
  const INTENT = { marriage: 'Marriage', serious_relationship: 'Serious relationship leading to marriage', friendship_to_marriage: 'Friendship that will lead to marriage' };
  const STRICT = '<div class="mm-strict"><b>Serious people only.</b> This is a professional matchmaking service for people looking for marriage, a serious relationship, or a friendship that will lead to marriage. It is <b>not</b> for hookups, casual dating, fun, attention, or paid &ldquo;compensated&rdquo; arrangements. The fee is there to keep unserious people out. Anyone who breaks this is removed with <b>no refund</b>.</div>';

  const CSS = `.mm{--bg:#fff7fb;--card:#fff;--line:#fbcfe8;--ink:#3b0a24;--mute:#6b5a64;--acc:#be185d;--accd:#9d174d;--onacc:#fff;--chip:#fdf2f8;--warn:#fffbeb;--warnl:#fde68a;--ok:#047857;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:18px;padding:14px;margin:0 auto;max-width:960px}
html[data-theme="dark"] .mm{--bg:#1a0f16;--card:#26141f;--line:#4a2438;--ink:#fde7f3;--mute:#c9a3b8;--acc:#f9a8d4;--accd:#f9a8d4;--onacc:#1a0f16;--chip:#3a1429;--warn:#2f2410;--warnl:#6b5314;--ok:#6ee7b7}
.mm *{box-sizing:border-box}.mm button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.mm-hd{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}.mm-logo{font-weight:800;font-size:19px;color:var(--acc)}
.mm-badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:#fef3c7;color:#92400e}.mm-badge.paid{background:#dcfce7;color:#166534}
.mm-nav{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px;margin-bottom:14px}
.mm-nav button{padding:9px 12px;min-height:44px;border-radius:10px;font-weight:700;font-size:13px;color:var(--mute)}.mm-nav button.on{background:var(--acc);color:var(--onacc)}
.mm .c{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}.mm .m{color:var(--mute);font-size:13px}.mm h2{margin:0 0 2px;font-size:19px}.mm h3{margin:0 0 4px;font-size:17px}
.mm-strict{background:var(--warn);border:1px solid var(--warnl);border-radius:12px;padding:12px 14px;font-size:13.5px;margin-bottom:14px}
.mm .btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;border-radius:10px;background:var(--acc);color:var(--onacc);font-weight:800;padding:0 18px;margin-top:8px}.mm .btn.ok{background:#16a34a;color:#fff}.mm .btn.out{background:transparent;color:var(--accd);border:1px solid var(--line)}.mm .btn.full{width:100%}.mm .btn:disabled{opacity:.6;cursor:default}
.mm label{display:block;font-size:13px;font-weight:700;margin:10px 0 4px}.mm input,.mm select,.mm textarea{width:100%;min-height:44px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:9px 12px;font:inherit}.mm textarea{resize:none}
.mm-g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px}.mm-tag{display:inline-block;padding:3px 10px;border-radius:6px;background:var(--chip);color:var(--accd);font-size:12.5px;font-weight:600;margin:0 6px 6px 0}
.mm-match{display:grid;grid-template-columns:200px 1fr;gap:18px;align-items:start}@media(max-width:680px){.mm-match{grid-template-columns:1fr}}
.mm-av{width:100%;height:230px;border-radius:12px;object-fit:cover;background:linear-gradient(135deg,#be185d,#f472b6)}.mm-bro{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.mm-bro .c{display:flex;flex-direction:column;justify-content:space-between;margin:0;padding:0;overflow:hidden}.mm-bro .mini{height:150px;width:100%;object-fit:cover;background:linear-gradient(135deg,#334155,#64748b)}.mm-bro .bd{padding:12px 14px}
.mm-req{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:13px;margin:10px 0}.mm-req b{color:var(--accd);display:block;margin-bottom:2px}
.mm-pay{text-align:center;padding:26px 16px;border:2px dashed var(--acc);border-radius:16px;background:var(--card);margin-bottom:14px}
.mm-lay{display:grid;grid-template-columns:230px 1fr;gap:14px;min-height:420px}@media(max-width:680px){.mm-lay{grid-template-columns:1fr}}
.mm-list{border-right:1px solid var(--line);padding-right:10px}@media(max-width:680px){.mm-list{border-right:0;padding-right:0}}
.mm-u{display:block;width:100%;text-align:left;padding:10px;border-radius:8px;border:1px solid transparent!important;margin-bottom:6px}.mm-u.on{background:var(--chip);border-color:var(--line)!important}
.mm-msgs{height:260px;overflow-y:auto;padding:12px;background:var(--chip);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;gap:8px}.mm-b{max-width:78%;padding:8px 12px;border-radius:12px;word-wrap:break-word;white-space:pre-wrap;font-size:14px}
.mm-b.me{align-self:flex-end;background:var(--acc);color:var(--onacc)}.mm-b.th{align-self:flex-start;background:var(--card);border:1px solid var(--line)}.mm-send{display:flex;gap:8px;margin-top:10px}.mm-send .btn{margin:0}
.mm-unlock{margin-top:12px;padding:12px;border-radius:10px;background:var(--warn);border:1px solid var(--warnl);font-size:13.5px}.mm-unlock.on{background:#dcfce7;border-color:#86efac;color:#14532d;font-weight:700}
.mm-chk{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-size:13.5px}.mm-chk input{width:22px;min-height:22px;margin-top:2px;flex:none}.mm-link{color:var(--accd);font-weight:700;text-decoration:underline;font-size:13px;padding:10px 4px;min-height:44px}`;

  let S = null, tab = 'profile', cand = null, left = 0, list = null, mlist = null, chat = null, chatId = '', poll = null, busy = false, mcount = null;
  const host = () => document.getElementById('mmRoot');
  const stop = () => { if (poll) { clearInterval(poll); poll = null; } };
  function shell() { if (!document.getElementById('mmCss')) { const s = document.createElement('style'); s.id = 'mmCss'; s.textContent = CSS; document.head.appendChild(s); } const r = host(); if (r && !r._mm) { r._mm = 1; r.addEventListener('click', onClick); } return r; }
  const photo = p => p.photo || (H().fbPhoto ? H().fbPhoto(p.name) : '');
  const spin = t => `<div class="c m" style="text-align:center">${esc(t || 'Loading...')}</div>`;
  const NAV = [['profile', '1. My Profile & Criteria'], ['match', '2. Auto-Match Queue'], ['browse', '3. Browse & Express Interest'], ['chats', '4. Matches & Chat']];
  const badge = () => !S || !S.sub ? 'Not active yet' : ({ listed: 'Free (listed by matchmaker)', free: 'Free access (launch offer)', admin: 'Admin test access', referrals: 'Unlocked by invites', paid: 'Paid member (active)' }[S.via] || 'Active');
  const note = () => !S ? '' : S.via === 'free' ? `<div class="mm-strict"><b>Free for now.</b> Matchmaking is free during our launch. Later it becomes a paid service, but anyone who invites ${S.refNeed} friends keeps it free.</div>` : S.via === 'admin' ? '<div class="mm-strict"><b>Admin test access.</b> This account can use every part of Matchmaking for testing.</div>' : '';
  const frame = body => `<div class="mm-hd"><div class="mm-logo">Heart Link Matchmaking</div><span class="mm-badge${S && S.sub ? ' paid' : ''}">${badge()}</span></div>
    <div class="mm-nav">${NAV.map(([k, n]) => `<button type="button" data-a="tab" data-v="${k}" class="${tab === k ? 'on' : ''}">${n}${k === 'chats' && mcount != null ? ' (' + mcount + ')' : ''}</button>`).join('')}</div>${note()}${body}`;
  const set = body => { const r = host(); if (r) r.innerHTML = frame(body); };
  async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { toast((e && e.message) || 'Something went wrong'); } finally { busy = false; } }
  const errBox = e => { const m = String((e && e.message) || ''); const msg = /failed to fetch|networkerror|load failed/i.test(m) ? 'Cannot reach the Heart Link server. Check your internet connection and that the server is running, then try again.' : (m || 'Could not load'); return `<div class="c" style="text-align:center"><b>${esc(msg)}</b><br><button type="button" class="btn" data-a="retry">Try again</button></div>`; };
  async function loadMe() { S = await api('/mm/me'); }

  // ---------- invite friends to unlock for free ----------
  function refCard() {
    const n = Math.min(S.refs || 0, S.refNeed), pct = Math.round(n * 100 / S.refNeed);
    return `<div class="c"><h2>Or unlock it free: invite ${S.refNeed} friends</h2><p class="m">When ${S.refNeed} new members join Heart Link with your invite code, Matchmaking is free for you.</p>
      <div style="margin:10px 0" role="progressbar" aria-valuemin="0" aria-valuemax="${S.refNeed}" aria-valuenow="${n}" aria-label="Friends invited"><div style="height:10px;border-radius:99px;background:var(--chip);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--acc)"></div></div><div class="m" style="margin-top:4px"><b>${n} of ${S.refNeed}</b> friends joined</div></div>
      ${S.refCode ? `<div class="mm-req"><b>Your invite code</b>${esc(S.refCode)}</div><button type="button" class="btn" data-a="share">Share my invite link</button>` : '<p class="m">Your invite code is not ready yet. Open the Wallet tab once, then come back.</p>'}
      <button type="button" class="btn out" data-a="refresh">Refresh my count</button></div>`;
  }

  // ---------- paywall (web: pay; app: nothing to pay here) ----------
  function payCard() {
    if (IN_APP || !S.canPayHere) return refCard() + `<div class="mm-pay"><h2>Matchmaking is not active yet</h2><p class="m" style="max-width:480px;margin:8px auto 14px">Matchmaking can also be activated on the Heart Link website, not in this app. Once your account has it, everything opens here.</p>${STRICT}<button type="button" class="btn" data-a="refresh">I have activated it: refresh</button><p class="m">No payment can be made in the app.</p></div>`;
    return refCard() + `<div class="mm-pay"><h2>Unlock Automated Exact Matchmaking</h2><p class="m" style="max-width:520px;margin:8px auto 12px">Pay a one-time matchmaking fee of <b>${naira(S.fee)}</b> to be paired only with serious, paid members who meet your criteria, and whose criteria you also meet.</p>${STRICT}
      <p class="m" style="max-width:520px;margin:0 auto 6px">Chat first. Phone numbers show only when both of you accept. The fee is non-refundable.</p>
      <button type="button" class="btn" data-a="pay">Pay ${naira(S.fee)} and activate matching</button><p class="m">Secure card or bank payment by Flutterwave. You come straight back here after paying.</p></div>`;
  }

  // ---------- 1. profile & criteria ----------
  const claimCard = () => `<div class="c"><h2>Were you listed by our matchmaker?</h2><p class="m">Enter the code the matchmaker sent you. Your listing moves to your own account, you answer members yourself, and Matchmaking is free for you.</p>
    <label for="mm_cc">Your code</label><input id="mm_cc" maxlength="12" autocapitalize="characters" autocomplete="off">
    <label for="mm_cph">Your phone / WhatsApp (hidden until you accept someone)</label><input id="mm_cph" type="tel" maxlength="24">
    <label class="mm-chk"><input type="checkbox" id="mm_cpl"><span>I promise I am here for <b>marriage or a serious relationship</b>, not hookups, casual dating, or paid arrangements.</span></label>
    <button type="button" class="btn out" data-a="claim">Claim my listing</button></div>`;
  function form(first) {
    const p = S.profile || {}, me = (H().meData && H().meData()) || {};
    const v = (k, d) => esc(p[k] != null && p[k] !== '' ? p[k] : (d != null ? d : ''));
    const sel = (id, opts, cur) => `<select id="${id}">${opts.map(o => `<option value="${esc(o[0])}"${o[0] === cur ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
    const rels = S.religions.map(r => [r, r]), anyRels = [['Any', 'Any religion'], ...rels];
    return `${first ? STRICT + claimCard() : ''}<div class="c"><h2>Step 1: Your bio-data</h2><p class="m">Your details let the engine match you with serious partners.</p><div class="mm-g2">
      <div><label for="mm_age">Age</label><input id="mm_age" type="number" min="18" max="90" value="${v('age', me.age)}"></div>
      <div><label for="mm_city">City / location</label><input id="mm_city" value="${v('city', me.city)}" maxlength="60"></div>
      <div><label for="mm_rel">Religion</label>${sel('mm_rel', rels, p.religion || 'Christian')}</div>
      <div><label for="mm_job">Profession</label><input id="mm_job" value="${v('job', me.occupation)}" maxlength="80"></div>
      <div><label for="mm_intent">What are you looking for?</label>${sel('mm_intent', S.intents.map(k => [k, INTENT[k]]), p.intent || 'serious_relationship')}</div>
      <div><label for="mm_phone">Your phone / WhatsApp (hidden until you both accept)</label><input id="mm_phone" type="tel" value="${v('phone')}" maxlength="24"></div></div>
      <label for="mm_bio">About me (short bio)</label><textarea id="mm_bio" rows="2" maxlength="300">${v('bio')}</textarea></div>
      <div class="c"><h2>Step 2: Qualities you want in a partner</h2><p class="m">The engine filters candidates with these rules.</p><div class="mm-g2">
      <div><label for="mm_lo">Preferred partner min age</label><input id="mm_lo" type="number" min="18" max="90" value="${v('prefMinAge', 24)}"></div>
      <div><label for="mm_hi">Preferred partner max age</label><input id="mm_hi" type="number" min="18" max="90" value="${v('prefMaxAge', 35)}"></div>
      <div><label for="mm_pc">Preferred location (type Any for anywhere)</label><input id="mm_pc" value="${v('prefCity', 'Any')}" maxlength="60"></div>
      <div><label for="mm_pr">Preferred religion</label>${sel('mm_pr', anyRels, p.prefReligion || 'Any')}</div></div>
      <label for="mm_q">Specific qualities / dealbreakers (shown on your profile)</label><input id="mm_q" value="${v('qualities')}" maxlength="200" placeholder="Kind-hearted, honest, ready for marriage"></div>
      ${first ? `<label class="mm-chk"><input type="checkbox" id="mm_pledge"><span>I promise I am here for <b>marriage or a serious relationship</b>. I am not here for hookups, casual dating, fun, or paid arrangements, and I understand I can be removed without a refund.</span></label>` : ''}
      <button type="button" class="btn" data-a="save">${first ? 'Agree, save profile and run match engine' : 'Save profile and run match engine'}</button>`;
  }
  function readForm(first) {
    const r = host(), g = id => (r.querySelector('#' + id) || {}).value;
    return { age: g('mm_age'), city: g('mm_city'), religion: g('mm_rel'), job: g('mm_job'), intent: g('mm_intent'), bio: g('mm_bio'), phone: g('mm_phone'),
      prefMinAge: g('mm_lo'), prefMaxAge: g('mm_hi'), prefCity: g('mm_pc'), prefReligion: g('mm_pr'), qualities: g('mm_q'),
      pledge: first ? !!(r.querySelector('#mm_pledge') || {}).checked : undefined };
  }

  function tags(p) { return `<span class="mm-tag">${esc(p.city)}</span><span class="mm-tag">${esc(p.religion)}</span><span class="mm-tag">${esc(p.job)}</span><span class="mm-tag">${esc(INTENT[p.intent] || '')}</span>${p.verified ? '<span class="mm-tag">Verified</span>' : ''}${p.managed ? '<span class="mm-tag">Posted by Heart Link matchmaker</span>' : ''}${p.likedYou ? '<span class="mm-tag">Interested in you</span>' : ''}`; }
  const lookingFor = p => `<div class="mm-req"><b>What ${esc(String(p.name).split(' ')[0])} is looking for</b>${esc(p.qualities || 'A serious partner')}<br>Age ${esc(p.prefMinAge)}–${esc(p.prefMaxAge)} · ${esc(p.prefCity)} · ${esc(p.prefReligion)}</div>`;

  // ---------- screens ----------
  async function draw() {
    const r = shell(); if (!r) return; stop();
    if (!S) { r.innerHTML = spin(); try { await loadMe(); } catch (e) { r.innerHTML = errBox(e); return; } }
    if (!S.profile) tab = 'profile';
    if (tab === 'profile') return set(`<div class="m" style="margin-bottom:10px">${S.sub ? 'Matchmaking is active on your account.' : 'Fill in your profile (free). The fee is only needed to start matching.'}</div>${form(!S.profile)}${S.profile ? STRICT : ''}`);
    if (!S.sub) return set(payCard());
    set(spin());
    try {
      if (tab === 'match') {
        const x = await api('/mm/queue'); cand = x.cand; left = x.left;
        set(`<div class="c"><h2>Option 1: Your automated exact match</h2><p class="m">Matched two ways on bio-data and partner preferences${left ? ` · ${left} more waiting` : ''}. Accept to tell them you are interested; chat opens when they accept too, or decline to get the next match.</p>
          ${cand ? `<div class="mm-match" style="margin-top:12px"><img class="mm-av" src="${esc(photo(cand))}" alt=""><div><h3>${esc(cand.name)}, ${esc(cand.age)}</h3><div>${tags(cand)}<span class="mm-tag" style="background:#dcfce7;color:#166534">100% mutual criteria match</span></div>${cand.bio ? `<p style="margin:8px 0">${esc(cand.bio)}</p>` : ''}${lookingFor(cand)}
          <div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="btn ok" data-a="accept">Accept match</button><button type="button" class="btn out" data-a="decline">Decline (find next)</button></div></div></div>`
          : `<div style="padding:18px;text-align:center"><b>No more exact two-way matches in your queue right now.</b><p class="m">Widen your age, city or religion in step 1, or explore profiles in step 3.</p></div>`}</div>${STRICT}`);
      } else if (tab === 'browse') {
        const x = await api('/mm/browse'); list = x.list;
        set(`<div class="c"><h2>Option 2: Browse and express interest</h2><p class="m">Read each person's bio-data and what they want. If you fit, tap <b>Express interest</b>. Chat opens when they accept too.</p></div>` +
          (list.length ? `<div class="mm-bro">${list.map((p, i) => `<div class="c"><div><img class="mini" src="${esc(photo(p))}" alt="" loading="lazy"><div class="bd"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${esc(p.name)}, ${esc(p.age)}</b><span class="mm-tag" style="margin:0">Fit: ${p.fit}/3</span></div><div style="margin-top:6px">${tags(p)}</div>${p.bio ? `<p style="font-size:13.5px;margin:6px 0">${esc(p.bio)}</p>` : ''}${lookingFor(p)}</div></div><div style="padding:0 14px 14px">${p.interested ? '<button type="button" class="btn out full" disabled>Interest sent (awaiting reply)</button>' : `<button type="button" class="btn full" data-a="like" data-i="${i}">${p.likedYou ? 'Accept and open chat' : 'Express interest'}</button>`}</div></div>`).join('')}</div>` : '<div class="c m">No members to show yet.</div>'));
      } else {
        const [x, ix] = await Promise.all([api('/mm/matches'), api('/mm/intros')]); mlist = x.list; mcount = mlist.length; const intro = introHtml(ix.list);
        if (chatId && !mlist.some(m => m.id === chatId)) chatId = '';
        if (!chatId && mlist.length) chatId = mlist[0].id;
        if (!mlist.length) return set(intro + `<div class="c"><h2>Mutual matches and gated phone reveal</h2><div class="m" style="padding:22px;text-align:center">No mutual matches yet. Accept an auto-match or express interest in someone first.</div></div>`);
        set(intro + `<div class="c"><h2>Mutual matches and gated phone reveal</h2><p class="m">Chat first to check chemistry. Once you have each sent at least ${S.minMsgs} messages and both click <b>Accept and share my number</b>, your numbers appear.</p>
          <div class="mm-lay"><div class="mm-list">${listHtml()}</div><div id="mmWin">${spin()}</div></div></div>`);
        await loadChat(true);
        poll = setInterval(() => { if (document.hidden || !host() || tab !== 'chats') return; loadChat(false).catch(() => {}); }, 5000);
      }
    } catch (e) {
      if (e.code === 'NEED_SUB') { S.sub = false; return draw(); }
      if (e.code === 'NEED_PROFILE') { S = null; tab = 'profile'; return draw(); }
      set(errBox(e));
    }
  }
  const INTRO = { open: 'Received. The Heart Link matchmaker will review it.', forwarded: 'Sent to {n} for approval. You will see the answer here.', approved: '{n} approved. The matchmaker is finalising your introduction.', declined: '{n} is not available right now. Thank you for your interest.' };
  const introHtml = l => !l.length ? '' : `<div class="c"><h2>Introductions by the matchmaker</h2><p class="m">Your contact details are passed on only with the person's approval, and theirs are shown to you only after they approve.</p>${l.map(x => `<div class="mm-req" style="margin-top:10px"><div class="mm-row" style="display:flex;gap:10px;align-items:center"><img src="${esc(photo(x.with))}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover"><b>${esc(x.with.name)}${x.with.age ? ', ' + esc(x.with.age) : ''}</b></div>${x.status === 'released' ? `<div class="mm-unlock on" style="margin-top:8px">Approved. Phone / WhatsApp: <u>${esc(x.phone)}</u><br><span style="font-weight:400">Be respectful. Serious intentions only.</span></div>` : `<div style="margin-top:6px">${esc((INTRO[x.status] || '').replace('{n}', x.with.name))}</div>`}</div>`).join('')}</div>`;
  const listHtml = () => mlist.map((m, i) => `<button type="button" class="mm-u ${m.id === chatId ? 'on' : ''}" data-a="open" data-i="${i}"><b>${esc(m.with.name)}</b>${m.revealed ? ' <span class="mm-tag" style="margin:0">Numbers shared</span>' : ''}<div class="m">${esc(m.last || 'Say hello')}</div></button>`).join('');

  async function loadChat(scroll) {
    const w = host() && host().querySelector('#mmWin'); if (!w || !chatId) return;
    const box = w.querySelector('.mm-msgs'), atEnd = scroll || !box || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    chat = await api('/mm/chat', { matchId: chatId }); paintChat(); if (atEnd) { const b = host().querySelector('.mm-msgs'); if (b) b.scrollTop = b.scrollHeight; }
  }
  function paintChat() {
    const w = host() && host().querySelector('#mmWin'); if (!w || !chat) return;
    const c = chat, typed = (w.querySelector('#mm_in') || {}).value || '';
    const gate = c.phone ? `<div class="mm-unlock on">Mutual connection approved. ${esc(c.with.name)}'s phone / WhatsApp: <u>${esc(c.phone)}</u></div>`
      : c.myConsent ? `<div class="mm-unlock">You accepted. Waiting for ${esc(c.with.name)} to accept too.</div>`
      : c.canConsent ? `<div class="mm-unlock"><b>Ready to take it off-app?</b> Both of you must accept to reveal phone numbers.<br><button type="button" class="btn ok" data-a="consent">Accept and share my number</button></div>`
      : `<div class="mm-unlock">Phone numbers are locked until each of you has sent at least ${c.need} messages. You have sent ${c.mySent}.</div>`;
    w.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Chatting with ${esc(c.with.name)} (${esc(c.with.city || '')})</div><div class="mm-msgs">${c.msgs.map(m => `<div class="mm-b ${m.me ? 'me' : 'th'}">${esc(m.text)}</div>`).join('') || '<div class="m">Say hello and ask what they are looking for.</div>'}</div>
      <div class="mm-send"><input id="mm_in" aria-label="Message" placeholder="Write a message..." maxlength="1000"><button type="button" class="btn" data-a="send">Send</button></div>${gate}
      <div><button type="button" class="mm-link" data-a="leave">Close this match</button> <button type="button" class="mm-link" data-a="report">Report: not serious or unsafe</button></div>`;
    const i = w.querySelector('#mm_in'); if (i) { i.value = typed; i.onkeydown = e => { if (e.key === 'Enter') send(); }; }
  }
  async function send() {
    const i = host().querySelector('#mm_in'), t = i && i.value.trim(); if (!t) return;
    await guard(async () => { await api('/mm/send', { matchId: chatId, text: t }); i.value = ''; await loadChat(true); });
  }

  // ---------- clicks ----------
  async function onClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a, i = +b.dataset.i;
    if (a === 'tab') { if (!S || !S.profile) return toast('Finish step 1 first: save your profile.'); tab = b.dataset.v; return draw(); }
    if (a === 'share') { const url = location.origin + '/?ref=' + encodeURIComponent(S.refCode || ''), text = 'Join me on Heart Link. Use my invite code ' + (S.refCode || '') + '.'; try { if (navigator.share) await navigator.share({ title: 'Heart Link', text, url }); else { await navigator.clipboard.writeText(text + ' ' + url); toast('Invite link copied'); } } catch {} return; }
    if (a === 'claim') return guard(async () => { const g = id => (host().querySelector('#' + id) || {}); await api('/mm/claim', { code: g('mm_cc').value, phone: g('mm_cph').value, pledge: !!g('mm_cpl').checked }); S = null; tab = 'match'; toast('Your listing is now on your account.'); return draw(); });
    if (a === 'retry') { S = null; return draw(); }
    if (a === 'refresh') return guard(async () => { S = null; await draw(); if (!S.sub) toast('Not active yet. Finish paying on the website, then refresh.'); });
    if (a === 'send') return send();
    await guard(async () => {
      if (a === 'save') { const first = !S.profile; await api('/mm/profile', readForm(first)); S = null; tab = first ? 'match' : 'profile'; toast('Profile saved'); return draw(); }
      if (a === 'pay') { const r = await api('/mm/pay/init'); try { sessionStorage.setItem('mm_pay', '1'); } catch {} location.href = r.url; return; }
      if (a === 'accept' && cand) { const r = await api('/mm/interest', { to: cand.uid }); if (r.matched) { toast('It is a match! Chat is open.'); chatId = r.matchId; tab = 'chats'; } else toast(r.managed ? 'Interest sent to the Heart Link matchmaker, who will contact you.' : 'Interest sent. Chat opens when they accept too.'); return draw(); }
      if (a === 'decline' && cand) { await api('/mm/decline', { to: cand.uid }); return draw(); }
      if (a === 'like') { const r = await api('/mm/interest', { to: list[i].uid }); if (r.matched) { toast('It is a match! Chat is open.'); chatId = r.matchId; tab = 'chats'; } else toast(r.managed ? 'Interest sent to the Heart Link matchmaker, who will contact you.' : 'Interest sent. Chat opens when they accept too.'); return draw(); }
      if (a === 'open') { chatId = mlist[i].id; host().querySelector('.mm-list').innerHTML = listHtml(); host().querySelector('#mmWin').innerHTML = spin(); return loadChat(true); }
      if (a === 'consent') { await api('/mm/consent', { matchId: chatId, on: true }); return loadChat(false); }
      if (a === 'leave') { if (!confirm('Close this match? You will not be able to chat with them again.')) return; await api('/mm/leave', { matchId: chatId }); chatId = ''; return draw(); }
      if (a === 'report') {
        const why = prompt('Why are you reporting? Type one: not_serious, hookup, harassment, fake, minor, other', 'not_serious'); if (!why) return;
        await api('/mm/report', { matchId: chatId, why: why.trim(), details: '' }); toast('Reported. This match is closed and our team will review it.'); chatId = ''; return draw();
      }
    });
  }

  // ---------- coming back from Flutterwave on the web ----------
  async function afterPay() {
    let flag = ''; try { flag = sessionStorage.getItem('mm_pay') || ''; } catch {}
    const q = new URLSearchParams(location.search), ref = q.get('tx_ref') || q.get('reference');
    if (!flag || !ref || !/^mm-/.test(ref)) return;
    for (let n = 0; n < 60 && !(H().me && H().me()); n++) await new Promise(r => setTimeout(r, 500));
    if (!(H().me && H().me())) return;
    try { sessionStorage.removeItem('mm_pay'); history.replaceState(null, '', location.pathname); } catch {}
    try { const r = await api('/mm/pay/verify', { reference: ref }); toast(r.ok ? 'Payment received. Matchmaking is active.' : 'Payment not completed yet.'); } catch (e) { toast(e.message || 'Could not confirm the payment. If you were charged, it will activate shortly.'); }
    S = null; tab = 'match'; try { window.switchTab('match'); } catch {}
  }

  // index.html calls mmEnter() when the Match tab opens and mmLeave() when another tab opens
  window.mmEnter = function () { S = null; tab = 'profile'; draw(); };
  window.mmLeave = stop;
  window.openMatchmaking = function () { try { window.switchTab('match'); } catch {} };
  afterPay();
})();