/* =====================================================================================================
   MISSIONS & RANKS  (separate browser module; put it next to index.html as /missions.js)
   index.html loads it with one line and gives it a small bridge, window.HL = { api, me, meData, toast, postMoment, goMoments, fbPhoto }.
   Screens: Missions (monthly goals + forecast + bonus), Ranks (level ladder), Insights (progress analytics), Card (level card -> Moments).
   Every reward, limit and rule is decided by the server (missions-server.js); this file only shows them and asks to claim.
   ===================================================================================================== */
(function () {
  'use strict';
  const H = () => window.HL || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString();
  const toast = m => { try { H().toast(m); } catch { alert(m); } };
  let root = null, origin = 'missions', tab = 'missions', D = null, Q = null, loading = false, shareBusy = false;

  const CSS = `.ms{--bg:#fbf6f4;--card:#fff;--line:#ecd9de;--ink:#2a1020;--mute:#7a5a68;--acc:#a3134f;--onacc:#fff;--gold:#7a5509;--goldfill:#c8962e;--track:#f1e4e8;--chip:#fbe8ef;position:absolute;inset:0;z-index:90;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,sans-serif}.ms.hidden{display:none}
html[data-theme="dark"] .ms{--bg:#12090f;--card:#1d0f18;--line:#3a2030;--ink:#fde7f3;--mute:#c9a3b8;--acc:#f9a8d4;--onacc:#12090f;--gold:#f3dca0;--goldfill:#e9c46a;--track:#3a2030;--chip:#3a1429}
.ms *{box-sizing:border-box}.ms button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.ms-top{display:flex;align-items:center;gap:12px;padding:calc(14px + env(safe-area-inset-top,0px)) 16px 8px}.ms-back{width:44px;height:44px;border-radius:50%;background:var(--card);border:1px solid var(--line);color:var(--acc);flex:none}
.ms-top h2{margin:0;font:700 24px Georgia,serif;flex:1}.ms-chip{padding:6px 12px;border-radius:99px;border:1px solid var(--line);background:var(--chip);color:var(--acc);font:700 12px system-ui}
.ms-tabs{display:flex;gap:6px;padding:4px 16px 10px}.ms-tabs button{flex:1;height:44px;border-radius:99px;background:var(--track);font-weight:700;font-size:13px;color:var(--mute)}.ms-tabs button.on{background:var(--acc);color:var(--onacc)}
.ms-body{flex:1;overflow-y:auto;padding:4px 16px calc(24px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:12px}
.ms .c{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:14px}.ms .r{display:flex;justify-content:space-between;align-items:center;gap:10px}
.ms .k{font:700 10.5px system-ui;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}.ms .m{color:var(--mute);font-size:12px}.ms .g{color:var(--acc);font-weight:700}
.ms .b{height:8px;border-radius:99px;background:var(--track);overflow:hidden;margin:8px 0 6px}.ms .b i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--goldfill),var(--acc))}
.ms .btn{width:100%;height:46px;border-radius:99px;background:var(--acc);color:var(--onacc);font-weight:800;margin-top:8px}.ms .btn:disabled{opacity:.55}.ms .btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}
.ms-ring{width:92px;height:92px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}.ms-ring div{width:70px;height:70px;border-radius:50%;background:var(--card);display:flex;align-items:center;justify-content:center;font:700 20px Georgia,serif}
.ms-gold{background:var(--chip)!important;border-color:var(--line)!important}.ms-lock{color:var(--mute)}
.ms-row{display:flex;gap:10px;align-items:center;padding:10px 14px}.ms-n{width:26px;height:26px;border-radius:50%;background:var(--acc);color:var(--onacc);font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}.ms-on{border-color:var(--acc)!important;background:var(--chip)!important}
.ms-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ms-kpi b{font:700 22px Georgia,serif;display:block}.ms-heat{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.ms-heat i{width:19px;height:19px;border-radius:6px}
.ms-card{width:100%;max-width:350px;aspect-ratio:350/214;margin:0 auto;border-radius:20px;padding:2px;background:conic-gradient(from 210deg,#fff2c2,#ff9ad0,#9ad8ff,#e9c46a,#fff2c2);box-shadow:0 18px 30px -14px rgba(60,10,40,.55);color:#fff}
.ms-card .m{color:rgba(255,255,255,.78)}.ms-card .g{color:#f3dca0}
.ms-card>div{position:relative;height:100%;border-radius:18px;background:radial-gradient(120% 90% at 15% 0%,#6a1a55,#1b0617 70%);overflow:hidden;padding:5%;display:flex;flex-direction:column;justify-content:space-between}
.ms-card .guil{position:absolute;inset:0;background:repeating-radial-gradient(circle at 85% 20%,rgba(233,196,106,.09) 0 1px,transparent 1px 7px)}.ms-card .z{position:relative}
.ms-av{width:78px;height:78px;border-radius:50%;padding:3px;background:conic-gradient(#fff2c2,#c8962e,#fff2c2,#c8962e,#fff2c2);flex:none}.ms-av img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;background:#3b0f33}
.ms-th{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.ms-th div{text-align:center;padding:8px 2px}.ms-th b{display:block;font:700 18px Georgia,serif;color:var(--acc)}
.ms textarea{width:100%;border-radius:12px;background:var(--card);border:1px solid var(--line);color:var(--ink);padding:10px;font:inherit;resize:none}
.ms details summary{cursor:pointer;font-weight:700;color:var(--acc)}.ms details li{margin:6px 0 0 16px}
.ms-lab{font:700 10.5px system-ui;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:6px 4px 0}
.ms-rank{background:#3a0d26;color:#fff;border-radius:20px;padding:16px}.ms-rank .e{font:700 10px system-ui;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.65)}
.ms-rank h3{margin:4px 0 12px;font:700 30px Georgia,serif}.ms-rank .t{height:6px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden}.ms-rank .t i{display:block;height:100%;border-radius:99px;background:#e8c27a}
.ms-rank .s{margin-top:10px;font-size:11px;color:rgba(255,255,255,.78)}
.ms-mi{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:12px 14px}.ms-mi .b{height:5px;margin:8px 0 0}
.ms-mi .h{display:flex;justify-content:space-between;gap:10px;font-size:13px}.ms-mi .h span{color:var(--acc);font-size:11px;font-weight:700;white-space:nowrap}
.ms-lv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.ms-lv div{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px 6px;text-align:center;color:var(--ink)}
.ms-lv i{color:var(--acc);display:flex;justify-content:center}.ms-lv b{display:block;font-size:13px;margin-top:6px}.ms-lv small{color:var(--mute);font-size:11px}
.ms .up{color:#047857;font-size:11px;font-weight:700}.ms .dn{color:#b42318;font-size:11px;font-weight:700}html[data-theme="dark"] .ms .up{color:#6ee7b7}html[data-theme="dark"] .ms .dn{color:#fca5a5}
.ms-leg{display:flex;gap:12px;font-size:11px;font-weight:700;margin:8px 0 0}`;

  function ensure() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 'ms hidden'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Missions and ranks');
    root.innerHTML = '<div class="ms-top"><button class="ms-back" data-act="back" aria-label="Back">&#8592;</button><h2 id="msTitle">Missions &amp; ranks</h2></div><div class="ms-body" id="msBody"></div>';
    (document.getElementById('app') || document.body).appendChild(root);
    root.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b) return; const [a, v] = b.dataset.act.split(':'); if (a === 'back') { if ((tab === 'card' || tab === 'ranks') && origin === 'missions') { tab = 'missions'; paint(); } else root.classList.add('hidden'); } else if (a === 'tab') { tab = v; paint(); } else if (a === 'claim') claim(v); else if (a === 'share') share(); else if (a === 'save') save(); else if (a === 'goCard') { tab = 'card'; paint(); } });
  }

  // ---------- data ----------
  async function load() {
    if (loading) return; loading = true;
    try { const [d, q] = await Promise.all([H().api('/missions/me'), H().api('/quests').catch(() => null)]); D = d; Q = q; }
    catch (e) { D = null; toast(e.message || 'Could not load your missions'); }
    loading = false; paint();
  }
  window.openMissions = async function (t) { ensure(); tab = t || 'missions'; origin = tab; root.classList.remove('hidden'); document.getElementById('msBody').innerHTML = '<p class="m">Loading…</p>'; paint(); await load(); };

  async function claim(id) {
    const btn = root.querySelector(`[data-act="claim:${id}"]`); if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
    try {
      const r = await H().api('/missions/claim', { id });
      toast(r.queued ? r.message : `${r.label} added${r.boostPct ? ` and +${r.boostPct}% task XP` : ''}`);
    } catch (e) { toast(e.message || 'Could not claim'); }
    await load();
  }

  // ---------- helpers ----------
  const hoursOr = (g, x) => g.unit === 'minutes' ? (x / 60).toFixed(1).replace(/\.0$/, '') + ' h' : fmt(x);
  const dateOf = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const monthName = mon => new Date(mon + '-15').toLocaleDateString(undefined, { month: 'long' });
  const hash = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const cardNo = uid => { const h = hash(uid), p = n => String(n % 10000).padStart(4, '0'); return `HL ${p(h)} ${p(h >> 7)}`; };
  const myName = () => (H().meData() || {}).name || 'Member';
  const myPhoto = () => { const m = H().meData() || {}, p = (m.media || []).find(x => x && x.kind === 'photo' && x.url); return p ? p.url : (H().fbPhoto ? H().fbPhoto(m.name) : ''); };
  const since = () => { const c = (H().meData() || {}).createdAt; try { const d = c && c.toDate ? c.toDate() : null; return d ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ''; } catch { return ''; } };
  const claimBtn = (id, st, label, why, at) => st === 'claimable' ? `<button class="btn" data-act="claim:${id}">${label}</button>`
    : st === 'holding' ? `<div class="m" style="margin-top:6px">Finished. Claimable from ${dateOf(at)} (cooling-off period).</div>`
    : st === 'locked' ? `<div class="m" style="margin-top:6px">${esc(why)}</div>` : '';

  // ---------- screens ----------
  function paint() {
    if (!root) return;
    { const TT = { missions: 'Missions & ranks', ranks: 'All levels', insights: 'Analytics', card: 'Your level card' }; document.getElementById('msTitle').textContent = TT[tab] || 'Missions'; }
    const body = document.getElementById('msBody'); if (!D) { if (!loading) body.innerHTML = '<p class="m">Could not load. Check your connection and reopen.</p>'; return; }
    body.innerHTML = { missions: vMissions, ranks: vRanks, insights: vInsights, card: vCard }[tab]();
    body.scrollTop = 0;
  }

  const ICON_LOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>', ICON_OK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
  function vMissions() {
    const G = D.goals, R = D.rank, lvlSeen = +localStorage.getItem('ms_lvl_' + H().me()) || 0, up = R.n > lvlSeen && R.n > 1;
    const span = R.nextXp ? R.nextXp - R.fromXp : 0, into = Math.max(0, R.xp - R.fromXp), pct = R.nextXp ? Math.max(3, Math.min(100, Math.round(into / span * 100))) : 100;
    const nxt = R.ladder.filter(l => !l.reached).slice(0, 3), shown = nxt.length ? nxt : R.ladder.slice(-3);
    return (up ? `<div class="c ms-gold"><b>You reached ${esc(R.name)}!</b><div class="m">Share your level card with friends in Moments.</div><button class="btn" data-act="goCard">Open my card</button></div>` : '')
      + `<div class="ms-rank"><div class="e">Current rank &middot; ${esc(R.name)}</div><h3>Level ${R.n}</h3><div class="t"><i style="width:${pct}%"></i></div><div class="s">${R.nextXp ? `${fmt(into)} / ${fmt(span)} XP to Level ${R.n + 1}` : 'Top level reached'}</div></div>`
      + (D.level.state === 'waiting' ? `<div class="m">${D.level.minutes} free call min is waiting for the reward pool to fill. It is paid to you automatically.</div>` : '')
      + `<div class="ms-lab">This month &middot; ${D.daysLeft} day${D.daysLeft === 1 ? '' : 's'} left</div>`
      + G.map(g => `<div class="ms-mi"><div class="h"><b>${esc(g.title)}</b><span>${esc(g.rewardLabel)}</span></div><div class="b"><i style="width:${Math.min(100, g.pct)}%"></i></div>`
        + `<div class="r m" style="margin-top:6px;font-size:11px"><span>${hoursOr(g, g.progress)} of ${hoursOr(g, g.target)}${g.unit === 'minutes' ? '' : ' ' + esc(g.unit)}</span><span>${g.state === 'claimed' ? 'Claimed' : g.progress >= g.target ? 'Goal reached' : g.onPace ? `On pace: ${hoursOr(g, g.projected)}` : `Needs ${hoursOr(g, g.perDay)}/day`}</span></div>${claimBtn(g.id, g.state, `Claim ${g.rewardLabel}`, D.eligibility.why, g.claimableAt)}</div>`).join('')
      + `<div class="ms-mi ms-gold"><div class="k">Monthly bonus</div><div style="margin-top:4px"><b>Finish all ${G.length} goals:</b> ${D.bonus.rewardLabel} and +${D.bonus.xpBoostPct}% task XP for 30 days</div>${claimBtn('bonus', D.bonus.state, `Claim ${D.bonus.rewardLabel}`, D.eligibility.why, D.bonus.claimableAt)}${D.bonus.state === 'claimed' ? '<div class="m" style="margin-top:6px">Claimed this month.</div>' : ''}</div>`
      + (D.eligibility.ok ? '' : `<div class="c ms-lock"><b>Rewards are locked</b><div class="m">${esc(D.eligibility.why)}</div></div>`)
      + `<div class="ms-lab">Level rewards</div><div class="ms-lv">${shown.map(l => `<div><i>${l.reached ? ICON_OK : ICON_LOCK}</i><b>Level ${l.n}</b><small>${esc(l.rewardLabel || (l.bonus ? '+' + l.bonus + '% XP' : l.name))}</small></div>`).join('')}</div>`
      + `<button class="btn" data-act="goCard">View your card</button><button class="btn ghost" data-act="tab:ranks" style="margin-top:0">See all levels</button>`
      + (D.cap ? `<div class="m">Rewards received this month: <b>${D.cap.paid}</b> of ${D.cap.max} free call minutes.</div>` : '')
      + (Q && Q.tasks ? `<div class="ms-lab">Today</div>` + Q.tasks.slice(0, 6).map(t => `<div class="ms-mi r"><span>${esc(t.title)}</span><span class="g">${t.done ? 'Done' : `${fmt(t.progress)} of ${fmt(t.target)}`} &middot; +${t.xp} XP</span></div>`).join('') : '')
      + `<details class="c"><summary>How rewards are funded</summary><ul style="padding:0;margin:4px 0 0">${D.policy.map(p => `<li class="m">${esc(p)}</li>`).join('')}</ul></details>`;
  }

  function vRanks() {
    const R = D.rank, span = R.nextXp ? R.nextXp - R.fromXp : 1, pct = R.nextXp ? Math.max(3, Math.min(100, Math.round((R.xp - R.fromXp) / span * 100))) : 100;
    return `<div class="c"><div class="r"><b style="font:700 22px Georgia,serif">${esc(R.emoji)} Level ${R.n} · ${esc(R.name)}</b></div><div class="b"><i style="width:${pct}%"></i></div><div class="r m"><span>${fmt(R.xp)} XP</span><span>${R.nextXp ? `Next: ${esc(R.nextName)} at ${fmt(R.nextXp)} XP` : 'Top level reached'}</span></div>`
      + (D.level.state === 'waiting' ? `<div class="m" style="margin-top:6px">${D.level.minutes} free call min is waiting for the reward pool to fill. It is paid to you automatically.</div>` : '') + '</div>'
      + R.ladder.map(l => `<div class="c ms-row ${l.n === R.n ? 'ms-on' : ''}" style="${l.reached ? '' : 'opacity:.7'}"><span class="ms-n">${l.reached ? '&#10003;' : l.n}</span><span style="flex:1"><b>${esc(l.emoji)} ${esc(l.name)}</b><br><span class="m">${fmt(l.xp)} XP</span></span><span class="m" style="text-align:right">${l.bonus ? `+${l.bonus}% XP` : 'Start'}${l.rewardLabel ? ` · ${esc(l.rewardLabel)}` : ''}${l.hot ? ` · ${l.hot}h hot` : ''}</span></div>`).join('')
      + '<div class="m">Levels rise mostly with real gift activity. Rank call minutes are paid automatically from the reward pool when you reach a new level.</div>';
  }

  function vInsights() {
    const S = D.series, byDay = {}; S.forEach(x => { byDay[x.d] = x; });
    const dim = D.dim, dom = D.dom, tgt = Math.max(1, D.points.target), top = Math.max(tgt, D.points.projected, D.points.now) * 1.1;
    const X = d => 10 + (d - 1) / Math.max(1, dim - 1) * 330, Y = p => 138 - p / top * 122;
    let cum = 0; const pts = []; for (let d = 1; d <= dom; d++) { cum += (byDay[D.month + '-' + String(d).padStart(2, '0')] || {}).pts || 0; pts.push([X(d), Y(cum)]); }
    const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '), last = pts[pts.length - 1] || [10, 138];
    const chart = `<svg viewBox="0 0 350 160" width="100%" role="img" aria-label="Points this month with projection"><defs><linearGradient id="msA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--acc)" stop-opacity=".45"/><stop offset="1" style="stop-color:var(--acc)" stop-opacity="0"/></linearGradient></defs>`
      + `<path d="M${pts[0] ? pts[0][0] : 10},138 L${line.replace(/ /g, ' L')} L${last[0]},138Z" fill="url(#msA)"/><line x1="10" x2="340" y1="${Y(tgt).toFixed(1)}" y2="${Y(tgt).toFixed(1)}" style="stroke:var(--goldfill)" stroke-dasharray="4 4"/>`
      + `<polyline points="${line}" fill="none" style="stroke:var(--acc)" stroke-width="2.5" stroke-linejoin="round"/><polyline points="${last[0].toFixed(1)},${last[1].toFixed(1)} ${X(dim).toFixed(1)},${Y(D.points.projected).toFixed(1)}" fill="none" style="stroke:var(--goldfill)" stroke-width="2" stroke-dasharray="3 4"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="5" style="fill:var(--card);stroke:var(--acc)" stroke-width="3"/><circle cx="${X(dim).toFixed(1)}" cy="${Y(D.points.projected).toFixed(1)}" r="4" style="fill:var(--goldfill)"/>`
      + `<g font-size="10" style="fill:var(--mute)"><text x="10" y="156">Day 1</text><text x="${X(Math.ceil(dim / 2)) - 14}" y="156">Day ${Math.ceil(dim / 2)}</text><text x="340" y="156" text-anchor="end">Day ${dim}</text></g></svg>`;
    const series = k => { const a = []; for (let i = 13; i >= 0; i--) { const dt = new Date(Date.parse(D.day + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10); a.push((byDay[dt] || {})[k] || 0); } return a; };
    const spark = a => { const mx = Math.max(1, ...a); return `<svg viewBox="0 0 80 24" width="80" height="24" aria-hidden="true"><polyline points="${a.map((v, i) => (i * 80 / 13).toFixed(1) + ',' + (22 - v / mx * 20).toFixed(1)).join(' ')}" fill="none" style="stroke:var(--goldfill)" stroke-width="1.8" stroke-linejoin="round"/></svg>`; };
    const wk = a => a.slice(7).reduce((s, v) => s + v, 0) - a.slice(0, 7).reduce((s, v) => s + v, 0);
    const kpi = (label, val, k, conv) => { const dl = wk(series(k)); return `<div class="c ms-kpi"><div class="m">${label}</div><b>${val}</b><div class="${dl >= 0 ? 'up' : 'dn'}">${dl >= 0 ? '+' : ''}${conv ? (dl / 60).toFixed(1) + ' h' : fmt(dl)} vs last week</div></div>`; };
    const allPts = series('pts').concat([]), vals = S.map(x => x.pts || 0).filter(v => v > 0).sort((a, b) => a - b), q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0;
    let heat = '', active = 0; for (let i = 29; i >= 0; i--) { const dt = new Date(Date.parse(D.day + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10), v = (byDay[dt] || {}).pts || 0; if (v > 0) active++; const col = v <= 0 ? 'var(--track)' : v >= q(.75) ? '#a3134f' : v >= q(.4) ? '#e0709d' : '#f3c9d8'; heat += `<i title="${dt}: ${Math.round(v)} points" style="background:${col};${i === 0 ? 'outline:2px solid var(--ink)' : ''}"></i>`; }
    const T = D.totals, w = D.weights, mix = [['Gifts', T.giftRecv * w.giftRecv + T.giftSent * w.giftSent, '#a3134f'], ['Streaming', T.liveMin * w.liveMin, '#c8962e'], ['Referrals', T.refs * w.refs, '#7c3aed'], ['Followers', T.followers * w.followers, '#6b7280']], tot = Math.max(1, mix.reduce((s, x) => s + x[1], 0));
    const onPace = D.goals.filter(g => g.onPace || g.progress >= g.target).length;
    const pctGoal = Math.round(D.points.projected / tgt * 100);
    return `<div class="c"><div class="r" style="align-items:flex-start"><div><div class="k">Points this<br>month</div><div style="font:700 30px Georgia,serif;margin-top:4px">${fmt(D.points.now)}</div></div><div style="text-align:right"><div class="g">Projected ${fmt(D.points.projected)}</div><div class="m" style="max-width:150px;margin-left:auto">${pctGoal}% of goal &middot; ${onPace} of ${D.goals.length} goals on pace</div></div></div><div class="ms-leg"><span style="color:var(--acc)">Actual</span><span style="color:var(--gold)">Projection</span><span class="m">Goal ${fmt(tgt)}</span></div>${chart}</div>`
      + `<div class="ms-grid">${kpi('Hours live', (T.liveMin / 60).toFixed(1) + ' h', 'liveMin', true)}${kpi('Gift coins', fmt(T.giftRecv), 'giftRecv')}${kpi('Followers', '+' + fmt(T.followers), 'followers')}${kpi('Referrals', fmt(T.refs), 'refs')}</div>`
      + `<div class="c"><div class="r"><b style="font-size:13px">Activity &middot; 30 days</b><span class="m">${active} active day${active === 1 ? '' : 's'}</span></div><div class="ms-heat">${heat}</div></div>`
      + `<div class="c"><b style="font-size:13px">Where your points come from</b><div style="display:flex;height:10px;border-radius:99px;overflow:hidden;margin:10px 0 8px">${mix.map(x => `<i style="width:${x[1] / tot * 100}%;background:${x[2]}"></i>`).join('')}</div><div style="display:flex;flex-wrap:wrap;gap:4px 12px">${mix.map(x => `<span class="m"><b style="color:${x[2]}">&#9632;</b> ${x[0]} ${Math.round(x[1] / tot * 100)}%</span>`).join('')}</div></div>`
      + `<div class="m" style="text-align:center">Points are a progress score only. They are not money.</div>`;
  }

  function cardHTML() {
    const R = D.rank, uid = H().me(), pips = Array.from({ length: R.ladder.length }, (_, i) => `<i style="width:14px;height:6px;border-radius:3px;background:${i < R.n ? '#e9c46a' : 'rgba(255,255,255,.2)'}"></i>`).join('');
    return `<div class="ms-card"><div><div class="guil"></div><div class="r z"><b style="letter-spacing:.24em;font-size:11px;color:#f3dca0">HEART LINK</b><span style="display:flex;gap:3px">${pips}</span></div>`
      + `<div class="r z" style="justify-content:flex-start;gap:14px"><div class="ms-av"><img src="${esc(myPhoto())}" alt=""></div><div><div style="font:700 22px Georgia,serif">${esc(myName())}</div><div class="g" style="letter-spacing:.2em">${esc(R.name.toUpperCase())} · LV ${R.n}</div><div class="m">${esc(R.emoji)} ${fmt(R.xp)} XP</div></div></div>`
      + `<div class="r m z"><span style="display:flex;gap:8px;align-items:center"><i style="width:26px;height:19px;border-radius:4px;background:linear-gradient(135deg,#fff2c2,#c8962e)"></i>${cardNo(uid)}</span><span>${since() ? 'Since ' + esc(since()) : ''}</span></div></div></div>`;
  }
  function vCard() {
    const R = D.rank, L = R.ladder[R.n - 1], uid = H().me(); localStorage.setItem('ms_lvl_' + uid, String(R.n));
    const th = (a, b) => `<div class="c"><b>${a}</b><span class="m" style="font-size:11px">${b}</span></div>`;
    return `<div class="k">Your level card</div><h2 style="margin:0;font:700 26px Georgia,serif">${esc(R.emoji)} ${esc(R.name)}</h2>${cardHTML()}`
      + `<div class="ms-th">${th(L.bonus ? '+' + L.bonus + '%' : '0%', 'task XP')}${th(L.rewardShort, L.rewardUnit)}${th(R.n + '/' + R.ladder.length, 'level')}${th((L.hot || 0) + 'h', 'hot feed')}</div>`
      + `<div><label class="m" for="msCap">Caption</label><textarea id="msCap" rows="2" maxlength="140">Just reached ${esc(R.name)} on Heart Link! ${esc(R.emoji)}</textarea></div>`
      + `<button class="btn" data-act="share" id="msShare" style="margin-top:0">Share to Moments</button><button class="btn ghost" data-act="save" style="margin-top:0">Save image</button>`
      + `<div class="m">Only you decide: nothing is posted until you tap Share. The card shows your name, photo and level only.</div>`;
  }

  // ---------- the card as a picture ----------
  const loadImg = url => new Promise(res => { if (!url) return res(null); const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  async function cardBlob() {
    const W = 1080, Hh = 680, c = document.createElement('canvas'); c.width = W; c.height = Hh; const x = c.getContext('2d'), R = D.rank, rr = (a, b, w, h, r) => { x.beginPath(); x.roundRect ? x.roundRect(a, b, w, h, r) : x.rect(a, b, w, h); };
    const bg = x.createLinearGradient(0, 0, W, Hh); ['#fff2c2', '#ff9ad0', '#9ad8ff', '#e9c46a'].forEach((cl, i) => bg.addColorStop(i / 3, cl)); x.fillStyle = bg; rr(0, 0, W, Hh, 64); x.fill();
    const g = x.createRadialGradient(200, 0, 40, 400, 300, 900); g.addColorStop(0, '#6a1a55'); g.addColorStop(1, '#1b0617'); x.fillStyle = g; rr(8, 8, W - 16, Hh - 16, 58); x.fill();
    x.save(); rr(8, 8, W - 16, Hh - 16, 58); x.clip(); x.strokeStyle = 'rgba(233,196,106,.09)'; x.lineWidth = 2; for (let r = 40; r < 1200; r += 22) { x.beginPath(); x.arc(920, 140, r, 0, 7); x.stroke(); } x.restore();
    x.fillStyle = '#f3dca0'; x.font = '700 30px system-ui,sans-serif'; if ('letterSpacing' in x) x.letterSpacing = '8px'; x.fillText('HEART LINK', 64, 100); if ('letterSpacing' in x) x.letterSpacing = '0px';
    R.ladder.forEach((_, i) => { x.fillStyle = i < R.n ? '#e9c46a' : 'rgba(255,255,255,.22)'; rr(W - 64 - (R.ladder.length - i) * 38, 80, 30, 14, 7); x.fill(); });
    const img = await loadImg(myPhoto()), cx = 190, cy = 340, r = 112, ring = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r); ['#fff2c2', '#c8962e', '#fff2c2', '#c8962e'].forEach((cl, i) => ring.addColorStop(i / 3, cl));
    x.fillStyle = ring; x.beginPath(); x.arc(cx, cy, r + 10, 0, 7); x.fill(); x.save(); x.beginPath(); x.arc(cx, cy, r, 0, 7); x.clip(); x.fillStyle = '#3b0f33'; x.fillRect(cx - r, cy - r, r * 2, r * 2);
    if (img) { const s = Math.max(r * 2 / img.width, r * 2 / img.height); x.drawImage(img, cx - img.width * s / 2, cy - img.height * s / 2, img.width * s, img.height * s); } else { x.fillStyle = '#fff'; x.font = '700 110px Georgia,serif'; x.textAlign = 'center'; x.fillText(myName().slice(0, 1).toUpperCase(), cx, cy + 38); x.textAlign = 'left'; } x.restore();
    x.fillStyle = '#fff'; x.font = '700 66px Georgia,serif'; x.fillText(myName().slice(0, 18), 350, 320); x.fillStyle = '#e9c46a'; x.font = '700 36px system-ui,sans-serif'; if ('letterSpacing' in x) x.letterSpacing = '6px'; x.fillText(`${R.name.toUpperCase()} · LV ${R.n}`, 352, 384); if ('letterSpacing' in x) x.letterSpacing = '0px';
    x.fillStyle = 'rgba(255,255,255,.78)'; x.font = '30px system-ui,sans-serif'; x.fillText(`${R.emoji} ${fmt(R.xp)} XP`, 352, 432);
    const chip = x.createLinearGradient(64, 560, 120, 600); chip.addColorStop(0, '#fff2c2'); chip.addColorStop(1, '#c8962e'); x.fillStyle = chip; rr(64, 566, 78, 56, 10); x.fill();
    x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '30px system-ui,sans-serif'; x.fillText(cardNo(H().me()), 162, 604); if (since()) { x.textAlign = 'right'; x.fillText('Since ' + since(), W - 64, 604); x.textAlign = 'left'; }
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not make the picture')), 'image/png'));
  }
  async function share() {
    if (shareBusy) return; shareBusy = true; const b = document.getElementById('msShare'); if (b) { b.disabled = true; b.textContent = 'Sharing…'; }
    try {
      const blob = await cardBlob(), cap = (document.getElementById('msCap') || {}).value || '';
      await H().postMoment(new File([blob], 'heartlink-level-card.png', { type: 'image/png' }), cap);
      toast('Shared to Moments'); root.classList.add('hidden'); if (H().goMoments) H().goMoments();
    } catch (e) { toast(e.message || 'Could not share the card'); if (b) { b.disabled = false; b.textContent = 'Share to Moments'; } }
    shareBusy = false;
  }
  async function save() {
    try { const blob = await cardBlob(), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'heartlink-level-card.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    catch (e) { toast(e.message || 'Could not save the picture'); }
  }
})();