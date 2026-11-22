// Heart Link API  (Node 18+)
const express = require('express');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const { RtcTokenBuilder, RtcRole } = require('agora-token');

/* ---------- config ---------- */
// Needed for the Firestore web app (calls, account deletion, media clean-up):
const REQUIRED = ['FIREBASE_SERVICE_ACCOUNT', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', ')); process.exit(1); }
// Only for the optional Postgres side; the endpoints that use it fail until it is set.
['DATABASE_URL', 'PLAY_SERVICE_ACCOUNT', 'PLAY_PACKAGE_NAME', 'ANDROID_SHA256', 'FIREBASE_DATABASE_URL', 'AGORA_APP_ID', 'AGORA_APP_CERTIFICATE']
  .filter(k => !process.env[k]).forEach(k => console.warn('Optional env var not set:', k));

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// Prices are in USD (the app's one currency). `ngn` is the OLD naira price, kept only so a payment started before this
// change still credits; new checkouts are always charged in USD.
// `bonus` = extra free tokens credited with the pack (the buyer gets tokens + bonus). Change it here; the app picks it up from /payout/config.
// const PACKS = { starter: { tokens: 50, bonus: 0, ...      // superseded: Starter now carries a small bonus (about 1.8 cents a coin; the cheapest rate stays on Mega, which sets the margin)
const PACKS = { starter: { tokens: 50, bonus: 5, usd: 0.99, ngn: 1500 }, popular: { tokens: 150, bonus: 15, usd: 2.99, ngn: 4000 }, mega: { tokens: 500, bonus: 100, usd: 8.99, ngn: 12000 } };
const CREATOR_SHARE = 0.8;
const app = express();

/* ---------- CORS (the web app runs on a different origin) ---------- */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- helpers ---------- */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/; // keeps client-supplied ids out of RTDB path tricks

async function withTx(fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

try { app.use(require('compression')()); } catch (e) { console.warn('compression not installed (run: npm i compression)'); }   // index.html is ~870 KB; gzip makes it ~5x smaller
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.send('ok'));

/* ---------- the web app itself: one Render Web Service serves both the app and this API ----------
   Only the ./public folder is served (index.html + firebase-messaging-sw.js); server code and secrets are never exposed. */
/* ---------- Android app (Play Store) support ---------- */
// Web app manifest: lets the site be packaged as an Android app. Put icon-192.png and icon-512.png (square PNGs) in ./public.
app.get('/manifest.webmanifest', (req, res) => {
  const name = process.env.APP_NAME || 'Heart Link';
  res.type('application/manifest+json').json({
    name, short_name: name.slice(0, 12), start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#ffffff', theme_color: '#fce7f3',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});
// Digital Asset Links: proves the Android app and this website belong together. Needs PLAY_PACKAGE_NAME and ANDROID_SHA256
// (one or more SHA-256 fingerprints separated by commas: the Play App Signing key from Play Console, plus your upload key).
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.PLAY_PACKAGE_NAME, fps = String(process.env.ANDROID_SHA256 || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!pkg || !fps.length) return res.status(404).json([]);
  res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]);
});

// Legal pages + the Missions script must always be reachable (the app links to them). If they were not uploaded into public/, fall back to the server folder.
const _fsNode = require('fs');
const STATIC_FALLBACK = ['privacy.html', 'terms.html', 'child-safety.html', 'delete-account.html', 'missions.js'];
app.get('/:file', (req, res, next) => {
  const f = req.params.file; if (!STATIC_FALLBACK.includes(f)) return next();
  const p = [path.join(__dirname, 'public', f), path.join(__dirname, f)].find(x => _fsNode.existsSync(x));
  if (!p) return next();
  if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(p);
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (/\.(html)$|firebase-messaging-sw\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },   // updates reach people (and the service worker) straight away
}));

/* ---------- auth ---------- */
async function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const decoded = await admin.auth().verifyIdToken(t);
    const uid = decoded.uid;
    const r = await db.query('SELECT * FROM users WHERE firebase_uid=$1', [uid]);
    req.uid = uid;
    req.token = decoded;
    req.user = r.rows[0] || null; // null until /register is called
    if (req.user) db.query(`UPDATE users SET last_seen=now() WHERE id=$1 AND last_seen < now() - interval '1 minute'`, [req.user.id]).catch(() => {});
    next();
  } catch { res.sendStatus(401); }
}
const needUser = (req, res, next) => req.user ? next() : res.status(403).json({ error: 'REGISTER_FIRST' });

/* ---------- 1. Register with full location + free promo tokens ---------- */
app.post('/register', auth, wrap(async (req, res) => {
  if (req.user) throw httpErr(409, 'ALREADY_REGISTERED');
  const b = req.body || {};
  const age = Number(b.age), lat = Number(b.lat), lng = Number(b.lng);
  if (!b.name || !Number.isInteger(age) || age < 18) throw httpErr(400, 'Name and an age of 18+ are required');
  if (!['male', 'female', 'other'].includes(b.gender)) throw httpErr(400, 'Invalid gender');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw httpErr(400, 'Invalid location');

  const id = await withTx(async c => {
    const u = await c.query(
      `INSERT INTO users (firebase_uid,name,age,gender,occupation,bio,relationship_goal,
        country,state,city,neighborhood,location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,ST_SetSRID(ST_MakePoint($12,$13),4326)::geography)
       RETURNING id`,
      [req.uid, String(b.name).trim(), age, b.gender, b.occupation, b.bio, b.relationshipGoal,
       b.country, b.state, b.city, b.neighborhood, lng, lat]);
    const uid = u.rows[0].id;
    await c.query('INSERT INTO wallets (user_id) VALUES ($1)', [uid]); // default 120 tokens
    await c.query(`INSERT INTO transactions (user_id,type,tokens,ref) VALUES ($1,'promo',120,$2)`, [uid, `promo:${uid}`]);
    return uid;
  });
  res.json({ id });
}));

/* ---------- 2 & 4. Nearby + swipe deck (excludes already-swiped) ---------- */
app.get('/discover', auth, needUser, wrap(async (req, res) => {
  const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 50, 1), 500);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const gender = ['male', 'female', 'other'].includes(req.query.gender) ? req.query.gender : 'all';
  const r = await db.query(
    `SELECT u.id,u.name,u.age,u.city,u.state,u.neighborhood,u.bio,u.occupation,
            ROUND(ST_Distance(u.location, me.location)/1000)::int AS km,
            (u.last_seen > now() - interval '5 minutes') AS online,
            COALESCE(json_agg(json_build_object('id',m.id,'kind',m.kind,'url',m.url) ORDER BY m.position, m.created_at)
              FILTER (WHERE m.id IS NOT NULL),'[]') AS media
     FROM users u JOIN users me ON me.id=$1
     LEFT JOIN media m ON m.user_id=u.id
     WHERE u.id<>me.id
       AND ST_DWithin(u.location, me.location, $2::float8*1000)
       AND ($3::text='all' OR u.gender=$3::text)
       AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id=me.id AND s.target_id=u.id)
     GROUP BY u.id, me.location ORDER BY u.location <-> me.location LIMIT $4`,
    [req.user.id, radiusKm, gender, limit]);
  res.json(r.rows);
}));

app.post('/swipe', auth, needUser, wrap(async (req, res) => {
  const { targetId, action } = req.body || {};
  if (!['like', 'pass'].includes(action)) throw httpErr(400, 'Invalid action');
  if (!targetId || targetId === req.user.id) throw httpErr(400, 'Invalid target');

  await db.query(
    `INSERT INTO swipes (swiper_id,target_id,action) VALUES ($1,$2,$3)
     ON CONFLICT (swiper_id,target_id) DO UPDATE SET action=EXCLUDED.action, created_at=now()`,
    [req.user.id, targetId, action]);

  let matched = false;
  if (action === 'like') {
    const m = await db.query(`SELECT 1 FROM swipes WHERE swiper_id=$1 AND target_id=$2 AND action='like'`, [targetId, req.user.id]);
    if (m.rowCount) {
      await db.query(
        `INSERT INTO matches (user_a,user_b) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid))
         ON CONFLICT DO NOTHING`, [req.user.id, targetId]);
      matched = true;
    }
  }
  res.json({ matched });
}));

/* ---------- 3. Cloudinary signed direct upload, then register/delete assets ---------- */
app.get('/media/signature', auth, needUser, (req, res) => {
  const timestamp = Math.round(Date.now() / 1000), folder = `flc/${req.user.id}`;
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, folder, signature, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
});

app.post('/media', auth, needUser, wrap(async (req, res) => {
  const { kind, url, publicId } = req.body || {};
  if (!['photo', 'video'].includes(kind)) throw httpErr(400, 'Invalid kind');
  if (typeof publicId !== 'string' || !publicId.startsWith(`flc/${req.user.id}/`)) throw httpErr(400, 'Invalid publicId');
  if (typeof url !== 'string' || !url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`)) throw httpErr(400, 'Invalid url');
  const count = (await db.query('SELECT count(*)::int AS n FROM media WHERE user_id=$1', [req.user.id])).rows[0].n;
  if (count >= 12) throw httpErr(400, 'Media limit reached (12)');
  const r = await db.query(
    `INSERT INTO media (user_id,kind,url,cloudinary_public_id,position) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.user.id, kind, url, publicId, count]);
  res.status(201).json({ id: r.rows[0].id });
}));

app.delete('/media/:id', auth, needUser, wrap(async (req, res) => {
  const r = await db.query('DELETE FROM media WHERE id=$1 AND user_id=$2 RETURNING cloudinary_public_id, kind', [req.params.id, req.user.id]);
  if (r.rowCount) {
    await cloudinary.uploader.destroy(r.rows[0].cloudinary_public_id, { resource_type: r.rows[0].kind === 'video' ? 'video' : 'image' }).catch(e => console.warn('cloudinary destroy failed', e.message));
  }
  res.sendStatus(204);
}));

/* ---------- 5. Wallet: atomic spend / idempotent credit ---------- */
async function spend(c, userId, tokens, type, meta) {
  const r = await c.query('UPDATE wallets SET tokens=tokens-$2 WHERE user_id=$1 AND tokens>=$2 RETURNING tokens', [userId, tokens]);
  if (!r.rowCount) throw httpErr(402, 'INSUFFICIENT_TOKENS');
  await c.query('INSERT INTO transactions (user_id,type,tokens,meta) VALUES ($1,$2,$3,$4)', [userId, type, -tokens, meta]);
  return r.rows[0].tokens;
}

app.post('/wallet/balance', auth, needUser, wrap(async (req, res) => {
  const r = await db.query('SELECT tokens, creator_balance FROM wallets WHERE user_id=$1', [req.user.id]);
  res.json(r.rows[0]);
}));

app.post('/wallet/call-charge', auth, needUser, wrap(async (req, res) => {
  const minutes = Number(req.body && req.body.minutes), callId = String((req.body && req.body.callId) || '');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw httpErr(400, 'Invalid minutes');
  const tokens = await withTx(c => spend(c, req.user.id, minutes * 10, 'call', { callId }));
  res.json({ tokens }); // 402 => client opens checkout
}));

/* ---------- 6 & 7. Gifts / tips: debit sender, credit creator (80/20), push animation event via RTDB ---------- */
async function sendValue({ from, toUserId, cost, spendType, receiveType, meta, context }) {
  if (!context || !['chat', 'room'].includes(context.type) || !SAFE_ID.test(String(context.id || ''))) throw httpErr(400, 'Invalid context');
  if (!toUserId || toUserId === from.id) throw httpErr(400, 'Invalid recipient');
  const payout = Math.floor(cost * CREATOR_SHARE);
  await withTx(async c => {
    await spend(c, from.id, cost, spendType, { ...meta, toUserId, context });
    const w = await c.query('UPDATE wallets SET creator_balance=creator_balance+$2 WHERE user_id=$1', [toUserId, payout]);
    if (!w.rowCount) throw httpErr(404, 'Recipient not found');
    await c.query('INSERT INTO transactions (user_id,type,tokens,meta) VALUES ($1,$2,$3,$4)', [toUserId, receiveType, payout, { ...meta, from: from.id }]);
  });
  // Money is already committed; a failed animation push must not fail the request.
  const path = context.type === 'room' ? `rooms/${context.id}/events` : `chats/${context.id}/events`;
  await admin.database().ref(path).push({ kind: spendType === 'tip' ? 'tip' : 'gift', ...meta.event, from: from.name, ts: Date.now() }).catch(e => console.warn('RTDB push failed', e.message));
}

app.post('/gifts/send', auth, needUser, wrap(async (req, res) => {
  const { giftId, toUserId, context } = req.body || {};
  const g = (await db.query('SELECT * FROM gifts WHERE id=$1', [Number(giftId) || 0])).rows[0];
  if (!g) throw httpErr(404, 'Gift not found');
  await sendValue({ from: req.user, toUserId, cost: g.token_cost, spendType: 'gift_sent', receiveType: 'gift_received',
    meta: { giftId: g.id, event: { name: g.name, emoji: g.emoji } }, context });
  res.json({ ok: true });
}));

app.post('/gifts/tip', auth, needUser, wrap(async (req, res) => {
  const { toUserId, tokens, context } = req.body || {};
  const cost = Number(tokens);
  if (!Number.isInteger(cost) || cost < 1 || cost > 10000) throw httpErr(400, 'Invalid amount');
  await sendValue({ from: req.user, toUserId, cost, spendType: 'tip', receiveType: 'tip_received',
    meta: { event: { name: 'a tip', emoji: '🪙' } }, context });
  res.json({ ok: true });
}));


/* ---------- Cloudinary clean-up + account deletion (used by the Firestore web app) ---------- */
const fsdb = () => admin.firestore();

async function destroyAsset(publicId, kind) {
  if (!publicId || typeof publicId !== 'string') return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: kind === 'video' ? 'video' : 'image', invalidate: true });
  } catch (e) { console.warn('cloudinary destroy failed', publicId, e.message); }
}

async function deleteRefs(refs) {
  if (!refs.length) return;
  const w = fsdb().bulkWriter();
  refs.forEach(r => w.delete(r));
  await w.close();
}

// Remove ONE gallery item: checks it really belongs to the caller (via their Firestore profile),
// deletes the file from Cloudinary, then drops it from the profile.
app.post('/media/remove', auth, wrap(async (req, res) => {
  const publicId = req.body && req.body.publicId;
  if (typeof publicId !== 'string' || !publicId || publicId.length > 300) throw httpErr(400, 'Invalid publicId');
  const ref = fsdb().collection('users').doc(req.uid);
  let item = null;
  await fsdb().runTransaction(async t => {
    const snap = await t.get(ref);
    const media = (snap.exists && snap.data().media) || [];
    item = media.find(m => m && m.id === publicId);
    if (!item) throw httpErr(404, 'Media not found');
    t.update(ref, { media: media.filter(m => m !== item && !(m && m.id === publicId)) });
  });
  await destroyAsset(item.id, item.kind);
  res.sendStatus(204);
}));

// Permanently delete the caller's account: Cloudinary files, Firestore data, Postgres rows, Firebase login.
// Requires a token minted within the last 5 minutes (the app re-authenticates with the password first).
app.delete('/account', auth, wrap(async (req, res) => {
  if (Date.now() / 1000 - (req.token.auth_time || 0) > 300) throw httpErr(401, 'REAUTH_REQUIRED');
  const uid = req.uid, f = fsdb();

  // 1. gather every Cloudinary asset we know about
  const assets = new Map(), privateAssets = [];
  const userSnap = await f.collection('users').doc(uid).get();
  ((userSnap.exists && userSnap.data().media) || []).forEach(m => m && m.id && assets.set(m.id, m.kind));
  if (req.user) {
    const pg = await db.query('SELECT cloudinary_public_id, kind FROM media WHERE user_id=$1', [req.user.id]);
    pg.rows.forEach(m => assets.set(m.cloudinary_public_id, m.kind));
  }

  // 2. Firestore: chats (+ messages), calls (+ candidates), hosted rooms, swipes, blocks, profile
  const matches = await f.collection('matches').where('members', 'array-contains', uid).get();
  for (const d of matches.docs) {
    // voice notes live in Cloudinary: remove the audio of the whole chat (both people's) before the messages go
    const vs = await d.ref.collection('messages').where('type', '==', 'voice').get().catch(() => null);
    if (vs) await Promise.all(vs.docs.map(v => destroyVoice(v.data().publicId)));
    // photos and videos too: normal ones keep their publicId in the message, view-once ones in chatMediaPrivate
    const ms = await d.ref.collection('messages').where('type', '==', 'media').get().catch(() => null);
    if (ms) await Promise.all(ms.docs.map(async v => { const x = v.data(); if (!x.once) return destroyChatMedia(x.publicId, x.kind, false); }));
    const pm = await f.collection('chatMediaPrivate').where('matchId', '==', d.id).get().catch(() => null);
    if (pm) { await Promise.all(pm.docs.map(v => destroyChatMedia(v.data().publicId, v.data().kind, true))); await deleteRefs(pm.docs.map(v => v.ref)); }
    await f.recursiveDelete(d.ref);
  }
  for (const field of ['from', 'to']) {
    const calls = await f.collection('calls').where(field, '==', uid).get();
    for (const d of calls.docs) await f.recursiveDelete(d.ref);
    await deleteRefs((await f.collection('swipes').where(field, '==', uid).get()).docs.map(d => d.ref));
  }
  for (const field of ['to', 'from']) await deleteRefs((await f.collection('notifications').where(field, '==', uid).get()).docs.map(d => d.ref));
  await deleteRefs((await f.collection('pushTokens').where('uid', '==', uid).get()).docs.map(d => d.ref));
  const rooms = await f.collection('rooms').where('hostId', '==', uid).get();
  for (const d of rooms.docs) await f.recursiveDelete(d.ref);
  for (const field of ['by', 'blocked']) {
    await deleteRefs((await f.collection('blocks').where(field, '==', uid).get()).docs.map(d => d.ref));
  }
  // verification, abuse and leaderboard data. Withdrawal records are kept for the payout audit trail.
  const kp = await kycPrivRef(uid).get();
  if (kp.exists) [kp.data().idPhoto, kp.data().selfie].forEach(x => x && x.id && privateAssets.push(x.id));
  await Promise.all([kycPrivRef(uid).delete(), kycRef(uid).delete(), abuseRef(uid).delete(), lbRef('all', uid).delete(), lbRef(weekKey(), uid).delete()].map(p => p.catch(() => {})));
  const devs = await f.collection('devices').where('uids', 'array-contains', uid).limit(50).get();
  await Promise.all(devs.docs.map(d => d.ref.update({ uids: FV().arrayRemove(uid) }).catch(() => {})));
  // follows, both directions; the other people's counters are fixed too
  for (const [field, other, counter] of [['from', 'to', 'followers'], ['to', 'from', 'following']]) {
    const fl = await f.collection('follows').where(field, '==', uid).get();
    for (const d of fl.docs) {
      await f.collection('users').doc(d.data()[other]).update({ [counter]: FV().increment(-1) }).catch(() => {});
      await d.ref.delete().catch(() => {});
    }
  }
  await f.collection('users').doc(uid).delete();

  // 3. Postgres (only if this uid was ever registered through /register). Adjust to your FK rules.
  if (req.user) {
    try {
      await withTx(async c => {
        await c.query('DELETE FROM media WHERE user_id=$1', [req.user.id]);
        await c.query('DELETE FROM swipes WHERE swiper_id=$1 OR target_id=$1', [req.user.id]);
        await c.query('DELETE FROM matches WHERE user_a=$1 OR user_b=$1', [req.user.id]);
        await c.query('DELETE FROM users WHERE id=$1', [req.user.id]); // wallets/transactions must cascade or be removed first
      });
    } catch (e) { console.error('Postgres clean-up failed for', req.user.id, e.message); }
  }

  // 4. Cloudinary files, then the Firebase login itself
  await Promise.all([...assets].map(([id, kind]) => destroyAsset(id, kind)));
  await Promise.all(privateAssets.map(id => cloudinary.uploader.destroy(id, { type: 'private', resource_type: 'image', invalidate: true }).catch(e => console.warn('kyc file destroy failed', e.message))));
  await admin.auth().deleteUser(uid).catch(e => { if (e.code !== 'auth/user-not-found') throw e; });
  res.sendStatus(204);
}));


/* ---------- Voice / video calls: Agora tokens + server-side billing (Firestore is the source of truth) ---------- */
const CALL_COST = 10;                 // tokens per minute, paid by the caller
const CALL_TTL = 3600;                // Agora token lifetime in seconds
const RING_MS = 60000;                // an unanswered call can no longer be accepted after this
const FV = () => admin.firestore.FieldValue;
// Only when CALL_EARNINGS=true: the person who answers a call earns CREATOR_SHARE of every minute the caller pays for (same 80/20 split as gifts).
// Unset = off: the caller still pays per minute, but nobody is paid for answering a call. Only gifts and tips become creator earnings.
// Kept off for the Google Play review so calls cannot be read as paid companionship.
// Call inside a transaction AFTER all reads. `rs` is the receiver's user snapshot (skipped if the account is gone).
function payCallReceiver(t, rs, c, callId) {
  return;      // replaced by billCallMinute (economy section): tier split, promo minutes, commissions
  if (process.env.CALL_EARNINGS !== 'true') return;
  const share = Math.floor(CALL_COST * CREATOR_SHARE);
  if (!rs || !rs.exists || share < 1) return;
  t.update(rs.ref, { creatorBalance: FV().increment(share) });
  t.set(rs.ref.collection('earnings').doc(), { type: 'call', label: c.kind === 'video' ? 'Video call' : 'Voice call', emoji: c.kind === 'video' ? '🎥' : '📞',
    tokens: share, from: c.from, fromName: c.fromName || '', callId, releaseAt: c.suspect ? suspectReleaseAt() : releaseAt(), ...(c.suspect ? { suspect: true } : {}), createdAt: FV().serverTimestamp() });
}
const callRef = id => { if (!SAFE_ID.test(String(id))) throw httpErr(400, 'Invalid call id'); return fsdb().collection('calls').doc(id); };

// Accounts that can test gifts and tips for free (review/QA). Comma-separated emails; override with the TEST_ADMIN_EMAILS env var.
const TEST_ADMIN_EMAILS = (process.env.TEST_ADMIN_EMAILS || 'heartlink43+review@gmail.com,heartlink43@gmail.com').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
// Same token check as `auth`, but without the Postgres lookup (the web app's users live in Firestore).
async function fbAuth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const decoded = await admin.auth().verifyIdToken(t);
    req.uid = decoded.uid; req.phone = decoded.phone_number || '';
    // Review/test admin: matched on the email inside the signed login token (it cannot be faked from the app).
    req.isTestAdmin = TEST_ADMIN_EMAILS.includes(String(decoded.email || '').toLowerCase());
    next();
  } catch { res.sendStatus(401); }
}

/* ---------- Moments: how many people have each post on screen right now (in memory, short-lived) ---------- */
const FEED_WATCH_TTL = 20000, feedWatch = new Map(), feedWatchMine = new Map();
const FEED_SRV_ID = Math.random().toString(36).slice(2, 6);   // changes on every restart; two phones showing different ids are talking to different servers   // postKey -> Map(uid -> last seen ms); uid -> Set(postKey)
app.post('/feed/watch', fbAuth, wrap(async (req, res) => {
  const now = Date.now();
  const keys = [...new Set((Array.isArray(req.body && req.body.keys) ? req.body.keys : []).map(k => String(k).slice(0, 120)))].slice(0, 12);
  for (const k of (feedWatchMine.get(req.uid) || [])) if (!keys.includes(k)) { const m = feedWatch.get(k); if (m) { m.delete(req.uid); if (!m.size) feedWatch.delete(k); } }
  if (keys.length) feedWatchMine.set(req.uid, new Set(keys)); else feedWatchMine.delete(req.uid);
  const counts = {};
  for (const k of keys) {
    let m = feedWatch.get(k); if (!m) feedWatch.set(k, m = new Map());
    m.set(req.uid, now);
    for (const [u, t] of m) if (now - t > FEED_WATCH_TTL) m.delete(u);
    counts[k] = m.size;
  }
  res.json({ counts, srv: FEED_SRV_ID });
}));
setInterval(() => {
  const now = Date.now();
  for (const [k, m] of feedWatch) { for (const [u, t] of m) if (now - t > FEED_WATCH_TTL) m.delete(u); if (!m.size) feedWatch.delete(k); }
  for (const [u, set] of feedWatchMine) if (![...set].some(k => feedWatch.has(k) && feedWatch.get(k).has(u))) feedWatchMine.delete(u);
}, 60000).unref();

function agoraCreds(channel, agoraUid) {
  const appId = process.env.AGORA_APP_ID, cert = process.env.AGORA_APP_CERTIFICATE;
  if (!appId || !cert) throw httpErr(503, 'Calls are not configured on the server');
  // agora-token takes durations in seconds, not absolute timestamps
  const token = RtcTokenBuilder.buildTokenWithUid(appId, cert, channel, agoraUid, RtcRole.PUBLISHER, CALL_TTL, CALL_TTL);
  return { appId, channel, token, uid: agoraUid };
}

// Starts a call: checks the chat, blocks and balance, creates calls/{id} (rings the other person's app).
app.post('/calls/start', fbAuth, wrap(async (req, res) => {
  const { matchId, kind } = req.body || {};
  if (!['voice', 'video'].includes(kind)) throw httpErr(400, 'Invalid call type');
  if (!SAFE_ID.test(String(matchId || ''))) throw httpErr(400, 'Invalid chat');
  const f = fsdb();
  const m = await f.collection('matches').doc(matchId).get();
  const members = (m.exists && m.data().members) || [];
  if (!members.includes(req.uid) || members.length !== 2) throw httpErr(403, 'Not your chat');
  const to = members.find(x => x !== req.uid);
  const [b1, b2] = await Promise.all([f.collection('blocks').doc(`${req.uid}_${to}`).get(), f.collection('blocks').doc(`${to}_${req.uid}`).get()]);
  if (b1.exists || b2.exists) throw httpErr(403, 'You cannot call this person');
  const me = await f.collection('users').doc(req.uid).get();
  if (!me.exists) throw httpErr(404, 'User not found');
  {   // who pays? A verified woman never does. A man's first minute can be a free promo minute (to a woman only). Everyone else needs Paid_Coins.
    const meNow = (await ensureLedger(req.uid, req.phone)) || me.data(), toD = (await f.collection('users').doc(to).get()).data() || {}, roles = callRoles(meNow, toD);
    if (roles && roles.payer === 'from' && !((meNow.promoCredits || 0) >= 1 && meNow.gender === 'male' && toD.gender === 'female') && (meNow.tokens || 0) < CALL_COST) throw httpErr(402, 'INSUFFICIENT_TOKENS');
  }

  const ref = f.collection('calls').doc();
  const channel = `call_${ref.id}`;
  const creds = agoraCreds(channel, 1);               // throws 503 before anything is written
  const sus = await suspectReason(req.uid, to);
  await ref.set({ from: req.uid, to, fromName: me.data().name || '', kind, matchId, channel, status: 'ringing', ...(sus ? { suspect: true } : {}), createdAt: FV().serverTimestamp() });
  // wake the other phone even when the app is closed (respects their muted "calls" alerts)
  pushToUser(to, { id: `incall_${ref.id}`, type: 'incall', from: req.uid, fromName: me.data().name || '', icon: photoOf(me.data()), text: kind, extra: { callId: ref.id, kind, ts: String(Date.now()) } })
    .catch(e => console.warn('incoming-call push failed', e.message));
  res.json({ callId: ref.id, ...creds });
}));

// Callee accepts: the caller is charged for the first minute here, then every minute via /tick.
app.post('/calls/:id/accept', fbAuth, wrap(async (req, res) => {
  const ref = callRef(req.params.id), f = fsdb();
  { const pre = await ref.get(); if (pre.exists) await Promise.all([ensureLedger(pre.data().from), ensureLedger(pre.data().to)]); }
  const call = await f.runTransaction(async t => {
    const cs = await t.get(ref); if (!cs.exists) throw httpErr(404, 'Call not found');
    const c = cs.data();
    if (c.to !== req.uid) throw httpErr(403, 'Not your call');
    if (c.status !== 'ringing') throw httpErr(409, 'Call is no longer ringing');
    if (Date.now() - (c.createdAt ? c.createdAt.toMillis() : 0) > RING_MS) { t.update(ref, { status: 'ended', endReason: 'missed', endedAt: FV().serverTimestamp() }); return { missed: true }; }
    const [us, rs] = await Promise.all([t.get(f.collection('users').doc(c.from)), t.get(f.collection('users').doc(c.to))]);
    const b = us.exists ? billCallMinute(t, ref, c, ref.id, us, rs) : { nofunds: true };
    if (b.nofunds) { t.update(ref, { status: 'ended', endReason: 'nofunds', endedAt: FV().serverTimestamp() }); return { nofunds: true }; }
    t.update(ref, { status: 'active', startedAt: FV().serverTimestamp(), paidUntil: Date.now() + 60000, fundedBy: b.source, payerSide: b.payer || null });
    return c;
  });
  if (call.missed) throw httpErr(410, 'Call expired');
  if (call.nofunds) throw httpErr(402, 'INSUFFICIENT_TOKENS');
  res.json({ callId: ref.id, ...agoraCreds(call.channel, 2) });
}));

// The callee's phone has the call and is ringing: the caller's screen switches from "Calling…" to "Ringing…".
app.post('/calls/:id/ringing', fbAuth, wrap(async (req, res) => {
  const ref = callRef(req.params.id), cs = await ref.get();
  if (!cs.exists) throw httpErr(404, 'Call not found');
  const c = cs.data(); if (c.to !== req.uid) throw httpErr(403, 'Not your call');
  if (c.status === 'ringing' && !c.ringingAt) await ref.update({ ringingAt: FV().serverTimestamp() });
  res.sendStatus(204);
}));

app.post('/calls/:id/decline', fbAuth, wrap(async (req, res) => {
  const ref = callRef(req.params.id);
  await fsdb().runTransaction(async t => {
    const cs = await t.get(ref); if (!cs.exists) throw httpErr(404, 'Call not found');
    if (cs.data().to !== req.uid) throw httpErr(403, 'Not your call');
    if (cs.data().status === 'ringing') t.update(ref, { status: 'declined', endedAt: FV().serverTimestamp() });
  });
  res.sendStatus(204);
}));

// Caller's app pings this every ~20s; the server charges a new minute when the paid time is nearly used up.
app.post('/calls/:id/tick', fbAuth, wrap(async (req, res) => {
  const ref = callRef(req.params.id), f = fsdb();
  { const pre = await ref.get(); if (pre.exists) await Promise.all([ensureLedger(pre.data().from), ensureLedger(pre.data().to)]); }
  const out = await f.runTransaction(async t => {
    const cs = await t.get(ref); if (!cs.exists) throw httpErr(404, 'Call not found');
    const c = cs.data();
    if (c.from !== req.uid) throw httpErr(403, 'Not your call');
    if (c.status !== 'active') throw httpErr(409, 'CALL_NOT_ACTIVE');
    if (Date.now() < c.paidUntil - 15000) return { paidUntil: c.paidUntil };       // already covered
    const [us, rs] = await Promise.all([t.get(f.collection('users').doc(c.from)), t.get(f.collection('users').doc(c.to))]);
    // The free minute runs out here: the next minute switches to Paid_Coins (Beans only tick from that moment) or the call ends cleanly.
    const b = billCallMinute(t, ref, c, ref.id, us, rs);
    if (b.nofunds) { t.update(ref, { status: 'ended', endReason: 'nofunds', endedAt: FV().serverTimestamp() }); return { nofunds: true, payer: b.payer }; }
    const paidUntil = c.paidUntil + 60000;
    t.update(ref, { paidUntil, fundedBy: b.source });
    return { paidUntil, source: b.source, promoLeft: b.promoLeft };
  });
  if (out.nofunds) { if (out.payer === 'from') throw httpErr(402, 'INSUFFICIENT_TOKENS'); return res.json({ ended: true, reason: 'nofunds' }); }
  res.json(out);
}));

app.post('/calls/:id/end', fbAuth, wrap(async (req, res) => {
  const ref = callRef(req.params.id), f = fsdb();
  const missed = await f.runTransaction(async t => {
    const cs = await t.get(ref); if (!cs.exists) return null;
    const c = cs.data();
    if (c.from !== req.uid && c.to !== req.uid) throw httpErr(403, 'Not your call');
    if (c.status === 'ringing' || c.status === 'active') t.update(ref, { status: 'ended', endReason: 'hangup', endedAt: FV().serverTimestamp() });
    return (c.status === 'ringing' && c.from === req.uid) ? c : null;   // caller gave up before it was answered
  });
  if (missed) {
    await f.collection('notifications').doc(`call_${ref.id}`).set({ to: missed.to, from: missed.from, fromName: missed.fromName || '', type: 'call', text: missed.kind, read: false, createdAt: FV().serverTimestamp() })
      .catch(e => console.warn('missed-call notice failed', e.message));
  }
  res.sendStatus(204);
}));

/* ---------- Social actions: likes, views, messages, gifts (server-side) + push notifications ----------
   The web app no longer writes swipes, chat messages or notifications itself. It calls these endpoints, which
   check who is asking, apply rate limits, write with the Admin SDK and send the push to the other person. */
const GIFT_CATALOG = { 'Rose': { emoji: '🌹', cost: 2 }, 'Coffee': { emoji: '☕', cost: 5 }, 'Golden Heart': { emoji: '💖', cost: 10 }, 'Princess': { emoji: '👑', cost: 20 }, 'Luxury Ride': { emoji: '🏎️', cost: 50 }, 'Diamond Ring': { emoji: '💍', cost: 100 },
  // premium gifts with video animations (clips live in public/gifts/; keep names and prices in sync with GIFTS in index.html)
  'Teddy Bear': { emoji: '🧸', cost: 30 }, 'Swallow & Soup': { emoji: '🍲', cost: 40 }, 'Football': { emoji: '⚽', cost: 60 }, 'Royal Drum': { emoji: '🥁', cost: 75 },
  'Dance Party': { emoji: '💃', cost: 90 }, 'Luxury Watch': { emoji: '⌚', cost: 150 }, 'Heart Link Token': { emoji: '🪙', cost: 200 }, 'Money Gun': { emoji: '💸', cost: 250 },
  'Diamond Guitar': { emoji: '🎸', cost: 400 }, 'Champions Cup': { emoji: '🏆', cost: 500 }, 'Diamond SUV': { emoji: '🚘', cost: 750 },
  'Football Arena': { emoji: '🏟️', cost: 1000 },
  'Crystal Penlight': { emoji: '✨', cost: 80 }, 'Heart Link Bouquet': { emoji: '💐', cost: 120 }, 'Heart Link Chronometer': { emoji: '🕰️', cost: 350 }, 'Loyal Shepherd': { emoji: '🐕', cost: 450 },
  'Golden Lion': { emoji: '🦁', cost: 600 }, 'Dream Team': { emoji: '⚽', cost: 650 }, 'Royal Limousine': { emoji: '🚘', cost: 900 }, 'Heart Link Victory': { emoji: '🏅', cost: 800 }, 'Universe': { emoji: '🌌', cost: 1500 },
  'Coin Vault': { emoji: '🏦', cost: 2000 },      // top premium gift: the minting + vault clip (public/gifts/coin-vault.mp4); keep in sync with GIFTS in index.html
  'Kisser': { emoji: '😘', cost: 180 } };      // video clip public/gifts/kisser.mp4 (VID in index.html); keep in sync with GIFTS in index.html
const PUSH_GROUP = { like: 'likes', match: 'likes', view: 'views', message: 'messages', gift: 'gifts', tip: 'gifts', call: 'calls', incall: 'calls', follow: 'follows', live: 'live', mention: 'messages', status: 'messages' };
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);
const MAX_TOKENS_PER_USER = 10;

// Per-user rate limit, kept in memory (fine for one server instance; use Redis if you scale out).
const hits = new Map();
function rateLimit(uid, key, max, windowMs) {
  const k = `${key}:${uid}`, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw httpErr(429, 'You are doing that too fast. Please wait a moment.');
  arr.push(now); hits.set(k, arr);
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 120000) hits.delete(k); }, 60000).unref();

const matchIdOf = (a, b) => [a, b].sort().join('_');
const otherOf = (members, uid) => members.find(x => x !== uid);
async function isBlocked(a, b) {
  const c = fsdb().collection('blocks');
  const [x, y] = await Promise.all([c.doc(`${a}_${b}`).get(), c.doc(`${b}_${a}`).get()]);
  return x.exists || y.exists;
}
async function getUserDoc(uid) {
  const s = await fsdb().collection('users').doc(uid).get();
  if (!s.exists) throw httpErr(404, 'User not found');
  return { id: uid, ...s.data() };
}
const photoOf = u => { const m = (u.media || []).find(x => x && x.kind !== 'video' && typeof x.url === 'string' && x.url.startsWith('https://')); return m ? m.url : ''; };

function pushCopy(n) {
  const name = n.fromName || 'Someone';
  const body = {
    view: 'viewed your profile', like: 'is interested in you. Like them back to match!', match: 'It’s a match! Say hello',
    message: n.text || 'sent you a message', gift: `sent you ${n.text || 'a gift'}`, tip: `tipped you ${n.text || ''}`.trim(),
    call: `Missed ${n.text === 'video' ? 'video' : 'voice'} call`, incall: n.text === 'video' ? 'Incoming video call' : 'Incoming voice call',
    follow: 'started following you', mention: n.text || 'mentioned you', live: n.text || 'is live now', status: n.text || 'viewed your status',
  }[n.type] || 'did something';
  return { title: name, body: String(body).slice(0, 120) };
}

// Sends the push to every device the person has turned alerts on for (respecting the categories they muted).
async function pushToUser(uid, n) {
  const snap = await fsdb().collection('pushTokens').where('uid', '==', uid).get();
  const group = PUSH_GROUP[n.type];
  const docs = snap.docs.filter(d => !((d.data().mute || {})[group]));
  if (!docs.length) return;
  const c = pushCopy(n);
  const res = await admin.messaging().sendEachForMulticast({
    tokens: docs.map(d => d.id),
    // data-only: the service worker builds the notification, so we control the tap action
    data: { nid: n.id, type: n.type, from: n.from, title: c.title, body: c.body, icon: n.icon || '', tag: n.id, ...(n.extra || {}) },
    // a ringing call is worthless after ~45s, so it must not be delivered late
    webpush: { headers: { Urgency: 'high', TTL: n.type === 'incall' ? '45' : '86400' } },
    android: { priority: 'high', ...(n.type === 'incall' ? { ttl: 45000 } : {}) },
  });
  const dead = [];
  res.responses.forEach((r, i) => { if (!r.success && r.error && DEAD_TOKEN.has(r.error.code)) dead.push(docs[i].ref); });
  await deleteRefs(dead);
}

// Writes the in-app alert (same shape the app already reads) and fires the push. gapMs = minimum time between
// two alerts of the same kind from the same sender to the same person.
async function notifyUser({ to, from, fromName, icon, type, text = '', id, gapMs = 0, meta }) {
  if (!to || to === from) return false;
  const ref = fsdb().collection('notifications').doc(id || `${type}_${from}_${to}`);
  if (gapMs) {
    const s = await ref.get(), t = s.exists && s.data().createdAt && s.data().createdAt.toMillis();
    if (t && Date.now() - t < gapMs) return false;
  }
  await ref.set({ to, from, fromName: String(fromName || '').slice(0, 80), icon: String(icon || '').slice(0, 500), type, text: String(text || '').slice(0, 140), ...(meta ? { meta } : {}), read: false, createdAt: FV().serverTimestamp() });
  pushToUser(to, { id: ref.id, from, fromName, icon, type, text }).catch(e => console.warn('push failed', e.message));
  return true;
}

/* ---------- @mentions in comments ----------
   @handle   alerts that person (anyone, as long as they are not blocked and can see the post).
   @all      only works for the owner of the photo / status: alerts everyone who follows the owner (first 500).
   Both write a normal alert (type 'mention') so the in-app list and the push use the existing pipeline. */
const MENTION_RE = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9][A-Za-z0-9_.]{1,18}[A-Za-z0-9])(?![A-Za-z0-9_@])/g;
function parseMentions(text) {
  const handles = new Set(); let all = false, m; MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(String(text || '')))) { const h = m[2].toLowerCase(); if (h === 'all') all = true; else handles.add(h); }
  return { all, handles: [...handles].slice(0, 10) };
}
async function notifyMentions({ mn, text, from, me, ownerId, commentId, canSee, meta }) {
  if (!mn || (!mn.all && !mn.handles.length)) return;
  const f = fsdb(), direct = new Set(), everyone = new Set();
  if (mn.handles.length) {
    const hs = await f.getAll(...mn.handles.map(h => f.collection('handles').doc(h)));
    hs.forEach(d => { if (d.exists && d.data().uid) direct.add(d.data().uid); });
  }
  if (mn.all && from === ownerId) {
    const snap = await f.collection('follows').where('to', '==', ownerId).limit(500).get();
    snap.docs.forEach(d => everyone.add(d.data().from));
  }
  const list = [...new Set([...direct, ...everyone])].filter(t => t && t !== from);
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(list.slice(i, i + 10).map(async t => {
      try {
        if (await isBlocked(from, t)) return;
        if (canSee && !(await canSee(t))) return;
        await notifyUser({ to: t, from, fromName: me.name, icon: photoOf(me), type: 'mention', text: direct.has(t) ? `mentioned you: ${text}` : `tagged everyone: ${text}`, id: `mention_${commentId}_${t}`, meta });
      } catch (e) { /* one bad recipient never stops the rest */ }
    }));
  }
}

// Like / pass. Writes the swipe, makes the match when it is mutual, and alerts the other person.
app.post('/social/swipe', fbAuth, wrap(async (req, res) => {
  const { targetId, action } = req.body || {};
  if (!['like', 'pass'].includes(action)) throw httpErr(400, 'Invalid action');
  if (!SAFE_ID.test(String(targetId || '')) || targetId === req.uid) throw httpErr(400, 'Invalid target');
  rateLimit(req.uid, 'swipe', 120, 60000);
  const f = fsdb();
  const [me, target] = await Promise.all([getUserDoc(req.uid), getUserDoc(targetId)]);
  if (await isBlocked(req.uid, targetId)) throw httpErr(403, 'You cannot interact with this person');
  if (!photoOf(me)) throw httpErr(403, 'Add a profile photo first');

  const mine = f.collection('swipes').doc(`${req.uid}_${targetId}`);
  const prev = await mine.get();
  await mine.set({ from: req.uid, to: targetId, action, createdAt: FV().serverTimestamp() });

  let matched = false;
  if (action === 'like') {
    const wasLike = prev.exists && prev.data().action === 'like';   // a repeat like must not re-alert or re-match
    const back = await f.collection('swipes').doc(`${targetId}_${req.uid}`).get();
    if (back.exists && back.data().action === 'like') {
      matched = true;
      const mref = f.collection('matches').doc(matchIdOf(req.uid, targetId)), ms = await mref.get();
      await mref.set({
        members: [req.uid, targetId], names: { [req.uid]: me.name || '', [targetId]: target.name || '' },
        dm: FV().delete(),                                           // a mutual like is a real match, not a DM shell
        ...(ms.exists ? {} : { createdAt: FV().serverTimestamp() }),
      }, { merge: true });
    }
    if (!wasLike) {
      const base = { to: targetId, from: req.uid, fromName: me.name, icon: photoOf(me) };
      await notifyUser({ ...base, type: 'like', gapMs: 6 * 3600e3 });
      if (matched) await notifyUser({ ...base, type: 'match' });
    }
  }
  res.json({ matched });
}));

// Profile view alert (at most one per viewer per profile every 6 hours).
app.post('/social/view', fbAuth, wrap(async (req, res) => {
  const { targetId } = req.body || {};
  if (!SAFE_ID.test(String(targetId || '')) || targetId === req.uid) throw httpErr(400, 'Invalid target');
  rateLimit(req.uid, 'view', 60, 60000);
  const [me] = await Promise.all([getUserDoc(req.uid), getUserDoc(targetId)]);
  if (await isBlocked(req.uid, targetId)) return res.sendStatus(204);
  await notifyUser({ to: targetId, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'view', gapMs: 6 * 3600e3 });
  res.sendStatus(204);
}));

// Delivery / read receipts: matches/{id}.deliv.{uid} and .reads.{uid} hold the time that person's app received / opened the latest messages.
app.post('/chat/receipt', fbAuth, wrap(async (req, res) => {
  const { matchId, kind } = req.body || {};
  if (!SAFE_ID.test(String(matchId || ''))) throw httpErr(400, 'Invalid chat');
  if (kind !== 'read' && kind !== 'delivered') throw httpErr(400, 'Invalid receipt');
  rateLimit(req.uid, 'receipt', 120, 60000);
  const mref = fsdb().collection('matches').doc(matchId), m = await mref.get();
  const members = (m.exists && m.data().members) || [];
  if (!members.includes(req.uid)) throw httpErr(403, 'Not your chat');
  const now = FV().serverTimestamp();
  await mref.update(kind === 'read' ? { ['reads.' + req.uid]: now, ['deliv.' + req.uid]: now } : { ['deliv.' + req.uid]: now });
  res.sendStatus(204);
}));

// Send a chat message. The sender's name comes from their profile, never from the request.
app.post('/chat/send', fbAuth, wrap(async (req, res) => {
  const { matchId } = req.body || {};
  const text = String((req.body && req.body.text) || '').trim();
  if (!SAFE_ID.test(String(matchId || ''))) throw httpErr(400, 'Invalid chat');
  if (!text || text.length > 2000) throw httpErr(400, 'Message must be 1–2000 characters');
  rateLimit(req.uid, 'msg', 30, 60000);
  const f = fsdb(), mref = f.collection('matches').doc(matchId), m = await mref.get();
  const members = (m.exists && m.data().members) || [];
  if (!members.includes(req.uid) || members.length !== 2) throw httpErr(403, 'Not your chat');
  const to = otherOf(members, req.uid);
  if (!to || to === req.uid) throw httpErr(403, "You can't message yourself");
  if (await isBlocked(req.uid, to)) throw httpErr(403, "You can't message this person");
  const me = await getUserDoc(req.uid);

  const msg = mref.collection('messages').doc();
  await msg.set({ type: 'text', text, from: req.uid, fromName: me.name || '', createdAt: FV().serverTimestamp() });
  await mref.update({ lastMessage: text, lastFrom: req.uid, lastAt: FV().serverTimestamp() });
  await notifyUser({ to, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'message', text, gapMs: 20000 })
    .catch(e => console.warn('message alert failed', e.message));
  res.json({ id: msg.id });
}));

// Likes and comments on profile photos and videos. Stored under mediaFeed/{ownerId}_{mediaId}; the app only reads them live.
// Needs a profile photo (same rule as liking people), no block either way, and a photo/video that is really on that profile.
const mediaKeyOf = (ownerId, mediaId) => `${ownerId}_${String(mediaId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
async function mediaTarget(req, needPhoto = true) {
  const ownerId = String((req.body && req.body.ownerId) || ''), mediaId = String((req.body && req.body.mediaId) || '');
  if (!SAFE_ID.test(ownerId) || !mediaId || mediaId.length > 200) throw httpErr(400, 'Invalid photo');
  const [me, owner] = await Promise.all([getUserDoc(req.uid), getUserDoc(ownerId)]);
  if (needPhoto && !photoOf(me)) throw httpErr(403, 'Add a profile photo first');
  if (ownerId !== req.uid && await isBlocked(req.uid, ownerId)) throw httpErr(403, "You can't do this on this profile");
  if (!(owner.media || []).some(m => m && m.id === mediaId && m.url)) throw httpErr(404, 'This photo is no longer available');
  return { me, ownerId, mediaId, ref: fsdb().collection('mediaFeed').doc(mediaKeyOf(ownerId, mediaId)) };
}
app.post('/media/like', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'mlike', 60, 60000);
  const { ownerId, mediaId, ref } = await mediaTarget(req);
  const lref = ref.collection('likes').doc(req.uid);
  const liked = await fsdb().runTransaction(async t => {
    const [l, p] = await Promise.all([t.get(lref), t.get(ref)]);
    const count = (p.exists && p.data().likeCount) || 0;
    if (l.exists) { t.delete(lref); t.set(ref, { ownerId, mediaId, likeCount: Math.max(0, count - 1) }, { merge: true }); return false; }
    t.set(lref, { at: FV().serverTimestamp() });
    t.set(ref, { ownerId, mediaId, likeCount: count + 1 }, { merge: true });
    return true;
  });
  res.json({ liked });
}));
app.post('/media/comment', fbAuth, wrap(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text || text.length > 500) throw httpErr(400, 'Comment must be 1–500 characters');
  rateLimit(req.uid, 'mcomment', 10, 60000);
  const { me, ownerId, mediaId, ref } = await mediaTarget(req);
  const mn = parseMentions(text); if (mn.all && ownerId === req.uid) rateLimit(req.uid, 'mentionall', 3, 600000);   // @all: 3 times per 10 minutes
  const cref = ref.collection('comments').doc(), batch = fsdb().batch();
  batch.set(cref, { from: req.uid, fromName: String(me.name || '').slice(0, 80), fromPhoto: photoOf(me), text, createdAt: FV().serverTimestamp() });
  batch.set(ref, { ownerId, mediaId, commentCount: FV().increment(1) }, { merge: true });
  await batch.commit();
  notifyMentions({ mn, text, from: req.uid, me, ownerId, commentId: cref.id, meta: { k: 'media', owner: ownerId, media: mediaId } }).catch(e => console.warn('mention alerts failed', e.message));
  res.json({ id: cref.id });
}));
// The author or the owner of the photo can delete a comment.
app.post('/media/comment-delete', fbAuth, wrap(async (req, res) => {
  const ownerId = String((req.body && req.body.ownerId) || ''), mediaId = String((req.body && req.body.mediaId) || ''), commentId = String((req.body && req.body.commentId) || '');
  if (!SAFE_ID.test(ownerId) || !SAFE_ID.test(commentId) || !mediaId || mediaId.length > 200) throw httpErr(400, 'Invalid comment');
  const ref = fsdb().collection('mediaFeed').doc(mediaKeyOf(ownerId, mediaId)), cref = ref.collection('comments').doc(commentId), s = await cref.get();
  if (!s.exists) return res.json({ ok: true });
  if (s.data().type === 'gift') throw httpErr(403, 'Gifts cannot be deleted');
  if (s.data().from !== req.uid && ownerId !== req.uid) throw httpErr(403, 'Not your comment');
  const batch = fsdb().batch();
  batch.delete(cref); batch.set(ref, { commentCount: FV().increment(-1) }, { merge: true });
  await batch.commit();
  res.json({ ok: true });
}));

// Gift on a photo or video: same money rules as /chat/gift (sender pays, owner earns the creator share, leaderboard, alert),
// and the gift shows up in that photo's comment list. Does not need a profile photo: we never turn away someone who wants to pay.
app.post('/media/gift', fbAuth, wrap(async (req, res) => {
  const giftName = String((req.body && req.body.giftName) || '');
  const g = GIFT_CATALOG[giftName]; if (!g) throw httpErr(400, 'Unknown gift');
  rateLimit(req.uid, 'gift', 20, 60000);
  const free = !!req.isTestAdmin;   // test admin: free, no payout to the owner
  const { me, ownerId, mediaId, ref } = await mediaTarget(req, false);
  if (ownerId === req.uid) throw httpErr(400, "You can't gift yourself");
  const f = fsdb(), cost = g.cost, uref = f.collection('users').doc(req.uid), rref = f.collection('users').doc(ownerId);
  const sus = free ? null : await suspectReason(req.uid, ownerId);
  if (!free) await Promise.all([ensureLedger(req.uid, req.phone), ensureLedger(ownerId)]);
  await f.runTransaction(async t => {
    const [us, rs] = await Promise.all([t.get(uref), t.get(rref)]);
    if (!us.exists || (!free && (us.data().tokens || 0) < cost)) throw httpErr(402, 'INSUFFICIENT_TOKENS');
    if (!free) t.update(uref, { tokens: FV().increment(-cost) });
    if (!free && rs.exists) payCreator(t, { payerId: req.uid, P: us.data(), earnerId: ownerId, earnerRef: rref, E: rs.data(), coins: cost, earning: { type: 'gift', label: giftName, emoji: g.emoji, fromName: me.name || '', ...(sus ? { suspect: true } : {}) } });
    t.set(ref.collection('comments').doc(), { type: 'gift', from: req.uid, fromName: String(me.name || '').slice(0, 80), fromPhoto: photoOf(me), text: `sent a ${giftName} ${g.emoji}`, giftName, emoji: g.emoji, createdAt: FV().serverTimestamp() });
    t.set(ref, { ownerId, mediaId, giftCount: FV().increment(1) }, { merge: true });
    t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'gift_sent', tokens: free ? 0 : -cost, to: ownerId, ...(free ? { test: true } : {}), createdAt: FV().serverTimestamp() });
    if (!me.hideFromBoard && !free) for (const p of ['all', weekKey()]) t.set(lbRef(p, req.uid), { name: me.name || '', photo: photoOf(me), total: FV().increment(cost) }, { merge: true });
  });
  if (sus) freezePayouts(ownerId, 'same_device', sus).catch(() => {});
  maybeScore(ownerId);
  await notifyUser({ to: ownerId, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'gift', text: `${giftName} ${g.emoji}`, id: `gift_${req.uid}_${ownerId}_${Date.now()}` })
    .catch(e => console.warn('gift alert failed', e.message));
  res.json({ ok: true });
}));

// Gift (in a chat or a room) or tip (to a room host): moves tokens, posts the gift line, alerts the receiver.
app.post('/chat/gift', fbAuth, wrap(async (req, res) => {
  const { giftName, tokens, context } = req.body || {};
  if (!context || !['chat', 'room'].includes(context.type) || !SAFE_ID.test(String(context.id || ''))) throw httpErr(400, 'Invalid context');
  const isTip = !giftName;
  let cost, emoji, label;
  if (isTip) {
    cost = Number(tokens); emoji = '🪙'; label = 'a tip';
    if (!Number.isInteger(cost) || cost < 1 || cost > 10000) throw httpErr(400, 'Invalid amount');
  } else {
    const g = GIFT_CATALOG[giftName]; if (!g) throw httpErr(400, 'Unknown gift');
    cost = g.cost; emoji = g.emoji; label = giftName;
  }
  rateLimit(req.uid, 'gift', 20, 60000);
  const free = !!req.isTestAdmin;   // test admin: no tokens taken, nothing paid out to the receiver, no leaderboard entry
  const f = fsdb(), ctxRef = f.collection(context.type === 'room' ? 'rooms' : 'matches').doc(context.id), ctx = await ctxRef.get();
  if (!ctx.exists) throw httpErr(404, 'Not found');
  let to;
  if (context.type === 'room') to = ctx.data().hostId;
  else { const members = ctx.data().members || []; if (!members.includes(req.uid) || members.length !== 2) throw httpErr(403, 'Not your chat'); to = otherOf(members, req.uid); }
  if (!to || (to === req.uid && !free)) throw httpErr(400, "You can't send this to yourself");
  if (context.type === 'chat' && await isBlocked(req.uid, to)) throw httpErr(403, 'You cannot send this to this person');
  if (context.type === 'room' && ctx.data().status !== 'live') throw httpErr(409, 'This room is not live');
  if (context.type === 'room' && (await ctxRef.collection('bans').doc(req.uid).get()).exists) throw httpErr(403, 'You were removed from this room');
  const me = await getUserDoc(req.uid);

  const uref = f.collection('users').doc(req.uid), rref = f.collection('users').doc(to);
  const sus = free ? null : await suspectReason(req.uid, to);
  if (!free) await Promise.all([ensureLedger(req.uid, req.phone), ensureLedger(to)]);
  await f.runTransaction(async t => {
    const [us, rs] = await Promise.all([t.get(uref), t.get(rref)]);
    if (!rs.exists) throw httpErr(404, 'Recipient not found');
    if (!free && (us.data().tokens || 0) < cost) throw httpErr(402, 'INSUFFICIENT_TOKENS');
    if (!free) t.update(uref, { tokens: FV().increment(-cost) });
    if (!free) payCreator(t, { payerId: req.uid, P: us.data(), earnerId: to, earnerRef: rref, E: rs.data(), coins: cost, earning: { type: isTip ? 'tip' : 'gift', label: isTip ? 'Tip' : label, emoji, fromName: me.name || '', ...(sus ? { suspect: true } : {}) } });
    t.set(ctxRef.collection('messages').doc(), { type: 'gift', from: req.uid, fromName: me.name || '', cost, giftName: label, emoji, createdAt: FV().serverTimestamp() });
    if (context.type === 'room') {
      if (!free) t.update(ctxRef, { paidGifts: FV().increment(cost) });      // coins gifted in this live (daily bonus is paid out of this)
      if (!free && !sus) t.set(questPoolRef(), { coins: FV().increment(Math.round(cost * QUEST.poolPct * 10) / 1000) }, { merge: true });      // a slice of live gift revenue funds the quest rewards
      t.set(ctxRef.collection('gifters').doc(req.uid), { name: me.name || '', total: FV().increment(cost) }, { merge: true });
      if (ctx.data().goal) t.update(ctxRef, { 'goal.progress': FV().increment(cost) });
    }
    t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'gift_sent', tokens: free ? 0 : -cost, to, ...(free ? { test: true } : {}), createdAt: FV().serverTimestamp() });
    if (!me.hideFromBoard && !free) for (const p of ['all', weekKey()]) t.set(lbRef(p, req.uid), { name: me.name || '', photo: photoOf(me), total: FV().increment(cost) }, { merge: true });
  });
  if (sus) freezePayouts(to, 'same_device', sus).catch(() => {});
  maybeScore(to);                                              // never slows the gift down
  if (context.type === 'room' && !free && !sus) { questXp(req.uid, cost); questXp(to, cost); missionsAdd(req.uid, 'giftSent', cost); missionsAdd(to, 'giftRecv', cost); qAdd(req.uid, 'v_gift').catch(() => {}); qAdd(to, 'h_gift').catch(() => {}); }      // live level XP: 1 per coin, on both sides
  const type = isTip ? 'tip' : 'gift';
  if (!(free && to === req.uid)) await notifyUser({ to, from: req.uid, fromName: me.name, icon: photoOf(me), type, text: isTip ? `${cost} tokens` : `${label} ${emoji}`, id: `${type}_${req.uid}_${to}_${Date.now()}` })
    .catch(e => console.warn('gift alert failed', e.message));
  res.json({ ok: true });
}));

/* ---------- Voice notes + premium stickers (private chats only) ----------
   Voice notes: the app records audio, uploads it straight to Cloudinary with a signed request from here
   (folder flc-voice/<uid>), then calls /chat/send-voice, which checks the file really is ours and writes the message.
   Premium stickers: big animated emoji that cost tokens. The tokens are taken from the sender and are NOT paid out to
   the receiver (they are platform revenue), so stickers cannot be used to farm payouts.
   Keep this catalog in sync with EMO_PACKS in index.html (the server price always wins). */
const VOICE_MAX_SECONDS = 180;
const STICKERS = {
  cupid: { emoji: '💘', name: 'Cupid', cost: 3 }, rose: { emoji: '🌹', name: 'Red Rose', cost: 3 }, letter: { emoji: '💌', name: 'Love Letter', cost: 3 },
  teddy: { emoji: '🧸', name: 'Teddy Hug', cost: 4 }, cheers: { emoji: '🥂', name: 'Cheers', cost: 4 }, choc: { emoji: '🍫', name: 'Sweet Treat', cost: 3 },
  crown: { emoji: '👑', name: 'Crown', cost: 10 }, diamond: { emoji: '💎', name: 'Diamond', cost: 15 }, seal: { emoji: '⚜️', name: 'Royal Seal', cost: 8 },
  peacock: { emoji: '🦚', name: 'Peacock', cost: 8 }, castle: { emoji: '🏰', name: 'Castle', cost: 12 }, trophy: { emoji: '🏆', name: 'Champion', cost: 10 },
  bubbly: { emoji: '🍾', name: 'Champagne', cost: 12 }, money: { emoji: '💰', name: 'Money Bag', cost: 10 }, jet: { emoji: '✈️', name: 'Private Jet', cost: 25 },
  island: { emoji: '🏝️', name: 'Island Escape', cost: 20 }, yacht: { emoji: '🛥️', name: 'Yacht', cost: 30 }, ride: { emoji: '🏎️', name: 'Fast Ride', cost: 20 },
  fire: { emoji: '🔥', name: 'Fire', cost: 2 }, spark: { emoji: '✨', name: 'Sparkles', cost: 2 }, star: { emoji: '🌟', name: 'Shining Star', cost: 3 },
  fw: { emoji: '🎆', name: 'Fireworks', cost: 5 }, spk: { emoji: '🎇', name: 'Sparkler', cost: 4 }, rbow: { emoji: '🌈', name: 'Rainbow', cost: 4 },
};
const destroyVoice = id => (typeof id === 'string' && id.startsWith('flc-voice/')) ? destroyAsset(id, 'video') : Promise.resolve();

// Loads a private chat, checks the caller is one of the two people, and (unless told not to) that nobody blocked anybody.
async function chatPeer(req, matchId, checkBlock = true) {
  if (!SAFE_ID.test(String(matchId || ''))) throw httpErr(400, 'Invalid chat');
  const mref = fsdb().collection('matches').doc(matchId), m = await mref.get();
  const members = (m.exists && m.data().members) || [];
  if (!members.includes(req.uid) || members.length !== 2) throw httpErr(403, 'Not your chat');
  const to = otherOf(members, req.uid);
  if (checkBlock && await isBlocked(req.uid, to)) throw httpErr(403, "You can't message this person");
  return { mref, to };
}

app.post('/chat/voice-signature', fbAuth, wrap(async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) throw httpErr(503, 'Voice notes are not set up yet');
  rateLimit(req.uid, 'voice-sig', 20, 60000);
  const timestamp = Math.round(Date.now() / 1000), folder = `flc-voice/${req.uid}`;
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, folder, signature, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
}));

app.post('/chat/send-voice', fbAuth, wrap(async (req, res) => {
  const { matchId, url, publicId, duration, peaks } = req.body || {};
  const dur = Math.round(Number(duration));
  if (!Number.isFinite(dur) || dur < 1 || dur > VOICE_MAX_SECONDS + 5) throw httpErr(400, 'Invalid voice note length');
  const prefix = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/`;
  if (!process.env.CLOUDINARY_CLOUD_NAME || typeof url !== 'string' || url.length > 400 || !url.startsWith(prefix)
    || typeof publicId !== 'string' || publicId.length > 200 || !publicId.startsWith(`flc-voice/${req.uid}/`) || !url.includes(publicId)) throw httpErr(400, 'Invalid voice note');
  const bars = Array.isArray(peaks) ? peaks.slice(0, 48).map(n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))) : [];
  rateLimit(req.uid, 'voice', 10, 60000);
  const { mref, to } = await chatPeer(req, matchId);
  const me = await getUserDoc(req.uid);
  // The message id comes from the file, so a retry after a dropped connection can never post the same note twice.
  const msg = mref.collection('messages').doc(crypto.createHash('sha1').update(publicId).digest('hex').slice(0, 20));
  try {
    await msg.create({ type: 'voice', url, publicId, duration: dur, peaks: bars, from: req.uid, fromName: me.name || '', createdAt: FV().serverTimestamp() });
  } catch (e) { if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return res.json({ id: msg.id }); throw e; }
  await mref.update({ lastMessage: '🎤 Voice message', lastFrom: req.uid, lastAt: FV().serverTimestamp() });
  await notifyUser({ to, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'message', text: 'Voice message', gapMs: 20000 })
    .catch(e => console.warn('voice alert failed', e.message));
  res.json({ id: msg.id });
}));

// Deletes a voice note: the audio file in Cloudinary and the message. Either person in the chat may do this
// (the same as the Firestore rules for deleting messages), which is also what "Delete conversation" uses.
app.post('/chat/voice-delete', fbAuth, wrap(async (req, res) => {
  const { matchId, messageId } = req.body || {};
  if (!SAFE_ID.test(String(messageId || ''))) throw httpErr(400, 'Invalid message');
  rateLimit(req.uid, 'voice-del', 200, 60000);
  const { mref } = await chatPeer(req, matchId, false);
  const ref = mref.collection('messages').doc(messageId), s = await ref.get();
  if (!s.exists) return res.json({ ok: true });
  if (s.data().type !== 'voice') throw httpErr(400, 'Not a voice note');
  await destroyVoice(s.data().publicId);
  await ref.delete();
  res.json({ ok: true });
}));

/* ---------- Photos + videos in private chats, with "view once" ----------
   Normal media: uploaded straight to Cloudinary (folder flc-chat/<uid>) with a signed request from here; the message keeps the link.
   View once: stored as a Cloudinary "authenticated" asset (its plain link does not work) and the link is kept ONLY in the
   server-side collection chatMediaPrivate/{matchId}_{messageId}, never in the message both people can read. /chat/media-open hands the
   receiver a signed link exactly once (and marks the message opened); the file is destroyed when they close the viewer
   (/chat/media-done) or after 15 minutes, whichever comes first.
   firestore.rules must NOT let clients read chatMediaPrivate (default deny; only a catch-all rule would expose it). */
const CHAT_MEDIA_PURGE_MS = 15 * 60 * 1000;
const chatMediaPriv = (matchId, messageId) => fsdb().collection('chatMediaPrivate').doc(`${matchId}_${messageId}`);
const destroyChatMedia = (publicId, kind, once) => (typeof publicId === 'string' && publicId.startsWith('flc-chat/'))
  ? cloudinary.uploader.destroy(publicId, { resource_type: kind === 'video' ? 'video' : 'image', type: once ? 'authenticated' : 'upload', invalidate: true })
      .catch(e => console.warn('chat media destroy failed', publicId, e.message))
  : Promise.resolve();
async function purgeOpenedChatMedia(olderThanMs) {
  const snap = await fsdb().collection('chatMediaPrivate').where('openedAt', '<', Date.now() - olderThanMs).limit(50).get();
  for (const d of snap.docs) { await destroyChatMedia(d.data().publicId, d.data().kind, true); await d.ref.delete().catch(() => {}); }
}
setInterval(() => purgeOpenedChatMedia(CHAT_MEDIA_PURGE_MS).catch(e => console.warn('chat media sweep failed', e.message)), 5 * 60 * 1000).unref();

app.post('/chat/media-signature', fbAuth, wrap(async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) throw httpErr(503, 'Photos and videos are not set up yet');
  const kind = req.body && req.body.kind;
  if (kind !== 'image' && kind !== 'video') throw httpErr(400, 'Invalid file type');
  rateLimit(req.uid, 'media-sig', 20, 60000);
  const once = !!(req.body && req.body.once);
  const params = { timestamp: Math.round(Date.now() / 1000), folder: `flc-chat/${req.uid}` };
  if (once) params.type = 'authenticated';
  const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp: params.timestamp, folder: params.folder, signature, ...(once ? { type: 'authenticated' } : {}), apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
}));

app.post('/chat/send-media', fbAuth, wrap(async (req, res) => {
  const { matchId, kind, url, publicId } = req.body || {}, once = !!(req.body && req.body.once);
  if (kind !== 'image' && kind !== 'video') throw httpErr(400, 'Invalid file type');
  const prefix = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/${kind}/${once ? 'authenticated' : 'upload'}/`;
  if (!process.env.CLOUDINARY_CLOUD_NAME || typeof url !== 'string' || url.length > 600 || !url.startsWith(prefix)
    || typeof publicId !== 'string' || publicId.length > 200 || !publicId.startsWith(`flc-chat/${req.uid}/`) || !url.includes(publicId)) throw httpErr(400, 'Invalid file');
  const caption = String((req.body && req.body.caption) || '').trim().slice(0, 300);
  const dur = kind === 'video' ? Math.max(0, Math.min(65, Math.round(Number(req.body.duration) || 0))) : 0;
  const dim = n => Math.max(0, Math.min(8000, Math.round(Number(n) || 0)));
  rateLimit(req.uid, 'media', 12, 60000);
  const { mref, to } = await chatPeer(req, matchId);
  const me = await getUserDoc(req.uid);
  // the message id comes from the file, so a retry after a dropped connection can never post the same file twice
  const msg = mref.collection('messages').doc(crypto.createHash('sha1').update(publicId).digest('hex').slice(0, 20));
  const doc = { type: 'media', kind, once, caption, duration: dur, w: dim(req.body.w), h: dim(req.body.h), from: req.uid, fromName: me.name || '', createdAt: FV().serverTimestamp() };
  if (once) {
    doc.opened = false;
    await chatMediaPriv(matchId, msg.id).set({ matchId, messageId: msg.id, url, publicId, kind, from: req.uid, to, createdAt: Date.now() });   // link stays server-side
  } else { doc.url = url; doc.publicId = publicId; }
  try { await msg.create(doc); }
  catch (e) { if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return res.json({ id: msg.id }); throw e; }
  const label = kind === 'video' ? '🎥 Video' : '📷 Photo';
  await mref.update({ lastMessage: (once ? '🔒 ' : '') + label, lastFrom: req.uid, lastAt: FV().serverTimestamp() });
  await notifyUser({ to, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'message', text: label, gapMs: 20000 })
    .catch(e => console.warn('media alert failed', e.message));
  res.json({ id: msg.id });
}));

// The receiver opens a view-once item. The transaction lets exactly one call through; every later call gets 410.
app.post('/chat/media-open', fbAuth, wrap(async (req, res) => {
  const { matchId, messageId } = req.body || {};
  if (!SAFE_ID.test(String(messageId || ''))) throw httpErr(400, 'Invalid message');
  rateLimit(req.uid, 'media-open', 60, 60000);
  const { mref } = await chatPeer(req, matchId, false);
  const msgRef = mref.collection('messages').doc(messageId), pRef = chatMediaPriv(matchId, messageId);
  const p = await fsdb().runTransaction(async t => {
    const [m, ps] = await Promise.all([t.get(msgRef), t.get(pRef)]);
    if (!m.exists || !ps.exists) throw httpErr(410, 'This was already opened');
    const md = m.data();
    if (md.type !== 'media' || !md.once) throw httpErr(400, 'Not a view-once item');
    if (md.from === req.uid || ps.data().to !== req.uid) throw httpErr(403, 'Not for you');
    if (md.opened) throw httpErr(410, 'This was already opened');
    t.update(msgRef, { opened: true, openedAt: FV().serverTimestamp() });
    t.update(pRef, { openedAt: Date.now() });
    return ps.data();
  });
  const url = cloudinary.url(p.publicId, { resource_type: p.kind === 'video' ? 'video' : 'image', type: 'authenticated', sign_url: true, secure: true, format: p.kind === 'video' ? 'mp4' : 'jpg' });
  res.set('Cache-Control', 'no-store').json({ url });
}));

// The receiver closed the viewer: the file is deleted for good.
app.post('/chat/media-done', fbAuth, wrap(async (req, res) => {
  const { matchId, messageId } = req.body || {};
  if (!SAFE_ID.test(String(messageId || ''))) throw httpErr(400, 'Invalid message');
  await chatPeer(req, matchId, false);
  const pRef = chatMediaPriv(matchId, messageId), ps = await pRef.get();
  if (ps.exists && ps.data().to === req.uid && ps.data().openedAt) { await destroyChatMedia(ps.data().publicId, ps.data().kind, true); await pRef.delete(); }
  res.json({ ok: true });
}));

// Deletes a photo/video message and its file. Either person may do this (same as voice notes), which is also what "Delete conversation" uses.
app.post('/chat/media-delete', fbAuth, wrap(async (req, res) => {
  const { matchId, messageId } = req.body || {};
  if (!SAFE_ID.test(String(messageId || ''))) throw httpErr(400, 'Invalid message');
  rateLimit(req.uid, 'media-del', 200, 60000);
  const { mref } = await chatPeer(req, matchId, false);
  const ref = mref.collection('messages').doc(messageId), s = await ref.get();
  if (!s.exists) return res.json({ ok: true });
  const md = s.data(); if (md.type !== 'media') throw httpErr(400, 'Not a photo or video');
  const pRef = chatMediaPriv(matchId, messageId), ps = await pRef.get();
  if (ps.exists) { await destroyChatMedia(ps.data().publicId, ps.data().kind, true); await pRef.delete(); }
  else if (md.publicId) await destroyChatMedia(md.publicId, md.kind, false);
  await ref.delete();
  res.json({ ok: true });
}));

app.post('/chat/sticker', fbAuth, wrap(async (req, res) => {
  const { matchId, stickerId } = req.body || {};
  const s = Object.prototype.hasOwnProperty.call(STICKERS, String(stickerId)) ? STICKERS[String(stickerId)] : null;
  if (!s) throw httpErr(400, 'Unknown sticker');
  rateLimit(req.uid, 'sticker', 20, 60000);
  const { mref, to } = await chatPeer(req, matchId);
  await ensureLedger(req.uid, req.phone);
  const me = await getUserDoc(req.uid), f = fsdb(), uref = f.collection('users').doc(req.uid), msg = mref.collection('messages').doc();
  await f.runTransaction(async t => {
    const us = await t.get(uref);
    if (!us.exists) throw httpErr(404, 'User not found');
    if ((us.data().tokens || 0) < s.cost) throw httpErr(402, 'INSUFFICIENT_TOKENS');
    t.update(uref, { tokens: FV().increment(-s.cost) });
    t.set(msg, { type: 'sticker', stickerId: String(stickerId), emoji: s.emoji, name: s.name, cost: s.cost, from: req.uid, fromName: me.name || '', createdAt: FV().serverTimestamp() });
    t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'sticker_sent', tokens: -s.cost, to, createdAt: FV().serverTimestamp() });
  });
  await mref.update({ lastMessage: `${s.emoji} Sticker`, lastFrom: req.uid, lastAt: FV().serverTimestamp() });
  await notifyUser({ to, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'message', text: `${s.emoji} Sticker`, gapMs: 20000 })
    .catch(e => console.warn('sticker alert failed', e.message));
  res.json({ id: msg.id, cost: s.cost });
}));

// Push device registration. The token is the device; registering it again just refreshes it (or moves it to the
// account that is now signed in on that device).
const MUTE_KEYS = ['likes', 'views', 'messages', 'gifts', 'calls', 'follows', 'live'];
app.post('/push/register', fbAuth, wrap(async (req, res) => {
  const { token, mute } = req.body || {};
  if (typeof token !== 'string' || token.length < 50 || token.length > 4096 || token.includes('/')) throw httpErr(400, 'Invalid token');
  rateLimit(req.uid, 'pushreg', 30, 60000);
  const cleanMute = {}; MUTE_KEYS.forEach(k => { if (mute && mute[k] === true) cleanMute[k] = true; });
  const f = fsdb();
  await f.collection('pushTokens').doc(token).set({ uid: req.uid, mute: cleanMute, ua: String(req.headers['user-agent'] || '').slice(0, 200), updatedAt: FV().serverTimestamp() });
  // keep only the newest few devices per person
  const all = await f.collection('pushTokens').where('uid', '==', req.uid).get();
  if (all.size > MAX_TOKENS_PER_USER) {
    const oldest = all.docs.sort((a, b) => ((a.data().updatedAt && a.data().updatedAt.toMillis()) || 0) - ((b.data().updatedAt && b.data().updatedAt.toMillis()) || 0));
    await deleteRefs(oldest.slice(0, all.size - MAX_TOKENS_PER_USER).map(d => d.ref));
  }
  res.sendStatus(204);
}));

app.post('/push/unregister', fbAuth, wrap(async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token || token.includes('/')) throw httpErr(400, 'Invalid token');
  const ref = fsdb().collection('pushTokens').doc(token), s = await ref.get();
  if (s.exists && s.data().uid === req.uid) await ref.delete();
  res.sendStatus(204);
}));

/* ---------- Token purchases (Firestore app): the server confirms the payment with the provider, then credits ----------
   The browser can no longer add tokens to itself. Paid amount -> pack -> tokens is decided here, never by the client.
   The same purchase can be confirmed twice (e.g. a retry): the transaction record `purchase_<provider>_<reference>`
   is created inside the credit, so the second one does nothing. */

async function creditTokens(uid, tokens, provider, reference, meta) {
  const f = fsdb(), uref = f.collection('users').doc(uid);
  const tref = f.collection('transactions').doc(`purchase_${provider}_${String(reference).replace(/[^A-Za-z0-9_.=-]/g, '_')}`);
  return f.runTransaction(async t => {
    const [ts, us] = await Promise.all([t.get(tref), t.get(uref)]);
    if (ts.exists) return { already: true, tokens };
    if (!us.exists) { console.error('Paid but profile not found:', uid, provider, reference); throw httpErr(404, 'User not found'); }
    t.update(uref, { tokens: FV().increment(tokens) });
    t.set(tref, { uid, type: 'purchase', tokens, ref: String(reference), provider, ...(meta ? { pack: meta.pack, usd: meta.usd } : {}), createdAt: FV().serverTimestamp() });
    return { already: false, tokens };
  });
}

// The app calls this right after its payment popup reports success.
/* ---------- Google Play Billing (tokens bought inside the Play Store app) ----------
   Setup: Play Console > Monetize > In-app products: create 3 consumable products with the ids in PLAY_SKU (prices matching PACKS).
   Then API access: link a Google Cloud project, create a service account, invite it in Play Console (Users and permissions)
   with "View financial data" + "Manage orders and subscriptions", and put its JSON key in PLAY_SERVICE_ACCOUNT.
   PLAY_PACKAGE_NAME is your app's package name, for example com.yourname.heartlink. */
const PLAY_SKU = { starter: 'tokens_starter', popular: 'tokens_popular', mega: 'tokens_mega' };
let playTok = null;
async function playAccessToken() {
  if (playTok && playTok.exp > Date.now() + 60000) return playTok.v;
  let sa; try { sa = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT || ''); } catch { sa = null; }
  if (!sa || !sa.client_email || !sa.private_key || !process.env.PLAY_PACKAGE_NAME) throw httpErr(503, 'Google Play billing is not configured on the server');
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
  const r = await axios.post('https://oauth2.googleapis.com/token',
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 })
    .catch(() => { throw httpErr(502, 'Could not reach Google Play'); });
  playTok = { v: r.data.access_token, exp: Date.now() + (r.data.expires_in || 3600) * 1000 };
  return playTok.v;
}
// Asks Google whether this purchase token is a real, completed purchase. Returns { orderId, consumed, consume() } or throws.
async function confirmPlay(productId, token) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(process.env.PLAY_PACKAGE_NAME || '')}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const headers = { Authorization: `Bearer ${await playAccessToken()}` };
  const r = await axios.get(base, { headers, timeout: 10000 })
    .catch(e => { throw httpErr(e.response && [400, 404, 410].includes(e.response.status) ? 400 : 502, 'Could not confirm the purchase'); });
  const d = r.data || {};
  if (d.purchaseState === 2) throw Object.assign(httpErr(409, 'Payment pending'), { pending: true });   // 0 purchased, 1 canceled, 2 pending (e.g. paying in cash)
  if (d.purchaseState === 1) throw Object.assign(httpErr(400, 'Purchase canceled'), { canceled: true });
  if (d.purchaseState !== 0) throw httpErr(400, 'Purchase not completed');
  if (!d.orderId) throw httpErr(400, 'Purchase has no order');
  return { orderId: String(d.orderId), consumed: d.consumptionState === 1, consume: () => axios.post(`${base}:consume`, null, { headers, timeout: 10000 }) };
}

// Google never lists unpaid purchases, so the history only knows about the ones this server was asked to check.
const tokKey = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);
async function noteAttempt(uid, status, key, token) {            // status: 'pending' | 'failed'
  try {
    const f = fsdb(), P = PACKS[key];
    await f.collection('transactions').doc(`purchase_${status}_${tokKey(token)}`)
      .create({ uid, type: `purchase_${status}`, packTokens: P.tokens + (P.bonus || 0), pack: key, usd: P.usd, provider: 'play', createdAt: FV().serverTimestamp() })
      .catch(e => { if (e.code !== 6) throw e; });                // 6 = already noted
    if (status === 'failed') await f.collection('transactions').doc(`purchase_pending_${tokKey(token)}`).delete().catch(() => {});
  } catch (e) { console.warn('Could not note purchase attempt:', e.message); }
}

app.post('/wallet/verify', fbAuth, wrap(async (req, res) => {
  const { provider } = req.body || {};
  rateLimit(req.uid, 'verify', 10, 60000);
  if (provider === 'play') {                              // bought through Google Play Billing inside the Android app
    const productId = String((req.body && req.body.productId) || ''), token = String((req.body && req.body.purchaseToken) || '');
    const key = Object.keys(PLAY_SKU).find(k => PLAY_SKU[k] === productId);
    if (!key) throw httpErr(400, 'Unknown product');
    if (!/^[\w.-]{20,600}$/.test(token)) throw httpErr(400, 'Invalid purchase');
    const p = await confirmPlay(productId, token).catch(async e => {
      if (e && e.pending) { await noteAttempt(req.uid, 'pending', key, token); return null; }
      if (e && e.canceled) await noteAttempt(req.uid, 'failed', key, token);
      throw e;
    });
    if (!p) return res.json({ pending: true });          // Google is still taking the payment; the app re-checks the next time checkout opens
    const out = await creditTokens(req.uid, PACKS[key].tokens + (PACKS[key].bonus || 0), 'play', p.orderId, { pack: key, usd: PACKS[key].usd, bonus: PACKS[key].bonus || 0 });
    await fsdb().collection('transactions').doc(`purchase_pending_${tokKey(token)}`).delete().catch(() => {});   // a pending payment that finally went through   // order id is unique, so a repeat can never credit twice
    if (!p.consumed) await p.consume().catch(e => console.warn('Play consume failed (retried on the next verify):', e.message));
    return res.json({ ...out, ref: p.orderId });
  }
  throw httpErr(400, 'Unknown provider');
}));

// The wallet's "Top ups" history: this user's purchases (confirmed, pending and canceled), newest first. Two equality filters need no custom index.
app.post('/wallet/purchases', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'purchases', 30, 60000);
  const col = fsdb().collection('transactions'), kinds = [['purchase', 'success'], ['purchase_pending', 'pending'], ['purchase_failed', 'failed']];
  const snaps = await Promise.all(kinds.map(([type]) => col.where('uid', '==', req.uid).where('type', '==', type).limit(100).get()));
  const items = [];
  snaps.forEach((snap, i) => snap.docs.forEach(d => {
    const x = d.data(), status = kinds[i][1], tokens = status === 'success' ? x.tokens : x.packTokens;
    const k = x.pack || Object.keys(PACKS).find(k => PACKS[k].tokens === x.tokens);     // older records have no pack saved: match by size
    items.push({ id: d.id, status, tokens, bonus: x.bonus || 0, usd: x.usd != null ? x.usd : (k ? PACKS[k].usd : null), provider: x.provider || 'play', ref: x.ref || '', at: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0 });
  }));
  items.sort((a, b) => b.at - a.at);
  res.json({ items: items.slice(0, 100) });
}));

/* ---------- errors ---------- */
// ---------- Creator cash-out ----------
// Creators ask to withdraw their gift/tip earnings. The tokens are taken out of their balance straight away (so they
// cannot be spent twice) and the request waits on the admin page (/admin.html) to be paid by hand and marked paid.
// A rejected request puts the tokens back.
const USD_PER_TOKEN = Number(process.env.TOKEN_PAYOUT_USD) || 0.013;       // US dollars paid for each creator token
// Cash-out (withdrawals + ID verification for payouts) is OFF unless PAYOUTS_ENABLED=true. Leave it off for the Google Play app on a
// personal developer account: turning virtual gifts into money counts as a financial feature on Play. With it off, creators convert
// their earnings into spendable tokens instead (POST /wallet/convert-earnings).
// PAYOUTS_ENABLED: unset = off for everyone; 'web' = on, but the app hides it inside the Play app (UI only, the server cannot tell the clients apart); 'true' = on everywhere.
const PAYOUTS_MODE = ['true', 'web'].includes(process.env.PAYOUTS_ENABLED) ? process.env.PAYOUTS_ENABLED : 'off';
const PAYOUTS_ENABLED = PAYOUTS_MODE !== 'off';
// The Google Play app sends X-Client: play. Cash-out is a web-only feature, so those requests are refused here as well as hidden in the app.
const isPlayClient = req => String(req.get('x-client') || '').toLowerCase() === 'play';
const payoutsOnly = (req, res, next) => isPlayClient(req) ? res.status(403).json({ error: 'Cash-out is only available on the Heart Link website.' }) : PAYOUTS_ENABLED ? next() : res.status(403).json({ error: 'Cash-out is not available.' });
// The ID check is open when cash-out is on OR when private rooms need people to prove they are 18+ (PRIVATE_AGE_GATE, on unless set to false).
const kycOpen = (req, res, next) => (PAYOUTS_ENABLED || process.env.PRIVATE_AGE_GATE !== 'false') ? next() : res.status(403).json({ error: 'ID verification is not available.' });

/* ---------- Currency: USD is the base. Every other currency is only a conversion at the current exchange rate ---------- */
const CURRENCIES = ['USD', 'NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'XOF', 'EGP', 'MAD', 'GBP', 'EUR', 'CAD', 'AUD', 'INR', 'AED', 'BRL', 'MXN', 'PHP'];
const FX_TTL = (Number(process.env.FX_REFRESH_MINUTES) || 360) * 60000;      // refresh the rates every 6 hours by default
let fxCache = { rates: { USD: 1 }, ok: false, at: 0, next: 0 };
async function getRates() {
  if (Date.now() < fxCache.next) return fxCache;
  try {
    const r = await axios.get(process.env.FX_URL || 'https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    const all = r.data && r.data.rates;
    if (!all || r.data.result === 'error') throw new Error('bad exchange-rate response');
    const rates = { USD: 1 };
    for (const c of CURRENCIES) if (c !== 'USD' && Number(all[c]) > 0) rates[c] = Number(all[c]);
    fxCache = { rates, ok: true, at: Date.now(), next: Date.now() + FX_TTL };
  } catch (e) {
    console.warn('Exchange-rate fetch failed:', e.message);
    fxCache = { ...fxCache, next: Date.now() + 60000 };      // keep the last good rates (if any) and try again in a minute
  }
  return fxCache;
}
app.get('/fx/rates', wrap(async (req, res) => {
  const f = await getRates();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ base: 'USD', rates: f.rates, live: f.ok, updatedAt: f.at });
}));
const MIN_WITHDRAW_TOKENS = Number(process.env.MIN_WITHDRAW_TOKENS) || 250;  // smallest request allowed
const WITHDRAW_FEE_PCT = Math.min(25, Math.max(0, Number(process.env.WITHDRAW_FEE_PCT ?? 5) || 0));      // % of a cash-out kept by the platform (default 5)
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

app.get('/payout/config', (req, res) => res.json({ payoutsEnabled: isPlayClient(req) ? false : PAYOUTS_MODE === 'true' ? true : PAYOUTS_MODE === 'web' ? 'web' : false, usdPerToken: USD_PER_TOKEN, withdrawFeePct: WITHDRAW_FEE_PCT, packs: Object.entries(PACKS).map(([id, p]) => ({ id, tokens: p.tokens, bonus: p.bonus || 0, usd: p.usd })), min: MIN_WITHDRAW_TOKENS, holdDays: HOLD_DAYS, minAgeDays: MIN_ACCOUNT_AGE_DAYS, kycRequired: KYC_REQUIRED }));

app.post('/wallet/withdraw', fbAuth, payoutsOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const tokens = Number(b.tokens);
  let bankName = String(b.bankName || '').trim().slice(0, 60);
  let accountName = String(b.accountName || '').trim().slice(0, 80);
  const accountNumber = String(b.accountNumber || '').replace(/\s/g, '');
  if (!Number.isInteger(tokens) || tokens < MIN_WITHDRAW_TOKENS) throw httpErr(400, `Minimum withdrawal is ${MIN_WITHDRAW_TOKENS} tokens`);
  if (tokens > 1000000) throw httpErr(400, 'Invalid amount');
  const payCurrency = String(b.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(payCurrency)) throw httpErr(400, 'Unsupported currency');
  const swift = String(b.swift || '').replace(/\s/g, '').toUpperCase().slice(0, 20);
  if (!/^[A-Z0-9-]*$/.test(swift)) throw httpErr(400, 'Invalid SWIFT/BIC or routing number');
  if (payCurrency === 'NGN' ? !/^\d{10}$/.test(accountNumber) : !/^[A-Za-z0-9-]{4,34}$/.test(accountNumber))
    throw httpErr(400, payCurrency === 'NGN' ? 'Account number must be 10 digits' : 'Enter a valid account number or IBAN');
  const fx = await getRates();
  if (payCurrency !== 'USD' && !fx.rates[payCurrency]) throw httpErr(503, 'Exchange rates are unavailable right now. Try again shortly, or choose USD.');
  const fxRate = payCurrency === 'USD' ? 1 : fx.rates[payCurrency];
  // const usd = Math.round(tokens * USD_PER_TOKEN * 100) / 100, local = ...      // superseded: the platform's cash-out fee is now taken here
  const grossUsd = Math.round(tokens * USD_PER_TOKEN * 100) / 100, feeUsd = Math.round(grossUsd * WITHDRAW_FEE_PCT) / 100;
  const usd = Math.round((grossUsd - feeUsd) * 100) / 100, local = Math.round(usd * fxRate * 100) / 100;   // usd is what is paid out after the fee; local is that at today's rate
  if (await isFrozen(req.uid)) throw httpErr(403, FROZEN_MSG);
  // identity first: no verified ID, no cash-out
  const kyc = await kycStatus(req.uid), extraFlags = [];
  if (KYC_REQUIRED && kyc.status !== 'approved') throw httpErr(403, 'KYC_REQUIRED');
  // Bank details are typed in by the creator. The admin page shows the account name next to the verified ID name before anyone is paid.
  if (bankName.length < 2 || accountName.length < 2) throw httpErr(400, 'Enter your bank name and the name on the account');
  if (kyc.legalName && !namesMatch(kyc.legalName, accountName)) extraFlags.push(`Account name "${accountName}" differs from verified name "${kyc.legalName}"`);
  rateLimit(req.uid, 'withdraw', 5, 3600000);
  const f = fsdb(), uref = f.collection('users').doc(req.uid);
  let id;
  const scored = await scoreEarner(req.uid).catch(() => []);      // strong signals freeze the account right here
  for (const x of scored) if (x.freeze) await freezePayouts(req.uid, x.code, x.text).catch(() => {});
  if (await isFrozen(req.uid)) throw httpErr(403, FROZEN_MSG);
  const flags = scored.map(x => x.text); flags.push(...extraFlags);
  await f.runTransaction(async t => {
    const [us, pend, held] = await Promise.all([
      t.get(uref),
      t.get(f.collection('withdrawals').where('uid', '==', req.uid).where('status', '==', 'pending').limit(1)),
      t.get(uref.collection('earnings').where('releaseAt', '>', admin.firestore.Timestamp.now())),
    ]);
    if (!us.exists) throw httpErr(404, 'Account not found');
    const born = us.data().createdAt && us.data().createdAt.toMillis ? us.data().createdAt.toMillis() : 0;
    if (born && Date.now() - born < MIN_ACCOUNT_AGE_DAYS * 86400000) throw httpErr(403, `New accounts can withdraw after ${MIN_ACCOUNT_AGE_DAYS} days`);
    if (!pend.empty) throw httpErr(409, 'You already have a withdrawal waiting for review');
    const bal = us.data().creatorBalance || 0, available = Math.max(0, bal - sumTokens(held));
    if (bal < tokens) throw httpErr(402, 'You do not have that many earnings');
    if (available < tokens) throw httpErr(402, `Only ${available} tokens are available. The rest is on a ${HOLD_DAYS}-day hold.`);
    const wref = f.collection('withdrawals').doc(); id = wref.id;
    t.update(uref, { creatorBalance: FV().increment(-tokens) });
    t.set(wref, { uid: req.uid, name: us.data().name || '', tokens, usdPerToken: USD_PER_TOKEN, grossUsd, feePct: WITHDRAW_FEE_PCT, feeUsd, usd, currency: payCurrency, fx: fxRate, local, swift,
      bankName, accountName, accountNumber, flags, kycName: kyc.legalName || '', verified: !!us.data().verified, status: 'pending', createdAt: FV().serverTimestamp() });
    t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'withdraw_hold', tokens: -tokens, withdrawalId: wref.id, createdAt: FV().serverTimestamp() });
  });
  res.json({ ok: true, id });
}));

// Creator earnings -> spendable tokens (1 for 1). Same hold + freeze rules as a withdrawal, but no money ever leaves the app.
app.post('/wallet/convert-earnings', fbAuth, wrap(async (req, res) => {
  const tokens = Number((req.body || {}).tokens);
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 1000000) throw httpErr(400, 'Invalid amount');
  rateLimit(req.uid, 'convert', 10, 60000);
  if (await isFrozen(req.uid)) throw httpErr(403, FROZEN_MSG);
  const f = fsdb(), uref = f.collection('users').doc(req.uid);
  await f.runTransaction(async t => {
    const [us, held] = await Promise.all([t.get(uref), t.get(uref.collection('earnings').where('releaseAt', '>', admin.firestore.Timestamp.now()))]);
    if (!us.exists) throw httpErr(404, 'Account not found');
    const bal = us.data().creatorBalance || 0, available = Math.max(0, bal - sumTokens(held));
    if (available < tokens) throw httpErr(402, `Only ${available} tokens are available. The rest is on a ${HOLD_DAYS}-day hold.`);
    t.update(uref, { creatorBalance: FV().increment(-tokens), tokens: FV().increment(tokens) });
    t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'earnings_convert', tokens, createdAt: FV().serverTimestamp() });
  });
  res.json({ ok: true, tokens });
}));

// Admin side: protected by the ADMIN_SECRET environment variable (sent as the x-admin-secret header).
function adminAuth(req, res, next) {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'Admin is not set up. Add ADMIN_SECRET on the server.' });
  const given = Buffer.from(String(req.get('x-admin-secret') || '')), want = Buffer.from(ADMIN_SECRET);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Wrong admin secret' });
  next();
}

app.get('/admin/withdrawals', adminAuth, wrap(async (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const snap = await fsdb().collection('withdrawals').where('status', '==', status).limit(200).get();
  const items = snap.docs.map(d => { const x = d.data(); return { id: d.id, ...x, createdAt: (x.createdAt && x.createdAt.toMillis && x.createdAt.toMillis()) || 0, resolvedAt: (x.resolvedAt && x.resolvedAt.toMillis && x.resolvedAt.toMillis()) || 0 }; })
    .sort((a, b) => status === 'pending' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  if (status === 'pending' && items.length) {
    const ab = await fsdb().getAll(...items.map(i => abuseRef(i.uid)));
    ab.forEach((d, i) => { items[i].frozen = d.exists && d.data().frozen === true; });
  }
  res.json({ items });
}));

app.post('/admin/withdrawals/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = req.body && req.body.action, note = String((req.body && req.body.note) || '').slice(0, 200);
  if (!['paid', 'reject'].includes(action)) throw httpErr(400, 'Invalid action');
  const f = fsdb(), wref = f.collection('withdrawals').doc(req.params.id);
  if (action === 'paid') { const w0 = await wref.get(); if (w0.exists && await isFrozen(w0.data().uid)) throw httpErr(409, 'This account is frozen. Review it under Flags before paying.'); }
  await f.runTransaction(async t => {
    const w = await t.get(wref);
    if (!w.exists) throw httpErr(404, 'Request not found');
    const d = w.data();
    if (d.status !== 'pending') throw httpErr(409, 'This request is already ' + d.status);
    const uref = f.collection('users').doc(d.uid), us = await t.get(uref);
    if (action === 'paid') {
      t.update(wref, { status: 'paid', note, resolvedAt: FV().serverTimestamp() });
    } else {
      t.update(wref, { status: 'rejected', note, resolvedAt: FV().serverTimestamp() });
      if (us.exists) t.update(uref, { creatorBalance: FV().increment(d.tokens) });   // give the tokens back
      t.set(f.collection('transactions').doc(), { uid: d.uid, type: 'withdraw_refund', tokens: d.tokens, withdrawalId: wref.id, createdAt: FV().serverTimestamp() });
    }
  });
  res.json({ ok: true });
}));

/* =====================================================================================================
   EARNINGS HOLD + ABUSE CHECKS
   New earnings carry a releaseAt date. creatorBalance is the total; "pending" is whatever is still on hold,
   and only (balance - pending) can be withdrawn. Nothing needs to run on a timer for this to work.
   ===================================================================================================== */
const HOLD_DAYS = Number(process.env.EARNINGS_HOLD_DAYS ?? 3);
const MIN_ACCOUNT_AGE_DAYS = Number(process.env.MIN_ACCOUNT_AGE_DAYS ?? 7);
const releaseAt = () => admin.firestore.Timestamp.fromMillis(Date.now() + HOLD_DAYS * 86400000);
const sumTokens = snap => snap.docs.reduce((n, d) => n + (Number(d.data().tokens) || 0), 0);

/* =====================================================================================================
   ANTI-ABUSE
   - Every browser registers a random device id (POST /abuse/device). Accounts that share a device are linked.
   - Gifts, tips, tickets and calls between accounts on the SAME device are held for SUSPECT_HOLD_DAYS and marked.
   - scoreEarner() looks at where an account's earnings come from. Strong signals FREEZE payouts automatically
     (abuse/{uid}.frozen). A frozen account cannot withdraw and the admin page cannot mark its requests paid.
   - The admin reviews frozen accounts under Flags: clear (unfreeze), keep frozen, or suspend the account.
   Signals are heuristics, not proof. A device id can be cleared by someone who knows how, so this raises the cost
   of farming; it does not make it impossible.
   ===================================================================================================== */
const abuseRef = uid => fsdb().collection('abuse').doc(uid);
const deviceKey = id => crypto.createHash('sha256').update('dev:' + id).digest('hex').slice(0, 40);
const MAX_DEVICE_ACCOUNTS = Number(process.env.MAX_ACCOUNTS_PER_DEVICE) || 2;
const SUSPECT_HOLD_DAYS = Number(process.env.SUSPECT_HOLD_DAYS) || 30;
const suspectReleaseAt = () => admin.firestore.Timestamp.fromMillis(Date.now() + SUSPECT_HOLD_DAYS * 86400000);
const FROZEN_MSG = 'Your payouts are paused while we review your account. Please contact support.';

async function isFrozen(uid) { const s = await abuseRef(uid).get(); return s.exists && s.data().frozen === true; }
async function freezePayouts(uid, code, text) {
  const ref = abuseRef(uid), s = await ref.get(), d = s.exists ? s.data() : {};
  if ((d.clearedCodes || []).includes(code)) return false;           // an admin already reviewed this exact signal
  if (d.frozen && d.reasons && d.reasons[code]) return true;
  await ref.set({ uid, frozen: true, ...(d.frozen ? {} : { frozenAt: FV().serverTimestamp() }), reasons: { [code]: String(text).slice(0, 200) } }, { merge: true });
  console.warn('Payouts frozen', uid, code, text);
  return true;
}
async function sharedDevice(a, b) {
  const snap = await fsdb().collection('devices').where('uids', 'array-contains', a).limit(20).get();
  return snap.docs.some(d => (d.data().uids || []).includes(b));
}
// '' when the pair looks normal, otherwise a short reason. Never throws.
async function suspectReason(from, to) {
  try { return (await sharedDevice(from, to)) ? 'Sender and receiver use the same device' : ''; } catch { return ''; }
}

// Returns [{ code, text, freeze }]. "freeze" signals are strong enough to pause payouts without waiting for a person.
async function scoreEarner(uid) {
  const f = fsdb(), out = [], dayAgo = Date.now() - 86400000;
  const snap = await f.collection('users').doc(uid).collection('earnings').orderBy('createdAt', 'desc').limit(200).get();
  const by = {}, recent = {}; let total = 0, held = 0;
  snap.docs.forEach(d => {
    const x = d.data(), t = Number(x.tokens) || 0, at = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
    total += t; if (x.suspect) held++;
    if (x.from) { by[x.from] = (by[x.from] || 0) + t; if (at > dayAgo) recent[x.from] = (recent[x.from] || 0) + t; }
  });
  const senders = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (total >= 100 && senders.length && senders[0][1] / total > 0.7) {
    const pct = Math.round(senders[0][1] / total * 100);
    out.push({ code: 'one_sender', text: `${pct}% of earnings come from one account (${senders[0][0]})`, freeze: total >= 300 && pct >= 85 });
  }
  for (const [sid, got] of senders.slice(0, 3)) {
    if (!sid) continue;
    const back = await f.collection('users').doc(sid).collection('earnings').where('from', '==', uid).limit(100).get();
    const sent = sumTokens(back);
    if (!back.empty) out.push({ code: 'mutual', text: `Mutual gifting with ${sid} (${got} tokens in, ${sent} out)`, freeze: got >= 100 && sent >= 100 });
  }
  for (const [sid, got] of senders.slice(0, 5)) {
    if (sid && await sharedDevice(uid, sid).catch(() => false)) out.push({ code: 'same_device', text: `Shares a device with ${sid}, who sent ${got} tokens`, freeze: got >= 50 });
  }
  const ids = Object.keys(recent);
  if (ids.length >= 5) {
    const docs = await f.getAll(...ids.slice(0, 40).map(i => f.collection('users').doc(i)));
    const fresh = docs.filter(d => d.exists && d.data().createdAt && d.data().createdAt.toMillis && Date.now() - d.data().createdAt.toMillis() < 3 * 86400000);
    const sum = fresh.reduce((n, d) => n + (recent[d.id] || 0), 0);
    if (fresh.length >= 5 && sum >= 200) out.push({ code: 'new_account_burst', text: `${fresh.length} accounts under 3 days old sent ${sum} tokens in the last 24 hours`, freeze: true });
  }
  if (held) out.push({ code: 'held', text: `${held} recent earning(s) were held as suspicious`, freeze: false });
  return out;
}
async function evaluateAndFreeze(uid) {
  const scored = await scoreEarner(uid);
  for (const x of scored) if (x.freeze) await freezePayouts(uid, x.code, x.text).catch(() => {});
  return scored;
}
// Re-score a receiver at most every 10 minutes, so a busy host does not cost a read-heavy check per gift.
const scoredAt = new Map();
function maybeScore(uid) {
  if (scoredAt.size > 5000) scoredAt.clear();
  if (Date.now() - (scoredAt.get(uid) || 0) < 600000) return;
  scoredAt.set(uid, Date.now());
  evaluateAndFreeze(uid).catch(() => {});
}
const abuseFlags = async uid => (await scoreEarner(uid)).map(x => x.text);

// The browser reports its device id after sign-in.
app.post('/abuse/device', fbAuth, wrap(async (req, res) => {
  const id = String((req.body || {}).deviceId || '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) throw httpErr(400, 'Invalid device');
  rateLimit(req.uid, 'device', 20, 3600000);
  const f = fsdb(), ref = f.collection('devices').doc(deviceKey(id));
  let uids = [];
  await f.runTransaction(async t => {
    const s = await t.get(ref); uids = s.exists ? (s.data().uids || []) : [];
    if (!uids.includes(req.uid)) uids = [...uids, req.uid].slice(-20);
    t.set(ref, { uids, lastSeen: FV().serverTimestamp(), ...(s.exists ? {} : { firstSeen: FV().serverTimestamp() }) }, { merge: true });
  });
  if (uids.length > MAX_DEVICE_ACCOUNTS) {
    const live = (await f.getAll(...uids.map(u => f.collection('users').doc(u)))).filter(d => d.exists).map(d => d.id);   // deleted accounts do not count
    if (live.length > MAX_DEVICE_ACCOUNTS) for (const u of live) await freezePayouts(u, 'multi_device', `${live.length} accounts have signed in on one device`);
  }
  res.json({ ok: true });
}));
app.post('/payout/status', fbAuth, wrap(async (req, res) => res.json({ frozen: await isFrozen(req.uid) })));

// Admin: review frozen accounts
app.get('/admin/abuse', adminAuth, wrap(async (req, res) => {
  const f = fsdb(), snap = await f.collection('abuse').where('frozen', '==', true).limit(100).get(), items = [];
  for (const d of snap.docs) {
    const a = d.data(), [us, ks, dv] = await Promise.all([f.collection('users').doc(d.id).get(), kycRef(d.id).get(), f.collection('devices').where('uids', 'array-contains', d.id).limit(10).get()]);
    const mates = [...new Set(dv.docs.flatMap(x => x.data().uids || []))].filter(x => x !== d.id);
    items.push({ id: d.id, name: us.exists ? us.data().name || '' : '(deleted account)', balance: us.exists ? us.data().creatorBalance || 0 : 0, disabled: false,
      kycName: ks.exists ? ks.data().legalName || '' : '', kycStatus: ks.exists ? ks.data().status : 'none', reasons: Object.values(a.reasons || {}), deviceMates: mates,
      createdAt: (a.frozenAt && a.frozenAt.toMillis && a.frozenAt.toMillis()) || 0 });
  }
  items.sort((x, y) => y.createdAt - x.createdAt);
  res.json({ items });
}));
app.post('/admin/abuse/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, f = fsdb(), ref = abuseRef(req.params.id), uid = req.params.id;
  if (action === 'clear') {
    const s = await ref.get(), codes = Object.keys((s.exists && s.data().reasons) || {});
    await ref.set({ frozen: false, reasons: {}, clearedAt: FV().serverTimestamp(), ...(codes.length ? { clearedCodes: FV().arrayUnion(...codes) } : {}) }, { merge: true });
    // earnings that were held 30 days only because of the flag go back onto the normal hold
    const held = await f.collection('users').doc(uid).collection('earnings').where('releaseAt', '>', admin.firestore.Timestamp.now()).limit(200).get();
    const w = f.bulkWriter(); held.docs.filter(d => d.data().suspect).forEach(d => w.update(d.ref, { releaseAt: releaseAt(), suspect: FV().delete(), reviewed: true })); await w.close();
  } else if (action === 'suspend') {
    await admin.auth().updateUser(uid, { disabled: true });
    await ref.set({ frozen: true, suspended: true }, { merge: true });
  } else if (action === 'freeze') {
    await ref.set({ uid, frozen: true, frozenAt: FV().serverTimestamp(), reasons: { manual: 'Frozen by an admin' } }, { merge: true });
  } else throw httpErr(400, 'Invalid action');
  res.json({ ok: true });
}));

/* App-wide top gifters: leaderboards/{all | w<week>}/gifters/{uid}. A week starts on Monday (UTC). */
const weekKey = () => 'w' + Math.floor((Date.now() - 4 * 86400000) / (7 * 86400000));
const lbRef = (period, uid) => fsdb().collection('leaderboards').doc(period).collection('gifters').doc(uid);
app.post('/board/hide', fbAuth, wrap(async (req, res) => {
  const hide = (req.body || {}).hide === true;
  await fsdb().collection('users').doc(req.uid).update({ hideFromBoard: hide });
  if (hide) await deleteRefs([lbRef('all', req.uid), lbRef(weekKey(), req.uid)]);
  res.json({ hide });
}));

/* =====================================================================================================
   LIVE ROOMS: lifecycle, real audio/video (Agora live mode), host controls, goals, paid rooms, reminders
   rooms/{id}: title, category, kind('video'|'audio'), status('live'|'scheduled'|'ended'), hostId, hostName, hostPhoto,
   entryFee, startsAt, lastBeat, viewers, goal{label,target,progress}, pinned{text,by}, announce{text,by,at,seconds,until}
   subcollections: messages, viewers/{uid}, members/{uid} (paid), bans/{uid}, mutes/{uid}, reminders/{uid}, gifters/{uid}
   ===================================================================================================== */
const ROOM_CATS_SERVER = ['Lagos', 'Music', 'Chill', 'Dating Talk', 'Games', 'Speed Dating', 'Ask Me Anything', 'Ice-breakers'];
// const MAX_AUDIENCE = Number(process.env.MAX_ROOM_AUDIENCE) || 100;          // superseded: raised so big rooms (2,000+) can fill
const MAX_AUDIENCE = Number(process.env.MAX_ROOM_AUDIENCE) || 5000;          // Agora bills per minute per person: still a cap (set MAX_ROOM_AUDIENCE on Render to change it without code)
const BIG_ROOM_AT = Number(process.env.BIG_ROOM_AT) || 150;                  // from this many viewers a room stops posting join / leave / first-like lines in the chat (keeps the chat readable and Firestore writes low)
const bigJoins = new Map();                                                  // roomId -> people who joined since the last summary line (big rooms only)
const bigRooms = new Set();                                                  // room ids currently at or above BIG_ROOM_AT (refreshed by the 30s sweep and on every join)
const MAX_ROOM_FEE = 500;
const ICEBREAKERS = [
  'What is the most spontaneous thing you have ever done?', 'Coffee date or dinner date, and why?',
  'What song is on repeat for you right now?', 'What is your ideal Sunday in Lagos?',
  'Which red flag do you secretly find funny?', 'Describe your perfect first date in one sentence.',
  'What is one thing you are proud of this year?', 'Jollof or fried rice? Defend your answer.',
  'What is a small thing that makes you feel loved?', 'If we could travel anywhere this weekend, where to?',
  'What is your love language, and how do you show it?', 'What is a green flag people overlook?',
  'Which talent would you secretly love to have?', 'Describe your best friend in three words.',
  'What would we be doing on a perfect second date?', 'What is the best advice you have ever been given?',
];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Join / leave / first-like notices in the live chat. A failure here must never break joining, so errors are swallowed.
const presenceMsg = (ref, kind, uid, name) => bigRooms.has(ref.id) ? Promise.resolve() : ref.collection('messages').add({ type: 'presence', kind, from: uid, fromName: String(name || 'Someone').slice(0, 40), createdAt: FV().serverTimestamp() }).catch(() => {});
const sysMsg = (ref, r, text) => ref.collection('messages').add({ type: 'system', text, from: r.hostId, fromName: r.hostName || '', createdAt: FV().serverTimestamp() });
let roundsHot = true;     // false once a check finds no room running rounds (saves Firestore reads)
const roomRef = id => { if (!SAFE_ID.test(String(id))) throw httpErr(400, 'Invalid room'); return fsdb().collection('rooms').doc(id); };
async function getRoom(id) { const s = await roomRef(id).get(); if (!s.exists) throw httpErr(404, 'Room not found'); return { id, ref: s.ref, ...s.data() }; }
function roomCreds(channel, publisher) {
  const appId = process.env.AGORA_APP_ID, cert = process.env.AGORA_APP_CERTIFICATE;
  if (!appId || !cert) throw httpErr(503, 'Live rooms are not configured on the server');
  // uid 0 = the token works for whatever uid Agora assigns; the SUBSCRIBER role stops audience from publishing
  const token = RtcTokenBuilder.buildTokenWithUid(appId, cert, channel, 0, publisher ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER, CALL_TTL, CALL_TTL);
  return { appId, channel, token, role: publisher ? 'host' : 'audience' };
}
const mustHost = (r, uid) => { if (r.hostId !== uid) throw httpErr(403, 'Only the host can do that'); };
const needPhoto = u => { if (!photoOf(u)) throw httpErr(403, 'Add a profile photo first'); };

// The host's own message for the "I'm live" push (plain text only: links, control characters and extra spaces are removed, 100 characters max).
const cleanPushText = t => String(t || '').replace(/https?:\/\/\S+|www\.\S+/gi, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
// Word filter for the host's \"I'm live\" message (a user-written push). Server-side only: nothing in the app changes.
// Catches stretched letters (fuuuck), look-alike symbols (sh1t, f@ck), dots/dashes between letters (f.u.c.k) and accents, on whole words only
// so normal words are not blocked. Add or remove words in the list below any time; no app update is needed.
const PUSH_BLOCKED_WORDS = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'cunt', 'asshole', 'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'tranny', 'rape', 'rapist', 'porn', 'porno', 'nude', 'nudes', 'xxx', 'nsfw', 'onlyfans', 'horny', 'blowjob', 'handjob',
  'cum', 'cumshot', 'sexting', 'kys', 'suicide', 'terrorist', 'hitler'];
const PUSH_BLOCKED_RE = new RegExp('\\b(?:' + PUSH_BLOCKED_WORDS.map(w => w.replace(/[a-z]/g, (c, i) => {
  const dbl = w[i + 1] === c || w[i - 1] === c;          // a letter written twice in the word (ss, ll) must still appear at least twice
  return (dbl ? c + '{1,}' : c + '+') + '[.\\-_]{0,2}';
}).replace(/\[\.\\-_\]\{0,2\}$/, '')).join('|') + ')\\b', 'i');
const LEET = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't' };
const pushTextBlocked = t => {
  const norm = String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[01!34@5$7]/g, c => LEET[c]);
  return PUSH_BLOCKED_RE.test(norm);
};
app.post('/rooms/create', fbAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 60);
  if (title.length < 3) throw httpErr(400, 'Give the room a title (at least 3 letters)');
  if (!ROOM_CATS_SERVER.includes(b.category)) throw httpErr(400, 'Pick a category');
  const kind = b.kind === 'audio' ? 'audio' : 'video';
  const entryFee = Math.max(0, Math.min(MAX_ROOM_FEE, Math.floor(Number(b.entryFee) || 0)));
  let startsAt = Number(b.startsAt) || 0, status = 'live';
  if (startsAt) {
    if (startsAt < Date.now() + 120000 && startsAt > Date.now() - 60000) startsAt = 0;       // "now"
    else if (startsAt < Date.now() || startsAt > Date.now() + 30 * 86400000) throw httpErr(400, 'Pick a start time within the next 30 days');
    else status = 'scheduled';
  }
  const goalTarget = Math.floor(Number(b.goalTarget) || 0), goalLabel = String(b.goalLabel || '').trim().slice(0, 50);
  // const pushText = cleanPushText(b.pushText);   // superseded: a message that fails the word filter is dropped and the usual "is live" alert is sent instead
  let pushText = cleanPushText(b.pushText); if (pushText && pushTextBlocked(pushText)) pushText = '';
  rateLimit(req.uid, 'roomcreate', 6, 3600000);
  if (status === 'live') await assertCanGoLive(req.uid);      // strike restriction
  const me = await getUserDoc(req.uid); needPhoto(me);
  const f = fsdb();
  const live = await f.collection('rooms').where('hostId', '==', req.uid).where('status', '==', 'live').limit(1).get();
  if (status === 'live' && !live.empty) throw httpErr(409, 'You already have a live room. End it first.');
  const ref = f.collection('rooms').doc();
  const channel = `room_${ref.id}`;
  const creds = status === 'live' ? roomCreds(channel, true) : null;          // throws 503 before anything is written
  await ref.set({
    title, category: b.category, kind, status, city: me.city || '', hostId: req.uid, hostName: me.name || '', hostPhoto: photoOf(me),
    entryFee, channel, viewers: 0, lastBeat: Date.now(), createdAt: FV().serverTimestamp(),
    ...(pushText ? { pushText } : {}),
    ...(status === 'scheduled' ? { startsAt, reminded: false } : {}),
    ...(goalTarget >= 10 && goalLabel ? { goal: { label: goalLabel, target: Math.min(goalTarget, 100000), progress: 0 } } : {}),
  });
  if (status === 'live') notifyFollowersLive({ id: ref.id, hostId: req.uid, hostName: me.name || '', hostPhoto: photoOf(me), title, pushText }).catch(() => {});
  res.json({ id: ref.id, status, ...(creds ? { creds } : {}) });
}));

// Host taps "Go live" on a scheduled room.
app.post('/rooms/:id/start', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  await assertCanGoLive(req.uid);      // strike restriction
  if (r.status === 'ended') throw httpErr(409, 'This room has ended');
  const live = await fsdb().collection('rooms').where('hostId', '==', req.uid).where('status', '==', 'live').limit(1).get();
  if (!live.empty && live.docs[0].id !== r.id) throw httpErr(409, 'You already have a live room. End it first.');
  await r.ref.update({ status: 'live', lastBeat: Date.now(), startedAt: FV().serverTimestamp() });
  notifyFollowersLive(r).catch(() => {});
  res.json({ creds: roomCreds(r.channel, true) });
}));

// Host ping (keeps the room alive) and viewer ping (counts toward the viewer number). Call every ~30s.
// @mentions in a live-room chat. The chat itself is written straight to Firestore by the app; right after posting, the app
// asks the server to send the alerts. The server reads the text from the saved message (never from the request), so only
// the author's own message counts, once. @all works for the host only and alerts everyone who follows the host.
app.post('/rooms/:id/mention', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'roommention', 20, 60000);
  const messageId = String((req.body && req.body.messageId) || '');
  if (!SAFE_ID.test(messageId)) throw httpErr(400, 'Invalid message');
  const r = await getRoom(req.params.id);
  if (r.status !== 'live') return res.json({ ok: true, sent: 0 });
  const mref = r.ref.collection('messages').doc(messageId), ms = await mref.get();
  if (!ms.exists) return res.json({ ok: true, sent: 0 });
  const m = ms.data(), t0 = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0;
  if (m.from !== req.uid || (m.type && m.type !== 'text') || m.mentioned || !t0 || Date.now() - t0 > 120000) return res.json({ ok: true, sent: 0 });
  const text = String(m.text || '').trim().slice(0, 300), mn = parseMentions(text);
  if (!mn.all && !mn.handles.length) return res.json({ ok: true, sent: 0 });
  if (mn.all && r.hostId === req.uid) rateLimit(req.uid, 'mentionall', 3, 600000);
  await mref.update({ mentioned: true });
  const me = await getUserDoc(req.uid);
  const canSee = async t => {
    if (t === r.hostId) return true;
    if ((await r.ref.collection('bans').doc(t).get()).exists) return false;
    if (r.private) { const [g, i] = await Promise.all([r.ref.collection('guests').doc(t).get(), r.ref.collection('invites').doc(t).get()]); if (!g.exists && !i.exists) return false; }
    return true;
  };
  notifyMentions({ mn, text, from: req.uid, me, ownerId: r.hostId, commentId: messageId, canSee, meta: { k: 'room', id: r.id } }).catch(e => console.warn('room mention alerts failed', e.message));
  res.json({ ok: true });
}));
const pingRoomCache = new Map();      // roomId -> { at, r }: 2,000 viewers pinging every ~30s would otherwise read the room doc ~65 times a second
setInterval(() => { const cut = Date.now() - 20000; for (const [k, v] of pingRoomCache) if (v.at < cut) pingRoomCache.delete(k); }, 30000).unref();
async function getRoomForPing(id, uid) {
  const c = pingRoomCache.get(id);
  if (c && Date.now() - c.at < 5000 && c.r.hostId !== uid && c.r.status !== 'ended') return c.r;
  const r = await getRoom(id); pingRoomCache.set(id, { at: Date.now(), r }); return r;
}
app.post('/rooms/:id/ping', fbAuth, wrap(async (req, res) => {
  // const r = await getRoom(req.params.id);      // superseded: cached for 5 seconds (the host's own ping and ended rooms always read fresh)
  const r = await getRoomForPing(req.params.id, req.uid);
  if (r.status === 'ended') return res.json({ ended: true });
  if (r.hostId === req.uid) { await r.ref.update({ lastBeat: Date.now() }); return res.json({ ok: true, viewers: r.viewers || 0 }); }
  const vref = r.ref.collection('viewers').doc(req.uid);
  const banned = await r.ref.collection('bans').doc(req.uid).get();
  if (banned.exists) return res.json({ removed: true });
  if (r.private) {
    const [pg, pi] = await Promise.all([r.ref.collection('guests').doc(req.uid).get(), r.ref.collection('invites').doc(req.uid).get()]);
    if (!pg.exists && !pi.exists) { await vref.delete().catch(() => {}); return res.json({ removed: true }); }
    if (MOD.privateRoom.requireMutualConsent && !(await r.ref.collection('consents').doc(req.uid).get()).exists) {      // still has to agree to the private rules
      if (Date.now() - (r.privateAt || 0) > (MOD.privateRoom.consentWindowSeconds || 60) * 1000) {
        await Promise.all(['viewers', 'guests', 'requests', 'invites'].map(sub => r.ref.collection(sub).doc(req.uid).delete().catch(() => {})));
        return res.json({ removed: true });
      }
      return res.json({ ok: true, needConsent: true, viewers: r.viewers || 0 });
    }
  }
  await vref.set({ seen: Date.now() }, { merge: true });      // also re-adds someone the sweeper dropped while their tab slept
  questWatch(req.uid);
  res.json({ ok: true, viewers: r.viewers || 0 });
}));

// Audience (or the host coming back) joins. Paid rooms charge once; the host gets the usual 80%.
app.post('/rooms/:id/join', fbAuth, wrap(async (req, res) => {
  const f = fsdb(), r = await getRoom(req.params.id);
  if (r.status !== 'live') throw httpErr(409, r.status === 'scheduled' ? 'This room has not started yet' : 'This room has ended');
  if (r.hostId === req.uid) return res.json({ creds: roomCreds(r.channel, true), host: true, now: Date.now() });
  if ((await r.ref.collection('bans').doc(req.uid).get()).exists) throw httpErr(403, 'You were removed from this room');
  if (await isBlocked(req.uid, r.hostId)) throw httpErr(403, 'You cannot join this room');
  if (r.private) {      // private room: only people on stage and guests the host invited
    const [pg, pi] = await Promise.all([r.ref.collection('guests').doc(req.uid).get(), r.ref.collection('invites').doc(req.uid).get()]);
    if (!pg.exists && !pi.exists) throw httpErr(403, 'This room is private. Only invited guests can join.');
    await privateGate(r, req);      // 18+ verified and agreed to the private room rules
  }
  const vref = r.ref.collection('viewers').doc(req.uid);
  const had = (await vref.get()).exists;
  if (!had && (r.viewers || 0) >= MAX_AUDIENCE) throw httpErr(429, 'This room is full right now');
  const me = await getUserDoc(req.uid);
  let paid = 0;
  const payEntry = (r.entryFee || 0) > 0 && !req.isTestAdmin;   // test admins walk into paid rooms free, to test live streaming
  const sus = payEntry ? await suspectReason(req.uid, r.hostId) : '';
  if (payEntry) {
    const mref = r.ref.collection('members').doc(req.uid), uref = f.collection('users').doc(req.uid), href = f.collection('users').doc(r.hostId);
    await Promise.all([ensureLedger(req.uid, req.phone), ensureLedger(r.hostId)]);
    await f.runTransaction(async t => {
      const [ms, us, hs] = await Promise.all([t.get(mref), t.get(uref), t.get(href)]);
      if (ms.exists) return;
      if ((us.data().tokens || 0) < r.entryFee) throw httpErr(402, 'INSUFFICIENT_TOKENS');
      t.update(uref, { tokens: FV().increment(-r.entryFee) });
      t.set(f.collection('transactions').doc(), { uid: req.uid, type: 'room_pass', tokens: -r.entryFee, to: r.hostId, roomId: r.id, createdAt: FV().serverTimestamp() });
      if (hs.exists) payCreator(t, { payerId: req.uid, P: us.data(), earnerId: r.hostId, earnerRef: href, E: hs.data(), coins: r.entryFee, earning: { type: 'room', label: 'Room ticket', emoji: '🎟️', fromName: me.name || '', ...(sus ? { suspect: true } : {}) } });
      t.set(mref, { paid: r.entryFee, at: FV().serverTimestamp() });
      paid = r.entryFee;
    });
  }
  await vref.set({ seen: Date.now(), name: me.name || '' });
  qAdd(req.uid, 'v_join', 1, r.id).catch(() => {});
  if ((r.viewers || 0) >= BIG_ROOM_AT) bigRooms.add(r.id);
  if (!had && bigRooms.has(r.id)) bigJoins.set(r.id, (bigJoins.get(r.id) || 0) + 1);      // big room: counted, and shown as one summary line by the sweep
  if (!had) presenceMsg(r.ref, 'join', req.uid, me.name);
  if (sus && paid) freezePayouts(r.hostId, 'same_device', sus).catch(() => {});
  res.json({ creds: roomCreds(r.channel, false), paid, now: Date.now() });
}));

// Muted video-only preview for the Live list: public, free, video lives only. No ticket, no viewer count, no join message.
app.post('/rooms/:id/preview', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'rpv', 40, 60000);
  const r = await getRoom(req.params.id);
  if (r.status !== 'live' || r.private || (r.entryFee || 0) > 0 || r.kind === 'audio' || r.hostId === req.uid) throw httpErr(403, 'No preview for this room');
  if (await isBlocked(req.uid, r.hostId)) throw httpErr(403, 'No preview for this room');
  if ((await r.ref.collection('bans').doc(req.uid).get()).exists) throw httpErr(403, 'No preview for this room');
  res.json({ creds: roomCreds(r.channel, false) });
}));

const likeBuf = new Map();      // roomId -> hearts waiting to be written
setInterval(async () => {
  for (const [id, n] of [...likeBuf]) { likeBuf.delete(id); await roomRef(id).update({ likes: FV().increment(n) }).catch(() => {}); }
}, 1500).unref();
app.post('/rooms/:id/like', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'rlike', 6, 10000);
  const r = await getRoom(req.params.id);
  if (r.status !== 'live' || r.hostId === req.uid) return res.json({ ok: true });      // the host only gets the animation
  const vref = r.ref.collection('viewers').doc(req.uid), v = await vref.get();
  if (!v.exists) return res.json({ ok: false });
  if (!v.data().liked) { await vref.set({ liked: true }, { merge: true }); presenceMsg(r.ref, 'like', req.uid, v.data().name); }
  likeBuf.set(r.id, (likeBuf.get(r.id) || 0) + Math.max(1, Math.min(20, parseInt(req.body && req.body.n, 10) || 1)));
  res.json({ ok: true });
}));

app.post('/rooms/:id/leave', fbAuth, wrap(async (req, res) => {
  const rr = roomRef(req.params.id), v = await rr.collection('viewers').doc(req.uid).get().catch(() => null);
  await Promise.all(['viewers', 'guests', 'requests', 'invites'].map(sub => rr.collection(sub).doc(req.uid).delete().catch(() => {})));
  if (v && v.exists) presenceMsg(rr, 'leave', req.uid, v.data().name);
  res.sendStatus(204);
}));

async function endRoom(ref, reason) {
  await ref.update({ status: 'ended', endReason: reason, endedAt: FV().serverTimestamp(), viewers: 0, roundActive: false });
  if (reason !== 'moderation' && reason !== 'reports') await streamRewards(ref).catch(e => console.warn('stream rewards failed', e.message));
  bigRooms.delete(ref.id); bigJoins.delete(ref.id); pingRoomCache.delete(ref.id);
  const vs = await ref.collection('viewers').get(); await deleteRefs(vs.docs.map(d => d.ref));
  for (const sub of ['guests', 'requests', 'invites']) { const x = await ref.collection(sub).get(); await deleteRefs(x.docs.map(d => d.ref)); }
}
app.post('/rooms/:id/end', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  if (r.status !== 'ended') await endRoom(r.ref, 'host');
  res.sendStatus(204);
}));

// Host controls: mute / unmute / ban a person, pin or unpin a message, post an ice-breaker, set a gift goal.
app.post('/rooms/:id/mod', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  pingRoomCache.delete(r.id);      // host changed something (private, announce, ...): viewer pings must see it straight away
  const { action, target, text, label, goalTarget } = req.body || {};
  const needTarget = () => { if (!SAFE_ID.test(String(target || '')) || target === req.uid) throw httpErr(400, 'Invalid person'); };
  if (action === 'mute') { needTarget(); await r.ref.collection('mutes').doc(target).set({ at: FV().serverTimestamp() }); }
  else if (action === 'unmute') { needTarget(); await r.ref.collection('mutes').doc(target).delete(); }
  else if (action === 'ban') {
    needTarget();
    await r.ref.collection('bans').doc(target).set({ at: FV().serverTimestamp() });
    await r.ref.collection('viewers').doc(target).delete().catch(() => {});
    for (const sub of ['guests', 'requests', 'invites']) await r.ref.collection(sub).doc(target).delete().catch(() => {});
  }
  else if (action === 'pin-product') {
    const url = cleanShopUrl(req.body.url), name = String(req.body.name || '').trim().slice(0, 80);
    if (!url) throw httpErr(400, 'Paste a full https:// product link');
    if (name.length < 2) throw httpErr(400, 'Give the product a name');
    const price = Number(req.body.price); if (!(price >= 0 && price <= 1e9)) throw httpErr(400, 'Enter a valid price');
    const image = cleanShopUrl(req.body.image) || '';
    const currency = /^[A-Z]{3}$/.test(String(req.body.currency || '')) ? req.body.currency : 'USD';
    await r.ref.update({ product: { url, name, price: Math.round(price * 100) / 100, currency, image, host: new URL(url).hostname.replace(/^www\./, ''), at: Date.now() } });
  }
  else if (action === 'unpin-product') { await r.ref.update({ product: FV().delete() }); }
  else if (action === 'pin') { await r.ref.update({ pinned: { text: String(text || '').slice(0, 200), by: r.hostName || '' } }); }
  else if (action === 'unpin') { await r.ref.update({ pinned: FV().delete() }); }
  else if (action === 'announce') {      // a timed message the host shows over the video for everyone in the room
    const t = String(text || '').trim().slice(0, 160); if (!t) throw httpErr(400, 'Write the message to show');
    const seconds = [10, 30, 60].includes(Number(req.body.seconds)) ? Number(req.body.seconds) : 10, now = Date.now();
    await r.ref.update({ announce: { text: t, by: r.hostName || '', at: now, seconds, until: now + seconds * 1000 } });
  }
  else if (action === 'unannounce') { await r.ref.update({ announce: FV().delete() }); }
  else if (action === 'prompt') {
    const q = String(text || '').trim().slice(0, 200) || ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
    await r.ref.collection('messages').add({ type: 'system', text: q, from: r.hostId, fromName: r.hostName || '', createdAt: FV().serverTimestamp() });
  }
  else if (action === 'unban') { needTarget(); await r.ref.collection('bans').doc(target).delete(); }
  else if (action === 'rounds-start') {
    if (r.status !== 'live') throw httpErr(409, 'Go live first');
    const seconds = Math.max(30, Math.min(600, Math.floor(Number(req.body.seconds) || 120))), total = Math.max(2, Math.min(20, Math.floor(Number(req.body.rounds) || 6)));
    const order = shuffle(ICEBREAKERS.map((_, i) => i)), q = ICEBREAKERS[order[0]];
    await r.ref.update({ roundActive: true, round: { n: 1, total, seconds, endsAt: Date.now() + seconds * 1000, q, order } });
    roundsHot = true;
    await sysMsg(r.ref, r, `Round 1 of ${total}: ${q}`);
  }
  else if (action === 'rounds-stop') {
    if (r.roundActive) { await r.ref.update({ roundActive: false, round: FV().delete() }); await sysMsg(r.ref, r, 'The host ended the rounds.'); }
  }
  else if (action === 'poll') {
    const pq = String(text || '').trim().slice(0, 120), a = String(req.body.a || '').trim().slice(0, 40), b = String(req.body.b || '').trim().slice(0, 40);
    if (pq.length < 3 || !a || !b) throw httpErr(400, 'Add a question and two options');
    await r.ref.update({ poll: { id: crypto.randomBytes(6).toString('hex'), text: pq, a, b, ca: 0, cb: 0, open: true } });
    await sysMsg(r.ref, r, `Poll: ${pq} (${a} or ${b}?)`);
  }
  else if (action === 'poll-close') { if (!r.poll) throw httpErr(409, 'No poll to close'); await r.ref.update({ 'poll.open': false }); }
  else if (action === 'poll-clear') { await r.ref.update({ poll: FV().delete() }); }
  else if (action === 'goal') {
    const gt = Math.floor(Number(goalTarget) || 0), gl = String(label || '').trim().slice(0, 50);
    if (gt >= 10 && gl) await r.ref.update({ goal: { label: gl, target: Math.min(gt, 100000), progress: 0 } });
    else await r.ref.update({ goal: FV().delete() });
  }
  else if (action === 'private') {
    const on = req.body.on === true || req.body.on === 'true';
    if (on) await hostPrivateGate(r, req);      // host must be 18+ verified and have agreed to the rules
    await r.ref.update(on ? { private: true, privateAt: Date.now() } : { private: false });
    if (on) await r.ref.collection('consents').doc(r.hostId).set({ at: FV().serverTimestamp(), v: MOD.privateRoom.consentVersion || 1, role: 'host' });
    else await clearConsents(r.ref);      // every private session asks for consent again
    if (on) {      // everyone except people on stage and invited guests is removed from the room
      const [vs, gs, is] = await Promise.all([r.ref.collection('viewers').get(), r.ref.collection('guests').get(), r.ref.collection('invites').get()]);
      const keep = new Set([...gs.docs.map(d => d.id), ...is.docs.map(d => d.id)]);
      await deleteRefs(vs.docs.filter(d => !keep.has(d.id)).map(d => d.ref));
      await sysMsg(r.ref, r, 'The host made this room private.');
    } else await sysMsg(r.ref, r, 'This room is public again.');
  }
  else if (action === 'grid') {      // how many tiles the big screen shows: 1 (solo) to 4 (host plus 3 guests)
    const n = Math.max(1, Math.min(BIG_MAX + 1, Math.floor(Number(req.body.n)) || 0));
    if (!(Math.floor(Number(req.body.n)) >= 1)) throw httpErr(400, 'Pick a grid layout');
    const cur = ((await r.ref.get()).data().stage) || [];
    await r.ref.update({ gridN: n, stage: cur.slice(0, n - 1) });
  }
  else if (action === 'seats') { await r.ref.update({ seatsLocked: req.body.on === true || req.body.on === 'true' }); }
  else throw httpErr(400, 'Invalid action');
  if (QUEST_INTERACT.has(action)) qAdd(req.uid, 'h_interact').catch(() => {});
  res.sendStatus(204);
}));

// Host-only list of who is banned / muted, with names, so they can be undone.
app.post('/rooms/:id/mod-list', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  const [bs, ms] = await Promise.all([r.ref.collection('bans').limit(100).get(), r.ref.collection('mutes').limit(100).get()]);
  const ids = [...new Set([...bs.docs, ...ms.docs].map(d => d.id))], info = {};
  if (ids.length) (await fsdb().getAll(...ids.map(i => fsdb().collection('users').doc(i)))).forEach(d => { info[d.id] = d.exists ? { name: d.data().name || 'Someone', photo: photoOf(d.data()) } : { name: 'Deleted account', photo: '' }; });
  const pack = docs => docs.map(d => ({ id: d.id, name: (info[d.id] || {}).name || 'Someone', photo: (info[d.id] || {}).photo || '', at: d.data().at && d.data().at.toMillis ? d.data().at.toMillis() : 0 })).sort((a, b) => b.at - a.at);
  res.json({ bans: pack(bs.docs), mutes: pack(ms.docs) });
}));

// Audience votes in the host's poll (one vote per person per poll).
app.post('/rooms/:id/vote', fbAuth, wrap(async (req, res) => {
  const choice = (req.body || {}).choice;
  if (!['a', 'b'].includes(choice)) throw httpErr(400, 'Pick an option');
  rateLimit(req.uid, 'vote', 20, 60000);
  const f = fsdb(), r = await getRoom(req.params.id);
  if (r.status !== 'live') throw httpErr(409, 'This room is not live');
  if (r.hostId === req.uid) throw httpErr(403, 'Hosts cannot vote in their own poll');
  if ((await r.ref.collection('bans').doc(req.uid).get()).exists) throw httpErr(403, 'You were removed from this room');
  if (!(await r.ref.collection('viewers').doc(req.uid).get()).exists) throw httpErr(403, 'Join the room to vote');
  const vref = r.ref.collection('votes').doc(req.uid);
  await f.runTransaction(async t => {
    const [rs, vs] = await Promise.all([t.get(r.ref), t.get(vref)]);
    const p = rs.data().poll;
    if (!p || !p.open) throw httpErr(409, 'This poll is closed');
    if (vs.exists && vs.data().pollId === p.id) throw httpErr(409, 'You already voted');
    t.set(vref, { pollId: p.id, choice, at: FV().serverTimestamp() });
    t.update(r.ref, { ['poll.c' + choice]: FV().increment(1) });
  });
  res.json({ ok: true });
}));

// "Remind me": the person gets a push shortly before a scheduled room starts.
app.post('/rooms/:id/remind', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id);
  if (r.status !== 'scheduled') throw httpErr(409, 'This room is not scheduled');
  const rem = r.ref.collection('reminders').doc(req.uid);
  if ((req.body || {}).off) await rem.delete(); else await rem.set({ at: FV().serverTimestamp() });
  res.sendStatus(204);
}));

// Background housekeeping (every 30s): close dead rooms, refresh viewer counts, send reminders.
// Every 30 minutes it also nudges matches that have gone quiet. Safe to run on one instance; for several, move to a job.
let sweepN = 0;
async function sweep() {
  const f = fsdb(), now = Date.now();
  const live = await f.collection('rooms').where('status', '==', 'live').limit(200).get();
  for (const d of live.docs) {
    const r = d.data();
    if (now - (r.lastBeat || 0) > 90000) { await endRoom(d.ref, 'idle'); continue; }          // host left or lost connection
    // const vs = await d.ref.collection('viewers').get();      // superseded: read every viewer doc every 30s (2,000 viewers = 4,000 reads a minute per room)
    // Stale viewers come from one indexed query and the head-count from a count aggregation, so a big room costs a few reads, not thousands.
    let stale = [], leaveMsgs = 0;
    for (let guard = 0; guard < 20; guard++) {      // up to 10,000 stale viewers per sweep, 500 at a time
      const sq = await d.ref.collection('viewers').where('seen', '<', now - 75000).limit(500).get().catch(() => null);
      if (!sq || sq.empty) break;
      await deleteRefs(sq.docs.map(v => v.ref));
      stale = stale.concat(sq.docs);
      for (const v of sq.docs) { if (leaveMsgs >= 20) break; if (v.data().name) { leaveMsgs++; presenceMsg(d.ref, 'leave', v.id, v.data().name); } }
      for (let i = 0; i < sq.docs.length; i += 25) await Promise.all(sq.docs.slice(i, i + 25).flatMap(v => ['guests', 'requests', 'invites'].map(sub => d.ref.collection(sub).doc(v.id).delete().catch(() => {}))));
      if (sq.size < 500) break;
    }
    let count;
    try { count = (await d.ref.collection('viewers').count().get()).data().count; }
    catch (e) { const vs = await d.ref.collection('viewers').get(); count = vs.size; }      // older firebase-admin without count(): the previous way
    if (count >= BIG_ROOM_AT) bigRooms.add(d.id); else { bigRooms.delete(d.id); bigJoins.delete(d.id); }
    // Big room: instead of one chat line per person, one quiet line every 30s ("142 people joined"). Uses the same system line the app already shows.
    const nj = bigJoins.get(d.id) || 0; bigJoins.delete(d.id);
    if (nj > 0 && bigRooms.has(d.id)) await sysMsg(d.ref, { hostId: r.hostId, hostName: r.hostName }, `${nj} ${nj === 1 ? 'person' : 'people'} joined`).catch(() => {});
    if (count !== (r.viewers || 0)) await d.ref.update({ viewers: count, peak: Math.max(r.peak || 0, count) });
  }
  const sched = await f.collection('rooms').where('status', '==', 'scheduled').limit(200).get();
  for (const d of sched.docs) {
    const r = d.data();
    if (r.startsAt < now - 2 * 3600e3) { await endRoom(d.ref, 'expired'); continue; }
    if (!r.reminded && r.startsAt - now < 5 * 60000) {
      await d.ref.update({ reminded: true });
      const rs = await d.ref.collection('reminders').get();
      for (const x of rs.docs) await notifyUser({ to: x.id, from: r.hostId, fromName: r.hostName, icon: r.hostPhoto, type: 'message', text: `Room starting soon: ${r.title}`, id: `room_${d.id}_${x.id}` }).catch(() => {});
    }
  }
  if (sweepN++ % 60 === 0) await nudgeQuietMatches(now);
}
async function nudgeQuietMatches(now) {
  const f = fsdb();
  const snap = await f.collection('matches').where('createdAt', '<', admin.firestore.Timestamp.fromMillis(now - 48 * 3600e3)).orderBy('createdAt', 'desc').limit(150).get();
  for (const d of snap.docs) {
    const m = d.data(); if (m.nudgedAt || m.dm || (m.members || []).length !== 2) continue;
    const last = m.lastAt && m.lastAt.toMillis ? m.lastAt.toMillis() : 0;
    if (last && now - last < 48 * 3600e3) continue;
    // someone is owed a reply, or nobody ever said hello
    const who = m.lastFrom ? [otherOf(m.members, m.lastFrom)] : m.members;
    for (const to of who) {
      const from = otherOf(m.members, to);
      await notifyUser({ to, from, fromName: (m.names && m.names[from]) || '', type: 'message', text: m.lastFrom ? 'is still waiting to hear from you' : 'matched with you. Break the ice!', id: `nudge_${d.id}_${to}` }).catch(() => {});
    }
    await d.ref.update({ nudgedAt: FV().serverTimestamp() }).catch(() => {});
  }
}
setInterval(() => sweep().catch(e => console.warn('sweep failed', e.message)), 30000).unref();

// Slow-mode for big rooms. Comments go straight from the app to Firestore (the rules cannot rate-limit a person), so the server
// trims floods after the fact: in a room at or above BIG_ROOM_AT viewers, one person keeps at most SLOW_MAX comments per SLOW_WINDOW_S
// seconds (the first ones), extras are deleted within ~5 seconds. The host is never trimmed. Nothing changes in the app or the rules.
const SLOW_MAX = Number(process.env.SLOW_MAX_MSGS) || 4, SLOW_WINDOW_S = Number(process.env.SLOW_WINDOW_SECONDS) || 15;
let slowBusy = false;
async function slowModeTick() {
  if (slowBusy || !bigRooms.size) return;
  slowBusy = true;
  try {
    const f = fsdb(), cut = admin.firestore.Timestamp.fromMillis(Date.now() - SLOW_WINDOW_S * 1000);
    for (const id of [...bigRooms]) {
      const rs = await f.collection('rooms').doc(id).get().catch(() => null);
      if (!rs || !rs.exists || rs.data().status !== 'live') { bigRooms.delete(id); bigJoins.delete(id); continue; }
      const hostId = rs.data().hostId;
      const ms = await rs.ref.collection('messages').where('createdAt', '>', cut).orderBy('createdAt', 'asc').limit(600).get().catch(() => null);
      if (!ms || ms.empty) continue;
      const seen = new Map(), drop = [];
      for (const m of ms.docs) {
        const x = m.data();
        if (x.type !== 'text' || !x.from || x.from === hostId) continue;      // only ordinary comments; join lines, gifts, system notices and the host are left alone
        const n = (seen.get(x.from) || 0) + 1; seen.set(x.from, n);
        if (n > SLOW_MAX) drop.push(m.ref);
      }
      if (drop.length) await deleteRefs(drop);
    }
  } catch (e) { console.warn('slow mode failed', e.message); }
  slowBusy = false;
}
setInterval(() => slowModeTick(), 5000).unref();

// Speed-dating rounds advance on the server, so they keep time even if the host's phone sleeps.
async function advanceRounds() {
  if (!roundsHot) return;
  const snap = await fsdb().collection('rooms').where('roundActive', '==', true).limit(100).get(), now = Date.now();
  if (snap.empty) { roundsHot = false; return; }
  for (const d of snap.docs) {
    const r = d.data(), rd = r.round;
    if (r.status !== 'live' || !rd) { await d.ref.update({ roundActive: false, round: FV().delete() }).catch(() => {}); continue; }
    if (now < rd.endsAt) continue;
    if (rd.n >= rd.total) {
      await d.ref.update({ roundActive: false, round: FV().delete() });
      await sysMsg(d.ref, r, 'That was the last round! If you clicked with someone, send them a like or a message.');
    } else {
      const n = rd.n + 1, q = ICEBREAKERS[rd.order[(n - 1) % rd.order.length]];
      await d.ref.update({ round: { ...rd, n, endsAt: now + rd.seconds * 1000, q } });
      await sysMsg(d.ref, r, `Round ${n} of ${rd.total}: ${q}`);
    }
  }
}
setInterval(() => advanceRounds().catch(e => console.warn('rounds failed', e.message)), 5000).unref();


/* =====================================================================================================
   FOLLOWERS / FOLLOWING
   follows/{from}_{to} {from, to, createdAt}. users/{uid}.followers and .following are counters kept by the server only.
   ===================================================================================================== */
app.post('/social/follow', fbAuth, wrap(async (req, res) => {
  const { targetId } = req.body || {}, want = (req.body || {}).follow !== false;
  if (!SAFE_ID.test(String(targetId || '')) || targetId === req.uid) throw httpErr(400, 'Invalid person');
  rateLimit(req.uid, 'follow', 60, 60000);
  const f = fsdb(), fref = f.collection('follows').doc(`${req.uid}_${targetId}`), mref = f.collection('users').doc(req.uid), tref = f.collection('users').doc(targetId);
  if (want && await isBlocked(req.uid, targetId)) throw httpErr(403, 'You cannot follow this person');
  let changed = false, followers = 0;
  await f.runTransaction(async t => {
    const [fs, ms, ts] = await Promise.all([t.get(fref), t.get(mref), t.get(tref)]);
    if (!ts.exists || !ms.exists) throw httpErr(404, 'User not found');
    followers = Math.max(0, ts.data().followers || 0);
    if (want && !fs.exists) {
      t.set(fref, { from: req.uid, to: targetId, createdAt: FV().serverTimestamp() });
      t.update(mref, { following: FV().increment(1) }); t.update(tref, { followers: FV().increment(1) });
      followers += 1; changed = true;
    } else if (!want && fs.exists) {
      t.delete(fref);
      t.update(mref, { following: Math.max(0, (ms.data().following || 0) - 1) }); t.update(tref, { followers: Math.max(0, followers - 1) });
      followers = Math.max(0, followers - 1); changed = true;
    }
  });
  if (want && changed) {
    const me = await getUserDoc(req.uid);
    notifyUser({ to: targetId, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'follow', gapMs: 24 * 3600e3 }).catch(() => {});
    questFollow(req.uid, targetId).catch(() => {});
    missionsAdd(targetId, 'followers', 1, req.uid);
  }
  res.json({ following: want, followers });
}));

// "Suggested for you": people to follow, shown as cards after someone follows in a chat. Skips yourself, people you already follow,
// anyone blocked either way and the person you were just chatting with. Ranked by shared interests, distance, verified and recently active.
let sugPool = { at: 0, users: [] };      // the newest members, shared by everyone for 2 minutes so this stays cheap
async function sugCandidates() {
  if (Date.now() - sugPool.at < 120000 && sugPool.users.length) return sugPool.users;
  const snap = await fsdb().collection('users').orderBy('createdAt', 'desc').limit(300).get();
  sugPool = { at: Date.now(), users: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  return sugPool.users;
}
app.post('/social/suggested-follows', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'sug-follow', 20, 60000);
  const f = fsdb(), ex = String((req.body || {}).exclude || '');
  const [me, fw, b1, b2, pool] = await Promise.all([getUserDoc(req.uid), f.collection('follows').where('from', '==', req.uid).limit(1000).get(),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get(), sugCandidates()]);
  const skip = new Set([req.uid, SAFE_ID.test(ex) ? ex : '', ...fw.docs.map(d => d.data().to), ...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  const mine = new Set(me.interests || []), now = Date.now();
  const scored = pool.filter(u => !skip.has(u.id) && photoOf(u) && u.name).map(u => {
    const dist = me.lat != null && u.lat != null ? hav(me.lat, me.lng, u.lat, u.lng) : null;
    const seen = u.lastSeen && u.lastSeen.toMillis ? u.lastSeen.toMillis() : 0;
    const score = (u.interests || []).filter(x => mine.has(x)).length * 3 + (dist != null ? Math.max(0, 50 - dist) / 10 : 0) + (u.verified ? 2 : 0) + (now - seen < 86400000 ? 2 : 0) + Math.random();
    return { u, score };
  }).sort((a, b) => b.score - a.score).slice(0, 12);
  res.json({ users: scored.map(({ u }) => ({ id: u.id, name: String(u.name).slice(0, 40), photo: photoOf(u), age: u.age || null, city: u.city || u.state || '', goal: u.goal || '', verified: !!u.verified })) });
}));

// Who follows a person / who they follow (first 100, newest first), with whether I follow each of them.
// The Moments feed: photos and videos from everyone I follow (no follow-back needed) plus my own, newest first.
// A Cloudinary url carries its upload time as /v<seconds>/, which is how the posts are dated and sorted.
// Claim or change my @handle (unique, searchable, shareable as /?u=handle)
const RESERVED_HANDLES = new Set(['admin', 'administrator', 'support', 'help', 'heartlink', 'heart_link', 'official', 'staff', 'moderator', 'mod', 'root', 'system', 'null', 'undefined', 'api', 'all', 'everyone', 'here', 'channel']);
app.post('/profile/handle', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'handle', 10, 60000);
  const h = String((req.body || {}).handle || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9_.]{1,18}[a-z0-9]$/.test(h) || /[_.]{2}/.test(h)) throw httpErr(400, 'Use 3-20 letters, numbers, dots or underscores');
  if (RESERVED_HANDLES.has(h)) throw httpErr(409, 'That handle is not available');
  const f = fsdb(), uref = f.collection('users').doc(req.uid), href = f.collection('handles').doc(h);
  await f.runTransaction(async t => {
    const [u, hs] = await Promise.all([t.get(uref), t.get(href)]);
    if (!u.exists) throw httpErr(404, 'Profile not found');
    const old = String(u.data().handle || '');
    if (old === h) return;
    if (hs.exists && hs.data().uid !== req.uid) throw httpErr(409, 'That handle is taken');
    t.set(href, { uid: req.uid, at: FV().serverTimestamp() });
    if (old) t.delete(f.collection('handles').doc(old));
    t.update(uref, { handle: h });
  });
  res.json({ ok: true, handle: h });
}));


/* ---------- Automatic @handles + handle search (so everyone can be tagged) ----------
   A handle is optional in the app, so most people never claimed one and could not be @tagged. Everyone now gets one made from
   their name (name, name.2, name47...). They can still change it any time. */
const HANDLE_OK = /^[a-z0-9][a-z0-9_.]{1,18}[a-z0-9]$/;
function handleBase(name) {
  let b = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 14).replace(/\.+$/g, '');
  if (b.length < 3) b = (b + 'user').replace(/\./g, '').slice(0, 14);
  return b;
}
async function claimAutoHandle(uid) {
  const f = fsdb(), uref = f.collection('users').doc(uid), us = await uref.get();
  if (!us.exists) throw httpErr(404, 'Profile not found');
  const cur = String(us.data().handle || ''); if (cur) return cur;
  const base = handleBase(us.data().name);
  for (let i = 0; i < 12; i++) {
    const h = i === 0 ? base : (i < 4 ? `${base}${i + 1}` : `${base}${Math.floor(10 + Math.random() * (i < 8 ? 990 : 99000))}`).slice(0, 20);
    if (!HANDLE_OK.test(h) || /[_.]{2}/.test(h) || RESERVED_HANDLES.has(h)) continue;
    const href = f.collection('handles').doc(h);
    const got = await f.runTransaction(async t => {
      const [hs, u] = await Promise.all([t.get(href), t.get(uref)]);
      if (u.data().handle) return u.data().handle;          // someone (the person, or a parallel call) already set one
      if (hs.exists) return '';
      t.set(href, { uid, at: FV().serverTimestamp(), auto: true }); t.update(uref, { handle: h }); return h;
    });
    if (got) return got;
  }
  throw httpErr(503, 'Could not make a handle right now');
}
app.post('/profile/handle-auto', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'handleauto', 5, 60000);
  res.json({ ok: true, handle: await claimAutoHandle(req.uid) });
}));
// Handles that start with what the person typed after "@" (for the suggestion list in comments and room chat).
app.post('/social/mention-search', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'mnsearch', 90, 60000);
  const q = String((req.body && req.body.q) || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_.]/g, '').slice(0, 20);
  if (!q) return res.json({ items: [] });
  const f = fsdb();
  const snap = await f.collection('handles').orderBy(admin.firestore.FieldPath.documentId()).startAt(q).endAt(q + '\uf8ff').limit(12).get();
  const rows = snap.docs.map(d => ({ handle: d.id, uid: d.data().uid })).filter(r => r.uid && r.uid !== req.uid);
  if (!rows.length) return res.json({ items: [] });
  const [users, b1, b2] = await Promise.all([
    f.getAll(...rows.map(r => f.collection('users').doc(r.uid))),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const bad = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  const items = [];
  users.forEach((u, i) => { if (u.exists && !bad.has(rows[i].uid) && items.length < 8) items.push({ handle: rows[i].handle, uid: rows[i].uid, name: u.data().name || '', photo: photoOf(u.data()) }); });
  res.json({ items });
}));
// One-time background pass: give a handle to everyone who never claimed one (runs once after deploy, then never again).
async function backfillHandles() {
  const f = fsdb(), flag = f.collection('system').doc('handleBackfill');
  if ((await flag.get()).exists) return;
  let cursor = null, made = 0;
  for (let page = 0; page < 200; page++) {
    let q = f.collection('users').orderBy('createdAt', 'desc').limit(200); if (cursor) q = q.startAfter(cursor);
    const snap = await q.get(); if (snap.empty) break;
    for (const d of snap.docs) { if (!d.data().handle && d.data().name) { try { await claimAutoHandle(d.id); made++; } catch (e) { /* skip this one */ } } }
    cursor = snap.docs[snap.docs.length - 1].data().createdAt; if (snap.size < 200 || !cursor) break;
  }
  await flag.set({ done: true, made, at: FV().serverTimestamp() });
  console.log('handle backfill done:', made);
}
setTimeout(() => backfillHandles().catch(e => console.warn('handle backfill failed', e.message)), 20000).unref();

app.post('/social/feed', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'mfeed', 30, 60000);
  const f = fsdb();
  const [fi, b1, b2] = await Promise.all([
    f.collection('follows').where('from', '==', req.uid).limit(500).get(),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const hidden = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  const friends = fi.docs.map(d => d.data().to).filter(id => !hidden.has(id)).slice(0, 300);
  const ids = [...friends, req.uid], docs = [];
  for (let i = 0; i < ids.length; i += 100) docs.push(...await f.getAll(...ids.slice(i, i + 100).map(id => f.collection('users').doc(id))));
  const items = [];
  docs.forEach(u => {
    if (!u.exists) return;
    const x = u.data();
    (Array.isArray(x.media) ? x.media : []).forEach(m => {
      if (!m || !m.id || typeof m.url !== 'string' || !m.url.startsWith('https://')) return;
      const v = /\/v(\d{9,11})\//.exec(m.url);
      items.push({ ownerId: u.id, ownerName: String(x.name || 'Someone').slice(0, 80), ownerPhoto: photoOf(x), verified: !!x.verified, you: u.id === req.uid,
        id: m.id, url: m.url, kind: m.kind === 'video' ? 'video' : 'photo', caption: typeof m.caption === 'string' ? m.caption.slice(0, 2000) : '', at: v ? Number(v[1]) * 1000 : 0 });
    });
  });
  items.sort((a, b) => b.at - a.at);
  res.json({ items: items.slice(0, 80), people: friends.length });
}));

app.post('/social/follow-list', fbAuth, wrap(async (req, res) => {
  const { uid, type } = req.body || {};
  if (!SAFE_ID.test(String(uid || '')) || !['followers', 'following'].includes(type)) throw httpErr(400, 'Invalid request');
  rateLimit(req.uid, 'followlist', 30, 60000);
  const f = fsdb(), field = type === 'followers' ? 'to' : 'from', other = type === 'followers' ? 'from' : 'to';
  const snap = await f.collection('follows').where(field, '==', uid).limit(100).get();
  const rows = snap.docs.map(d => ({ id: d.data()[other], at: d.data().createdAt && d.data().createdAt.toMillis ? d.data().createdAt.toMillis() : 0 })).sort((a, b) => b.at - a.at);
  if (!rows.length) return res.json({ items: [] });
  const [users, mine, b1, b2] = await Promise.all([
    f.getAll(...rows.map(r => f.collection('users').doc(r.id))),
    f.getAll(...rows.map(r => f.collection('follows').doc(`${req.uid}_${r.id}`))),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const hidden = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  const items = [];
  users.forEach((u, i) => {
    if (!u.exists || hidden.has(u.id)) return;
    const x = u.data();
    items.push({ id: u.id, name: x.name || 'Someone', photo: photoOf(x), verified: !!x.verified, city: x.city || '', isFollowing: mine[i].exists, you: u.id === req.uid });
  });
  res.json({ items });
}));

async function notifyFollowersLive(r) {
  const snap = await fsdb().collection('follows').where('to', '==', r.hostId).limit(300).get();
  const ids = snap.docs.map(d => d.data().from);
  // the host's message only goes out if it passes the word filter; otherwise the usual alert (and "is live now" if the title itself fails)
  const alertText = (r.pushText && !pushTextBlocked(r.pushText)) ? r.pushText : (pushTextBlocked(r.title) ? 'is live now' : `is live: ${r.title}`);
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(to => notifyUser({ to, from: r.hostId, fromName: r.hostName, icon: r.hostPhoto, type: 'live', text: alertText, id: `live_${r.id}_${to}` }).catch(() => {})));
  }
}

/* =====================================================================================================
   GUEST STAGE: the host plus up to 9 guests stream live at the same time (10 publishers).
   rooms/{id}/requests/{uid}  viewer asked to join      rooms/{id}/invites/{uid}  host invited a viewer
   rooms/{id}/guests/{uid}    {name, photo, agoraUid, mic, cam, hostMuted, at}   (the people on stage)
   A guest first gets a normal audience token; only after the host accepts do they get a PUBLISHER token for their own Agora uid.
   ===================================================================================================== */
const MAX_GUESTS = 9;
const BIG_MAX = 3;                    // guests the host can bring onto the big screen next to themselves
const bigMaxOf = r => Math.max(0, Math.min(BIG_MAX, (Math.floor(Number(r.gridN)) || BIG_MAX + 1) - 1));   // the host's grid choice: 1 to 4 tiles on the big screen
async function liveRoom(id) {
  const r = await getRoom(id);
  if (r.status !== 'live') throw httpErr(409, r.status === 'scheduled' ? 'This room has not started yet' : 'This room has ended');
  return r;
}
async function mustBeInRoom(r, uid) {
  if (r.hostId === uid) throw httpErr(403, 'You are the host');
  if ((await r.ref.collection('bans').doc(uid).get()).exists) throw httpErr(403, 'You were removed from this room');
  if (!(await r.ref.collection('viewers').doc(uid).get()).exists) throw httpErr(403, 'Join the room first');
}
async function addGuest(r, uid) {
  const f = fsdb(), u = await getUserDoc(uid);
  const gref = r.ref.collection('guests').doc(uid);
  await f.runTransaction(async t => {
    const gs = await t.get(r.ref.collection('guests'));
    if (gs.docs.some(d => d.id === uid)) return;
    if (gs.size >= MAX_GUESTS) throw httpErr(409, `The stage is full (${MAX_GUESTS} guests)`);
    const used = new Set(gs.docs.map(d => d.data().agoraUid));
    let agoraUid; do { agoraUid = 1000 + crypto.randomInt(2000000000); } while (used.has(agoraUid));
    t.set(gref, { name: u.name || 'Guest', photo: photoOf(u), agoraUid, mic: true, cam: r.kind !== 'audio', hostMuted: false, at: FV().serverTimestamp() });
    t.delete(r.ref.collection('requests').doc(uid)); t.delete(r.ref.collection('invites').doc(uid));
  });
}

// Viewer asks to come on stage (or takes the request back).
app.post('/rooms/:id/guest/request', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'guestreq', 12, 60000);
  const r = await liveRoom(req.params.id); await mustBeInRoom(r, req.uid);
  if (r.seatsLocked && !(req.body || {}).off) throw httpErr(409, 'The host has locked the stage seats');
  const rref = r.ref.collection('requests').doc(req.uid);
  if ((req.body || {}).off) { await rref.delete(); return res.sendStatus(204); }
  if ((await r.ref.collection('guests').doc(req.uid).get()).exists) throw httpErr(409, 'You are already on stage');
  if ((await r.ref.collection('requests').limit(40).get()).size >= 40) throw httpErr(429, 'Too many requests right now');
  const me = await getUserDoc(req.uid); needPhoto(me);
  await rref.set({ name: me.name || '', photo: photoOf(me), at: FV().serverTimestamp() });
  res.sendStatus(204);
}));

// Host: accept / decline a request, invite a viewer, take a guest off stage, mute or let a guest unmute.
app.post('/rooms/:id/guest/mod', fbAuth, wrap(async (req, res) => {
  const r = await liveRoom(req.params.id); mustHost(r, req.uid);
  const { action, target } = req.body || {};
  if (!SAFE_ID.test(String(target || '')) || target === req.uid) throw httpErr(400, 'Invalid person');
  rateLimit(req.uid, 'guestmod', 60, 60000);
  if (action === 'accept') {
    if (!(await r.ref.collection('requests').doc(target).get()).exists) throw httpErr(404, 'That request is gone');
    await mustBeInRoom(r, target); await addGuest(r, target);
  } else if (action === 'decline') await r.ref.collection('requests').doc(target).delete();
  else if (action === 'invite') {
    await mustBeInRoom(r, target);
    if ((await r.ref.collection('guests').doc(target).get()).exists) throw httpErr(409, 'They are already on stage');
    if ((await r.ref.collection('guests').get()).size >= MAX_GUESTS) throw httpErr(409, `The stage is full (${MAX_GUESTS} guests)`);
    await r.ref.collection('invites').doc(target).set({ at: FV().serverTimestamp(), by: r.hostName || '' });
  }
  else if (action === 'remove') await Promise.all([r.ref.collection('guests').doc(target).delete(), r.ref.update({ stage: FV().arrayRemove(target) }).catch(() => {})]);
  else if (action === 'stage' || action === 'cohost') {          // bring a guest onto the big screen (a co-host is the first of them)
    if (r.kind === 'audio') throw httpErr(409, 'The big screen is only for video rooms');
    const gref = r.ref.collection('guests').doc(target);
    if (!(await gref.get()).exists) throw httpErr(404, 'That guest left');
    const cur = ((await r.ref.get()).data().stage) || [];
    if (!cur.includes(target) && cur.length >= bigMaxOf(r)) throw httpErr(409, bigMaxOf(r) ? `The big screen is full (you and ${bigMaxOf(r)} guest${bigMaxOf(r) > 1 ? 's' : ''}). Change the grid to fit more.` : 'The big screen is set to solo. Change the grid to bring guests up.');
    if (action === 'cohost') {
      const old = await r.ref.collection('guests').where('cohost', '==', true).get();
      await Promise.all(old.docs.filter(d => d.id !== target).map(d => d.ref.update({ cohost: false })));
      await gref.update({ cohost: true });
    }
    await r.ref.update({ stage: FV().arrayUnion(target) });
  }
  else if (action === 'unstage') {
    await r.ref.update({ stage: FV().arrayRemove(target) });
    await r.ref.collection('guests').doc(target).update({ cohost: false }).catch(() => {});
  }
  else if (action === 'uncohost') await r.ref.collection('guests').doc(target).update({ cohost: false }).catch(() => { throw httpErr(404, 'That guest left'); });
  else if (action === 'mute') await r.ref.collection('guests').doc(target).update({ hostMuted: true, mic: false }).catch(() => { throw httpErr(404, 'That guest left'); });
  else if (action === 'unmute') await r.ref.collection('guests').doc(target).update({ hostMuted: false }).catch(() => { throw httpErr(404, 'That guest left'); });
  else throw httpErr(400, 'Invalid action');
  res.sendStatus(204);
}));

// Host: people currently watching (to invite them on stage). Guests are left out.
app.post('/rooms/:id/viewers', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  const f = fsdb(), [vs, gs] = await Promise.all([r.ref.collection('viewers').limit(60).get(), r.ref.collection('guests').get()]);
  const guestIds = new Set(gs.docs.map(d => d.id)), ids = vs.docs.map(d => d.id).filter(i => !guestIds.has(i));
  if (!ids.length) return res.json({ items: [] });
  const us = await f.getAll(...ids.map(i => f.collection('users').doc(i)));
  res.json({ items: us.filter(u => u.exists).map(u => ({ id: u.id, name: u.data().name || 'Someone', photo: photoOf(u.data()) })) });
}));

// Invited person says yes (or no).
app.post('/rooms/:id/guest/accept', fbAuth, wrap(async (req, res) => {
  const r = await liveRoom(req.params.id); await mustBeInRoom(r, req.uid);
  const iref = r.ref.collection('invites').doc(req.uid);
  if ((req.body || {}).decline) { await iref.delete(); return res.sendStatus(204); }
  if (!(await iref.get()).exists) throw httpErr(404, 'That invite is no longer open');
  await addGuest(r, req.uid);
  res.sendStatus(204);
}));

// A guest on stage gets their publisher token (their own Agora uid, so everyone can tell whose video is whose).
app.post('/rooms/:id/guest/token', fbAuth, wrap(async (req, res) => {
  const r = await liveRoom(req.params.id);
  await assertCanGoLive(req.uid);      // strike restriction also covers going on stage
  const g = await r.ref.collection('guests').doc(req.uid).get();
  if (!g.exists) throw httpErr(403, 'You are not on stage');
  res.json({ creds: agoraCreds(r.channel, g.data().agoraUid), guest: g.data() });
}));

app.post('/rooms/:id/guest/leave', fbAuth, wrap(async (req, res) => {
  const r = roomRef(req.params.id);
  await Promise.all([...['guests', 'requests', 'invites'].map(sub => r.collection(sub).doc(req.uid).delete().catch(() => {})), r.update({ stage: FV().arrayRemove(req.uid) }).catch(() => {})]);
  res.sendStatus(204);
}));

// A guest's own mic / camera switches, so everyone sees the muted icons. The host's mute wins.
app.post('/rooms/:id/guest/state', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'gueststate', 60, 60000);
  const r = await getRoom(req.params.id), gref = r.ref.collection('guests').doc(req.uid), g = await gref.get();
  if (!g.exists) throw httpErr(403, 'You are not on stage');
  const b = req.body || {}, upd = {};
  if (typeof b.mic === 'boolean') upd.mic = g.data().hostMuted ? false : b.mic;
  if (typeof b.cam === 'boolean' && r.kind !== 'audio') upd.cam = b.cam;
  if (Object.keys(upd).length) await gref.update(upd);
  res.json({ ok: true, ...upd });
}));

/* =====================================================================================================
   PINNED PRODUCT LINK: the host pastes a shop link, the server reads its title, photo and price.
   The fetch is SSRF-safe: http(s) only, ports 80/443, every address is checked at connect time, redirects re-checked.
   ===================================================================================================== */
function cleanShopUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (x.protocol !== 'https:' || x.username || x.password || x.href.length > 500) return '';
    return x.href;
  } catch { return ''; }
}
function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase(), m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return privateIp(m[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...(typeof opts === 'object' ? opts : {}), all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => privateIp(a.address))) return cb(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
async function fetchShopPage(url) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) throw httpErr(400, 'Use a normal https:// link');
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && privateIp(u.hostname.replace(/^\[|\]$/g, ''))) throw httpErr(400, 'That link is not allowed');
    const r = await axios.get(url, {
      timeout: 6000, maxRedirects: 0, maxContentLength: 1.5e6, maxBodyLength: 1.5e6, responseType: 'text', proxy: false, lookup: safeLookup,
      validateStatus: s => s < 400, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HeartLinkBot/1.0; +link-preview)', Accept: 'text/html,application/xhtml+xml' },
    });
    if (r.status >= 300 && r.headers.location) { url = new URL(r.headers.location, url).href; continue; }
    return { html: String(r.data || '').slice(0, 700000), url };
  }
  throw httpErr(400, 'Too many redirects');
}
const unEnt = s => String(s || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
  const k = e.toLowerCase(); if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos' || k === '#39') return "'";
  const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }).trim();
function metaTag(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && names.includes(key.toLowerCase())) { const c = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1]; if (c) return unEnt(c); }
  }
  return '';
}
function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    const stack = Array.isArray(j) ? j.slice() : [j];
    while (stack.length) {
      const x = stack.shift(); if (!x || typeof x !== 'object') continue;
      if (x['@graph']) stack.push(...[].concat(x['@graph']));
      const t = [].concat(x['@type'] || []);
      if (t.includes('Product')) {
        const o = [].concat(x.offers || [])[0] || {}, img = [].concat(x.image || [])[0];
        return { name: x.name, image: typeof img === 'string' ? img : img && img.url, price: o.price || (o.priceSpecification && o.priceSpecification.price) || o.lowPrice, currency: o.priceCurrency };
      }
    }
  }
  return {};
}
app.post('/rooms/:id/product-preview', fbAuth, wrap(async (req, res) => {
  const r = await getRoom(req.params.id); mustHost(r, req.uid);
  rateLimit(req.uid, 'preview', 20, 60000);
  const url = cleanShopUrl((req.body || {}).url);
  if (!url) throw httpErr(400, 'Paste a full https:// product link');
  let page;
  try { page = await fetchShopPage(url); }
  catch (e) { if (e.status) throw e; return res.json({ host: new URL(url).hostname.replace(/^www\./, ''), title: '', image: '', price: '', currency: '', note: 'We could not read that page. Type the name and price yourself.' }); }
  const ld = jsonLdProduct(page.html), h = page.html;
  const title = unEnt(ld.name) || metaTag(h, ['og:title', 'twitter:title']) || unEnt((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  let image = ''; { const raw = metaTag(h, ['og:image', 'og:image:secure_url', 'twitter:image']) || ld.image || ''; try { image = cleanShopUrl(new URL(raw, page.url).href); } catch {} }
  const priceRaw = ld.price || metaTag(h, ['product:price:amount', 'og:price:amount', 'price']);
  const price = parseFloat(String(priceRaw || '').replace(/[^\d.]/g, '')) || '';
  const currency = String(ld.currency || metaTag(h, ['product:price:currency', 'og:price:currency', 'pricecurrency']) || '').toUpperCase().slice(0, 3);
  res.json({ host: new URL(page.url).hostname.replace(/^www\./, ''), title: title.slice(0, 80), image, price, currency: /^[A-Z]{3}$/.test(currency) ? currency : '' });
}));

/* =====================================================================================================
   DISCOVER with paging and filters (replaces loading 200 users in the browser)
   ===================================================================================================== */
const hav = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
app.post('/social/discover', fbAuth, wrap(async (req, res) => {
  const b = req.body || {}, f = fsdb();
  rateLimit(req.uid, 'discover', 30, 60000);
  const me = await getUserDoc(req.uid);
  const minAge = Math.max(18, Math.floor(Number(b.minAge) || 18)), maxAge = Math.min(99, Math.floor(Number(b.maxAge) || 99));
  const maxKm = Number(b.maxKm) > 0 ? Number(b.maxKm) : 0;
  const gender = ['male', 'female'].includes(b.gender) ? b.gender : '';
  const interests = Array.isArray(b.interests) ? b.interests.map(x => String(x).slice(0, 30)).slice(0, 10) : [];
  const verifiedOnly = b.verifiedOnly === true;
  const search = String(b.q || '').trim().toLowerCase().slice(0, 40);
  const [sw, bl1, bl2] = await Promise.all([
    b.includeSwiped === true ? Promise.resolve({ docs: [] }) : f.collection('swipes').where('from', '==', req.uid).get(),     // the Nearby tab lists everyone, swiped or not
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const skip = new Set([req.uid, ...sw.docs.map(d => d.data().to), ...bl1.docs.map(d => d.data().blocked), ...bl2.docs.map(d => d.data().by)]);
  const out = []; let cursor = Number(b.cursor) || 0, last = null, exhausted = false;
  for (let page = 0; page < 6 && out.length < 25 && !exhausted; page++) {
    let q = f.collection('users').orderBy('createdAt', 'desc').limit(100);
    if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));
    const snap = await q.get();
    if (snap.size < 100) exhausted = true;
    for (const d of snap.docs) {
      const u = d.data(); last = u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : last;
      if (skip.has(d.id) || !photoOf(u)) continue;
      if (!(u.age >= minAge && u.age <= maxAge)) continue;
      if (gender && u.gender !== gender) continue;
      if (verifiedOnly && !u.verified) continue;
      if (search && ![u.name, u.city, u.state, u.neighborhood, u.occupation].filter(Boolean).join(' ').toLowerCase().includes(search)) continue;
      if (interests.length && !(u.interests || []).some(x => interests.includes(x))) continue;
      let dist = null;
      if (me.lat != null && u.lat != null) dist = Math.round(hav(me.lat, me.lng, u.lat, u.lng));
      if (maxKm && (dist == null || dist > maxKm)) continue;
      out.push({ id: d.id, name: u.name, handle: u.handle || '', age: u.age, gender: u.gender, occupation: u.occupation, goal: u.goal, bio: u.bio, city: u.city, state: u.state, country: u.country,
        neighborhood: u.neighborhood, lat: u.lat ?? null, lng: u.lng ?? null, media: u.media || [], verified: !!u.verified, interests: u.interests || [], prompts: u.prompts || [],
        lastSeen: u.lastSeen && u.lastSeen.toMillis ? u.lastSeen.toMillis() : 0, createdAt: last });
    }
    cursor = last || 0;
  }
  out.sort((a, b2) => (a.lat != null && me.lat != null ? hav(me.lat, me.lng, a.lat, a.lng) : 1e9) - (b2.lat != null && me.lat != null ? hav(me.lat, me.lng, b2.lat, b2.lng) : 1e9));
  res.json({ users: out, cursor: exhausted ? 0 : cursor, done: exhausted });
}));

// Most popular members (by followers) for the Nearby tab: top 80 cached for 5 minutes, then filtered per person (blocks, gender, photo, adults).
let popCache = { at: 0, list: [] };
app.post('/social/popular', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'popular', 20, 60000);
  const f = fsdb(), g = (req.body || {}).gender, gender = ['male', 'female'].includes(g) ? g : '';
  if (Date.now() - popCache.at > 300000) {
    const snap = await f.collection('users').orderBy('followers', 'desc').limit(80).get();
    popCache = { at: Date.now(), list: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
  const [bl1, bl2] = await Promise.all([f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const skip = new Set([req.uid, ...bl1.docs.map(d => d.data().blocked), ...bl2.docs.map(d => d.data().by)]);
  const me = await getUserDoc(req.uid);
  const users = popCache.list.filter(u => !skip.has(u.id) && photoOf(u) && u.age >= 18 && (u.followers || 0) > 0 && (!gender || u.gender === gender)).slice(0, 12).map(u => ({
    id: u.id, name: u.name, handle: u.handle || '', age: u.age, gender: u.gender, occupation: u.occupation, goal: u.goal, bio: u.bio, city: u.city, state: u.state, country: u.country,
    neighborhood: u.neighborhood, lat: u.lat ?? null, lng: u.lng ?? null, media: u.media || [], verified: !!u.verified, interests: u.interests || [], prompts: u.prompts || [], followers: u.followers || 0,
    lastSeen: u.lastSeen && u.lastSeen.toMillis ? u.lastSeen.toMillis() : 0, createdAt: u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : 0 }));
  res.json({ users });
}));

/* =====================================================================================================
   STATUS: 24-hour updates (text, photo or video) like WhatsApp. Stored in 'statuses'; every viewer is a doc in
   statuses/{id}/views/{uid} (with an optional emoji reaction and reply). Expired ones are hidden at once and purged hourly.
   ===================================================================================================== */
const STATUS_TTL = 24 * 3600e3, STATUS_EMOJI = ['❤️', '😂', '😮', '😢', '🙏', '👍', '🔥', '😍'];
const cloudUrl = u => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' && x.hostname === 'res.cloudinary.com' ? x.href.slice(0, 600) : ''; } catch { return ''; } };
const stItem = (d, own) => { const x = d.data(); return { id: d.id, uid: x.uid, kind: x.kind, text: x.text || '', bg: x.bg || 0, font: x.font || 0, url: x.url || '', caption: x.caption || '', duration: x.duration || 0, privacy: x.privacy || 'public', createdAt: x.createdAt || 0, expiresAt: x.expiresAt || 0, likes: Math.max(0, x.likes || 0), comments: Math.max(0, x.comments || 0), ...(own ? { views: x.views || 0 } : {}) }; };
async function statusVisible(x, viewer) {
  if (x.uid === viewer) return true;
  if (!x.expiresAt || x.expiresAt <= Date.now()) return false;
  if (await isBlocked(viewer, x.uid)) return false;
  if (x.privacy === 'matches') return (await fsdb().collection('matches').doc(matchIdOf(viewer, x.uid)).get()).exists;
  return true;
}
async function getStatus(id, viewer, needOther) {
  if (!SAFE_ID.test(String(id || ''))) throw httpErr(400, 'Invalid status');
  const ref = fsdb().collection('statuses').doc(id), snap = await ref.get();
  if (!snap.exists) throw httpErr(404, 'This status is gone');
  const x = snap.data();
  if (!(await statusVisible(x, viewer))) throw httpErr(404, 'This status is gone');
  if (needOther && x.uid === viewer) throw httpErr(400, 'That is your own status');
  return { ref, x };
}
async function recordStatusView(sref, uid, extra) {      // first time = counts as a view; later calls only add the reaction / reply
  const vref = sref.collection('views').doc(uid), me = await getUserDoc(uid); let isNew = false;
  await fsdb().runTransaction(async t => {
    const v = await t.get(vref); isNew = !v.exists;
    if (!v.exists) { t.set(vref, { name: me.name || '', photo: photoOf(me), at: FV().serverTimestamp(), ...(extra || {}) }); t.update(sref, { views: FV().increment(1) }); }
    else if (extra && Object.keys(extra).length) t.update(vref, extra);
  });
  me._new = isNew;      // true the first time this person opens the status
  return me;
}

async function setStatusReact(sref, uid, emoji) {      // one reaction per person; keeps the status "likes" counter in step (emoji '' removes it)
  const vref = sref.collection('views').doc(uid), me = await getUserDoc(uid); let had = false, isNew = false;
  await fsdb().runTransaction(async t => {
    const v = await t.get(vref); isNew = !v.exists; had = !!(v.exists && v.data().react);
    if (!v.exists) {
      t.set(vref, { name: me.name || '', photo: photoOf(me), at: FV().serverTimestamp(), ...(emoji ? { react: emoji } : {}) });
      t.update(sref, { views: FV().increment(1), ...(emoji ? { likes: FV().increment(1) } : {}) });
    } else if (emoji) { t.update(vref, { react: emoji }); if (!had) t.update(sref, { likes: FV().increment(1) }); }
    else if (had) { t.update(vref, { react: FV().delete() }); t.update(sref, { likes: FV().increment(-1) }); }
  });
  me._new = isNew; me._had = had; return me;
}

// New status: push to the people who follow you or are matched with you (matches-only statuses go to matches only). Blocked people are skipped,
// each person gets at most one such alert per 2 hours from you, and the fan-out is capped.
async function notifyStatusFollowers(uid, me, st) {
  const f = fsdb();
  const [fol, mat, b1, b2] = await Promise.all([
    f.collection('follows').where('to', '==', uid).limit(300).get(), f.collection('matches').where('members', 'array-contains', uid).limit(300).get(),
    f.collection('blocks').where('by', '==', uid).get(), f.collection('blocks').where('blocked', '==', uid).get()]);
  const blocks = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]), to = new Set();
  mat.docs.forEach(d => (d.data().members || []).forEach(m => { if (m !== uid) to.add(m); }));
  if (st.privacy !== 'matches') fol.docs.forEach(d => { const t = d.data().from; if (t && t !== uid) to.add(t); });
  const list = [...to].filter(t => !blocks.has(t)).slice(0, 300);
  const text = st.kind === 'video' ? 'posted a new video status' : st.kind === 'image' ? 'posted a new photo status' : 'posted a new status';
  for (let i = 0; i < list.length; i += 15)
    await Promise.all(list.slice(i, i + 15).map(t => notifyUser({ to: t, from: uid, fromName: me.name, icon: photoOf(me), type: 'status', text, id: `statuspost_${uid}_${t}`, gapMs: 2 * 3600e3 }).catch(() => {})));
}
async function deleteStatusDoc(ref) {
  for (let i = 0; i < 20; i++) { const v = await ref.collection('views').limit(400).get(); if (v.empty) break; await deleteRefs(v.docs.map(d => d.ref)); }
  for (let i = 0; i < 20; i++) { const c = await ref.collection('comments').limit(400).get(); if (c.empty) break; await deleteRefs(c.docs.map(d => d.ref)); }
  await ref.delete();
}

app.post('/status/create', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stcreate', 20, 3600e3);
  const b = req.body || {}, kind = b.kind;
  if (!['text', 'image', 'video'].includes(kind)) throw httpErr(400, 'Invalid status type');
  const f = fsdb(), me = await getUserDoc(req.uid), now = Date.now();
  const mine = await f.collection('statuses').where('uid', '==', req.uid).limit(60).get();
  if (mine.docs.filter(d => (d.data().expiresAt || 0) > now).length >= 30) throw httpErr(429, 'You have 30 active updates. Delete one to add more.');
  const doc = { uid: req.uid, name: String(me.name || '').slice(0, 80), photo: photoOf(me), kind, privacy: b.privacy === 'matches' ? 'matches' : 'public', views: 0, createdAt: now, expiresAt: now + STATUS_TTL };
  if (kind === 'text') {
    doc.text = String(b.text || '').trim().slice(0, 700);
    if (!doc.text) throw httpErr(400, 'Write something first');
    doc.bg = Math.min(11, Math.max(0, Math.floor(Number(b.bg) || 0))); doc.font = Math.min(3, Math.max(0, Math.floor(Number(b.font) || 0)));
  } else {
    doc.url = cloudUrl(b.url);
    if (!doc.url) throw httpErr(400, 'The upload did not finish. Please try again.');
    doc.caption = String(b.caption || '').trim().slice(0, 200);
    if (kind === 'video') doc.duration = Math.min(60, Math.max(1, Number(b.duration) || 15));
  }
  const ref = await f.collection('statuses').add(doc);
  notifyStatusFollowers(req.uid, me, doc).catch(e => console.warn('status alert fan-out failed', e.message));   // never slows the post down
  res.json({ ok: true, id: ref.id });
}));

app.post('/status/feed', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stfeed', 40, 60000);
  const f = fsdb(), now = Date.now();
  const [snap, fol, mat, b1, b2] = await Promise.all([
    f.collection('statuses').where('expiresAt', '>', now).orderBy('expiresAt', 'desc').limit(500).get(),
    f.collection('follows').where('from', '==', req.uid).limit(2000).get(),
    f.collection('matches').where('members', 'array-contains', req.uid).get(),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get()]);
  const following = new Set(fol.docs.map(d => d.data().to)), matched = new Set(), blocks = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  mat.docs.forEach(d => (d.data().members || []).forEach(m => { if (m !== req.uid) matched.add(m); }));
  const by = new Map();
  snap.docs.forEach(d => {
    const x = d.data(), own = x.uid === req.uid;
    if (blocks.has(x.uid) || (!own && x.privacy === 'matches' && !matched.has(x.uid))) return;
    let g = by.get(x.uid);
    if (!g) { g = { uid: x.uid, name: x.name || 'Someone', photo: x.photo || '', friend: own || following.has(x.uid) || matched.has(x.uid), items: [] }; by.set(x.uid, g); }
    g.items.push(stItem(d, own));
  });
  const groups = [...by.values()].filter(g => g.uid !== req.uid);
  groups.forEach(g => g.items.sort((a, b) => a.createdAt - b.createdAt));
  const last = g => g.items[g.items.length - 1].createdAt;
  groups.sort((a, b) => (b.friend - a.friend) || (last(b) - last(a)));
  const mine = (by.get(req.uid) || { items: [] }).items.sort((a, b) => a.createdAt - b.createdAt);
  res.json({ mine, groups: [...groups.filter(g => g.friend), ...groups.filter(g => !g.friend).slice(0, 40)] });
}));

app.post('/status/view', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stview', 300, 60000);
  let st; try { st = await getStatus((req.body || {}).id, req.uid); } catch (e) { return res.json({ ok: false }); }
  if (st.x.uid !== req.uid) {
    const me = await recordStatusView(st.ref, req.uid).catch(() => null);
    if (me && me._new) {      // one alert per status, at most every 20 minutes, counting the rest as "others"
      const n = (st.x.views || 0) + 1;
      notifyUser({ to: st.x.uid, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'status', text: n > 1 ? `and ${n - 1} ${n - 1 === 1 ? 'other' : 'others'} viewed your status` : 'viewed your status', id: `statusview_${st.ref.id}`, gapMs: 20 * 60e3 }).catch(() => {});
    }
  }
  let liked = false; try { if (st.x.uid !== req.uid) { const v = await st.ref.collection('views').doc(req.uid).get(); liked = !!(v.exists && v.data().react); } } catch {}
  const fresh = await st.ref.get().then(d => d.data() || {}).catch(() => ({}));
  res.json({ ok: true, liked, likes: Math.max(0, fresh.likes || 0), comments: Math.max(0, fresh.comments || 0) });
}));

app.post('/status/viewers', fbAuth, wrap(async (req, res) => {
  const id = (req.body || {}).id;
  if (!SAFE_ID.test(String(id || ''))) throw httpErr(400, 'Invalid status');
  const ref = fsdb().collection('statuses').doc(id), s = await ref.get();
  if (!s.exists || s.data().uid !== req.uid) throw httpErr(403, 'Only the owner can see this');
  const snap = await ref.collection('views').orderBy('at', 'desc').limit(200).get();
  res.json({ total: s.data().views || 0, items: snap.docs.map(d => { const x = d.data(); return { id: d.id, name: x.name || 'Someone', photo: x.photo || '', at: (x.at && x.at.toMillis && x.at.toMillis()) || 0, react: x.react || '', reply: x.reply || '' }; }) });
}));

app.post('/status/react', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'streact', 60, 60000);
  const emoji = String((req.body || {}).emoji || '');
  if (!STATUS_EMOJI.includes(emoji)) throw httpErr(400, 'Invalid reaction');
  const { ref, x } = await getStatus((req.body || {}).id, req.uid, true);
  const me = await setStatusReact(ref, req.uid, emoji);
  if (!me._had) notifyUser({ to: x.uid, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'status', text: `reacted ${emoji} to your status`, id: `status_${ref.id}_${req.uid}_react`, gapMs: 30000 }).catch(() => {});
  res.json({ ok: true });
}));

// Like / unlike (heart). Sends { id, on?: true|false }; without "on" it toggles.
app.post('/status/like', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stlike', 60, 60000);
  const b = req.body || {}, { ref, x } = await getStatus(b.id, req.uid, true);
  const v = await ref.collection('views').doc(req.uid).get(), has = !!(v.exists && v.data().react), want = b.on === true ? true : b.on === false ? false : !has;
  const me = await setStatusReact(ref, req.uid, want ? '❤️' : '');
  if (want && !me._had) notifyUser({ to: x.uid, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'status', text: 'liked your status', id: `status_${ref.id}_${req.uid}_react`, gapMs: 30000 }).catch(() => {});
  const fresh = (await ref.get()).data() || {};
  res.json({ ok: true, liked: want, likes: Math.max(0, fresh.likes || 0) });
}));

// Public comments on a status (anyone who can see the status, including its owner).
app.post('/status/comment', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stcomment', 20, 60000);
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 300);
  if (!text) throw httpErr(400, 'Write a comment first');
  const { ref, x } = await getStatus(b.id, req.uid, false), me = await getUserDoc(req.uid), cref = ref.collection('comments').doc(), f = fsdb(), batch = f.batch();
  const mn = parseMentions(text); if (mn.all && x.uid === req.uid) rateLimit(req.uid, 'mentionall', 3, 600000);
  batch.set(cref, { uid: req.uid, name: String(me.name || '').slice(0, 80), photo: photoOf(me), text, at: FV().serverTimestamp() });
  batch.update(ref, { comments: FV().increment(1) });
  await batch.commit();
  notifyMentions({ mn, text, from: req.uid, me, ownerId: x.uid, commentId: cref.id, canSee: t => statusVisible(x, t), meta: { k: 'status', owner: x.uid, id: ref.id } }).catch(e => console.warn('mention alerts failed', e.message));
  if (x.uid !== req.uid) notifyUser({ to: x.uid, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'status', text: `commented on your status: ${text}`, id: `status_${ref.id}_${req.uid}_comment`, gapMs: 20000 }).catch(() => {});
  res.json({ ok: true, item: { id: cref.id, uid: req.uid, name: me.name || '', photo: photoOf(me), text, at: Date.now(), mine: true, canDelete: true } });
}));

app.post('/status/comments', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stcmlist', 120, 60000);
  const { ref, x } = await getStatus((req.body || {}).id, req.uid, false), f = fsdb(), own = x.uid === req.uid;
  const [snap, b1, b2, v] = await Promise.all([ref.collection('comments').orderBy('at', 'asc').limit(200).get(),
    f.collection('blocks').where('by', '==', req.uid).get(), f.collection('blocks').where('blocked', '==', req.uid).get(), own ? null : ref.collection('views').doc(req.uid).get()]);
  const blocks = new Set([...b1.docs.map(d => d.data().blocked), ...b2.docs.map(d => d.data().by)]);
  const items = snap.docs.map(d => { const c = d.data(); return { id: d.id, uid: c.uid, name: c.name || 'Someone', photo: c.photo || '', text: c.text || '', at: (c.at && c.at.toMillis && c.at.toMillis()) || 0, mine: c.uid === req.uid, canDelete: c.uid === req.uid || own }; }).filter(c => !blocks.has(c.uid));
  res.json({ total: Math.max(0, x.comments || 0), likes: Math.max(0, x.likes || 0), liked: !!(v && v.exists && v.data().react), items });
}));

app.post('/status/comment-delete', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'stcmdel', 60, 60000);
  const b = req.body || {}; if (!SAFE_ID.test(String(b.commentId || ''))) throw httpErr(400, 'Invalid comment');
  const { ref, x } = await getStatus(b.id, req.uid, false), cref = ref.collection('comments').doc(b.commentId), c = await cref.get();
  if (!c.exists) return res.json({ ok: true });
  if (c.data().uid !== req.uid && x.uid !== req.uid) throw httpErr(403, 'You can only delete your own comment');
  const batch = fsdb().batch(); batch.delete(cref); batch.update(ref, { comments: FV().increment(-1) }); await batch.commit();
  res.json({ ok: true });
}));

app.post('/status/reply', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'streply', 20, 60000);
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  if (!text) throw httpErr(400, 'Write a reply first');
  const { ref, x } = await getStatus((req.body || {}).id, req.uid, true);
  const me = await recordStatusView(ref, req.uid, { reply: text, replyAt: FV().serverTimestamp() });
  notifyUser({ to: x.uid, from: req.uid, fromName: me.name, icon: photoOf(me), type: 'status', text: `replied to your status: ${text}`, id: `status_${ref.id}_${req.uid}_reply` }).catch(() => {});
  res.json({ ok: true });
}));

app.post('/status/delete', fbAuth, wrap(async (req, res) => {
  const id = (req.body || {}).id;
  if (!SAFE_ID.test(String(id || ''))) throw httpErr(400, 'Invalid status');
  const ref = fsdb().collection('statuses').doc(id), s = await ref.get();
  if (!s.exists) return res.json({ ok: true });
  if (s.data().uid !== req.uid) throw httpErr(403, 'This is not your status');
  await deleteStatusDoc(ref);
  res.json({ ok: true });
}));

async function purgeStatuses() {      // removes updates that expired more than an hour ago, with their viewer lists
  const snap = await fsdb().collection('statuses').where('expiresAt', '<', Date.now() - 3600e3).limit(100).get();
  for (const d of snap.docs) await deleteStatusDoc(d.ref).catch(() => {});
}
setInterval(() => purgeStatuses().catch(e => console.warn('status purge', e.message)), 3600e3).unref();

/* =====================================================================================================
   ADVERTS: created in /admin.html (Ads tab), shown inside the app between users' videos (gallery viewer),
   in the Nearby list and in the Live rooms list. Stored in the Firestore 'ads' collection.
   ===================================================================================================== */
const AD_PLACEMENTS = ['lightbox', 'nearby', 'live', 'status'];
const adUrl = u => { u = String(u || '').trim(); if (!u) return ''; try { const x = new URL(u); return x.protocol === 'https:' ? x.href.slice(0, 600) : ''; } catch { return ''; } };
let adCache = { at: 0, list: [] };
async function activeAds() {                 // cached for a minute so a busy app does not read Firestore on every request
  if (Date.now() - adCache.at < 60000) return adCache.list;
  const snap = await fsdb().collection('ads').where('status', '==', 'active').limit(200).get(), now = Date.now();
  adCache = { at: now, list: snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => (!a.startsAt || a.startsAt <= now) && (!a.endsAt || a.endsAt > now)) };
  return adCache.list;
}
app.post('/ads/feed', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'adfeed', 30, 60000);
  const place = String((req.body || {}).placement || '');
  if (!AD_PLACEMENTS.includes(place)) throw httpErr(400, 'Invalid placement');
  const ads = (await activeAds()).filter(a => (a.placements || []).includes(place))
    .map(a => ({ a, k: -Math.log(Math.random() || 1e-9) / Math.max(1, Number(a.weight) || 1) })).sort((x, y) => x.k - y.k).slice(0, 8)   // weighted random order
    .map(({ a }) => ({ id: a.id, title: a.title || '', body: a.body || '', sponsor: a.sponsor || '', cta: a.cta || '', imageUrl: a.imageUrl || '', videoUrl: a.videoUrl || '', linkUrl: a.linkUrl || '' }));
  res.json({ ads });
}));
app.post('/ads/event', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'adevent', 120, 60000);
  const { id, type } = req.body || {};
  if (!SAFE_ID.test(String(id || '')) || !['view', 'click'].includes(type)) throw httpErr(400, 'Invalid event');
  await fsdb().collection('ads').doc(id).update({ [type === 'view' ? 'views' : 'clicks']: FV().increment(1) }).catch(() => {});   // an ad deleted meanwhile is ignored
  res.json({ ok: true });
}));
app.get('/admin/ads', adminAuth, wrap(async (req, res) => {
  const snap = await fsdb().collection('ads').orderBy('createdAt', 'desc').limit(200).get();
  res.json({ items: snap.docs.map(d => { const x = d.data(); return { id: d.id, ...x, createdAt: (x.createdAt && x.createdAt.toMillis && x.createdAt.toMillis()) || 0 }; }) });
}));
app.post('/admin/ads', adminAuth, wrap(async (req, res) => {                // create (no id) or edit (with id)
  const b = req.body || {}, f = fsdb();
  const placements = (Array.isArray(b.placements) ? b.placements : []).filter(p => AD_PLACEMENTS.includes(p));
  const doc = {
    title: String(b.title || '').trim().slice(0, 80), body: String(b.body || '').trim().slice(0, 200), sponsor: String(b.sponsor || '').trim().slice(0, 40),
    cta: String(b.cta || '').trim().slice(0, 24), imageUrl: adUrl(b.imageUrl), videoUrl: adUrl(b.videoUrl), linkUrl: adUrl(b.linkUrl),
    placements, weight: Math.min(10, Math.max(1, Math.floor(Number(b.weight) || 1))),
    startsAt: Number(b.startsAt) > 0 ? Number(b.startsAt) : 0, endsAt: Number(b.endsAt) > 0 ? Number(b.endsAt) : 0
  };
  if (!doc.title) throw httpErr(400, 'Add a title');
  if (!doc.imageUrl && !doc.videoUrl) throw httpErr(400, 'Add an image or a video (https link or upload)');
  if (!placements.length) throw httpErr(400, 'Choose where the advert should show');
  if (doc.endsAt && doc.endsAt <= doc.startsAt) throw httpErr(400, 'The end date must be after the start date');
  if (b.id) {
    if (!SAFE_ID.test(String(b.id))) throw httpErr(400, 'Invalid id');
    const ref = f.collection('ads').doc(b.id); if (!(await ref.get()).exists) throw httpErr(404, 'Advert not found');
    await ref.update(doc); adCache.at = 0; return res.json({ ok: true, id: b.id });
  }
  const ref = await f.collection('ads').add({ ...doc, status: 'active', views: 0, clicks: 0, createdAt: FV().serverTimestamp() });
  adCache.at = 0; res.json({ ok: true, id: ref.id });
}));
app.post('/admin/ads/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, ref = fsdb().collection('ads').doc(req.params.id);
  if (action === 'delete') await ref.delete();
  else if (action === 'pause' || action === 'resume') await ref.update({ status: action === 'pause' ? 'paused' : 'active' });
  else throw httpErr(400, 'Invalid action');
  adCache.at = 0; res.json({ ok: true });
}));

/* =====================================================================================================
   SELFIE VERIFICATION + REPORTS REVIEW (reviewed by hand on /admin.html)
   ===================================================================================================== */
const VERIFY_MIN_FOLLOWERS = Math.max(0, parseInt(process.env.VERIFY_MIN_FOLLOWERS, 10) || 500);      // followers needed before a face check can be sent
async function verifyEligible(uid) {
  const me = await getUserDoc(uid);
  if (me.verified) throw httpErr(409, 'You are already verified');
  const have = Math.max(0, Number(me.followers) || 0);      // followers is a server-kept counter, a member can't edit it
  if (have < VERIFY_MIN_FOLLOWERS) throw httpErr(403, `You need ${VERIFY_MIN_FOLLOWERS} followers to request the verified badge. You have ${have}.`);
  return me;
}
// signed direct upload: the face video and the selfie can only land in this member's own verification folder
app.post('/verify/signature', fbAuth, wrap(async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) throw httpErr(503, 'Verification is not set up yet');
  await verifyEligible(req.uid);
  rateLimit(req.uid, 'verify-sig', 6, 86400000);
  const timestamp = Math.round(Date.now() / 1000), folder = `flc-verify/${req.uid}`;
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, folder, signature, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
}));
app.post('/verify/request', fbAuth, wrap(async (req, res) => {
  const b = req.body || {}, url = String(b.url || ''), video = String(b.video || '');
  const base = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`, mine = `/flc-verify/${req.uid}/`;
  const ok = u => process.env.CLOUDINARY_CLOUD_NAME && u.startsWith(base) && u.includes(mine);
  if (!ok(url) || !ok(video)) throw httpErr(400, 'Please record the live face check with your camera.');
  if (!url.includes('/image/upload/') || !video.includes('/video/upload/')) throw httpErr(400, 'Invalid face check');
  const me = await verifyEligible(req.uid);
  rateLimit(req.uid, 'verify', 3, 86400000);
  await fsdb().collection('verifications').doc(req.uid).set({ uid: req.uid, name: me.name || '', selfie: url, video, profilePhoto: photoOf(me), status: 'pending', createdAt: FV().serverTimestamp() });
  res.json({ ok: true });
}));

app.get('/admin/reports', adminAuth, wrap(async (req, res) => {
  const snap = await fsdb().collection('reports').orderBy('createdAt', 'desc').limit(100).get();
  const items = snap.docs.map(d => { const x = d.data(); return { id: d.id, from: x.from, to: x.to, reason: x.reason, details: x.details || '', reviewed: !!x.reviewed, createdAt: (x.createdAt && x.createdAt.toMillis && x.createdAt.toMillis()) || 0 }; });
  res.json({ items: items.filter(i => req.query.all === '1' || !i.reviewed) });
}));
app.post('/admin/reports/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, f = fsdb(), rref = f.collection('reports').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) throw httpErr(404, 'Report not found');
  if (action === 'suspend' && rs.data().to) await admin.auth().updateUser(rs.data().to, { disabled: true });     // reported person can no longer sign in
  else if (action !== 'dismiss') throw httpErr(400, 'Invalid action');
  await rref.update({ reviewed: true, outcome: action, reviewedAt: FV().serverTimestamp() });
  res.json({ ok: true });
}));
app.get('/admin/verifications', adminAuth, wrap(async (req, res) => {
  const snap = await fsdb().collection('verifications').where('status', '==', 'pending').limit(100).get();
  res.json({ items: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: (d.data().createdAt && d.data().createdAt.toMillis && d.data().createdAt.toMillis()) || 0 })) });
}));
app.post('/admin/verifications/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, f = fsdb();
  if (!['approve', 'reject'].includes(action)) throw httpErr(400, 'Invalid action');
  await f.collection('verifications').doc(req.params.id).update({ status: action === 'approve' ? 'approved' : 'rejected', reviewedAt: FV().serverTimestamp() });
  if (action === 'approve') await f.collection('users').doc(req.params.id).update({ verified: true });
  res.json({ ok: true });
}));

/* =====================================================================================================
   KYC: identity check before a creator can withdraw money
   - ID and selfie photos go straight to Cloudinary as PRIVATE assets (signed upload); only admins get signed links.
   - The full ID number is never stored in plain text: we keep the last 4 digits, an HMAC fingerprint (to catch one ID
     used on several accounts) and, if KYC_ENC_KEY is set, an encrypted copy that only the admin page can read.
   - The bank account name is compared with the verified name; a mismatch is flagged for the admin.
   ===================================================================================================== */
const KYC_REQUIRED = process.env.KYC_REQUIRED !== 'false';
const KYC_ENC_KEY = process.env.KYC_ENC_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.KYC_ENC_KEY) ? Buffer.from(process.env.KYC_ENC_KEY, 'hex') : null;   // 32 bytes as 64 hex characters
const KYC_PEPPER = process.env.KYC_PEPPER || process.env.ADMIN_SECRET || 'fine-love-kyc';
if (!process.env.KYC_PEPPER) console.warn('KYC_PEPPER is not set. Set it once and never change it: changing it breaks duplicate-ID detection.');
if (KYC_REQUIRED && !KYC_ENC_KEY) console.warn('KYC_ENC_KEY is not set: full ID numbers will not be stored, so the admin page only sees the last 4 digits.');
const ID_TYPES = { nin: /^\d{11}$/, bvn: /^\d{11}$/, drivers: /^[A-Za-z0-9-]{8,20}$/, passport: /^[A-Za-z0-9]{6,12}$/, voters: /^[A-Za-z0-9 ]{9,25}$/ };
const kycRef = uid => fsdb().collection('kyc').doc(uid);
const kycPrivRef = uid => fsdb().collection('kycPrivate').doc(uid);
const idFingerprint = (type, num) => crypto.createHmac('sha256', KYC_PEPPER).update(`${type}:${String(num).replace(/\s/g, '').toUpperCase()}`).digest('hex');
function encId(v) {
  if (!KYC_ENC_KEY) return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KYC_ENC_KEY, iv);
  const e = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), e].map(x => x.toString('base64')).join('.');
}
function decId(s) {
  if (!KYC_ENC_KEY || !s) return '';
  try { const [iv, tag, e] = s.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', KYC_ENC_KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); }
  catch { return ''; }
}
const normName = s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
function namesMatch(a, b) {              // order does not matter; at least two names (or all of them, if fewer) must be shared
  const A = normName(a), B = new Set(normName(b));
  if (!A.length || !B.size) return false;
  return A.filter(w => B.has(w)).length >= Math.min(2, A.length, B.size);
}
async function kycStatus(uid) { const s = await kycRef(uid).get(); return s.exists ? { status: s.data().status, legalName: s.data().legalName || '' } : { status: 'none', legalName: '' }; }
// Deletes the private ID photos and selfie from Cloudinary and the stored fingerprint (reject, revoke, account deletion).
async function destroyKycFiles(uid) {
  const ps = await kycPrivRef(uid).get(); if (!ps.exists) return;
  const p = ps.data();
  await Promise.all([p.idPhoto, p.selfie].filter(x => x && x.id).map(x => cloudinary.uploader.destroy(x.id, { type: 'private', resource_type: 'image', invalidate: true }).catch(e => console.warn('kyc file destroy failed', e.message))));
  await kycPrivRef(uid).delete().catch(() => {});
}
const signedPrivateUrl = (id, format) => cloudinary.url(id, { type: 'private', sign_url: true, secure: true, resource_type: 'image', format: format || 'jpg' });

// Signed, PRIVATE upload for ID photos and selfies (the client uploads straight to Cloudinary)
app.post('/kyc/upload-signature', fbAuth, kycOpen, wrap(async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw httpErr(503, 'Uploads are not configured');
  rateLimit(req.uid, 'kycsig', 10, 3600000);
  const timestamp = Math.floor(Date.now() / 1000), folder = `kyc/${req.uid}`;
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder, type: 'private' }, process.env.CLOUDINARY_API_SECRET);
  res.json({ timestamp, folder, signature, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
}));

app.post('/kyc/submit', fbAuth, kycOpen, wrap(async (req, res) => {
  const b = req.body || {};
  const legalName = String(b.legalName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const idType = String(b.idType || ''), idNumber = String(b.idNumber || '').trim();
  const dob = String(b.dob || '');
  if (b.consent !== true) throw httpErr(400, 'Please accept the consent box to continue');
  if (normName(legalName).length < 2) throw httpErr(400, 'Enter your full legal name as it appears on your ID (first and last name)');
  if (!ID_TYPES[idType] || !ID_TYPES[idType].test(idNumber)) throw httpErr(400, 'That ID number does not look right for the ID type you picked');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(dob + 'T00:00:00Z') : null;
  if (!d || isNaN(d)) throw httpErr(400, 'Enter your date of birth');
  const age = (Date.now() - d.getTime()) / (365.25 * 86400000);
  if (age < 18 || age > 100) throw httpErr(400, 'You must be at least 18 to verify');
  const okFile = f => f && typeof f.id === 'string' && f.id.startsWith(`kyc/${req.uid}/`) && /^[A-Za-z0-9_\/-]{5,200}$/.test(f.id) && ['jpg', 'jpeg', 'png', 'webp'].includes(String(f.format || '').toLowerCase());
  if (!okFile(b.idPhoto) || !okFile(b.selfie)) throw httpErr(400, 'Upload a clear photo of your ID and a selfie');
  if (b.idPhoto.id === b.selfie.id) throw httpErr(400, 'The ID photo and the selfie must be two different photos');
  rateLimit(req.uid, 'kyc', 4, 86400000);
  const cur = await kycStatus(req.uid);
  if (cur.status === 'pending') throw httpErr(409, 'Your documents are already being reviewed');
  if (cur.status === 'approved') throw httpErr(409, 'You are already verified');
  const fp = idFingerprint(idType, idNumber), f = fsdb();
  const dup = await f.collection('kycPrivate').where('idHash', '==', fp).limit(5).get();
  const others = dup.docs.map(x => x.id).filter(x => x !== req.uid);
  if (others.length) {
    console.warn('KYC duplicate ID', req.uid, others);
    throw httpErr(409, 'This ID is already linked to another account. Contact support if this is a mistake.');
  }
  const me = await getUserDoc(req.uid);
  await kycPrivRef(req.uid).set({
    uid: req.uid, dob, idType, idHash: fp, idLast4: idNumber.replace(/\s/g, '').slice(-4), idNumberEnc: encId(idNumber),
    idPhoto: { id: b.idPhoto.id, format: String(b.idPhoto.format).toLowerCase() }, selfie: { id: b.selfie.id, format: String(b.selfie.format).toLowerCase() },
    profilePhoto: photoOf(me), createdAt: FV().serverTimestamp(),
  });
  await kycRef(req.uid).set({ uid: req.uid, status: 'pending', legalName, idType, idLast4: idNumber.replace(/\s/g, '').slice(-4), note: '', submittedAt: FV().serverTimestamp() });
  res.json({ ok: true });
}));

app.get('/admin/kyc', adminAuth, wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const snap = await fsdb().collection('kyc').where('status', '==', status).limit(100).get();
  const items = [];
  for (const d of snap.docs) {
    const k = d.data(), ps = await kycPrivRef(d.id).get(), p = ps.exists ? ps.data() : {};
    const same = p.idHash ? (await fsdb().collection('kycPrivate').where('idHash', '==', p.idHash).limit(5).get()).docs.map(x => x.id).filter(x => x !== d.id) : [];
    items.push({ id: d.id, legalName: k.legalName, idType: k.idType, idLast4: k.idLast4, idNumber: decId(p.idNumberEnc), dob: p.dob || '', note: k.note || '',
      idUrl: p.idPhoto ? signedPrivateUrl(p.idPhoto.id, p.idPhoto.format) : '', selfieUrl: p.selfie ? signedPrivateUrl(p.selfie.id, p.selfie.format) : '', profilePhoto: p.profilePhoto || '',
      duplicates: same, createdAt: (k.submittedAt && k.submittedAt.toMillis && k.submittedAt.toMillis()) || 0 });
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  res.json({ items });
}));
app.post('/admin/kyc/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, note = String((req.body || {}).note || '').slice(0, 200);
  if (!['approve', 'reject', 'revoke'].includes(action)) throw httpErr(400, 'Invalid action');
  if (action !== 'approve' && note.length < 3) throw httpErr(400, 'Tell the user why (they will see it)');
  const ref = kycRef(req.params.id), s = await ref.get();
  if (!s.exists) throw httpErr(404, 'Not found');
  if (action === 'revoke') { if (s.data().status !== 'approved') throw httpErr(409, 'Only approved verifications can be revoked'); }
  else if (s.data().status !== 'pending') throw httpErr(409, 'This request is already ' + s.data().status);
  await ref.update({ status: action === 'approve' ? 'approved' : 'rejected', note, reviewedAt: FV().serverTimestamp() });
  if (action !== 'approve') await destroyKycFiles(req.params.id);      // removes the photos and the stored fingerprint, so they can resubmit
  if (action === 'revoke') await freezePayouts(req.params.id, 'kyc_revoked', 'Identity verification was revoked by an admin').catch(() => {});
  res.json({ ok: true });
}));

/* ---------- Referrals: invite a friend, earn tokens ----------
   Inviter shares a code (users/{uid}.refCode, looked up through refCodes/{code}). The NEW member's app calls /referral/claim once the profile has a photo;
   the server pays the inviter REF_REWARD_TOKENS exactly once per new member. Tokens only ever change here, never in the browser.
   Env (all optional): REF_REWARD_TOKENS (50), REF_MAX_REWARDS per inviter (50), REF_WINDOW_DAYS the new account may be at most this old (7). */
const REF_REWARD = Math.max(1, Number(process.env.REF_REWARD_TOKENS) || 50);
const REF_MAX = Math.max(1, Number(process.env.REF_MAX_REWARDS) || 50);
const REF_WINDOW_MS = (Number(process.env.REF_WINDOW_DAYS) || 7) * 86400000;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';      // no 0/O/1/I
const REF_CODE_RE = /^[A-Z0-9]{4,12}$/;
const newRefCode = () => Array.from(crypto.randomBytes(6), b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

async function ensureRefCode(uid) {
  const f = fsdb(), uref = f.collection('users').doc(uid);
  const first = await uref.get();
  if (!first.exists) return null;
  if (first.data().refCode) return first.data().refCode;
  for (let i = 0; i < 8; i++) {
    const code = newRefCode(), cref = f.collection('refCodes').doc(code);
    const got = await f.runTransaction(async t => {
      const [c, u] = await Promise.all([t.get(cref), t.get(uref)]);
      if (u.data().refCode) return u.data().refCode;      // another request got there first
      if (c.exists) return null;                          // taken, try another
      t.set(cref, { uid, joined: 0, rewarded: 0, earned: 0, createdAt: FV().serverTimestamp() });
      t.update(uref, { refCode: code });
      return code;
    });
    if (got) return got;
  }
  throw httpErr(500, 'Could not create your code');
}

app.post('/referral/me', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'refme', 30, 60000);
  const code = await ensureRefCode(req.uid);
  if (!code) throw httpErr(404, 'Profile not found');
  const c = (await fsdb().collection('refCodes').doc(code).get()).data() || {};
  res.json({ code, joined: c.joined || 0, rewarded: c.rewarded || 0, earned: c.earned || 0, capReached: (c.rewarded || 0) >= REF_MAX });
}));

app.post('/referral/claim', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'refclaim', 10, 3600000);
  const uid = req.uid, code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!REF_CODE_RE.test(code)) return res.json({ status: 'rejected', reason: 'invalid_code' });
  const f = fsdb(), myRef = f.collection('referrals').doc(uid), meRef = f.collection('users').doc(uid), codeRef = f.collection('refCodes').doc(code);
  const [done, me, c] = await Promise.all([myRef.get(), meRef.get(), codeRef.get()]);
  if (done.exists) return res.json({ status: 'already' });                      // one referral per new member, ever
  if (!me.exists) throw httpErr(404, 'Profile not found');
  if (!c.exists) return res.json({ status: 'rejected', reason: 'invalid_code' });
  const inviter = c.data().uid, mine = me.data();
  if (inviter === uid) return res.json({ status: 'rejected', reason: 'own_code' });
  const created = mine.createdAt && mine.createdAt.toMillis ? mine.createdAt.toMillis() : 0;
  if (!created || Date.now() - created > REF_WINDOW_MS) return res.json({ status: 'rejected', reason: 'not_new' });
  if (!(mine.media || []).some(m => m && m.kind === 'photo' && m.url)) return res.json({ status: 'pending' });   // real profiles only; the app asks again once there is a photo
  if (await sharedDevice(inviter, uid).catch(() => false)) return res.json({ status: 'rejected', reason: 'same_device' });
  if (await isFrozen(inviter).catch(() => false)) return res.json({ status: 'rejected', reason: 'inviter_review' });

  const out = await f.runTransaction(async t => {
    const iref = f.collection('users').doc(inviter);
    const [mr, cr, ir] = await Promise.all([t.get(myRef), t.get(codeRef), t.get(iref)]);
    if (mr.exists) return 'already';
    if (!ir.exists) return 'invalid_code';
    if ((cr.data().rewarded || 0) >= REF_MAX) {
      t.set(myRef, { referrer: inviter, referee: uid, code, status: 'capped', createdAt: FV().serverTimestamp() });
      t.update(codeRef, { joined: FV().increment(1) });
      return 'capped';
    }
    t.set(myRef, { referrer: inviter, referee: uid, code, status: 'rewarded', tokens: 0, createdAt: FV().serverTimestamp() });
    t.update(codeRef, { joined: FV().increment(1), rewarded: FV().increment(1) });      // no sign-up bounty: the inviter earns only when this member's Paid_Coins are spent
    t.update(meRef, { referredBy: inviter });
    return 'rewarded';
  });
  if (out === 'rewarded') {
    notifyUser({ to: inviter, from: uid, fromName: mine.name || 'A new member', icon: photoOf(mine), type: 'referral', text: `joined with your code. You will earn a share when they spend.`, id: `referral_${uid}` }).catch(() => {});
    return res.json({ status: 'rewarded' });
  }
  if (out === 'capped') return res.json({ status: 'rejected', reason: 'inviter_limit' });
  res.json(out === 'already' ? { status: 'already' } : { status: 'rejected', reason: out });
}));

/* =====================================================================================================
   LIVE MODERATION: frame scanning, 15-second warning, strikes, Go Live restrictions, appeals, live reports,
   and the private-room gate (18+ verified + two-way consent).
   Settings: moderation-config.json (thresholds, strike tiers, private-room rules). Environment variables:
     MOD_PROVIDER      sightengine | vision | none (default none = nothing is scanned, only reports work)
     SIGHTENGINE_USER / SIGHTENGINE_SECRET   when MOD_PROVIDER=sightengine
     MOD_PROFILE       standard | strict (overrides "profile" in the config)
     MOD_SHADOW        true = score and log frames but never warn, end a live or give strikes (use this for the first days)
     MOD_REQUIRE_SIGNAL true = end a video live that sends no frames for 2 minutes (stops a tampered app from skipping the scan)
     PRIVATE_AGE_GATE  false = turn off the 18+ ID check for private rooms
   Firestore: modState/{uid}, modIncidents/{id}, modAppeals/{id}, rooms/{id}/consents/{uid}.
   No video frame is ever saved: a frame is scored in memory and thrown away.
   ===================================================================================================== */
const fsNode = require('fs');
const DEFAULT_MOD = {
  profile: 'standard',
  scan: { intervalMs: 3000, minGapMs: 2000, frameMaxPx: 320, jpegQuality: 0.6, providerTimeoutMs: 6000 },
  profiles: {
    standard: { explicit_nudity: { warn: 0.55, violate: 0.85, instant: 0.93, consecutiveFrames: 2 }, sexual_activity: { warn: 0.4, violate: 0.7, instant: 0.7, consecutiveFrames: 1 } },
    strict: { explicit_nudity: { warn: 0.4, violate: 0.75, instant: 0.88, consecutiveFrames: 2 }, sexual_activity: { warn: 0.3, violate: 0.55, instant: 0.55, consecutiveFrames: 1 } },
  },
  warning: { graceSeconds: 15, clearAfterCleanFrames: 2 },
  strikes: { tiers: [{ strike: 1, restrictHours: 1 }, { strike: 2, restrictHours: 24 }, { strike: 3, restrictHours: 168 }], fourthStrikeAndAbove: { restrictHours: 168, needsHumanReview: true }, severeJumpToStrike: 3, strikesExpireAfterDays: 90 },
  appeals: { enabled: true, maxOpenPerUser: 1, minTextLength: 10, windowDays: 30 },
  liveReports: { distinctReportersToTakeDown: 3, windowMinutes: 5, takeDownRestrictHours: 1 },
  privateRoom: { requireHostAge18Verified: true, requireViewerAge18Verified: true, requireMutualConsent: true, consentVersion: 1, consentWindowSeconds: 60 },
  providers: { sightengine: { explicitFrom: ['sexual_display', 'erotica'], suggestiveFrom: ['very_suggestive', 'suggestive', 'mildly_suggestive'] } },
};
let MOD = DEFAULT_MOD;
try { MOD = { ...DEFAULT_MOD, ...JSON.parse(fsNode.readFileSync(path.join(__dirname, 'moderation-config.json'), 'utf8')) }; }
catch (e) { console.warn('moderation-config.json not read, using built-in defaults:', e.message); }
const MOD_PROVIDER = ['sightengine', 'vision'].includes(process.env.MOD_PROVIDER) ? process.env.MOD_PROVIDER : 'none';
const MOD_SHADOW = process.env.MOD_SHADOW === 'true';
const modProfile = () => MOD.profiles[process.env.MOD_PROFILE || MOD.profile] || MOD.profiles.standard;
if (MOD_PROVIDER === 'none') console.warn('MOD_PROVIDER is not set: live video is NOT being scanned. Viewer reports and the strike system still work.');
if (MOD_SHADOW) console.warn('MOD_SHADOW=true: live frames are scored and logged, but nobody is warned, ended or given strikes.');
const HOUR_MS = 3600000;
const modErr = (status, message, code, extra) => Object.assign(httpErr(status, message), { mcode: code, extra });
const modStateRef = uid => fsdb().collection('modState').doc(uid);

/* ---------- scoring: turns one JPEG into { explicit_nudity, sexual_activity, suggestive_attire } (0..1) ---------- */
const LIKELIHOOD = { VERY_UNLIKELY: 0.02, UNLIKELY: 0.15, POSSIBLE: 0.5, LIKELY: 0.8, VERY_LIKELY: 0.96 };
async function scoreFrame(buf) {
  if (MOD_PROVIDER === 'none') return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), MOD.scan.providerTimeoutMs || 6000);
  try {
    if (MOD_PROVIDER === 'sightengine') {
      if (!process.env.SIGHTENGINE_USER || !process.env.SIGHTENGINE_SECRET) throw new Error('SIGHTENGINE_USER / SIGHTENGINE_SECRET not set');
      const fd = new FormData();
      fd.append('media', new Blob([buf], { type: 'image/jpeg' }), 'frame.jpg');
      fd.append('models', 'nudity-2.1'); fd.append('api_user', process.env.SIGHTENGINE_USER); fd.append('api_secret', process.env.SIGHTENGINE_SECRET);
      const r = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: fd, signal: ctl.signal });
      const j = await r.json();
      if (j.status !== 'success' || !j.nudity) throw new Error('Sightengine: ' + ((j.error && j.error.message) || r.status));
      const m = (MOD.providers && MOD.providers.sightengine) || DEFAULT_MOD.providers.sightengine, n = j.nudity;
      const top = keys => Math.max(0, ...keys.map(k => Number(n[k]) || 0));
      return { explicit_nudity: top(m.explicitFrom), sexual_activity: Number(n.sexual_activity) || 0, suggestive_attire: top(m.suggestiveFrom) };
    }
    // Google Cloud Vision SafeSearch (uses the Firebase service account; enable the "Cloud Vision API" on that project)
    const tok = await admin.app().options.credential.getAccessToken();
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: buf.toString('base64') }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] }] }),
    });
    const j = await r.json(), s = j.responses && j.responses[0] && j.responses[0].safeSearchAnnotation;
    if (!s) throw new Error('Vision: ' + ((j.error && j.error.message) || r.status));
    // SafeSearch only says "adult" or "racy": "adult" maps to explicit nudity, "racy" to suggestive attire. It cannot tell sexual acts apart.
    return { explicit_nudity: LIKELIHOOD[s.adult] || 0, sexual_activity: 0, suggestive_attire: LIKELIHOOD[s.racy] || 0 };
  } finally { clearTimeout(timer); }
}

/* ---------- strikes and restrictions ---------- */
async function applyStrike(uid, { roomId, kind, score, severe }) {
  const f = fsdb(), ref = modStateRef(uid), now = Date.now(), S = MOD.strikes;
  let out;
  await f.runTransaction(async t => {
    const s = await t.get(ref), d = s.exists ? s.data() : {};
    let strikes = d.strikes || 0;
    if (d.lastStrikeAt && now - d.lastStrikeAt > S.strikesExpireAfterDays * 86400000) strikes = 0;      // a clean stretch wipes the slate
    strikes += 1; if (severe) strikes = Math.max(strikes, S.severeJumpToStrike);
    const tier = S.tiers.find(x => x.strike === strikes) || S.fourthStrikeAndAbove;
    const until = now + tier.restrictHours * HOUR_MS, review = !!(severe || tier.needsHumanReview || strikes >= 4);
    out = { strikes, until, review };
    t.set(ref, { strikes, lastStrikeAt: now, restrictedUntil: until, restrictionStrike: strikes, needsReview: review || d.needsReview || false, last: { kind, roomId, at: now } }, { merge: true });
  });
  const inc = await f.collection('modIncidents').add({ uid, roomId, kind, score: Math.round(score * 100) / 100, strike: out.strikes, restrictedUntil: out.until, needsReview: out.review, source: 'scan', status: 'open', createdAt: FV().serverTimestamp() });
  await modStateRef(uid).set({ last: { kind, roomId, at: now, incidentId: inc.id } }, { merge: true });
  return { ...out, incidentId: inc.id };
}
async function modStatusFor(uid) {
  const s = await modStateRef(uid).get(), d = s.exists ? s.data() : {}, now = Date.now(), A = MOD.appeals || {};
  const active = !!(d.restrictedUntil && d.restrictedUntil > now);
  let strikes = d.strikes || 0; if (d.lastStrikeAt && now - d.lastStrikeAt > MOD.strikes.strikesExpireAfterDays * 86400000) strikes = 0;
  let appeal = null;
  if (d.lastAppealId) { const a = await fsdb().collection('modAppeals').doc(d.lastAppealId).get(); if (a.exists) appeal = { status: a.data().status, note: a.data().note || '', incidentId: a.data().incidentId }; }
  const recent = !!(d.last && d.last.at && now - d.last.at < (A.windowDays || 30) * 86400000);
  return {
    strikes, appeal,
    restricted: active ? { until: d.restrictedUntil, strike: d.restrictionStrike || strikes, kind: (d.last && d.last.kind) || 'explicit_nudity' } : null,
    canAppeal: !!(A.enabled !== false && recent && d.last && d.last.incidentId && !(appeal && (appeal.status === 'open' || appeal.incidentId === d.last.incidentId))),
  };
}
async function assertCanGoLive(uid) {
  const st = await modStatusFor(uid);
  if (st.restricted) throw modErr(403, 'Go Live is paused for your account', 'GO_LIVE_RESTRICTED', { restricted: st.restricted, strikes: st.strikes, canAppeal: st.canAppeal, appeal: st.appeal });
}

/* ---------- 18+ check and consent for private rooms ---------- */
const AGE_GATE = process.env.PRIVATE_AGE_GATE !== 'false';
async function isAdultVerified(uid) { return (await kycStatus(uid)).status === 'approved'; }      // government ID + date of birth, approved by a person
async function privateGate(r, req) {      // viewer side: 18+ verified AND has agreed to the private room rules
  if (!r.private || r.hostId === req.uid) return;
  const P = MOD.privateRoom;
  if (P.requireViewerAge18Verified && AGE_GATE && !req.isTestAdmin && !(await isAdultVerified(req.uid))) throw modErr(403, 'Verify that you are 18 or older to join private rooms', 'AGE_VERIFICATION_REQUIRED');
  if (P.requireMutualConsent && !(await r.ref.collection('consents').doc(req.uid).get()).exists) throw modErr(403, 'Please agree to the private room rules to join', 'PRIVATE_CONSENT_REQUIRED', { hostName: r.hostName || '', title: r.title || '' });
}
async function hostPrivateGate(r, req) {      // host side: 18+ verified AND ticked the consent box
  const P = MOD.privateRoom;
  if (P.requireHostAge18Verified && AGE_GATE && !req.isTestAdmin && !(await isAdultVerified(req.uid))) throw modErr(403, 'Verify that you are 18 or older to host private rooms', 'AGE_VERIFICATION_REQUIRED');
  if (P.requireMutualConsent && !(req.body && req.body.consent === true)) throw modErr(400, 'Please agree to the private room rules first', 'CONSENT_REQUIRED');
}
async function clearConsents(ref) { const x = await ref.collection('consents').get(); await deleteRefs(x.docs.map(d => d.ref)); }

app.post('/rooms/:id/private/consent', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'pconsent', 12, 60000);
  const r = await getRoom(req.params.id);
  if (!r.private || r.status !== 'live') throw httpErr(409, 'This room is not private right now');
  if (r.hostId === req.uid) throw httpErr(400, 'You agreed when you made the room private');
  const [g, i] = await Promise.all([r.ref.collection('guests').doc(req.uid).get(), r.ref.collection('invites').doc(req.uid).get()]);
  if (!g.exists && !i.exists) throw httpErr(403, 'Only people the host invited can join a private room');
  if (req.body && req.body.accept === false) {      // declined: out of the room, invitation withdrawn
    await Promise.all(['viewers', 'guests', 'requests', 'invites', 'consents'].map(sub => r.ref.collection(sub).doc(req.uid).delete().catch(() => {})));
    return res.json({ ok: true, declined: true });
  }
  if (MOD.privateRoom.requireViewerAge18Verified && AGE_GATE && !req.isTestAdmin && !(await isAdultVerified(req.uid))) throw modErr(403, 'Verify that you are 18 or older to join private rooms', 'AGE_VERIFICATION_REQUIRED');
  await r.ref.collection('consents').doc(req.uid).set({ at: FV().serverTimestamp(), v: MOD.privateRoom.consentVersion || 1, role: g.exists ? 'guest' : 'viewer' });
  res.json({ ok: true });
}));

/* ---------- the scan pipeline ---------- */
const modRoomState = new Map();      // `${roomId}:${uid}` -> { hot:{kind:n}, warnUntil, warnKind, clean, lastAt, last }
setInterval(() => { const cut = Date.now() - 600000; for (const [k, v] of modRoomState) if ((v.lastAt || 0) < cut) modRoomState.delete(k); }, 120000).unref();
const modReply = (st, now) => st.warnUntil && st.warnUntil > now ? { state: 'warning', graceLeft: Math.max(0, Math.ceil((st.warnUntil - now) / 1000)), kind: st.warnKind } : { state: 'ok' };

async function modViolation(r, uid, isHost, kind, score) {
  const severe = kind === 'sexual_activity';
  if (MOD_SHADOW) {
    await fsdb().collection('modIncidents').add({ uid, roomId: r.id, kind, score: Math.round(score * 100) / 100, source: 'scan', shadow: true, status: 'shadow', createdAt: FV().serverTimestamp() }).catch(() => {});
    return null;
  }
  const strike = await applyStrike(uid, { roomId: r.id, kind, score, severe });
  if (isHost) { await endRoom(r.ref, 'moderation'); await sysMsg(r.ref, r, 'This live ended because it broke the live guidelines.').catch(() => {}); }
  else {
    await Promise.all(['guests', 'requests', 'invites'].map(sub => r.ref.collection(sub).doc(uid).delete().catch(() => {})));
    await sysMsg(r.ref, r, 'A guest was removed from the stage for breaking the live guidelines.').catch(() => {});
  }
  modRoomState.delete(r.id + ':' + uid);
  return strike;
}

app.post('/rooms/:id/frame', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'frame', 40, 60000);
  const r = await getRoom(req.params.id);
  if (r.status !== 'live') return res.json({ state: 'ended' });
  const isHost = r.hostId === req.uid;
  if (!isHost && !(await r.ref.collection('guests').doc(req.uid).get()).exists) throw httpErr(403, 'Only people on stage are scanned');
  const img = String((req.body && req.body.img) || '');
  if (img.length < 400 || img.length > 90000 || !/^[A-Za-z0-9+/=]+$/.test(img)) throw httpErr(400, 'Bad frame');
  const buf = Buffer.from(img, 'base64');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw httpErr(400, 'Bad frame');
  const key = r.id + ':' + req.uid, now = Date.now(), st = modRoomState.get(key) || { hot: {}, clean: 0, lastAt: 0 };
  modRoomState.set(key, st);
  if (now - st.lastAt < (MOD.scan.minGapMs || 2000) - 300) return res.json(modReply(st, now));      // too soon: repeat the last answer
  st.lastAt = now;
  if (isHost) r.ref.update({ lastFrame: now }).catch(() => {});
  let sc = null;
  try { sc = await scoreFrame(buf); } catch (e) { console.warn('moderation scorer failed:', e.message); }
  if (!sc) return res.json({ ...modReply(st, now), unavailable: true });      // scorer down or not set up: fail open, reports still work

  const P = modProfile(), W = MOD.warning || {};
  let verdict = null, borderline = null;
  for (const k of ['sexual_activity', 'explicit_nudity']) {      // worst first
    const p = P[k]; if (!p) continue;
    const s = sc[k] || 0;
    if (s >= p.instant) { verdict = { kind: k, score: s }; break; }
    if (s >= p.violate) {
      st.hot[k] = (st.hot[k] || 0) + 1;
      if (st.hot[k] >= (p.consecutiveFrames || 1)) { verdict = { kind: k, score: s }; break; }
      if (!borderline || s > borderline.score) borderline = { kind: k, score: s };
    } else {
      st.hot[k] = 0;
      if (s >= p.warn && (!borderline || s > borderline.score)) borderline = { kind: k, score: s };
    }
  }
  if (!verdict && borderline) {      // near-miss: private warning, 15-second grace, then it counts as a violation
    st.clean = 0;
    if (!st.warnUntil || st.warnUntil < now - 60000) { st.warnUntil = now + (W.graceSeconds || 15) * 1000; st.warnKind = borderline.kind; }
    else if (now >= st.warnUntil) verdict = { kind: borderline.kind, score: borderline.score, expired: true };
  } else if (!verdict && st.warnUntil) {
    st.clean += 1; if (st.clean >= (W.clearAfterCleanFrames || 2)) { st.warnUntil = 0; st.clean = 0; }
  }
  if (!verdict) return res.json(modReply(st, now));

  const strike = await modViolation(r, req.uid, isHost, verdict.kind, verdict.score);
  if (!strike) return res.json({ state: 'ok', shadow: true });
  res.json({ state: isHost ? 'ended' : 'removed', kind: verdict.kind, strike: strike.strikes, until: strike.until, review: strike.review });
}));

// Broadcaster dashboard: strikes, countdown, appeal status, and the scan settings the app needs.
app.post('/moderation/status', fbAuth, wrap(async (req, res) => {
  const st = await modStatusFor(req.uid);
  res.json({ ...st, now: Date.now(), enabled: MOD_PROVIDER !== 'none', ageVerified: await isAdultVerified(req.uid).catch(() => false), ageGate: AGE_GATE,
    config: { intervalMs: MOD.scan.intervalMs, frameMaxPx: MOD.scan.frameMaxPx, jpegQuality: MOD.scan.jpegQuality, graceSeconds: (MOD.warning || {}).graceSeconds || 15 } });
}));
app.post('/moderation/appeal', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'appeal', 3, 86400000);
  const A = MOD.appeals || {}, text = String((req.body && req.body.text) || '').trim().slice(0, 600);
  if (text.length < (A.minTextLength || 10)) throw httpErr(400, 'Tell us what happened in a sentence or two');
  const st = await modStatusFor(req.uid);
  if (!st.canAppeal) throw httpErr(409, st.appeal && st.appeal.status === 'open' ? 'Your appeal is already being reviewed' : 'There is nothing to appeal right now');
  const s = (await modStateRef(req.uid).get()).data(), ref = fsdb().collection('modAppeals').doc();
  await ref.set({ uid: req.uid, incidentId: s.last.incidentId, kind: s.last.kind, strike: s.restrictionStrike || 0, restrictedUntil: s.restrictedUntil || 0, text, status: 'open', createdAt: FV().serverTimestamp() });
  await modStateRef(req.uid).set({ lastAppealId: ref.id }, { merge: true });
  res.json({ ok: true });
}));

// Viewers report a live. Three different people reporting nudity or a minor within five minutes pauses the live for a human to check.
app.post('/rooms/:id/report-live', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'livereport', 5, 600000);
  const r = await getRoom(req.params.id), b = req.body || {}, f = fsdb();
  if (r.hostId === req.uid) throw httpErr(400, 'You cannot report your own room');
  const reason = ['nudity', 'minor', 'harassment', 'illegal', 'other'].includes(b.reason) ? b.reason : 'other';
  const rref = f.collection('reports').doc(`live_${r.id}_${req.uid}`);
  if ((await rref.get()).exists) return res.json({ ok: true });
  await rref.set({ from: req.uid, to: r.hostId, reason: 'live:' + reason, details: String(b.details || '').trim().slice(0, 500), roomId: r.id, live: true, severity: reason === 'minor' ? 'critical' : 'normal', ...(r.pushText ? { alertText: String(r.pushText).slice(0, 100) } : {}), createdAt: FV().serverTimestamp() });
  const L = MOD.liveReports || {};
  if (r.status === 'live' && (reason === 'nudity' || reason === 'minor')) {
    const snap = await f.collection('reports').where('roomId', '==', r.id).where('live', '==', true).get();
    const cut = Date.now() - (L.windowMinutes || 5) * 60000, who = new Set();
    snap.docs.forEach(d => { const x = d.data(), t = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0; if (t >= cut && /^live:(nudity|minor)$/.test(x.reason)) who.add(x.from); });
    if (who.size >= (L.distinctReportersToTakeDown || 3)) {
      const until = Date.now() + (L.takeDownRestrictHours || 1) * HOUR_MS;
      await endRoom(r.ref, 'reports'); await sysMsg(r.ref, r, 'This live was paused after reports and will be reviewed.').catch(() => {});
      await modStateRef(r.hostId).set({ restrictedUntil: until, last: { kind: 'reports', roomId: r.id, at: Date.now() }, needsReview: true }, { merge: true });
      await f.collection('modIncidents').add({ uid: r.hostId, roomId: r.id, kind: 'reports', reporters: who.size, restrictedUntil: until, needsReview: true, source: 'reports', status: 'open', createdAt: FV().serverTimestamp() });
    }
  }
  res.json({ ok: true });
}));

/* ---------- admin: appeals, incidents, critical reports (page: /moderation.html, same x-admin-secret as the rest of admin) ---------- */
const ms = x => (x && x.toMillis ? x.toMillis() : 0);
app.get('/admin/moderation', adminAuth, wrap(async (req, res) => {
  const f = fsdb();
  const [ap, inc, cr] = await Promise.all([
    f.collection('modAppeals').where('status', '==', 'open').limit(100).get(),
    f.collection('modIncidents').orderBy('createdAt', 'desc').limit(60).get(),
    f.collection('reports').where('severity', '==', 'critical').limit(60).get(),
  ]);
  const names = {}; const nameOf = async uid => { if (!uid) return ''; if (!(uid in names)) { const u = await f.collection('users').doc(uid).get().catch(() => null); names[uid] = u && u.exists ? (u.data().name || '') : ''; } return names[uid]; };
  const appeals = [], incidents = [];
  for (const d of ap.docs) { const x = d.data(); appeals.push({ id: d.id, ...x, name: await nameOf(x.uid), createdAt: ms(x.createdAt) }); }
  for (const d of inc.docs) { const x = d.data(); incidents.push({ id: d.id, ...x, name: await nameOf(x.uid), createdAt: ms(x.createdAt) }); }
  const critical = cr.docs.map(d => ({ id: d.id, ...d.data(), createdAt: ms(d.data().createdAt) })).filter(x => !x.reviewed).sort((a, b) => b.createdAt - a.createdAt);
  appeals.sort((a, b) => a.createdAt - b.createdAt);
  res.json({ appeals, incidents, critical, provider: MOD_PROVIDER, shadow: MOD_SHADOW, profile: process.env.MOD_PROFILE || MOD.profile, ageGate: AGE_GATE });
}));
app.post('/admin/moderation/appeal/:id', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, note = String((req.body || {}).note || '').slice(0, 300), f = fsdb();
  if (!['approve', 'deny'].includes(action)) throw httpErr(400, 'Invalid action');
  const aref = f.collection('modAppeals').doc(req.params.id), a = await aref.get(); if (!a.exists) throw httpErr(404, 'Appeal not found');
  const x = a.data(), sref = modStateRef(x.uid);
  if (action === 'approve') {      // strike removed, Go Live back right away
    await f.runTransaction(async t => { const s = await t.get(sref), d = s.exists ? s.data() : {}; t.set(sref, { strikes: Math.max(0, (d.strikes || 1) - 1), restrictedUntil: 0, needsReview: false }, { merge: true }); });
    await f.collection('modIncidents').doc(x.incidentId).update({ status: 'overturned' }).catch(() => {});
  } else await f.collection('modIncidents').doc(x.incidentId).update({ status: 'upheld' }).catch(() => {});
  await aref.update({ status: action === 'approve' ? 'approved' : 'denied', note, reviewedAt: FV().serverTimestamp() });
  res.json({ ok: true });
}));
// action: dismiss (close the report only), lift (remove restriction and last strike), strike (confirm a report take-down: counts as a strike), ban (account can no longer sign in)
app.post('/admin/moderation/user/:uid', adminAuth, wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.uid)) throw httpErr(400, 'Invalid id');
  const action = (req.body || {}).action, uid = req.params.uid, f = fsdb();
  if (action === 'lift') { await f.runTransaction(async t => { const s = await t.get(modStateRef(uid)), d = s.exists ? s.data() : {}; t.set(modStateRef(uid), { strikes: Math.max(0, (d.strikes || 1) - 1), restrictedUntil: 0, needsReview: false }, { merge: true }); }); }
  else if (action === 'strike') await applyStrike(uid, { roomId: String((req.body || {}).roomId || ''), kind: 'reports', score: 1, severe: false });
  else if (action === 'ban') { await admin.auth().updateUser(uid, { disabled: true }); await modStateRef(uid).set({ needsReview: false, banned: true }, { merge: true }); }
  else if (action !== 'dismiss') throw httpErr(400, 'Invalid action');      // dismiss: only closes the report, changes nothing on the account
  if ((req.body || {}).reportId && SAFE_ID.test(String(req.body.reportId))) await f.collection('reports').doc(req.body.reportId).update({ reviewed: true, outcome: action, reviewedAt: FV().serverTimestamp() }).catch(() => {});
  res.json({ ok: true });
}));
// Optional: end a video live that stops sending frames (a tampered or very old app). Off unless MOD_REQUIRE_SIGNAL=true.
if (process.env.MOD_REQUIRE_SIGNAL === 'true' && MOD_PROVIDER !== 'none' && !MOD_SHADOW) {
  setInterval(async () => {
    try {
      const live = await fsdb().collection('rooms').where('status', '==', 'live').limit(200).get();
      for (const d of live.docs) { const r = d.data(), started = ms(r.startedAt) || ms(r.createdAt);
        if (r.kind === 'audio' || !started || Date.now() - started < 120000) continue;
        if (Date.now() - (r.lastFrame || 0) > 120000) { await endRoom(d.ref, 'no_moderation_signal'); }
      }
    } catch (e) { console.warn('signal watchdog failed', e.message); }
  }, 60000).unref();
}

/* =====================================================================================================
   ECONOMY: Paid_Coins vs Promo_Credits vs Beans, follower-tier splits, revenue-backed referral commissions,
   and daily live rewards. Numbers live in economy-config.json.

   Where each balance lives (Firestore, users/{uid}):
     tokens          = PAID_COINS. Only real purchases (and Beans the person converted back) can add to it. Spent on gifts, tips, tickets, calls.
     promoCredits    = PROMO_CREDITS. Free call-minutes (1 for a new man). Calls only. Never pays Beans, never pays a commission.
     creatorBalance  = BEANS. The only withdrawable balance. Only Paid_Coin spends can add to it (earnings/{id} docs carry the hold date).
     beanFrac        = leftover hundredths of a Bean, so 55% and 65% tiers are paid exactly.
     creatorExp      = ranking points. Promo minutes earn these; they are not money.
   Pending referral commissions: referralCommissions/{id}, 7-day escrow, released into Beans by the sweeper below.
   ===================================================================================================== */
const ECON_DEFAULT = {
  coins: { callCostPerMinute: 10, worstCaseStoreFeePct: 30 },
  tiers: [{ minFollowers: 0, beanPct: 50 }, { minFollowers: 1000, beanPct: 55 }, { minFollowers: 10000, beanPct: 60 }, { minFollowers: 50000, beanPct: 65 }, { minFollowers: 200000, beanPct: 70 }],
  promo: { signupMinutes: 1, oncePerDeviceOrPhone: true, legacyMaxMinutes: 12, cutoverIso: '2026-11-18T00:00:00Z', expPerPromoMinute: 10 },
  referral: { commissionPct: 8, escrowDays: 7 },
  dailyStream: { timezoneOffsetHours: 1, minMinutes: 30, expBonusBase: 50, expBonusPerStreakDay: 10, expBonusMaxStreakDays: 7, hotFeedHours: 6, expBoostHours: 24, expBoostMultiplier: 1.2,
    streakPromoMinutes: { 7: 5, 30: 15 }, minPaidGiftCoinsForCashBonus: 500, cashBonusPctOfPaidGifts: 3, maxCashBonusBeans: 200 },
};
let ECON = ECON_DEFAULT;
try {
  const j = JSON.parse(fsNode.readFileSync(path.join(__dirname, 'economy-config.json'), 'utf8'));
  ECON = Object.fromEntries(Object.keys(ECON_DEFAULT).map(k => [k, Array.isArray(ECON_DEFAULT[k]) ? (j[k] || ECON_DEFAULT[k]) : { ...ECON_DEFAULT[k], ...(j[k] || {}) }]));
} catch (e) { console.warn('economy-config.json not read, using built-in defaults:', e.message); }
const ECON_CUTOVER = Date.parse(process.env.ECON_CUTOVER_ISO || ECON.promo.cutoverIso) || 0;
const BEAN_USD = USD_PER_TOKEN;                                                        // dollars paid out for one Bean (TOKEN_PAYOUT_USD)
const COIN_FLOOR_USD = Math.min(...Object.values(PACKS).map(p => p.usd / (p.tokens + (p.bonus || 0))));      // cheapest real price of one coin
const NET_USD_PER_COIN = COIN_FLOOR_USD * (1 - ECON.coins.worstCaseStoreFeePct / 100);                        // what is left of it after the store takes the most it could
const MAX_TIER_PCT = Math.max(...ECON.tiers.map(x => x.beanPct));
const BREAKEVEN_PCT = NET_USD_PER_COIN / BEAN_USD * 100;                                // the share of a coin that could go to a creator before the platform loses money
if (MAX_TIER_PCT + ECON.dailyStream.cashBonusPctOfPaidGifts > BREAKEVEN_PCT) console.warn(`ECONOMY WARNING: top tier ${MAX_TIER_PCT}% + live bonus ${ECON.dailyStream.cashBonusPctOfPaidGifts}% is above the break-even ${BREAKEVEN_PCT.toFixed(1)}% (net ${NET_USD_PER_COIN.toFixed(5)} USD per coin, ${BEAN_USD} USD per Bean). Lower TOKEN_PAYOUT_USD or the tiers.`);
/* What the platform keeps, per coin, from the real settings. Every coin a creator earns is paid out at (tier %) of a creator token (BEAN_USD),
   plus the live bonus and the quest reward fund. Store fee: worst case (ECON.coins.worstCaseStoreFeePct) and the usual 15%. The withdrawal fee comes on top. */
function unitEconomics() {
  const lowT = Math.min(...ECON.tiers.map(x => x.beanPct)), topT = MAX_TIER_PCT;
  const bonusPct = ECON.dailyStream.cashBonusPctOfPaidGifts, poolPct = (typeof QUEST !== 'undefined' && QUEST.poolPct) || 0;
  const row = (price, coins, feePct) => {
    const perCoin = price / coins, net = perCoin * (1 - feePct / 100), at = t => {
      const payout = (t + bonusPct) / 100 * BEAN_USD, pool = poolPct / 100 * net, wd = payout * WITHDRAW_FEE_PCT / 100, keep = net - payout - pool + wd;
      return { creatorPayoutUsd: +payout.toFixed(5), keepsUsd: +keep.toFixed(5), keepsPctOfNet: +(keep / net * 100).toFixed(1) };
    };
    return { perCoinUsd: +perCoin.toFixed(5), netAfterStoreFeeUsd: +net.toFixed(5), lowestTier: at(lowT), topTier: at(topT) };
  };
  const packs = Object.fromEntries(Object.entries(PACKS).map(([id, p]) => [id, { coins: p.tokens + (p.bonus || 0), usd: p.usd,
    worstCase: row(p.usd, p.tokens + (p.bonus || 0), ECON.coins.worstCaseStoreFeePct), usual15PctStoreFee: row(p.usd, p.tokens + (p.bonus || 0), 15) }]));
  return { beanUsd: BEAN_USD, withdrawFeePct: WITHDRAW_FEE_PCT, liveBonusPct: bonusPct, questPoolPct: poolPct, lowestTierPct: lowT, topTierPct: topT, packs,
    note: 'keepsUsd = what the platform keeps per coin after the store fee, the creator payout, the live bonus and the quest fund, plus the withdrawal fee. Referral commission (8% of what is kept) comes out of this. Negative keepsUsd = losing money.' };
}
setTimeout(() => { try { const u = unitEconomics(), w = u.packs.mega.worstCase.topTier; console.log(`ECONOMY: on the Mega pack with the worst store fee the platform keeps ${(w.keepsPctOfNet)}% of net at the top creator tier (${w.keepsUsd} USD per coin)`); if (w.keepsUsd <= 0) console.warn('ECONOMY WARNING: the top creator tier would LOSE money in the worst case. Raise WITHDRAW_FEE_PCT or lower the tiers / QUEST_CONFIG poolPct.'); } catch (e) { console.warn('economy check', e.message); } }, 3000).unref();
const tierPct = followers => [...ECON.tiers].sort((a, b) => b.minFollowers - a.minFollowers).find(x => (followers || 0) >= x.minFollowers).beanPct;
const nextTier = followers => ECON.tiers.filter(x => x.minFollowers > (followers || 0)).sort((a, b) => a.minFollowers - b.minFollowers)[0] || null;
const CALL_EARNINGS_ON = () => process.env.CALL_EARNINGS === 'true';      // same switch as before: calls pay Beans only when it is on
const hasPass = d => !!d && d.gender === 'female' && !!d.verified;       // verified women never spend coins on calls

/* ---------- the cut a creator gets, in whole Beans, carrying the fraction forward ---------- */
function creatorCut(e, coins) {
  const pct = tierPct((e && e.followers) || 0), exact = coins * pct + ((e && e.beanFrac) || 0);
  return { pct, beans: Math.floor(exact / 100), frac: exact % 100 };
}

/* ---------- referral / agency commission: a percentage of NET PLATFORM REVENUE only ---------- */
function commissionPlan(o) {
  // net platform revenue of this spend = what the coins were really worth after store fees, minus the Beans the creator was given
  const platformUsd = Math.max(0, o.coins * NET_USD_PER_COIN - o.beans * BEAN_USD), usd = platformUsd * ECON.referral.commissionPct / 100;
  if (!(usd > 0)) return [];
  const rec = new Map(), add = (uid, kind) => { if (uid && typeof uid === 'string' && uid !== o.payerId && uid !== o.earnerId && !rec.has(uid)) rec.set(uid, kind); };
  add(o.P && o.P.referredBy, 'payer_referrer'); add(o.P && o.P.agencyId, 'payer_agency');                 // the person who spent Paid_Coins brought in / is managed by...
  if (o.beans > 0) { add(o.E && o.E.referredBy, 'creator_referrer'); add(o.E && o.E.agencyId, 'creator_agency'); }   // ...or the creator who earned Beans did
  return [...rec].map(([to, kind]) => ({ to, kind, usd }));
}

// Call inside a transaction AFTER all reads. Pays a creator from a Paid_Coin spend. Returns the Beans given.
function payCreator(t, o) {
  const E = o.E || {}, cut = creatorCut(E, o.coins), beansOn = o.beansOn !== false, beans = beansOn ? cut.beans : 0;
  const boost = Number(E.expBoostUntil) > Date.now() ? ECON.dailyStream.expBoostMultiplier : 1;
  const upd = { creatorExp: FV().increment(Math.round(o.coins * boost)) };
  if (beansOn) { upd.beanFrac = cut.frac; if (beans > 0) upd.creatorBalance = FV().increment(beans); }
  t.update(o.earnerRef, upd);
  if (beans > 0) t.set(o.earnerRef.collection('earnings').doc(), { ...o.earning, tokens: beans, from: o.payerId, releaseAt: o.earning.suspect ? suspectReleaseAt() : releaseAt(), createdAt: FV().serverTimestamp() });
  const f = fsdb();
  for (const c of commissionPlan({ ...o, beans })) {
    t.set(f.collection('referralCommissions').doc(), { to: c.to, kind: c.kind, payer: o.payerId, earner: o.earnerId, coins: o.coins, usd: c.usd, status: 'pending',
      releaseAt: admin.firestore.Timestamp.fromMillis(Date.now() + ECON.referral.escrowDays * 86400000), createdAt: FV().serverTimestamp() });
    if (c.kind === 'payer_referrer') missionsAdd(c.to, 'refs', 1, o.payerId);      // a referred friend's paid spend counts once per month toward the monthly goal
  }
  return beans;
}

/* ---------- one-time ledger split for every account (new sign-ups and old ones) ---------- */
// Promo can only be claimed once per device or phone: claims are stored under promoClaims/{key}.
async function promoAllowed(uid, phone) {
  const f = fsdb(), keys = [];
  (await f.collection('devices').where('uids', 'array-contains', uid).limit(20).get()).docs.forEach(d => keys.push('dev_' + d.id));
  if (phone) keys.push('tel_' + crypto.createHash('sha256').update('tel:' + phone).digest('hex').slice(0, 40));
  if (!keys.length) return { ok: false, pending: true };               // no device known yet: try again later, never grant blind
  const snaps = await Promise.all(keys.map(k => f.collection('promoClaims').doc(k).get()));
  if (snaps.some(s => s.exists && s.data().uid !== uid)) return { ok: false, pending: false };
  await Promise.all(keys.map(k => f.collection('promoClaims').doc(k).set({ uid, at: FV().serverTimestamp() })));
  return { ok: true };
}
const ledgerLocks = new Map();
async function ensureLedger(uid, phone) {
  if (!uid) return null;
  if (ledgerLocks.has(uid)) return ledgerLocks.get(uid);
  const p = ensureLedgerNow(uid, phone).finally(() => ledgerLocks.delete(uid));
  ledgerLocks.set(uid, p); return p;
}
async function ensureLedgerNow(uid, phone) {
  const f = fsdb(), uref = f.collection('users').doc(uid), snap = await uref.get();
  if (!snap.exists) return null;
  let u = snap.data();
  if (u.ledgerV >= 2 && !u.promoPending) return u;
  const male = u.gender === 'male', created = u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : 0, isNew = created >= ECON_CUTOVER;
  if (u.ledgerV >= 2) {                                                  // only a late promo grant is left to do
    if (!male || !isNew || (u.promoCredits || 0) > 0) { await uref.update({ promoPending: false }); return { ...u, promoPending: false }; }
    const a = await promoAllowed(uid, phone);
    if (a.pending) return u;
    await f.runTransaction(async t => { const s = await t.get(uref); if (!s.exists || !s.data().promoPending) return; t.update(uref, { promoPending: false, ...(a.ok ? { promoCredits: FV().increment(ECON.promo.signupMinutes) } : {}) }); });
    return (await uref.get()).data();
  }
  // 1) what did this person really pay for? Everything above that was free sign-up money.
  const tx = await f.collection('transactions').where('uid', '==', uid).get();
  let bought = 0, converted = 0, spent = 0, refRewards = 0;
  tx.docs.forEach(d => { const x = d.data(), n = Number(x.tokens) || 0;
    if (x.type === 'purchase') bought += Math.max(0, n); else if (x.type === 'earnings_convert') converted += Math.max(0, n); else if (x.type === 'referral') refRewards += Math.max(0, n);
    if (n < 0 && x.type !== 'withdraw_hold') spent += -n; });
  const freePool = 120 + refRewards;                                     // the old sign-up gift and referral rewards were spent first
  const paidLeft = Math.max(0, bought + converted - Math.max(0, spent - freePool));
  // 2) the free part turns into call minutes (men only)
  let promoMin = 0, pending = false;
  if (male && isNew) { const a = ECON.promo.oncePerDeviceOrPhone ? await promoAllowed(uid, phone) : { ok: true }; if (a.ok) promoMin = ECON.promo.signupMinutes; else pending = !!a.pending; }
  const result = await f.runTransaction(async t => {
    const s = await t.get(uref); if (!s.exists) return null;
    const d = s.data(); if (d.ledgerV >= 2) return d;
    const cur = Number(d.tokens) || 0, excess = Math.max(0, cur - Math.min(cur, paidLeft));
    if (male && !isNew) promoMin = Math.min(Math.floor(excess / CALL_COST), ECON.promo.legacyMaxMinutes);      // old accounts keep their free value as call time
    t.update(uref, { ledgerV: 2, ledgerAt: FV().serverTimestamp(), ...(excess ? { tokens: FV().increment(-excess) } : {}), ...(promoMin ? { promoCredits: FV().increment(promoMin) } : {}), ...(pending ? { promoPending: true } : {}) });
    if (excess || promoMin) t.set(f.collection('transactions').doc(), { uid, type: 'ledger_split', tokens: -excess, promo: promoMin, createdAt: FV().serverTimestamp() });
    return d;
  });
  return result ? (await uref.get()).data() : null;
}

/* ---------- calls: who pays, who earns, and which balance funds each minute ---------- */
// Verified women have the free-call pass. If one calls a man, the man pays (he agrees by answering). Two passes = a free call.
function callRoles(F, T) {
  const fp = hasPass(F), tp = hasPass(T);
  if (fp && tp) return null;
  return fp ? { payer: 'to', earner: 'from' } : { payer: 'from', earner: 'to' };
}
// Call inside a transaction AFTER reading both snapshots. Returns { ok, source:'promo'|'paid'|'free', payer:'from'|'to' } or { nofunds, payer }.
function billCallMinute(t, callRef, c, callId, fs, ts) {
  const F = fs.data() || {}, Tt = ts && ts.exists ? ts.data() : null, roles = callRoles(F, Tt || {});
  if (!roles) { t.update(callRef, { 'meter.freeMin': FV().increment(1), meterSource: 'free' }); return { ok: true, source: 'free' }; }
  const psnap = roles.payer === 'from' ? fs : ts, esnap = roles.earner === 'from' ? fs : ts, P = psnap.data() || {}, E = esnap && esnap.exists ? esnap.data() : null;
  const payerId = roles.payer === 'from' ? c.from : c.to, earnerId = roles.earner === 'from' ? c.from : c.to, f = fsdb();
  if ((P.promoCredits || 0) >= 1 && P.gender === 'male' && E && E.gender === 'female') {      // free trial minute: she gets ranking points, no Beans, nobody gets a commission
    t.update(psnap.ref, { promoCredits: FV().increment(-1) });
    t.update(esnap.ref, { creatorExp: FV().increment(Math.round(ECON.promo.expPerPromoMinute * (Number(E.expBoostUntil) > Date.now() ? ECON.dailyStream.expBoostMultiplier : 1))) });
    t.set(f.collection('transactions').doc(), { uid: payerId, type: 'call_promo', tokens: 0, promo: -1, callId, createdAt: FV().serverTimestamp() });
    t.update(callRef, { 'meter.promoMin': FV().increment(1), 'meter.exp': FV().increment(ECON.promo.expPerPromoMinute), meterSource: 'promo' });
    return { ok: true, source: 'promo', payer: roles.payer, promoLeft: (P.promoCredits || 0) - 1 };
  }
  if ((P.tokens || 0) < CALL_COST) return { nofunds: true, payer: roles.payer };
  t.update(psnap.ref, { tokens: FV().increment(-CALL_COST) });
  t.set(f.collection('transactions').doc(), { uid: payerId, type: 'call', tokens: -CALL_COST, callId, createdAt: FV().serverTimestamp() });
  let beans = 0;
  if (E && esnap.exists) beans = payCreator(t, { payerId, P, earnerId, earnerRef: esnap.ref, E, coins: CALL_COST, beansOn: CALL_EARNINGS_ON(),
    earning: { type: 'call', label: c.kind === 'video' ? 'Video call' : 'Voice call', emoji: c.kind === 'video' ? '🎥' : '📞', fromName: c.fromName || '', callId, ...(c.suspect ? { suspect: true } : {}) } });
  t.update(callRef, { 'meter.paidMin': FV().increment(1), 'meter.beans': FV().increment(beans), 'meter.exp': FV().increment(CALL_COST), meterSource: 'paid' });
  return { ok: true, source: 'paid', payer: roles.payer, beans };
}

/* ---------- referral commissions: 7 days in escrow, then turned into Beans ---------- */
async function releaseCommissions() {
  const f = fsdb();
  const snap = await f.collection('referralCommissions').where('status', '==', 'pending').where('releaseAt', '<=', admin.firestore.Timestamp.now()).limit(300).get();
  const by = new Map(); snap.docs.forEach(d => { const to = d.data().to; if (!by.has(to)) by.set(to, []); by.get(to).push(d.ref); });
  let paid = 0;
  for (const [to, refs] of by) {
    try {
      await f.runTransaction(async t => {
        const uref = f.collection('users').doc(to), [us, ...cs] = await Promise.all([t.get(uref), ...refs.map(r => t.get(r))]);
        const live = cs.filter(c => c.exists && c.data().status === 'pending'); if (!live.length) return;
        if (!us.exists) { live.forEach(c => t.update(c.ref, { status: 'void', note: 'recipient gone' })); return; }
        const total = (us.data().refResidualUsd || 0) + live.reduce((s, c) => s + c.data().usd, 0), beans = Math.floor(total / BEAN_USD + 1e-9);
        live.forEach(c => t.update(c.ref, { status: 'released', releasedAt: FV().serverTimestamp() }));
        t.update(uref, { refResidualUsd: Math.max(0, total - beans * BEAN_USD), ...(beans > 0 ? { creatorBalance: FV().increment(beans) } : {}) });
        if (beans > 0) { t.set(uref.collection('earnings').doc(), { type: 'referral', label: 'Referral commission', emoji: '🤝', tokens: beans, releaseAt: admin.firestore.Timestamp.now(), createdAt: FV().serverTimestamp() }); paid += beans; }
      });
    } catch (e) { console.warn('commission release failed for', to, e.message); }
  }
  return paid;
}
setInterval(() => releaseCommissions().catch(e => console.warn('commission sweep failed', e.message)), 10 * 60000).unref();
setTimeout(() => releaseCommissions().catch(() => {}), 45000).unref();

/* ---------- daily live rewards: streak, ranking boost, and a cash bonus only out of gift revenue made in that live ---------- */
async function streamRewards(ref) {
  const f = fsdb(), S = ECON.dailyStream, rs = await ref.get(); if (!rs.exists) return;
  const r = rs.data(); if (r.rewardsDone || !r.hostId) return;
  const started = ms(r.startedAt) || ms(r.createdAt), now = Date.now();
  const day = new Date(now + S.timezoneOffsetHours * 3600000).toISOString().slice(0, 10), yday = new Date(now + S.timezoneOffsetHours * 3600000 - 86400000).toISOString().slice(0, 10);
  const longEnough = started && now - started >= S.minMinutes * 60000, frozen = await isFrozen(r.hostId).catch(() => false);
  const uref = f.collection('users').doc(r.hostId);
  await f.runTransaction(async t => {
    const [us, rs2] = await Promise.all([t.get(uref), t.get(ref)]);
    if (!rs2.exists || rs2.data().rewardsDone) return;
    t.update(ref, { rewardsDone: true });
    if (!us.exists || !longEnough) return;
    const u = us.data(), upd = {}; let days = u.streakDays || 0;
    if (u.streakDay !== day) {
      days = u.streakDay === yday ? days + 1 : 1;
      upd.streakDays = days; upd.streakDay = day;
      upd.creatorExp = FV().increment(S.expBonusBase + S.expBonusPerStreakDay * Math.min(days, S.expBonusMaxStreakDays));
      upd.hotUntil = now + S.hotFeedHours * 3600000; upd.expBoostUntil = now + S.expBoostHours * 3600000;          // visibility + ranking boost, never cash
      const promo = S.streakPromoMinutes[String(days)]; if (promo) upd.promoCredits = FV().increment(promo);            // call minutes, not withdrawable
    }
    const gifts = Number(rs2.data().paidGifts) || 0;
    if (!frozen && gifts >= S.minPaidGiftCoinsForCashBonus && u.bonusDay !== day) {                                    // paid out of the coins gifted in THIS live
      const beans = Math.min(S.maxCashBonusBeans, Math.floor(gifts * S.cashBonusPctOfPaidGifts / 100));
      if (beans > 0) {
        upd.creatorBalance = FV().increment(beans); upd.bonusDay = day;
        t.set(uref.collection('earnings').doc(), { type: 'bonus', label: 'Live bonus', emoji: '🎁', tokens: beans, from: '', fromName: '', releaseAt: releaseAt(), createdAt: FV().serverTimestamp() });
      }
    }
    if (Object.keys(upd).length) t.update(uref, upd);
  });
  if (!frozen) {      // daily quests that are decided when a live ends (a live ended by moderation never gets here)
    if (longEnough) { qAdd(r.hostId, 'h_live').catch(() => {}); missionsAdd(r.hostId, 'liveMin', Math.floor((now - started) / 60000)); }
    if ((Number(r.peak) || 0) >= QUEST.tasks.h_crowd.target) qAdd(r.hostId, 'h_crowd', QUEST.tasks.h_crowd.target).catch(() => {});
  }
}

/* ---------- endpoints ---------- */
app.post('/economy/me', fbAuth, wrap(async (req, res) => {
  const u = await ensureLedger(req.uid, req.phone); if (!u) throw httpErr(404, 'Profile not found');
  const f = fsdb(), pend = await f.collection('referralCommissions').where('to', '==', req.uid).where('status', '==', 'pending').limit(500).get();
  const pendUsd = pend.docs.reduce((s, d) => s + d.data().usd, 0), nt = nextTier(u.followers || 0);
  res.json({ paidCoins: u.tokens || 0, promoCredits: u.promoCredits || 0, beans: u.creatorBalance || 0, exp: u.creatorExp || 0, followers: u.followers || 0, tierPct: tierPct(u.followers || 0),
    nextTier: nt ? { followers: nt.minFollowers, pct: nt.beanPct } : null, pendingCommissionBeans: Math.round(pendUsd / BEAN_USD * 100) / 100, escrowDays: ECON.referral.escrowDays,
    streakDays: u.streakDays || 0, hotUntil: u.hotUntil || 0, callEarnings: CALL_EARNINGS_ON(), hasCallPass: hasPass(u) });
}));
// Admin: put a creator or member under an agency (the agency earns the commission instead of being a referrer).
app.post('/admin/economy/agency', adminAuth, wrap(async (req, res) => {
  const { uid, agencyId } = req.body || {};
  if (!SAFE_ID.test(String(uid || '')) || (agencyId && !SAFE_ID.test(String(agencyId))) || uid === agencyId) throw httpErr(400, 'Invalid id');
  await fsdb().collection('users').doc(uid).update({ agencyId: agencyId || FV().delete() });
  res.json({ ok: true });
}));
// Admin: correct a member's gender (the app and the Firestore rules lock it after sign-up).
app.post('/admin/user/gender', adminAuth, wrap(async (req, res) => {
  const { uid, gender } = req.body || {};
  if (!SAFE_ID.test(String(uid || '')) || !['male', 'female'].includes(gender)) throw httpErr(400, 'Invalid uid or gender');
  await fsdb().collection('users').doc(uid).update({ gender });
  res.json({ ok: true, uid, gender });
}));
// Admin: a payment was reversed (chargeback / refund). Cancels that person's commissions that are still in escrow.
app.post('/admin/economy/void-commissions', adminAuth, wrap(async (req, res) => {
  const payer = String((req.body || {}).payer || ''); if (!SAFE_ID.test(payer)) throw httpErr(400, 'Invalid id');
  const f = fsdb(), snap = await f.collection('referralCommissions').where('payer', '==', payer).where('status', '==', 'pending').limit(450).get();
  const b = f.batch(); snap.docs.forEach(d => b.update(d.ref, { status: 'void', note: 'payment reversed' })); await b.commit();
  res.json({ ok: true, voided: snap.size });
}));
app.get('/admin/economy/summary', adminAuth, wrap(async (req, res) => {
  const f = fsdb(), pend = await f.collection('referralCommissions').where('status', '==', 'pending').limit(1000).get();
  const questPool = await poolCoins().catch(() => 0);
  res.json({ unitEconomics: unitEconomics(), questPoolCoins: Math.round(questPool * 100) / 100, pendingCommissions: pend.size, pendingUsd: Math.round(pend.docs.reduce((s, d) => s + d.data().usd, 0) * 10000) / 10000, beanUsd: BEAN_USD, netUsdPerCoin: NET_USD_PER_COIN,
    breakevenPct: Math.round(BREAKEVEN_PCT * 10) / 10, topTierPct: MAX_TIER_PCT, liveBonusPct: ECON.dailyStream.cashBonusPctOfPaidGifts, callEarnings: CALL_EARNINGS_ON() });
}));

/* ---------- LIVE QUESTS: daily tasks + Live Levels --------------------------------------------------------------------
   Modelled on the ladder Bigo Live uses: people climb levels by taking part, and the level they reach pays more.
   It pays for itself:
   - Levels go up mostly with REAL REVENUE: 1 Live XP for every coin a person sends or receives in a live. Tasks add a little XP,
     with a hard daily cap, so grinding tasks alone cannot run away.
   - The only reward that costs the platform anything is the free call minutes at level-up. They are paid out of a REWARD POOL that
     is filled with QUEST.poolPct % of every paid live gift. Pool empty = the minutes wait (nothing is created from thin air).
   - Everything else is free to give: ranking points, hot-feed time, badges. No cash, nothing withdrawable.
   - Frozen accounts, test-admin gifts and gifts flagged as suspicious earn nothing.
   Tune everything below without code: set QUEST_CONFIG on Render to a JSON object (any key here, e.g. {"poolPct":3}).     */
const QUEST_DEFAULT = {
  poolPct: 2,                  // % of every paid live gift (in coins) that goes into the reward pool
  dailyXpCap: 250,             // most task XP a person can earn in one day (gift XP is not capped: it is paid for by the gift)
  watchFlushSec: 120,          // watch time is saved in chunks of this size so a big room does not hammer the database
  tasks: {
    h_live:     { role: 'host',   title: 'Go live for 30 minutes',                    unit: 'live', target: 1,    xp: 40 },
    h_crowd:    { role: 'host',   title: 'Reach 20 viewers at once',                  unit: 'viewers', target: 20, xp: 30 },
    h_gift:     { role: 'host',   title: 'Receive a gift in your live',               unit: 'gift', target: 1,    xp: 40 },
    h_follow:   { role: 'host',   title: 'Gain 3 new followers while live',           unit: 'followers', target: 3, xp: 30 },
    h_interact: { role: 'host',   title: 'Use a poll, question, pin or goal',         unit: 'action', target: 1,  xp: 20 },
    v_watch:    { role: 'viewer', title: 'Watch lives for 10 minutes',                unit: 'seconds', target: 600, xp: 15 },
    v_join:     { role: 'viewer', title: 'Join 3 different lives',                    unit: 'lives', target: 3,   xp: 15 },
    v_gift:     { role: 'viewer', title: 'Send a gift in a live',                     unit: 'gift', target: 1,    xp: 30 },
    v_follow:   { role: 'viewer', title: 'Follow a host who is live',                 unit: 'follow', target: 1,  xp: 10 },
  },
  // level number = position + 1. bonus = % extra task XP. chestPts / hot = what the daily chest gives. mins = free call minutes at level-up (from the pool).
  levels: [
    { xp: 0,     name: 'Newcomer',  emoji: '🌱', bonus: 0,  chestPts: 20,  hot: 0, mins: 0 },
    { xp: 300,   name: 'Spark',     emoji: '✨', bonus: 5,  chestPts: 30,  hot: 0, mins: 1 },
    { xp: 1000,  name: 'Rising',    emoji: '🌟', bonus: 10, chestPts: 40,  hot: 2, mins: 2 },
    { xp: 2500,  name: 'Star',      emoji: '⭐', bonus: 15, chestPts: 60,  hot: 3, mins: 3 },
    { xp: 5500,  name: 'Headliner', emoji: '🎤', bonus: 20, chestPts: 80,  hot: 4, mins: 5 },
    { xp: 11000, name: 'Icon',      emoji: '👑', bonus: 25, chestPts: 100, hot: 6, mins: 8 },
    { xp: 20000, name: 'Legend',    emoji: '💎', bonus: 30, chestPts: 130, hot: 6, mins: 12 },
  ],
  chests: [{ need: 2, mult: 1 }, { need: 4, mult: 1.5 }],      // tasks done today -> chest (second one is bigger)
};
let QUEST = QUEST_DEFAULT;
try { if (process.env.QUEST_CONFIG) QUEST = { ...QUEST_DEFAULT, ...JSON.parse(process.env.QUEST_CONFIG) }; } catch (e) { console.warn('QUEST_CONFIG ignored:', e.message); }
if (MAX_TIER_PCT + ECON.dailyStream.cashBonusPctOfPaidGifts + QUEST.poolPct > BREAKEVEN_PCT) console.warn(`ECONOMY WARNING: top tier ${MAX_TIER_PCT}% + live bonus ${ECON.dailyStream.cashBonusPctOfPaidGifts}% + quest pool ${QUEST.poolPct}% is above the break-even ${BREAKEVEN_PCT.toFixed(1)}%. Lower QUEST_CONFIG poolPct or the tiers.`);
const QUEST_INTERACT = new Set(['poll', 'prompt', 'pin', 'pin-product', 'announce', 'goal']);
const levelOf = xp => { let L = 1; QUEST.levels.forEach((l, i) => { if (xp >= l.xp) L = i + 1; }); return L; };
const qDay = () => new Date(Date.now() + ECON.dailyStream.timezoneOffsetHours * 3600000).toISOString().slice(0, 10);      // same day boundary as the streak
const qRef = (uid, day) => fsdb().collection('users').doc(uid).collection('liveQuests').doc(day);

/* reward pool: 10 small counters so a busy night of gifts never fights over one document */
const questPoolRef = () => fsdb().collection('questPool').doc('s' + Math.floor(Math.random() * 10));
async function poolCoins() { return (await fsdb().collection('questPool').get()).docs.reduce((a, d) => a + (Number(d.data().coins) || 0), 0); }
async function poolSpend(coins) {      // takes `coins` out of the pool across the counters, all or nothing
  const f = fsdb(), col = f.collection('questPool');
  return f.runTransaction(async t => {
    const snap = await t.get(col); let need = coins; const take = [];
    for (const d of snap.docs) { if (need <= 0) break; const c = Number(d.data().coins) || 0; if (c <= 0) continue; const x = Math.min(c, need); take.push([d.ref, x]); need -= x; }
    if (need > 1e-9) return false;
    take.forEach(([r, x]) => t.update(r, { coins: FV().increment(-x) }));
    return true;
  });
}

const questXp = (uid, n) => { if (SAFE_ID.test(String(uid || '')) && n > 0) fsdb().collection('users').doc(uid).update({ liveXp: FV().increment(Math.round(n)) }).catch(() => {}); };
// Add progress to a task (n more, or one more unique thing). Pays the task XP once, the moment the target is reached.
async function qAdd(uid, id, n = 1, uniq) {
  const T = QUEST.tasks[id]; if (!T || !SAFE_ID.test(String(uid || ''))) return;
  if (await isFrozen(uid).catch(() => false)) return;
  const f = fsdb(), qref = qRef(uid, qDay()), uref = f.collection('users').doc(uid);
  await f.runTransaction(async t => {
    const [qs, us] = await Promise.all([t.get(qref), t.get(uref)]);
    if (!us.exists) return;
    const q = qs.exists ? qs.data() : {};
    if ((q.done || {})[id]) return;
    let val = Number((q.p || {})[id]) || 0; const w = {};
    if (uniq !== undefined) { const arr = Array.isArray(q['u_' + id]) ? q['u_' + id].slice() : []; if (arr.includes(String(uniq))) return; arr.push(String(uniq)); w['u_' + id] = arr.slice(-40); val = arr.length; }
    else val += n;
    w.p = { [id]: Math.min(val, T.target) };
    if (val >= T.target) {
      const L = QUEST.levels[levelOf(Number(us.data().liveXp) || 0) - 1], room = Math.max(0, QUEST.dailyXpCap - (Number(q.xp) || 0)), gain = Math.min(room, Math.round(T.xp * (1 + (L.bonus + missionsBoost(us.data())) / 100)));
      w.done = { [id]: true }; w.xp = (Number(q.xp) || 0) + gain;
      if (gain > 0) t.update(uref, { liveXp: FV().increment(gain) });
    }
    t.set(qref, w, { merge: true });
  });
}
// Following a host who is live counts for both people (the host only once per follower per day).
async function questFollow(fromUid, targetId) {
  const s = await fsdb().collection('rooms').where('hostId', '==', targetId).where('status', '==', 'live').limit(1).get();
  if (s.empty) return;
  qAdd(fromUid, 'v_follow').catch(() => {}); qAdd(targetId, 'h_follow', 1, fromUid).catch(() => {});
}
// Watch time from the viewer check-ins, kept in memory and saved in chunks (a viewer's check-in is already every ~30 seconds).
const lastPing = new Map(), watchBuf = new Map(), watchSum = new Map(), watchDone = new Set();
function questWatch(uid) {
  const now = Date.now(), k = qDay() + ':' + uid; if (watchDone.has(k)) return;
  const prev = lastPing.get(uid); lastPing.set(uid, now);
  if (!prev || now - prev > 75000) return;                       // a gap means they were not watching
  const tot = (watchBuf.get(k) || 0) + Math.min(45, Math.round((now - prev) / 1000));
  if (tot < QUEST.watchFlushSec) { watchBuf.set(k, tot); return; }
  watchBuf.delete(k);
  const sum = (watchSum.get(k) || 0) + tot; watchSum.set(k, sum); if (sum >= QUEST.tasks.v_watch.target) watchDone.add(k);
  qAdd(uid, 'v_watch', tot).catch(() => {});
}
setInterval(() => {
  const d = qDay(), cut = Date.now() - 300000;
  for (const m of [watchBuf, watchSum]) for (const k of m.keys()) if (!k.startsWith(d)) m.delete(k);
  for (const k of watchDone) if (!k.startsWith(d)) watchDone.delete(k);
  for (const [u, at] of lastPing) if (at < cut) lastPing.delete(u);
}, 600000).unref();

// Level-up gifts: free call minutes, paid out of the pool. If the pool is short they simply wait and are paid on a later visit.
const payingLevels = new Set();
async function payLevelRewards(uid) {
  if (payingLevels.has(uid)) return 0;
  payingLevels.add(uid);
  try {
    const uref = fsdb().collection('users').doc(uid), us = await uref.get(); if (!us.exists) return 0;
    const lvl = levelOf(Number(us.data().liveXp) || 0), paid = Number(us.data().liveLevelPaid) || 1;
    if (lvl <= paid || await isFrozen(uid).catch(() => false)) return 0;
    let p = paid, minutes = 0; const perks = us.data().gender === 'female';      // women cannot spend free call minutes: they get the same value as ranking points, which cost nothing
    for (let L = paid + 1; L <= lvl; L++) {
      const m = QUEST.levels[L - 1].mins || 0;
      if (!perks && m > 0 && !(await poolSpend(m * ECON.coins.callCostPerMinute))) break;
      minutes += m; p = L;
    }
    if (p > paid) await uref.update({ liveLevelPaid: p, ...(minutes ? (perks ? { creatorExp: FV().increment(minutes * ECON.promo.expPerPromoMinute) } : { promoCredits: FV().increment(minutes) }) : {}) });
    return minutes;
  } finally { payingLevels.delete(uid); }
}

// The quests screen: today's tasks, the level bar and the chests.
app.post('/quests', fbAuth, wrap(async (req, res) => {
  rateLimit(req.uid, 'quests', 60, 60000);
  const day = qDay(), f = fsdb(), [us, qs] = await Promise.all([f.collection('users').doc(req.uid).get(), qRef(req.uid, day).get()]);
  if (!us.exists) throw httpErr(404, 'User not found');
  const minutesPaid = await payLevelRewards(req.uid).catch(() => 0);
  const u = us.exists ? (await f.collection('users').doc(req.uid).get()).data() : {}, q = qs.exists ? qs.data() : {};
  const xp = Number(u.liveXp) || 0, lvl = levelOf(xp), L = QUEST.levels[lvl - 1], nx = QUEST.levels[lvl] || null, paid = Number(u.liveLevelPaid) || 1;
  const doneCount = Object.keys(q.done || {}).length;
  let pendingMinutes = 0; for (let i = paid + 1; i <= lvl; i++) pendingMinutes += QUEST.levels[i - 1].mins || 0;
  const now = Date.now(), midnight = Date.parse(day + 'T00:00:00Z') + 86400000 - ECON.dailyStream.timezoneOffsetHours * 3600000;
  res.json({
    day, resetsInMs: Math.max(0, midnight - now), xpToday: Number(q.xp) || 0, dailyXpCap: QUEST.dailyXpCap,
    tasks: Object.entries(QUEST.tasks).map(([id, T]) => ({ id, role: T.role, title: T.title, unit: T.unit, target: T.target, xp: T.xp, progress: Math.min(T.target, Number((q.p || {})[id]) || 0), done: !!(q.done || {})[id] })),
    doneCount,
    chests: QUEST.chests.map((C, i) => ({ n: i + 1, need: C.need, claimed: !!q['chest' + (i + 1)], ready: doneCount >= C.need && !q['chest' + (i + 1)], pts: Math.round(L.chestPts * C.mult), hotHours: Math.round(L.hot * C.mult) })),
    level: { n: lvl, name: L.name, emoji: L.emoji, xp, bonusPct: L.bonus, nextName: nx ? nx.name : null, nextXp: nx ? nx.xp : null, fromXp: L.xp },
    ladder: QUEST.levels.map((l, i) => ({ n: i + 1, name: l.name, emoji: l.emoji, xp: l.xp, mins: l.mins, reached: lvl >= i + 1, rewardLabel: !l.mins ? '' : u.gender === 'female' ? `+${l.mins * ECON.promo.expPerPromoMinute} ranking pts` : `${l.mins} free call min` })),
    minutesPaid, pendingMinutes: u.gender === 'female' ? 0 : pendingMinutes,
    paidLabel: !minutesPaid ? '' : u.gender === 'female' ? `+${minutesPaid * ECON.promo.expPerPromoMinute} ranking points` : `${minutesPaid} free call minute${minutesPaid === 1 ? '' : 's'}`,
  });
}));
app.post('/quests/chest', fbAuth, wrap(async (req, res) => {
  const n = Number((req.body || {}).n), C = QUEST.chests[n - 1]; if (!C) throw httpErr(400, 'Invalid chest');
  rateLimit(req.uid, 'quest-chest', 20, 60000);
  if (await isFrozen(req.uid).catch(() => false)) throw httpErr(403, 'Rewards are paused for this account');
  const f = fsdb(), qref = qRef(req.uid, qDay()), uref = f.collection('users').doc(req.uid); let reward;
  await f.runTransaction(async t => {
    const [qs, us] = await Promise.all([t.get(qref), t.get(uref)]);
    if (!us.exists) throw httpErr(404, 'User not found');
    const q = qs.exists ? qs.data() : {};
    if (Object.keys(q.done || {}).length < C.need) throw httpErr(409, `Finish ${C.need} tasks to open this chest`);
    if (q['chest' + n]) throw httpErr(409, 'You already opened this chest today');
    const L = QUEST.levels[levelOf(Number(us.data().liveXp) || 0) - 1], pts = Math.round(L.chestPts * C.mult), hot = Math.round(L.hot * C.mult);
    const upd = { creatorExp: FV().increment(pts) }; if (hot > 0) upd.hotUntil = Math.max(Number(us.data().hotUntil) || 0, Date.now() + hot * 3600e3);
    t.set(qref, { ['chest' + n]: true }, { merge: true }); t.update(uref, upd); reward = { pts, hotHours: hot };
  });
  res.json({ ok: true, ...reward });
}));

/* ---------- Missions & Ranks: monthly goals, rank rewards and analytics live in their own file (missions-server.js) ---------- */
const _missions = require('./missions-server')({ app, admin, adminAuth, fsdb, FV, fbAuth, wrap, httpErr, rateLimit, SAFE_ID, QUEST, ECON, levelOf, qDay, isFrozen, poolCoins, poolSpend, questPoolRef, payLevelRewards });
const missionsAdd = (...a) => { _missions.add(...a); };          // never throws, never waits
const missionsBoost = u => _missions.boostPct(u);

/* ---------- Matchmaking (serious relationships only; fee paid on the WEB only): its own file (matchmaking-server.js) ---------- */
try { require('./admin-server')({ app, admin, adminAuth, fsdb, wrap, httpErr, SAFE_ID }); }
catch (e) { console.error('Admin panel module NOT loaded (is admin-server.js uploaded next to server.js?):', e.message); }
try { require('./matchmaking-server')({ app, admin, adminAuth, fsdb, FV, fbAuth, wrap, httpErr, rateLimit, ensureRefCode }); }
catch (e) { console.error('Matchmaking module NOT loaded (is matchmaking-server.js uploaded next to server.js?):', e.message); }      // a missing file must never take the rest of the server down

app.use((req, res) => res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path + '. Check that the app is pointing at the live server.' }));
app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
  if (e.status) return res.status(e.status).json({ error: e.message, ...(e.mcode ? { code: e.mcode } : {}), ...(e.extra || {}) });
  if (e.code === '22P02' || e.code === '23503') return res.status(400).json({ error: 'Invalid id' });
  console.error(e);
  res.status(500).json({ error: 'Server error' });
});

app.listen(process.env.PORT || 3000, () => console.log('API listening'));