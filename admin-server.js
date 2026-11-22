'use strict';
/* =====================================================================================================
   ADMIN PANEL DATA (separate module; server.js loads it with one require).  FILE NAME: admin-server.js
   The existing admin routes (withdrawals, reports, kyc, verifications, abuse, ads, moderation, economy) stay in server.js.
   This file only ADDS what the new control panel needs:
     GET  /admin/overview          totals, sign-ups and purchases per day, money waiting, queues that need attention
     GET  /admin/users             every member (search, newest or recently active, page by page) with their sign-in details
     GET  /admin/user/:uid         one member in full: profile, sign-in, purchases and gifts, withdrawals, complaints, calls
     POST /admin/user/:uid/status  suspend or re-enable sign-in
     GET  /admin/users/export      all members as a CSV file
     GET  /admin/activity          the latest money and gift movements across the app
     POST /admin/names             uid -> name lookup for the lists
   Every route uses the same adminAuth (ADMIN_SECRET) as the rest of admin.
   ===================================================================================================== */
module.exports = function (d) {
  const { app, admin, adminAuth, fsdb, wrap, httpErr, SAFE_ID } = d;
  const DAY = 86400000, TZ = 3600000;      // sign-up days are cut at midnight in Lagos (UTC+1)
  const ms = t => (t && t.toMillis ? t.toMillis() : 0);
  const ts = t => admin.firestore.Timestamp.fromMillis(t);
  const cnt = async q => { try { return (await q.count().get()).data().count; } catch { return 0; } };
  const dayKey = t => new Date(t + TZ).toISOString().slice(5, 10);
  const lastDays = n => { const out = []; for (let i = n - 1; i >= 0; i--) out.push(dayKey(Date.now() - i * DAY)); return out; };
  const series = (days, rows, pick) => { const m = Object.fromEntries(days.map(k => [k, 0])); rows.forEach(r => { const k = dayKey(r.t); if (k in m) m[k] += pick(r); }); return days.map(k => ({ day: k, n: Math.round(m[k] * 100) / 100 })); };

  async function authInfo(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const r = await admin.auth().getUsers(ids.slice(i, i + 100).map(uid => ({ uid }))).catch(() => ({ users: [] }));
      r.users.forEach(u => { out[u.uid] = { email: u.email || '', disabled: !!u.disabled, created: Date.parse(u.metadata.creationTime) || 0, lastSignIn: Date.parse(u.metadata.lastSignInTime) || 0, providers: (u.providerData || []).map(p => p.providerId).join(', ') }; });
    }
    return out;
  }
  const userRow = (doc, a) => { const u = doc.data(), x = (a || {})[doc.id] || {};
    return { id: doc.id, name: u.name || '', email: x.email || '', gender: u.gender || '', age: u.age || '', country: u.country || '', state: u.state || '', city: u.city || '',
      createdAt: ms(u.createdAt), lastSeen: ms(u.lastSeen), lastSignIn: x.lastSignIn || 0, tokens: u.tokens || 0, balance: u.creatorBalance || 0, followers: u.followers || 0,
      verified: !!u.verified, disabled: !!x.disabled, referredBy: u.referredBy || '' }; };

  app.get('/admin/overview', adminAuth, wrap(async (req, res) => {
    const db = fsdb(), U = db.collection('users'), now = Date.now();
    const [total, male, female, new24, new7, new30, act24, act7, verified, pendW, pendKyc, pendVer, frozen, appeals, mmProf, mmPaid, mmLeads] = await Promise.all([
      cnt(U), cnt(U.where('gender', '==', 'male')), cnt(U.where('gender', '==', 'female')),
      cnt(U.where('createdAt', '>=', ts(now - DAY))), cnt(U.where('createdAt', '>=', ts(now - 7 * DAY))), cnt(U.where('createdAt', '>=', ts(now - 30 * DAY))),
      cnt(U.where('lastSeen', '>=', ts(now - DAY))), cnt(U.where('lastSeen', '>=', ts(now - 7 * DAY))), cnt(U.where('verified', '==', true)),
      cnt(db.collection('withdrawals').where('status', '==', 'pending')), cnt(db.collection('kyc').where('status', '==', 'pending')), cnt(db.collection('verifications').where('status', '==', 'pending')),
      cnt(db.collection('abuse').where('frozen', '==', true)), cnt(db.collection('modAppeals').where('status', '==', 'open')),
      cnt(db.collection('mmProfiles')), cnt(db.collection('mmProfiles').where('subscribed', '==', true)), cnt(db.collection('mmLeads').where('status', '==', 'open')),
    ]);
    const days = lastDays(30);
    const su = await U.where('createdAt', '>=', ts(now - 30 * DAY)).select('createdAt').limit(5000).get().catch(() => ({ docs: [] }));
    let tx;
    try { tx = await db.collection('transactions').where('type', '==', 'purchase').orderBy('createdAt', 'desc').limit(3000).get(); }
    catch { tx = await db.collection('transactions').where('type', '==', 'purchase').limit(3000).get().catch(() => ({ docs: [] })); }
    const buys = tx.docs.map(x => ({ t: ms(x.data().createdAt), coins: Number(x.data().tokens) || 0, usd: Number(x.data().usd) || 0 })).filter(r => r.t >= now - 30 * DAY);
    const [pw, paid, rep] = await Promise.all([
      db.collection('withdrawals').where('status', '==', 'pending').limit(500).get().catch(() => ({ docs: [] })),
      db.collection('withdrawals').where('status', '==', 'paid').limit(500).get().catch(() => ({ docs: [] })),
      db.collection('reports').orderBy('createdAt', 'desc').limit(300).get().catch(() => ({ docs: [] })),
    ]);
    const sum = (docs, k) => Math.round(docs.reduce((s, x) => s + (Number(x.data()[k]) || 0), 0) * 100) / 100;
    res.json({
      counts: { users: total, male, female, new24, new7, new30, active24: act24, active7: act7, verified, pendingWithdrawals: pendW, pendingKyc: pendKyc, pendingSelfies: pendVer, frozen, appeals,
        openReports: rep.docs.filter(x => !x.data().reviewed).length, mmProfiles: mmProf, mmPaid, mmLeads, ads: await cnt(db.collection('ads').where('status', '==', 'active')) },
      money: { pendingTokens: sum(pw.docs, 'tokens'), pendingUsd: sum(pw.docs, 'usd'),
        paidUsd30: Math.round(paid.docs.filter(x => ms(x.data().resolvedAt) >= now - 30 * DAY).reduce((s, x) => s + (Number(x.data().usd) || 0), 0) * 100) / 100,
        purchases30: buys.length, coinsSold30: buys.reduce((s, r) => s + r.coins, 0), usd30: Math.round(buys.reduce((s, r) => s + r.usd, 0) * 100) / 100 },
      signups: series(days, su.docs.map(x => ({ t: ms(x.data().createdAt) })), () => 1),
      purchases: series(days, buys, r => r.coins),
    });
  }));

  app.get('/admin/users', adminAuth, wrap(async (req, res) => {
    const U = fsdb().collection('users'), field = req.query.sort === 'active' ? 'lastSeen' : 'createdAt';
    const q = String(req.query.q || '').trim().slice(0, 80), limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    let docs = [];
    if (q) {
      if (q.includes('@')) { const r = await admin.auth().getUserByEmail(q).catch(() => null); if (r) { const s = await U.doc(r.uid).get(); if (s.exists) docs = [s]; } }
      else if (SAFE_ID.test(q) && q.length >= 20) { const s = await U.doc(q).get(); if (s.exists) docs = [s]; }
      if (!docs.length) {
        const vs = [...new Set([q, q.charAt(0).toUpperCase() + q.slice(1).toLowerCase(), q.toLowerCase()])];
        const snaps = await Promise.all(vs.map(v => U.orderBy('name').startAt(v).endAt(v + '\uf8ff').limit(limit).get()));
        const m = new Map(); snaps.forEach(s => s.docs.forEach(x => m.set(x.id, x))); docs = [...m.values()].slice(0, limit);
      }
    } else {
      let qq = U.orderBy(field, 'desc').limit(limit); const cur = Number(req.query.cursor); if (cur > 0) qq = qq.startAfter(ts(cur));
      docs = (await qq.get()).docs;
    }
    const a = await authInfo(docs.map(x => x.id));
    const rows = docs.map(x => userRow(x, a));
    res.json({ users: rows, next: !q && docs.length === limit ? ms(docs[docs.length - 1].data()[field]) : 0, total: !q && !req.query.cursor ? await cnt(U) : undefined });
  }));

  app.get('/admin/user/:uid', adminAuth, wrap(async (req, res) => {
    if (!SAFE_ID.test(req.params.uid)) throw httpErr(400, 'Invalid id');
    const db = fsdb(), uid = req.params.uid, us = await db.collection('users').doc(uid).get();
    if (!us.exists) throw httpErr(404, 'Member not found');
    const take = async (col, field, n) => (await db.collection(col).where(field, '==', uid).limit(100).get().catch(() => ({ docs: [] }))).docs
      .map(x => ({ id: x.id, ...x.data(), createdAt: ms(x.data().createdAt), resolvedAt: ms(x.data().resolvedAt) })).sort((p, q) => q.createdAt - p.createdAt).slice(0, n);
    const [a, tx, wd, repBy, repTo, calls, ab, kyc, mm] = await Promise.all([authInfo([uid]), take('transactions', 'uid', 40), take('withdrawals', 'uid', 15), take('reports', 'from', 15), take('reports', 'to', 15),
      take('calls', 'from', 15), db.collection('abuse').doc(uid).get(), db.collection('kyc').doc(uid).get(), db.collection('mmProfiles').doc(uid).get()]);
    const u = us.data();
    res.json({ user: { ...userRow(us, a), bio: u.bio || '', occupation: u.occupation || '', goal: u.goal || '', neighborhood: u.neighborhood || '', following: u.following || 0, photos: (u.media || []).length, agencyId: u.agencyId || '' },
      auth: a[uid] || null, transactions: tx, withdrawals: wd, reportsAgainst: repTo, reportsBy: repBy, calls,
      flags: ab.exists ? { frozen: !!ab.data().frozen, reasons: Object.values(ab.data().reasons || {}) } : null, kyc: kyc.exists ? { status: kyc.data().status || '' } : null,
      matchmaking: mm.exists ? { managed: !!mm.data().managed, subscribed: !!mm.data().subscribed, intent: mm.data().intent || '' } : null });
  }));

  app.post('/admin/user/:uid/status', adminAuth, wrap(async (req, res) => {
    if (!SAFE_ID.test(req.params.uid)) throw httpErr(400, 'Invalid id');
    await admin.auth().updateUser(req.params.uid, { disabled: !!(req.body && req.body.disabled) });
    res.json({ ok: true });
  }));

  app.get('/admin/users/export', adminAuth, wrap(async (req, res) => {
    const snap = await fsdb().collection('users').orderBy('createdAt', 'desc').limit(3000).get(), ids = snap.docs.map(x => x.id), a = await authInfo(ids);
    const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const iso = t => t ? new Date(t).toISOString() : '';
    const head = ['uid', 'name', 'email', 'gender', 'age', 'country', 'state', 'city', 'joined', 'last_seen', 'last_sign_in', 'coins', 'creator_balance', 'verified', 'disabled'];
    const lines = [head.join(',')].concat(snap.docs.map(x => { const r = userRow(x, a); return [r.id, r.name, r.email, r.gender, r.age, r.country, r.state, r.city, iso(r.createdAt), iso(r.lastSeen), iso(r.lastSignIn), r.tokens, r.balance, r.verified, r.disabled].map(cell).join(','); }));
    res.set('Content-Type', 'text/csv; charset=utf-8').send(lines.join('\n'));
  }));

  app.get('/admin/activity', adminAuth, wrap(async (req, res) => {
    const snap = await fsdb().collection('transactions').orderBy('createdAt', 'desc').limit(80).get();
    res.json({ items: snap.docs.map(x => { const t = x.data(); return { id: x.id, uid: t.uid || '', type: t.type || '', tokens: t.tokens || 0, usd: t.usd || 0, provider: t.provider || '', createdAt: ms(t.createdAt) }; }) });
  }));

  app.post('/admin/names', adminAuth, wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter(x => SAFE_ID.test(x)))].slice(0, 100);
    if (!ids.length) return res.json({ names: {} });
    const docs = await fsdb().getAll(...ids.map(i => fsdb().collection('users').doc(i)));
    res.json({ names: Object.fromEntries(docs.map(x => [x.id, x.exists ? x.data().name || '' : '(deleted)'])) });
  }));
  return {};
};