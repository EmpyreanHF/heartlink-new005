'use strict';
/* =====================================================================================================
   MISSIONS & RANKS  (separate module; plugged into server.js with one require, see the bottom of server.js)
   FILE NAME MUST BE:  missions-server.js   (server.js does require('./missions-server'))

   What it adds
   - Monthly goals (refer paying friends, stream hours, gift coins received) with a forecast, and a bonus for finishing all three.
   - Rank rewards: the level ladder is the existing QUEST.levels. Its free call minutes are paid by payLevelRewards() in server.js
     (one payout path only, so a level can never be paid twice). This module just shows them.
   - Progress analytics: daily counters the app turns into charts.

   Rewards never involve cash and never touch Paid_Coins (users.tokens = real purchases only). By gender (locked after sign-up):
     men   -> FREE CALL MINUTES in promoCredits (calls only), paid from the reward pool, capped per month.
     women -> PERKS: hot-feed hours + ranking points (creatorExp). Free to give, so no pool and no cash. (A woman cannot spend call minutes.)
   Nothing here can be gifted, turned into Beans or withdrawn, and nothing here triggers a referral commission.

   Why it cannot drain revenue (every rule is enforced here, on the server; the app only displays them)
   1. Pool only (minute rewards). Every reward minute is taken out of the existing reward pool (the slice of paid live gifts, QUEST.poolPct),
      at ECON.coins.callCostPerMinute coins per minute, all or nothing. Pool short = the reward waits.
   2. Reserve. A payout never takes the pool below poolReserveCoins, and one payout can take at most poolMaxSharePerPayout of the pool.
   3. Revenue-linked. Rewards unlock only after the member took part in minGiftCoinsForRewards coins of PAID live gifts this month.
      Referrals count only when the friend makes a paid spend (once per friend per month).
   4. Cooling-off. A finished goal waits holdDays before it can be claimed. Accounts under minAccountDays old, frozen accounts and
      suspicious/test gifts earn nothing.
   5. Caps. userMonthlyMinuteCap per member per month (re-checked inside the claim transaction), one payout per goal per month.
   6. Kill switch. Set MISSIONS_CONFIG to {"enabled":false} on Render (permanent), or POST /admin/missions/toggle (until restart).

   Tune without code: set MISSIONS_CONFIG on Render to a JSON object (any key below, e.g. {"policy":{"userMonthlyMinuteCap":8}}).
   Firestore (all written by the server only):
     users/{uid}/missionMonths/{YYYY-MM}  counters, doneAt{}, paid{}, minutesPaid
     users/{uid}/missionDays/{YYYY-MM-DD} daily counters for the charts
     missionUniq/{key}                    one-time markers (one referred friend counted once per month)
   ===================================================================================================== */

const DEFAULT = {
  enabled: true,
  policy: {
    minAccountDays: 7,              // new accounts earn nothing for this long
    minGiftCoinsForRewards: 50,     // coins of paid live gifts (sent or received) in the month before rewards unlock
    holdDays: 3,                    // a finished goal waits this long before it can be claimed
    userMonthlyMinuteCap: 12,       // most free call minutes one member can receive from missions in a month
    poolReserveCoins: 100,          // the pool is never taken below this
    poolMaxSharePerPayout: 0.25,    // one payout may take at most this share of the pool
  },
  weights: { refs: 100, liveMin: 1, giftRecv: 0.2, giftSent: 0.1, followers: 3 },   // points shown on the charts (display only, never money)
  goals: {
    refs:      { title: 'Bring in paying friends', unit: 'friends', kind: 'refs',     target: 10,   minutes: 3, perks: { hotHours: 6, exp: 60 }, hint: 'A friend counts once a month, after their first paid spend that month.' },
    liveMin:   { title: 'Stream this month',       unit: 'minutes', kind: 'liveMin',  target: 1200, minutes: 2, perks: { hotHours: 4, exp: 40 }, hint: 'Lives of 30 minutes or more.' },
    giftCoins: { title: 'Gift coins received',     unit: 'coins',   kind: 'giftRecv', target: 5000, minutes: 2, perks: { hotHours: 4, exp: 40 }, hint: 'Paid gifts you receive in lives.' },
  },
  bonus: { minutes: 2, perks: { hotHours: 6, exp: 60 }, xpBoostPct: 10, boostDays: 30 },                       // for finishing all three goals (3+2+2+2 = 9, under the monthly cap)
};
const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] ? merge(a[k], b[k]) : b[k]; return o; };

module.exports = function mountMissions(d) {
  const { app, admin, adminAuth, fsdb, FV, fbAuth, wrap, httpErr, rateLimit, SAFE_ID, QUEST, ECON, levelOf, qDay, isFrozen, poolCoins, poolSpend, questPoolRef, payLevelRewards } = d;
  let CFG = DEFAULT;
  try { if (process.env.MISSIONS_CONFIG) CFG = merge(DEFAULT, JSON.parse(process.env.MISSIONS_CONFIG)); } catch (e) { console.warn('MISSIONS_CONFIG ignored:', e.message); }
  const P = () => CFG.policy, W = CFG.weights, GOALS = Object.entries(CFG.goals).map(([id, g]) => ({ id, ...g }));
  const KINDS = new Set(Object.keys(W));
  const COST = Math.max(1, Number(ECON && ECON.coins && ECON.coins.callCostPerMinute) || 10);   // pool coins per free call minute
  const monthOf = day => day.slice(0, 7);
  const daysIn = mon => new Date(Date.UTC(+mon.slice(0, 4), +mon.slice(5, 7), 0)).getUTCDate();
  const uref = uid => fsdb().collection('users').doc(uid);
  const mref = (uid, mon) => uref(uid).collection('missionMonths').doc(mon);
  const dref = (uid, day) => uref(uid).collection('missionDays').doc(day);
  const ms = x => (x && x.toMillis ? x.toMillis() : 0);
  const boostPct = u => (u && Number(u.missionBoostUntil) > Date.now() ? Number(u.missionBoostPct) || 0 : 0);
  const reached = (m, g) => (Number(m[g.kind]) || 0) >= g.target;
  const EXPM = Math.max(1, Number(ECON && ECON.promo && ECON.promo.expPerPromoMinute) || 10);     // ranking points one call minute is worth
  const isPerks = u => !!u && u.gender === 'female';                                              // women: perks. Everyone else: call minutes.
  const rewardOf = (def, u) => isPerks(u) ? { type: 'perks', minutes: 0, hotHours: def.perks.hotHours, exp: def.perks.exp } : { type: 'minutes', minutes: def.minutes, hotHours: 0, exp: 0 };
  const labelOf = r => r.type === 'perks' ? `+${r.hotHours}h hot feed · +${r.exp} ranking pts` : `+${r.minutes} call min`;

  // ---------- tracking (called from server.js hooks; never throws, never slows the caller) ----------
  async function add(uid, kind, n, uniq) {
    try {
      n = Math.round(Number(n)); if (!SAFE_ID.test(String(uid || '')) || !(n > 0) || !KINDS.has(kind)) return;
      const f = fsdb(), day = qDay(), mon = monthOf(day), mr = mref(uid, mon), dr = dref(uid, day), pts = n * W[kind];
      const uk = uniq === undefined ? null : f.collection('missionUniq').doc(`${uid}_${mon}_${kind}_${String(uniq).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 300));
      await f.runTransaction(async t => {       // the one-time marker and the counters are written together: a failure leaves neither behind
        if (uk) { if ((await t.get(uk)).exists) return; }
        const m = (await t.get(mr)).data() || {}, cur = Number(m[kind]) || 0, nxt = cur + n, done = {};
        GOALS.forEach(g => { if (g.kind === kind && cur < g.target && nxt >= g.target) done[g.id] = Date.now(); });
        if (uk) t.set(uk, { at: FV().serverTimestamp() });
        t.set(mr, { [kind]: FV().increment(n), pts: FV().increment(pts), updatedAt: FV().serverTimestamp(), ...(Object.keys(done).length ? { doneAt: done } : {}) }, { merge: true });
        t.set(dr, { [kind]: FV().increment(n), pts: FV().increment(pts) }, { merge: true });
      });
    } catch (e) { console.warn('missions add failed:', e.message); }
  }

  // A goal that is reached but has no finish time (e.g. a target lowered mid-month) starts its cooling-off now, never skips it.
  async function ensureDoneAt(uid, mon, m) {
    const doneAt = { ...(m.doneAt || {}) }, fix = {};
    GOALS.forEach(g => { if (reached(m, g) && !(Number(doneAt[g.id]) > 0)) fix[g.id] = doneAt[g.id] = Date.now(); });
    if (Object.keys(fix).length) await mref(uid, mon).set({ doneAt: fix }, { merge: true }).catch(() => {});
    return doneAt;
  }

  // ---------- the policy gates, in one place ----------
  async function gates(uid, m, u, minutes) {
    const p = P(), age = (Date.now() - (ms(u.createdAt) || Date.now())) / 86400000, coins = (Number(m.giftSent) || 0) + (Number(m.giftRecv) || 0);
    if (!CFG.enabled) return { ok: false, why: 'Rewards are paused right now.' };
    if (await isFrozen(uid).catch(() => false)) return { ok: false, why: 'Rewards are paused for this account.' };
    if (age < p.minAccountDays) return { ok: false, why: `Rewards start ${p.minAccountDays} days after you join.` };
    if (coins < p.minGiftCoinsForRewards) return { ok: false, why: `Rewards unlock after ${p.minGiftCoinsForRewards} coins of paid live gifts this month (you have ${coins}).` };
    if (minutes > 0 && (Number(m.minutesPaid) || 0) + minutes > p.userMonthlyMinuteCap) return { ok: false, why: `Monthly reward limit reached (${p.userMonthlyMinuteCap} free call minutes). It resets next month.` };
    return { ok: true };
  }

  // ---------- the screen data ----------
  app.post('/missions/me', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mme', 60, 60000);
    if (payLevelRewards) await payLevelRewards(req.uid).catch(() => 0);      // rank call minutes are paid here, the same single path as /quests
    const f = fsdb(), day = qDay(), mon = monthOf(day), dim = daysIn(mon), dom = +day.slice(8, 10), left = dim - dom;
    const start = new Date(Date.parse(day + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
    const FP = admin.firestore.FieldPath.documentId();
    const [us, ms_, ds] = await Promise.all([uref(req.uid).get(), mref(req.uid, mon).get(), uref(req.uid).collection('missionDays').where(FP, '>=', start).where(FP, '<=', day).get()]);
    if (!us.exists) throw httpErr(404, 'User not found');
    const u = us.data(), m = ms_.exists ? ms_.data() : {}, paid = m.paid || {}, doneAt = await ensureDoneAt(req.uid, mon, m), hold = P().holdDays * 86400000;
    const g0 = await gates(req.uid, m, u, 0), now = Date.now();
    const goals = GOALS.map(g => {
      const prog = Math.min(g.target, Number(m[g.kind]) || 0), done = reached(m, g), at = Number(doneAt[g.id]) || 0;
      const proj = Math.round((Number(m[g.kind]) || 0) / dom * dim);
      let state = 'active'; if (paid[g.id]) state = 'claimed'; else if (done) state = at + hold > now ? 'holding' : !g0.ok ? 'locked' : 'claimable';
      const rw = rewardOf(g, u);
      return { id: g.id, title: g.title, unit: g.unit, hint: g.hint, target: g.target, progress: prog, pct: Math.round(prog / g.target * 100), reward: rw, rewardLabel: labelOf(rw), state, projected: proj, onPace: proj >= g.target, perDay: left > 0 ? Math.ceil(Math.max(0, g.target - prog) / left) : 0, claimableAt: done && !paid[g.id] ? at + hold : 0 };
    });
    const all = GOALS.every(g => reached(m, g)), lastAt = Math.max(0, ...GOALS.map(g => Number(doneAt[g.id]) || 0));
    const bonus = { reward: rewardOf(CFG.bonus, u), rewardLabel: labelOf(rewardOf(CFG.bonus, u)), xpBoostPct: CFG.bonus.xpBoostPct, state: paid.bonus ? 'claimed' : !all ? 'active' : lastAt + hold > now ? 'holding' : !g0.ok ? 'locked' : 'claimable', claimableAt: all && !paid.bonus ? lastAt + hold : 0 };
    const pts = Math.round(Number(m.pts) || 0), target = Math.round(GOALS.reduce((s, g) => s + g.target * W[g.kind], 0));
    const series = ds.docs.map(x => ({ d: x.id, ...Object.fromEntries(Object.entries(x.data()).map(([k, v]) => [k, Math.round(v * 10) / 10])) }));
    const xp = Number(u.liveXp) || 0, lvl = levelOf(xp), L = QUEST.levels[lvl - 1], nx = QUEST.levels[lvl] || null, lp = Number(u.liveLevelPaid) || 1;
    let waitingMin = 0; if (!isPerks(u)) for (let i = lp + 1; i <= lvl; i++) waitingMin += QUEST.levels[i - 1].mins || 0;      // women are paid ranking points at once, they never wait for the pool
    res.json({
      month: mon, day, dom, dim, daysLeft: left, enabled: CFG.enabled, goals, bonus, level: { state: waitingMin > 0 ? 'waiting' : 'none', minutes: waitingMin },
      points: { now: pts, target, projected: Math.round(pts / dom * dim) },
      totals: { refs: Number(m.refs) || 0, liveMin: Number(m.liveMin) || 0, giftRecv: Number(m.giftRecv) || 0, giftSent: Number(m.giftSent) || 0, followers: Number(m.followers) || 0 },
      series, weights: W,
      rank: { n: lvl, name: L.name, emoji: L.emoji, xp, fromXp: L.xp, nextName: nx ? nx.name : null, nextXp: nx ? nx.xp : null, bonusPct: L.bonus,
        ladder: QUEST.levels.map((l, i) => ({ n: i + 1, name: l.name, emoji: l.emoji, xp: l.xp, bonus: l.bonus, mins: l.mins, hot: l.hot, reached: lvl >= i + 1, paid: lp >= i + 1,
          rewardShort: isPerks(u) ? (l.mins ? '+' + l.mins * EXPM : '0') : String(l.mins || 0), rewardUnit: isPerks(u) ? 'rank pts' : 'call min', rewardLabel: !l.mins ? '' : isPerks(u) ? `+${l.mins * EXPM} ranking pts` : `${l.mins} call min` })) },
      eligibility: { ok: g0.ok, why: g0.ok ? '' : g0.why, coins: (Number(m.giftSent) || 0) + (Number(m.giftRecv) || 0), need: P().minGiftCoinsForRewards },
      cap: isPerks(u) ? null : { paid: Number(m.minutesPaid) || 0, max: P().userMonthlyMinuteCap },
      rewardType: isPerks(u) ? 'perks' : 'minutes',
      policy: [
        isPerks(u) ? 'Rewards are hot-feed time and ranking points. They are never cash and cost nothing, so they are never held back by the reward pool.' : 'Rewards are free call minutes, paid from a shared reward pool that a small share of paid live gifts fills. If the pool is low, your reward waits. Nothing is created from nothing.',
        `Rewards unlock after ${P().minGiftCoinsForRewards} coins of paid live gifts (sent or received) in the month.`,
        'A friend counts toward your goal after their first paid spend of the month.',
        `A finished goal is held for ${P().holdDays} days before you can claim it.`,
        isPerks(u) ? 'Each goal pays once a month. Hot-feed time from different goals does not add up: the longest one counts.' : `You can receive up to ${P().userMonthlyMinuteCap} free call minutes a month from missions. Each goal pays once a month.`,
        isPerks(u) ? 'Rank rewards are paid automatically as ranking points when you reach a new level.' : 'Rank call minutes are paid automatically when you reach a new level.',
        `Accounts under ${P().minAccountDays} days old, accounts under review and flagged gifts earn nothing.`,
      ],
    });
  }));

  // ---------- claiming a reward ----------
  app.post('/missions/claim', fbAuth, wrap(async (req, res) => {
    rateLimit(req.uid, 'mclaim', 20, 60000);
    const id = String((req.body || {}).id || ''), uid = req.uid, f = fsdb(), mon = monthOf(qDay()), mr = mref(uid, mon), ur = uref(uid);
    const [us, ms_] = await Promise.all([ur.get(), mr.get()]); if (!us.exists) throw httpErr(404, 'User not found');
    const u = us.data(), m = ms_.exists ? ms_.data() : {}, doneAt = await ensureDoneAt(uid, mon, m), hold = P().holdDays * 86400000;
    let def, boost = false;
    if (id === 'bonus') {
      if (!GOALS.every(g => reached(m, g))) throw httpErr(409, 'Finish all the goals first');
      if (Math.max(...GOALS.map(g => Number(doneAt[g.id]) || 0)) + hold > Date.now()) throw httpErr(409, 'This reward is still in its cooling-off period');
      def = CFG.bonus; boost = true;
    } else {
      const g = GOALS.find(x => x.id === id); if (!g) throw httpErr(400, 'Unknown reward');
      if (!reached(m, g)) throw httpErr(409, 'This goal is not finished yet');
      if ((Number(doneAt[g.id]) || 0) + hold > Date.now()) throw httpErr(409, 'This reward is still in its cooling-off period');
      def = g;
    }
    const rw = rewardOf(def, u), minutes = rw.minutes;
    if ((m.paid || {})[id]) throw httpErr(409, 'Already claimed');
    const gt = await gates(uid, m, u, minutes); if (!gt.ok) throw httpErr(409, gt.why);
    const coins = minutes * COST, waitMsg = { queued: true, message: 'The reward pool is filling up. Your reward is saved: try again a little later.' };
    if (coins > 0) {   // minute rewards only (perks cost nothing): pool check first: reserve + max share per payout
      const have = await poolCoins();
      if (have - coins < P().poolReserveCoins || coins > have * P().poolMaxSharePerPayout) return res.json(waitMsg);
    }
    // 1) reserve the claim; the monthly cap and "already claimed" are re-checked INSIDE the transaction, so two devices cannot beat them
    await f.runTransaction(async t => {
      const a = await t.get(mr), mm = a.exists ? a.data() : {};
      if ((mm.paid || {})[id]) throw httpErr(409, 'Already claimed');
      if (minutes > 0 && (Number(mm.minutesPaid) || 0) + minutes > P().userMonthlyMinuteCap) throw httpErr(409, `Monthly reward limit reached (${P().userMonthlyMinuteCap} free call minutes). It resets next month.`);
      t.set(mr, { paid: { [id]: Date.now() }, minutesPaid: FV().increment(minutes) }, { merge: true });
    });
    const undo = async () => f.runTransaction(async t => {
      t.set(mr, { paid: { [id]: FV().delete() }, minutesPaid: FV().increment(-minutes) }, { merge: true });
    }).catch(e => console.error('missions undo failed', uid, id, e.message));
    // 2) take it out of the pool (all or nothing), 3) credit the free call minutes (promoCredits: calls only, never Beans)
    let took = coins === 0; if (coins > 0) { try { took = await poolSpend(coins); } catch (e) { await undo(); throw e; } }
    if (!took) { await undo(); return res.json(waitMsg); }
    try {
      await f.runTransaction(async t => {
        const cur = (await t.get(ur)).data() || {}, upd = {};
        if (rw.type === 'minutes') upd.promoCredits = FV().increment(minutes);                       // men: free call minutes (calls only)
        else { upd.creatorExp = FV().increment(rw.exp); if (rw.hotHours > 0) upd.hotUntil = Math.max(Number(cur.hotUntil) || 0, Date.now() + rw.hotHours * 3600000); }      // women: ranking points + hot feed, no cash
        if (boost) { upd.missionBoostUntil = Date.now() + CFG.bonus.boostDays * 86400000; upd.missionBoostPct = CFG.bonus.xpBoostPct; }
        t.update(ur, upd);
        t.set(f.collection('transactions').doc(`mission_${uid}_${mon}_${id}`), { uid, type: 'mission_reward', kind: id, rewardType: rw.type, minutes, hotHours: rw.hotHours, exp: rw.exp, poolCoins: coins, month: mon, createdAt: FV().serverTimestamp() });
      });
    } catch (e) { if (coins > 0) await questPoolRef().set({ coins: FV().increment(coins) }, { merge: true }).catch(() => {}); await undo(); throw e; }
    res.json({ ok: true, type: rw.type, minutes, hotHours: rw.hotHours, exp: rw.exp, label: labelOf(rw), boostPct: boost ? CFG.bonus.xpBoostPct : 0 });
  }));

  // ---------- admin: see the settings and the pool, pause or resume payouts without a redeploy ----------
  if (adminAuth) {
    app.get('/admin/missions/status', adminAuth, wrap(async (req, res) => {
      res.json({ enabled: CFG.enabled, policy: CFG.policy, goals: CFG.goals, bonus: CFG.bonus, poolCoins: Math.round((await poolCoins()) * 100) / 100, poolCoinsPerMinute: COST,
        note: 'POST /admin/missions/toggle {"enabled":false} pauses payouts until the server restarts. For a permanent change set MISSIONS_CONFIG on Render.' });
    }));
    app.post('/admin/missions/toggle', adminAuth, wrap(async (req, res) => {
      CFG = { ...CFG, enabled: !!(req.body || {}).enabled }; console.log('Missions rewards', CFG.enabled ? 'RESUMED' : 'PAUSED', 'by admin');
      res.json({ enabled: CFG.enabled });
    }));
  }

  console.log(`Missions module ready (rewards ${CFG.enabled ? 'on' : 'PAUSED'}; monthly cap ${P().userMonthlyMinuteCap} free call minutes; paid only from the reward pool)`);
  return { add, boostPct, config: () => CFG };
};