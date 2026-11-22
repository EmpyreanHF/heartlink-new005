'use strict';
/* =====================================================================================================
   MATCHMAKING  (separate module; plugged into server.js with one require, see the bottom of server.js)
   FILE NAME MUST BE:  matchmaking-server.js   (server.js does require('./matchmaking-server'))

   A PROFESSIONAL matchmaking service for people seeking marriage, a serious relationship, or a friendship that leads to marriage.
   It is NOT for hookups, casual dating, fun, or paid ("compensated") arrangements. The one-time fee exists to keep unserious people out.

   Rules enforced here (the app only displays them):
   1. Pledge. Nobody can save a matchmaking profile without accepting the serious-intent pledge, and picking one serious intent.
   0. WHO GETS IN: (a) everybody while MM_FREE_MODE is on (default ON: free launch), (b) anyone who invited MM_REFS_TO_UNLOCK (10) new members with their invite code,
      (c) paid members, (d) admin test accounts listed in MM_ADMIN_EMAILS. Set MM_FREE_MODE=false on Render to start charging.
   2. Fee, WEB ONLY. Paying is started on the website with Flutterwave (NGN). /mm/pay/init refuses the Android app / Play Store app.
      The app only READS the result: once the fee is paid on the web, the account is unlocked everywhere.
   3. Pool = paid members only. You only ever see, and are only seen by, other paid members.
   4. Two-way match: they fit your criteria AND you fit theirs (age, city, religion). Browse lets you read profiles and express interest.
   5. Chat first. Phone numbers are never sent to the app until BOTH people accept, after each has sent MM_MIN_MSGS_EACH messages.
      Phone numbers, emails and hookup language are blocked inside the chat.
   6. Report / leave on every match. Admin can revoke access (no refund).

   MATCHMAKER-POSTED PROFILES: the admin page (matchmaking-admin.html) can list real people who agreed to be listed (18+, with their consent ticked). They appear in
   Browse and the queue with a visible "Posted by Heart Link matchmaker" tag. They have no account, so interest in them becomes a LEAD for the admin, never a pretend chat.

   Firestore (server only; the rules deny everything that has no rule): mmProfiles/{uid}, mmSubs/{uid}, mmPayments/{reference},
     mmInterest/{from_to}, mmMatches/{a_b} (+ /msgs), mmState/{uid} (declined list), mmReports/{id}, mmLeads/{member_profile}, mmClaims/{code}

   Render env vars:  MM_FREE_MODE ('false' to stop the free launch), MM_REFS_TO_UNLOCK (default 10), MM_ADMIN_EMAILS (comma list of admin test emails),
                     FLW_SECRET_KEY (Flutterwave secret key), FLW_SECRET_HASH (the webhook secret hash), PUBLIC_WEB_URL (your website, e.g. https://heartlink.example.com),
                     MM_FEE_NGN (default 15000), MM_MIN_MSGS_EACH (default 2), MM_REQUIRE_VERIFIED ('true' = only ID/selfie verified members)
   Flutterwave dashboard > Settings > Webhooks: URL  https://YOUR-SERVER/mm/webhook  and the same Secret hash as FLW_SECRET_HASH
   ===================================================================================================== */
const crypto = require('crypto');
const axios = require('axios');

module.exports = function (d) {
  const { app, admin, adminAuth, fsdb, FV, fbAuth, wrap, httpErr, rateLimit, ensureRefCode } = d;
  const FEE = Number(process.env.MM_FEE_NGN) || 15000;
  const MIN_MSGS = Math.max(1, Number(process.env.MM_MIN_MSGS_EACH) || 2);
  const FLW = process.env.FLW_SECRET_KEY || '', FLW_HASH = process.env.FLW_SECRET_HASH || '';
  const NEED_VERIFIED = process.env.MM_REQUIRE_VERIFIED === 'true';
  const FREE_MODE = process.env.MM_FREE_MODE !== 'false';
  const REF_NEED = Math.max(1, Number(process.env.MM_REFS_TO_UNLOCK) || 10);
  const ADMIN_EMAILS = String(process.env.MM_ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const PLEDGE_V = 1;
  const INTENTS = ['marriage', 'serious_relationship', 'friendship_to_marriage'];
  const RELIGIONS = ['Christian', 'Muslim', 'Other'];
  const REPORT_WHY = ['not_serious', 'hookup', 'harassment', 'fake', 'minor', 'other'];

  const col = n => fsdb().collection(n);
  const ms = t => (t && t.toMillis ? t.toMillis() : 0);
  const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const lc = v => String(v || '').trim().toLowerCase();

  // Anything that signals "not serious" or tries to move the chat off the platform too early.
  const BAD = /\b(hook\s?-?ups?|one[\s-]?night|one night stand|ons|fwb|friends? with benefits|casual (sex|fun|dating|relationship)|just for fun|fun only|no strings|sugar\s?(daddy|mummy|mommy|baby|boy|girl)|sponsor(ed)?|allowance|escort|nudes?|sex|sexy|horny|bed buddy|side (chick|piece)|toyboy|boyfriend material for fun)\b/i;
  const PHONE = /(\+?\d[\d\s().-]{6,}\d)/;
  const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const bad = t => BAD.test(t);

  const photoOf = u => { const m = ((u && u.media) || []).find(x => x && x.kind !== 'video' && typeof x.url === 'string' && x.url.startsWith('https://')); return m ? m.url : ''; };
  // the client sends app:true only when it runs inside the Play Store app (opened as a Trusted Web Activity)
  const inApp = req => !!(req.body && req.body.app === true) || lc(req.headers['x-requested-with']).startsWith('com.') || lc(req.headers.referer).startsWith('android-app://');
  const webOnly = req => {
    if (inApp(req))
      throw Object.assign(httpErr(403, 'Matchmaking is activated on the Heart Link website, not in the app. Pay there once and it unlocks here.'), { mcode: 'WEB_ONLY' });
  };

  const pub = p => ({ uid: p.uid, name: p.name, age: p.age, city: p.city, religion: p.religion, job: p.job, bio: p.bio, intent: p.intent, qualities: p.qualities,
    prefMinAge: p.prefMinAge, prefMaxAge: p.prefMaxAge, prefCity: p.prefCity, prefReligion: p.prefReligion, photo: p.photo || '', verified: !!p.verified, managed: !!p.managed });

  // access = admin test account, paid, invited enough people, or the free launch. A revoked account gets nothing.
  const accCache = new Map();
  async function refCount(uid) { try { const r = await fsdb().collection('users').where('referredBy', '==', uid).count().get(); return r.data().count || 0; } catch { return 0; } }
  async function access(uid) {
    const hit = accCache.get(uid); if (hit && hit.t > Date.now()) return hit.v;
    let v;
    const s = await col('mmSubs').doc(uid).get(), sd = s.exists ? s.data() : {};
    if (sd.active === false && sd.revokedAt) v = { active: false, via: '', refs: 0 };
    else if (sd.active === true) v = { active: true, via: sd.provider === 'admin' ? 'admin' : sd.provider === 'matchmaker' ? 'listed' : 'paid', refs: 0 };
    else {
      const rec = ADMIN_EMAILS.length ? await admin.auth().getUser(uid).catch(() => null) : null;
      if (rec && rec.email && ADMIN_EMAILS.includes(rec.email.toLowerCase())) v = { active: true, via: 'admin', refs: 0 };
      else {
        const refs = await refCount(uid);
        v = refs >= REF_NEED ? { active: true, via: 'referrals', refs } : FREE_MODE ? { active: true, via: 'free', refs } : { active: false, via: '', refs };
      }
    }
    accCache.set(uid, { v, t: Date.now() + 60000 }); return v;
  }
  const inPool = p => p && p.pledgeV === PLEDGE_V && p.revoked !== true && (p.managed ? p.active !== false : (p.subscribed === true || FREE_MODE));
  // people I already showed interest in (members and matchmaker-posted profiles), so they do not come back in my queue
  async function sentTo(uid) { const [a, b] = await Promise.all([col('mmInterest').where('from', '==', uid).get(), col('mmLeads').where('from', '==', uid).get()]); return new Set([...a.docs, ...b.docs].map(x => x.data().to)); }
  async function needSub(uid) { if (!(await access(uid)).active) throw Object.assign(httpErr(402, `Matchmaking is not active yet. Invite ${REF_NEED} friends with your code, or activate it on the Heart Link website.`), { mcode: 'NEED_SUB' }); }
  async function mine(uid) { const s = await col('mmProfiles').doc(uid).get(); if (!s.exists || s.data().pledgeV !== PLEDGE_V) throw Object.assign(httpErr(409, 'Finish your matchmaking profile first.'), { mcode: 'NEED_PROFILE' }); return s.data(); }

  // do both sides meet each other's requirements?
  const okAge = (age, lo, hi) => age >= lo && age <= hi;
  const okCity = (pref, city) => pref === 'Any' || lc(pref) === lc(city);
  const okRel = (pref, rel) => pref === 'Any' || pref === rel;
  const theyFitMe = (me, c) => okAge(c.age, me.prefMinAge, me.prefMaxAge) && okCity(me.prefCity, c.city) && okRel(me.prefReligion, c.religion);
  const iFitThem = (me, c) => okAge(me.age, c.prefMinAge, c.prefMaxAge) && okCity(c.prefCity, me.city) && okRel(c.prefReligion, me.religion);
  const fitScore = (me, c) => [okAge(me.age, c.prefMinAge, c.prefMaxAge), okCity(c.prefCity, me.city), okRel(c.prefReligion, me.religion)].filter(Boolean).length;

  async function blockedSet(uid) {
    const [a, b] = await Promise.all([col('blocks').where('by', '==', uid).get(), col('blocks').where('blocked', '==', uid).get()]);
    return new Set([...a.docs.map(x => x.data().blocked), ...b.docs.map(x => x.data().by)]);
  }
  async function matchedWith(uid) {
    const s = await col('mmMatches').where('users', 'array-contains', uid).get();
    return new Set(s.docs.map(x => x.data().users.find(u => u !== uid)));
  }
  async function poolFor(me, uid) {
    const g = me.gender === 'male' ? 'female' : 'male';
    const [s, bl, mt] = await Promise.all([col('mmProfiles').where('gender', '==', g).limit(400).get(), blockedSet(uid), matchedWith(uid)]);
    return s.docs.map(x => x.data()).filter(p => p.uid !== uid && !bl.has(p.uid) && !mt.has(p.uid) && inPool(p));
  }
  async function likedMe(uid) { const s = await col('mmInterest').where('to', '==', uid).get(); return new Set(s.docs.map(x => x.data().from)); }

  // ---------- me ----------
  app.post('/mm/me', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmme', 60, 60000);
    accCache.delete(req.uid);
    const [p, acc, code] = await Promise.all([col('mmProfiles').doc(req.uid).get(), access(req.uid), ensureRefCode ? ensureRefCode(req.uid).catch(() => '') : '']);
    const prof = p.exists ? p.data() : null;
    if (prof && prof.subscribed !== acc.active) col('mmProfiles').doc(req.uid).set({ subscribed: acc.active }, { merge: true }).catch(() => {});
    res.json({ sub: acc.active, via: acc.via, refs: acc.refs || 0, refNeed: REF_NEED, refCode: code || '', free: FREE_MODE, fee: FEE, minMsgs: MIN_MSGS, pledgeV: PLEDGE_V, intents: INTENTS, religions: RELIGIONS,
      canPayHere: !inApp(req),
      profile: prof ? { ...pub(prof), phone: prof.phone, pledgeV: prof.pledgeV } : null });
  }));

  app.post('/mm/profile', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmprof', 10, 60000);
    const b = req.body || {};
    const us = await fsdb().collection('users').doc(req.uid).get();
    if (!us.exists) throw httpErr(404, 'User not found');
    const u = us.data();
    if (u.gender !== 'male' && u.gender !== 'female') throw httpErr(400, 'Set your gender (Man or Woman) in your Heart Link profile first.');
    const old = await col('mmProfiles').doc(req.uid).get();
    const pledged = b.pledge === true || (old.exists && old.data().pledgeV === PLEDGE_V);
    if (!pledged) throw httpErr(400, 'You must accept the serious-intent pledge. This service is not for hookups or casual dating.');
    if (!INTENTS.includes(b.intent)) throw httpErr(400, 'Choose what you are looking for: marriage, a serious relationship, or friendship that leads to marriage.');
    const age = Math.round(Number(b.age) || Number(u.age) || 0);
    if (age < 18 || age > 90) throw httpErr(400, 'You must be 18 or older.');
    if (!RELIGIONS.includes(b.religion)) throw httpErr(400, 'Choose your religion.');
    const prefMinAge = Math.round(Number(b.prefMinAge)), prefMaxAge = Math.round(Number(b.prefMaxAge));
    if (!(prefMinAge >= 18 && prefMaxAge <= 90 && prefMinAge <= prefMaxAge)) throw httpErr(400, 'Check the partner age range (18 to 90).');
    const prefReligion = b.prefReligion === 'Any' || RELIGIONS.includes(b.prefReligion) ? b.prefReligion : 'Any';
    const city = str(b.city || u.city, 60), prefCity = str(b.prefCity, 60) || 'Any';
    if (!city) throw httpErr(400, 'Enter your city.');
    const phone = str(b.phone, 24), digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) throw httpErr(400, 'Enter a phone number that can be reached on WhatsApp or calls. It stays hidden until you and your match both agree.');
    const job = str(b.job || u.occupation, 80), bio = str(b.bio, 300), qualities = str(b.qualities, 200);
    if (bad(bio + ' ' + qualities + ' ' + job)) throw httpErr(400, 'Matchmaking is for serious relationships only. Please remove any casual, hookup or paid-arrangement wording from your profile.');
    if (PHONE.test(bio + ' ' + qualities) || EMAIL.test(bio + ' ' + qualities)) throw httpErr(400, 'Do not put phone numbers or emails in your bio. They are shared only after both of you accept.');
    const doc = { uid: req.uid, name: str(u.name, 60) || 'Member', gender: u.gender, age, city, religion: b.religion, job, bio, qualities, intent: b.intent, phone,
      prefMinAge, prefMaxAge, prefCity, prefReligion, photo: photoOf(u), verified: !!u.verified, pledgeV: PLEDGE_V,
      subscribed: (await access(req.uid)).active, updatedAt: FV().serverTimestamp() };
    if (!old.exists || old.data().pledgeV !== PLEDGE_V) doc.pledgedAt = FV().serverTimestamp();
    await col('mmProfiles').doc(req.uid).set(doc, { merge: true });
    res.json({ ok: true });
  }));

  // ---------- paying (WEB ONLY, Flutterwave) ----------
  // init saves a "pending" record that remembers WHO is paying; verify/webhook only ever trust that record plus Flutterwave's own answer.
  async function activate(ref, amount) {
    const pref = col('mmPayments').doc(ref); let uid = '';
    await fsdb().runTransaction(async t => {
      const s = await t.get(pref); if (!s.exists) throw httpErr(400, 'Unknown payment reference');
      uid = s.data().uid; if (s.data().status === 'paid') return;
      t.update(pref, { status: 'paid', paidAmountNgn: amount, paidAt: FV().serverTimestamp() });
      t.set(col('mmSubs').doc(uid), { active: true, paidAt: FV().serverTimestamp(), reference: ref, amountNgn: amount, provider: 'flutterwave' }, { merge: true });
    });
    await col('mmProfiles').doc(uid).set({ subscribed: true, revoked: false }, { merge: true }); accCache.delete(uid);
    return uid;
  }
  async function flwVerify(ref) {
    if (!FLW) throw httpErr(503, 'Payments are not set up yet.');
    const r = await axios.get('https://api.flutterwave.com/v3/transactions/verify_by_reference', { params: { tx_ref: ref }, headers: { Authorization: 'Bearer ' + FLW }, timeout: 15000 });
    return (r.data && r.data.data) || null;
  }
  const paidOk = x => x && x.status === 'successful' && x.currency === 'NGN' && Number(x.amount) >= FEE;

  app.post('/mm/pay/init', fbAuth, wrap(async (req, res) => {
    webOnly(req);
    rateLimit(req.uid, 'mmpay', 8, 600000);
    if (!FLW) throw httpErr(503, 'Payments are not set up yet.');
    await mine(req.uid);
    if ((await access(req.uid)).active) throw httpErr(409, 'Matchmaking is already active on your account, so no payment is needed.');
    const rec = await admin.auth().getUser(req.uid).catch(() => null);
    if (!rec || !rec.email) throw httpErr(400, 'Add an email to your account to pay.');
    const base = String(process.env.PUBLIC_WEB_URL || req.headers.origin || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw httpErr(503, 'The website address is not set on the server (PUBLIC_WEB_URL).');
    const ref = 'mm-' + req.uid.slice(0, 8).replace(/[^A-Za-z0-9]/g, '') + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await col('mmPayments').doc(ref).set({ uid: req.uid, status: 'pending', amountNgn: FEE, createdAt: FV().serverTimestamp(), provider: 'flutterwave' });
    const r = await axios.post('https://api.flutterwave.com/v3/payments', {
      tx_ref: ref, amount: FEE, currency: 'NGN', redirect_url: base + '/',
      customer: { email: rec.email, name: str(rec.displayName, 60) || 'Heart Link member' },
      customizations: { title: 'Heart Link Matchmaking', description: 'One-time matchmaking fee' }
    }, { headers: { Authorization: 'Bearer ' + FLW }, timeout: 15000 }).catch(e => { throw httpErr(502, 'The payment page could not open: ' + (e.response && e.response.data && e.response.data.message || 'try again')); });
    const link = r.data && r.data.data && r.data.data.link; if (!link) throw httpErr(502, 'The payment page could not open. Try again.');
    res.json({ url: link, reference: ref });
  }));

  app.post('/mm/pay/verify', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmver', 20, 600000);
    const ref = str(req.body && req.body.reference, 80);
    if (!/^mm-[A-Za-z0-9-]+$/.test(ref)) throw httpErr(400, 'Bad payment reference');
    const p = await col('mmPayments').doc(ref).get();
    if (!p.exists || p.data().uid !== req.uid) throw httpErr(400, 'This payment does not match your account.');
    const x = await flwVerify(ref);
    if (!paidOk(x)) return res.json({ ok: false, status: x ? x.status : 'unknown' });
    await activate(ref, Number(x.amount));
    res.json({ ok: true });
  }));

  // Flutterwave calls this itself, so a payment is never lost if the person closes the page before returning.
  // Dashboard > Settings > Webhooks: URL https://YOUR-SERVER/mm/webhook and a Secret hash that you also put in FLW_SECRET_HASH.
  app.post('/mm/webhook', wrap(async (req, res) => {
    if (!FLW || !FLW_HASH || req.headers['verif-hash'] !== FLW_HASH) return res.sendStatus(401);
    const ev = req.body || {}, ref = ev.data && ev.data.tx_ref;
    if (/^mm-[A-Za-z0-9-]+$/.test(ref || '')) {
      const x = await flwVerify(ref).catch(() => null);
      if (paidOk(x)) await activate(ref, Number(x.amount)).catch(() => {});
    }
    res.sendStatus(200);
  }));

  // ---------- finding people ----------
  app.post('/mm/queue', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmq', 60, 60000);
    await needSub(req.uid);
    const me = await mine(req.uid);
    const [pool, liked, st, sent] = await Promise.all([poolFor(me, req.uid), likedMe(req.uid), col('mmState').doc(req.uid).get(), sentTo(req.uid)]);
    const declined = new Set((st.exists && st.data().declined) || []);
    const list = pool.filter(c => !declined.has(c.uid) && !sent.has(c.uid) && theyFitMe(me, c) && iFitThem(me, c) && (!NEED_VERIFIED || c.verified))
      .sort((a, b) => (liked.has(b.uid) ? 1 : 0) - (liked.has(a.uid) ? 1 : 0));
    res.json({ cand: list[0] ? { ...pub(list[0]), likedYou: liked.has(list[0].uid) } : null, left: Math.max(0, list.length - 1) });
  }));

  app.post('/mm/decline', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmdec', 60, 60000);
    const to = str(req.body && req.body.to, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(to)) throw httpErr(400, 'Bad id');
    await col('mmState').doc(req.uid).set({ declined: FV().arrayUnion(to) }, { merge: true });
    await col('mmInterest').doc(`${to}_${req.uid}`).delete().catch(() => {});
    res.json({ ok: true });
  }));

  app.post('/mm/browse', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmbr', 30, 60000);
    await needSub(req.uid);
    const me = await mine(req.uid);
    const [pool, liked, sent] = await Promise.all([poolFor(me, req.uid), likedMe(req.uid), sentTo(req.uid)]);
    const list = pool.filter(c => c.managed || !NEED_VERIFIED || c.verified).map(c => ({ ...pub(c), fit: fitScore(me, c), likedYou: liked.has(c.uid), interested: sent.has(c.uid) }))
      .sort((a, b) => (b.likedYou - a.likedYou) || (b.fit - a.fit)).slice(0, 40);
    res.json({ list });
  }));

  app.post('/mm/interest', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmint', 40, 3600000);
    await needSub(req.uid); await mine(req.uid);
    const to = str(req.body && req.body.to, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(to) || to === req.uid) throw httpErr(400, 'Bad id');
    const [tp, bl] = await Promise.all([col('mmProfiles').doc(to).get(), blockedSet(req.uid)]);
    if (!tp.exists || !inPool(tp.data()) || bl.has(to)) throw httpErr(404, 'This member is not available.');
    if (tp.data().managed) {      // a matchmaker-posted profile has no account: the interest goes to the admin as a lead
      const lref = col('mmLeads').doc(`${req.uid}_${to}`);
      if (!(await lref.get()).exists) await lref.set({ from: req.uid, to, status: 'open', at: FV().serverTimestamp() });      // a repeat tap never resets the stage
      return res.json({ matched: false, managed: true });
    }
    const mid = [req.uid, to].sort().join('_'), mref = col('mmMatches').doc(mid);
    let out = { matched: false };
    await fsdb().runTransaction(async t => {
      const [m, rev] = await Promise.all([t.get(mref), t.get(col('mmInterest').doc(`${to}_${req.uid}`))]);
      if (m.exists) { if (m.data().closed) throw httpErr(409, 'This match was closed.'); out = { matched: true, matchId: mid }; return; }
      if (rev.exists) {
        t.set(mref, { users: [req.uid, to].sort(), createdAt: FV().serverTimestamp(), consent: {}, counts: { [req.uid]: 0, [to]: 0 }, closed: false });
        t.delete(rev.ref); out = { matched: true, matchId: mid };
      } else t.set(col('mmInterest').doc(`${req.uid}_${to}`), { from: req.uid, to, at: FV().serverTimestamp() });
    });
    res.json(out);
  }));

  app.post('/mm/claim', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmclaim', 5, 3600000);
    const code = str(req.body && req.body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) throw httpErr(400, 'Enter the code the matchmaker sent you.');
    if (req.body.pledge !== true) throw httpErr(400, 'You must accept the serious-intent pledge.');
    const phone = str(req.body.phone, 24), digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) throw httpErr(400, 'Enter your phone / WhatsApp number. It stays hidden until you accept someone.');
    const [cs, us, mp] = await Promise.all([col('mmClaims').doc(code).get(), fsdb().collection('users').doc(req.uid).get(), col('mmProfiles').doc(req.uid).get()]);
    const bad404 = () => httpErr(404, 'That code is not valid. Ask the matchmaker for a new one.');
    if (!cs.exists || cs.data().used || cs.data().expiresAt < Date.now()) throw bad404();
    if (mp.exists && mp.data().pledgeV === PLEDGE_V) throw httpErr(409, 'You already have a matchmaking profile.');
    const pid = cs.data().profileId, ps = await col('mmProfiles').doc(pid).get();
    if (!ps.exists || !ps.data().managed || ps.data().linkedUid) throw bad404();
    const u = us.exists ? us.data() : {}, p = ps.data();
    if (u.gender !== p.gender) throw httpErr(409, 'The gender on your Heart Link profile does not match the listing. Ask the matchmaker.');
    await fsdb().runTransaction(async t => {
      const c = await t.get(cs.ref); if (!c.exists || c.data().used) throw httpErr(409, 'This code was already used.');
      t.update(cs.ref, { used: true, usedBy: req.uid });
      t.set(col('mmProfiles').doc(req.uid), { uid: req.uid, name: str(u.name, 60) || p.name, gender: p.gender, age: p.age, city: p.city, religion: p.religion, job: p.job, bio: p.bio, qualities: p.qualities, intent: p.intent,
        phone, prefMinAge: p.prefMinAge, prefMaxAge: p.prefMaxAge, prefCity: p.prefCity, prefReligion: p.prefReligion, photo: photoOf(u) || p.photo, verified: !!u.verified, pledgeV: PLEDGE_V,
        pledgedAt: FV().serverTimestamp(), subscribed: true, claimedFrom: pid, updatedAt: FV().serverTimestamp() }, { merge: true });
      t.set(ps.ref, { active: false, linkedUid: req.uid, claimCode: FV().delete() }, { merge: true });
      t.set(col('mmSubs').doc(req.uid), { active: true, provider: 'matchmaker', paidAt: FV().serverTimestamp() }, { merge: true });
    });
    // members who were waiting on the old listing: already-approved ones become a match, the rest become ordinary interest she can accept in the app
    try {
      const ls = await col('mmLeads').where('to', '==', pid).get();
      for (const x of ls.docs) {
        const l = x.data(); if (!['open', 'forwarded', 'approved'].includes(l.status)) continue;
        if (l.status === 'approved') {
          const mr = col('mmMatches').doc([l.from, req.uid].sort().join('_'));
          if (!(await mr.get()).exists) await mr.set({ users: [l.from, req.uid].sort(), createdAt: FV().serverTimestamp(), consent: {}, counts: { [l.from]: 0, [req.uid]: 0 }, closed: false });
        } else await col('mmInterest').doc(`${l.from}_${req.uid}`).set({ from: l.from, to: req.uid, at: FV().serverTimestamp() });
        await x.ref.set({ status: 'closed', movedTo: req.uid }, { merge: true });
      }
    } catch (e) { console.error('claim: moving interest failed', e.message); }
    accCache.delete(req.uid);
    res.json({ ok: true });
  }));

  // introductions the member asked for with matchmaker-posted profiles. The number appears only after the admin sets "released".
  app.post('/mm/intros', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmin', 60, 60000);
    const s = await col('mmLeads').where('from', '==', req.uid).get();
    const rows = s.docs.filter(x => x.data().status !== 'closed');
    const ps = await Promise.all(rows.map(x => col('mmProfiles').doc(x.data().to).get()));
    const list = rows.map((x, i) => { const l = x.data(), p = ps[i].exists ? pub(ps[i].data()) : { name: 'Member', photo: '' };
      return { id: x.id, with: { name: p.name, photo: p.photo, age: p.age, city: p.city }, status: l.status, phone: l.status === 'released' ? l.releasedPhone || '' : '', at: ms(l.at) }; }).sort((a, b) => b.at - a.at);
    res.json({ list });
  }));

  // ---------- matches and chat ----------
  async function myMatch(uid, id) {
    if (!/^[A-Za-z0-9_-]{3,140}$/.test(id || '')) throw httpErr(400, 'Bad match');
    const ref = col('mmMatches').doc(id), s = await ref.get();
    if (!s.exists || !s.data().users.includes(uid)) throw httpErr(404, 'Match not found');
    return { ref, m: s.data(), other: s.data().users.find(x => x !== uid) };
  }

  app.post('/mm/matches', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmms', 60, 60000);
    await needSub(req.uid);
    const s = await col('mmMatches').where('users', 'array-contains', req.uid).get();
    const rows = s.docs.filter(x => !x.data().closed);
    const ps = await Promise.all(rows.map(x => col('mmProfiles').doc(x.data().users.find(u => u !== req.uid)).get()));
    const list = rows.map((x, i) => { const m = x.data(), p = ps[i].exists ? pub(ps[i].data()) : { uid: '', name: 'Member' };
      return { id: x.id, with: p, last: m.last || '', lastAt: ms(m.lastAt) || ms(m.createdAt), revealed: !!(m.consent && m.consent[m.users[0]] && m.consent[m.users[1]]) }; })
      .sort((a, b) => b.lastAt - a.lastAt);
    res.json({ list });
  }));

  app.post('/mm/chat', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmch', 90, 60000);
    await needSub(req.uid);
    const { ref, m, other } = await myMatch(req.uid, req.body && req.body.matchId);
    if (m.closed) throw httpErr(409, 'This match was closed.');
    const [ms_, op] = await Promise.all([ref.collection('msgs').orderBy('at', 'desc').limit(100).get(), col('mmProfiles').doc(other).get()]);
    const c = m.consent || {}, counts = m.counts || {}, both = !!(c[req.uid] && c[other]);
    const msgs = ms_.docs.reverse().map(x => ({ id: x.id, me: x.data().from === req.uid, text: x.data().text, at: ms(x.data().at) }));
    res.json({ with: op.exists ? pub(op.data()) : { name: 'Member' }, msgs, myConsent: !!c[req.uid], theirConsent: !!c[other],
      canConsent: (counts[req.uid] || 0) >= MIN_MSGS && (counts[other] || 0) >= MIN_MSGS, need: MIN_MSGS, mySent: counts[req.uid] || 0,
      phone: both && op.exists ? op.data().phone : '' });
  }));

  app.post('/mm/send', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmsend', 25, 60000);
    await needSub(req.uid);
    const { ref, m } = await myMatch(req.uid, req.body && req.body.matchId);
    if (m.closed) throw httpErr(409, 'This match was closed.');
    const text = str(req.body && req.body.text, 1000); if (!text) throw httpErr(400, 'Write a message');
    if (bad(text)) throw httpErr(400, 'Matchmaking is for serious relationships only. That message was not sent.');
    if (PHONE.test(text) || EMAIL.test(text)) throw httpErr(400, 'Phone numbers and emails cannot be typed in the chat. Use Accept and share my number once you both feel ready.');
    await ref.collection('msgs').add({ from: req.uid, text, at: FV().serverTimestamp() });
    await ref.update({ ['counts.' + req.uid]: FV().increment(1), last: text.slice(0, 80), lastAt: FV().serverTimestamp() });
    res.json({ ok: true });
  }));

  app.post('/mm/consent', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmcon', 20, 60000);
    await needSub(req.uid);
    const { ref, m, other } = await myMatch(req.uid, req.body && req.body.matchId);
    if (m.closed) throw httpErr(409, 'This match was closed.');
    const counts = m.counts || {};
    if ((counts[req.uid] || 0) < MIN_MSGS || (counts[other] || 0) < MIN_MSGS) throw httpErr(409, `Each of you must send at least ${MIN_MSGS} messages first.`);
    await ref.update({ ['consent.' + req.uid]: req.body.on !== false });
    res.json({ ok: true });
  }));

  app.post('/mm/leave', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmlv', 20, 60000);
    const { ref } = await myMatch(req.uid, req.body && req.body.matchId);
    await ref.update({ closed: true, closedBy: req.uid, closedAt: FV().serverTimestamp() });
    res.json({ ok: true });
  }));

  app.post('/mm/report', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mmrep', 10, 3600000);
    const { ref, other } = await myMatch(req.uid, req.body && req.body.matchId);
    const why = REPORT_WHY.includes(req.body.why) ? req.body.why : 'other';
    await col('mmReports').add({ by: req.uid, against: other, matchId: ref.id, why, details: str(req.body.details, 500), status: 'open', createdAt: FV().serverTimestamp() });
    await ref.update({ closed: true, closedBy: req.uid, closedAt: FV().serverTimestamp() });
    res.json({ ok: true });
  }));

  // ---------- admin ----------
  if (adminAuth) {
    app.get('/admin/mm/reports', adminAuth, wrap(async (req, res) => {
      const s = await col('mmReports').where('status', '==', 'open').limit(100).get();
      res.json({ reports: s.docs.map(x => ({ id: x.id, ...x.data(), createdAt: ms(x.data().createdAt) })) });
    }));
    // ----- matchmaker-posted profiles (real people who agreed to be listed) -----
    const mgd = async id => { if (!/^ad_[A-Za-z0-9]{6,40}$/.test(id || '')) throw httpErr(400, 'Bad id'); const s = await col('mmProfiles').doc(id).get(); if (!s.exists || !s.data().managed) throw httpErr(404, 'Profile not found'); return s.ref; };
    app.post('/admin/mm/profile', adminAuth, wrap(async (req, res) => {
      const b = req.body || {};
      if (b.consent !== true) throw httpErr(400, 'Tick the box: this person agreed to be listed and is 18 or older.');
      if (b.gender !== 'male' && b.gender !== 'female') throw httpErr(400, 'Choose Man or Woman.');
      const name = str(b.name, 60); if (!name) throw httpErr(400, 'Enter a name.');
      const age = Math.round(Number(b.age)); if (!(age >= 18 && age <= 90)) throw httpErr(400, 'Age must be 18 or more.');
      if (!RELIGIONS.includes(b.religion)) throw httpErr(400, 'Choose a religion.');
      if (!INTENTS.includes(b.intent)) throw httpErr(400, 'Choose what they are looking for.');
      const prefMinAge = Math.round(Number(b.prefMinAge)), prefMaxAge = Math.round(Number(b.prefMaxAge));
      if (!(prefMinAge >= 18 && prefMaxAge <= 90 && prefMinAge <= prefMaxAge)) throw httpErr(400, 'Check the partner age range.');
      const city = str(b.city, 60); if (!city) throw httpErr(400, 'Enter a city.');
      const photo = str(b.photo, 500);
      if (!photo.startsWith('https://res.cloudinary.com/')) throw httpErr(400, 'Add a photo of the person.');
      const job = str(b.job, 80), bio = str(b.bio, 300), qualities = str(b.qualities, 200);
      const ph = str(b.phone, 24).replace(/\D/g, ''); if (ph && (ph.length < 7 || ph.length > 15)) throw httpErr(400, 'Check the phone number to release.');
      if (bad(bio + ' ' + qualities + ' ' + job)) throw httpErr(400, 'Serious relationships only: remove casual or hookup wording.');
      if (PHONE.test(bio + ' ' + qualities) || EMAIL.test(bio + ' ' + qualities)) throw httpErr(400, 'No phone numbers or emails in the bio. Put them in the private contact box.');
      const id = b.id ? (await mgd(str(b.id, 60))).id : 'ad_' + crypto.randomBytes(8).toString('hex');
      await col('mmProfiles').doc(id).set({ uid: id, managed: true, active: b.active !== false, name, gender: b.gender, age, city, religion: b.religion, job, bio, qualities, intent: b.intent,
        prefMinAge, prefMaxAge, prefCity: str(b.prefCity, 60) || 'Any', prefReligion: b.prefReligion === 'Any' || RELIGIONS.includes(b.prefReligion) ? b.prefReligion : 'Any',
        photo, verified: false, pledgeV: PLEDGE_V, subscribed: true, revoked: false,
        contact: str(b.contact, 300), phone: str(b.phone, 24), consentAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() }, { merge: true });
      res.json({ ok: true, id });
    }));
    app.get('/admin/mm/profiles', adminAuth, wrap(async (req, res) => {
      const s = await col('mmProfiles').where('managed', '==', true).limit(300).get();
      res.json({ profiles: s.docs.map(x => ({ ...x.data(), id: x.id, consentAt: ms(x.data().consentAt), updatedAt: ms(x.data().updatedAt) })) });
    }));
    app.post('/admin/mm/profile/toggle', adminAuth, wrap(async (req, res) => { const r = await mgd(str(req.body && req.body.id, 60)); await r.set({ active: req.body.active === true }, { merge: true }); res.json({ ok: true }); }));
    app.post('/admin/mm/profile/delete', adminAuth, wrap(async (req, res) => { const r = await mgd(str(req.body && req.body.id, 60)); await r.delete(); res.json({ ok: true }); }));
    // A person we listed joins Heart Link later: the admin makes a claim code, they enter it in the Match tab and the listing moves to their own account.
    const CC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    app.post('/admin/mm/profile/claimcode', adminAuth, wrap(async (req, res) => {
      const r = await mgd(str(req.body && req.body.id, 60)), d0 = (await r.get()).data();
      if (d0.linkedUid) throw httpErr(409, 'This listing is already linked to an account.');
      if (d0.claimCode) await col('mmClaims').doc(d0.claimCode).delete().catch(() => {});
      const code = Array.from(crypto.randomBytes(8), x => CC[x % CC.length]).join('');
      await col('mmClaims').doc(code).set({ profileId: r.id, createdAt: FV().serverTimestamp(), expiresAt: Date.now() + 30 * 86400000, used: false });
      await r.set({ claimCode: code }, { merge: true });
      res.json({ code });
    }));
    // Introductions. status: open (new) -> forwarded (sent to the person for approval) -> approved or declined -> released (the member sees the contact) | closed
    const NEXT = { open: ['forwarded', 'declined', 'closed'], forwarded: ['approved', 'declined', 'closed'], approved: ['released', 'closed'], released: ['closed'], declined: ['closed'] };
    app.get('/admin/mm/leads', adminAuth, wrap(async (req, res) => {
      const s = await col('mmLeads').where('status', 'in', ['open', 'forwarded', 'approved']).limit(100).get();
      const rows = await Promise.all(s.docs.map(async x => { const l = x.data(); const [m, p] = await Promise.all([col('mmProfiles').doc(l.from).get(), col('mmProfiles').doc(l.to).get()]);
        const md = m.exists ? m.data() : {}, pd = p.exists ? p.data() : {};
        return { id: x.id, status: l.status, at: ms(l.at), member: { uid: l.from, name: md.name || '', phone: md.phone || '', age: md.age || '', city: md.city || '', religion: md.religion || '', job: md.job || '', bio: md.bio || '', qualities: md.qualities || '', intent: md.intent || '', photo: md.photo || '' },
          profile: { id: l.to, name: pd.name || '', contact: pd.contact || '', phone: pd.phone || '' } }; }));
      res.json({ leads: rows.sort((a, b) => b.at - a.at) });
    }));
    app.post('/admin/mm/lead/status', adminAuth, wrap(async (req, res) => {
      const id = str(req.body && req.body.id, 140), to = str(req.body && req.body.status, 20);
      if (!/^[A-Za-z0-9_-]{3,140}$/.test(id)) throw httpErr(400, 'Bad id');
      const ref = col('mmLeads').doc(id), s = await ref.get(); if (!s.exists) throw httpErr(404, 'Not found');
      const l = s.data(); if (!(NEXT[l.status] || []).includes(to)) throw httpErr(409, `Cannot go from "${l.status}" to "${to}".`);
      const upd = { status: to, updatedAt: FV().serverTimestamp() };
      if (to === 'released') {      // the person approved: now (and only now) their number is shown to the member
        const p = await col('mmProfiles').doc(l.to).get(); const ph = p.exists ? str(p.data().phone, 24) : '';
        if (!ph) throw httpErr(400, 'Add the phone / WhatsApp number to release on that profile first (Edit the profile).');
        upd.releasedPhone = ph; upd.releasedAt = FV().serverTimestamp();
      }
      await ref.set(upd, { merge: true });
      res.json({ ok: true });
    }));
    // Gives one account free access (e.g. a tester). Body: { uid } or { email }.
    app.post('/admin/mm/grant', adminAuth, wrap(async (req, res) => {
      let uid = str(req.body && req.body.uid, 64);
      if (!uid && req.body && req.body.email) { const r = await admin.auth().getUserByEmail(str(req.body.email, 120)).catch(() => null); uid = r ? r.uid : ''; }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw httpErr(404, 'User not found');
      await col('mmSubs').doc(uid).set({ active: true, provider: 'admin', paidAt: FV().serverTimestamp(), revokedAt: FV().delete() }, { merge: true });
      await col('mmProfiles').doc(uid).set({ subscribed: true, revoked: false }, { merge: true }).catch(() => {}); accCache.delete(uid);
      res.json({ ok: true, uid });
    }));
    // No refund. Removes them from every match pool and blocks the chat and browse.
    app.post('/admin/mm/revoke', adminAuth, wrap(async (req, res) => {
      const uid = str(req.body && req.body.uid, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw httpErr(400, 'Bad uid');
      await col('mmSubs').doc(uid).set({ active: false, revokedAt: FV().serverTimestamp(), reason: str(req.body.reason, 200) }, { merge: true });
      await col('mmProfiles').doc(uid).set({ subscribed: false, revoked: true }, { merge: true }); accCache.delete(uid);
      if (req.body.reportId) await col('mmReports').doc(str(req.body.reportId, 64)).set({ status: 'actioned' }, { merge: true });
      res.json({ ok: true });
    }));
  }
  return {};
};