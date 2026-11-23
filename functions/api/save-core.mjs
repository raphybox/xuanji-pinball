/**
 * 账号存档 · 纯逻辑核心（Cloudflare Worker / 本地 server.js / 离线测试单源）
 *
 * 设计要点（方案 B：云同步 + 经济权威）
 *   1) 存档按内部 uid 存，绝不用 SteamID64 作 key（uid 与 Steam 身份已解耦）。
 *   2) 金币不接受客户端整包覆盖：客户端只提交「动作」，服务端按自己的
 *      SHOP 规则重算 delta，回执覆盖本地乐观值 —— 这是防刷的关键。
 *   3) 其它存档（库存 / 昵称）走 rev 乐观锁整包 PUT，金币字段一律忽略。
 *   4) 每条 op 带 id，服务端记账去重，离线重放不会重复加钱。
 *   5) 首次登录仅当云端为空时接受一次游客存档（seeded），之后云端恒为权威。
 */

export const SAVE_LIMIT_BYTES = 8 * 1024;
export const OPS_QUEUE_LIMIT = 200;
export const SEED_COINS_MAX = 5000;      // 游客档首次并入时金币上限，避免刷满再登录
export const REV_START = 1;

/* -------------------------------------------------------------------------
   作弊检测（只标记不阻断）
   结果类字段（outcome / result）由客户端上报，服务端判不了真伪。本层不改权威：
   applyOps 照常按规则结算，另把每次动作记进 telemetry 环形缓冲；scoreRisk
   只读地扫这份缓冲打风险分，写入 save.risk 供后台审计。任何 op 都不会因分数被拒。
   阈值集中在此，方便单变量调参；样本量门槛防止小样本误杀新手。
   ------------------------------------------------------------------------- */
export const SIGNAL_CFG = {
  windowMs: 5 * 60 * 1000,   // 流速窗口 5 分钟
  rewardWindowMax: 20,       // 窗口内 reward 条数上限（真人 5 分钟约 5 局，20 已是极端）
  coinsWindowMax: 1500,      // 窗口内净增金币上限（win=120，约 12 局满额）
  winRateMax: 0.9,           // 胜率上限
  winSampleMin: 12,          // 判胜率最少局数
  refundRateMax: 0.6,        // (empty+duplicate)/buy 退款率上限
  buySampleMin: 10,          // 判退款率最少抽卡数
  windowCap: 200             // telemetry 环形缓冲上限
};
export const RISK_LEVELS = { CLEAN: 0, OBSERVE: 1, SOFT: 2, HARD: 3 };

const TIERS = ['normal', 'rare', 'precious'];
const KINDS = ['fruit', 'skin'];
const OUTCOMES = ['new', 'duplicate', 'empty'];
const RESULTS = ['win', 'draw', 'lose'];

function int(v, def, lo, hi) {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
}
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

/** 把后台 shop 配置收敛成服务端权威规则；缺字段一律回落到与 game.js 一致的默认值。 */
export function normalizeRules(shop) {
  const s = obj(shop);
  const p = obj(s.prices), r = obj(s.rewards);
  /* 果实与外观的默认价不同，别复用同一组（与 game.js 的 SHOP.prices 一致） */
  const DEFAULT_PRICES = {
    fruit: { normal: 60, rare: 150, precious: 360 },
    skin: { normal: 80, rare: 200, precious: 480 }
  };
  const prices = {};
  KINDS.forEach(k => {
    const pk = obj(p[k]);
    prices[k] = {};
    TIERS.forEach(t => { prices[k][t] = int(pk[t], DEFAULT_PRICES[k][t], 0, 100000); });
  });
  const rewards = {};
  RESULTS.forEach(k => { rewards[k] = int(r[k], { win: 120, draw: 60, lose: 30 }[k], 0, 100000); });
  return {
    coinsInit: int(s.coinsInit, 300, 0, 100000),
    initialSkins: int(s.initialSkins, 3, 1, 100),
    duplicateRefund: Math.max(0, Math.min(1, Number(s.duplicateRefund) || 0.5)),
    prices: prices,
    rewards: rewards
  };
}
export const DEFAULT_RULES = normalizeRules(null);

/* -------------------------------------------------------------------------
   存档字段清洗：只保留已知键，防止脏数据 / 超长字符串把存档撑爆
   ------------------------------------------------------------------------- */
export function cleanInventory(v, validIds) {
  const x = obj(v);
  const ids = validIds && typeof validIds.has === 'function' ? validIds : null;
  const owned = Array.isArray(x.owned) ? x.owned.filter(o => o && typeof o.id === 'string' && (!ids || ids.has(o.id)))
    .slice(0, 500).map(o => ({ uid: String(o.uid || '').slice(0, 40), id: o.id })) : [];
  let skinsOwned = Array.isArray(x.skinsOwned) ? x.skinsOwned.filter(s => typeof s === 'string').slice(0, 200) : [];
  if (!skinsOwned.length) skinsOwned = [];
  return {
    owned: owned,
    skinId: String(x.skinId || '').slice(0, 80),
    skinTheme: String(x.skinTheme || 'all').slice(0, 40),
    skinsOwned: skinsOwned
  };
}
export function cleanProfile(v) {
  const x = obj(v);
  return { name: String(x.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 12) };
}
export function blankSave(now, rules) {
  return {
    rev: REV_START,
    coins: rules.coinsInit,
    inventory: { owned: [], skinId: '', skinTheme: 'all', skinsOwned: [] },
    profile: { name: '' },
    seeded: false,
    updatedAt: now,
    opIds: [],
    opResults: [],
    // 检测层：只审计不参与结算。事件 [{ at, t, k }]，risk 为最近一次打分快照。
    telemetry: [],
    risk: { score: 0, flags: [], level: 0, at: 0 }
  };
}
/* 8KB 限额只管业务存档字段；opIds / opResults 是服务端幂等账本，
   已有 200 条硬上限，不该被业务体积误伤（否则批量重放会被自身账本撑爆）。 */
function sizeOk(save) {
  try {
    return JSON.stringify({
      inventory: save.inventory, profile: save.profile, coins: save.coins
    }).length <= SAVE_LIMIT_BYTES;
  } catch (e) { return false; }
}

/** 首次登录合并：只有云端还是空白存档时接受一次，且金币钳制到上限。 */
export function mergeSeed(save, seed, rules, now) {
  if (save.seeded || save.rev > REV_START || save.opIds.length) {
    return { save: save, error: 'already_seeded' };
  }
  const s = obj(seed);
  const next = Object.assign({}, save, {
    coins: int(s.coins, rules.coinsInit, 0, SEED_COINS_MAX),
    inventory: cleanInventory(s.inventory),
    profile: cleanProfile(s.profile),
    seeded: true,
    updatedAt: now,
    rev: save.rev + 1,
    telemetry: [],
    risk: { score: 0, flags: [], level: 0, at: 0 }
  });
  if (!sizeOk(next)) return { save: save, error: 'save_too_large' };
  return { save: next, error: null };
}

/** 整包 PUT：CAS + 字段白名单（coins 一律忽略，只能由 ops 改）。 */
export function patchSave(save, patch, baseRev, now) {
  if (baseRev !== save.rev) return { save: save, error: 'rev_conflict' };
  const p = obj(patch);
  const next = Object.assign({}, save, {
    inventory: p.inventory === undefined ? save.inventory : cleanInventory(p.inventory),
    profile: p.profile === undefined ? save.profile : cleanProfile(p.profile),
    updatedAt: now,
    rev: save.rev + 1
  });
  if (!sizeOk(next)) return { save: save, error: 'save_too_large' };
  return { save: next, error: null };
}

/** 单条动作的金币 delta，完全由服务端规则算；返回 null 表示非法动作。 */
export function coinDeltaForOp(op, rules) {
  if (!op || typeof op !== 'object') return null;
  if (op.t === 'reward') {
    if (RESULTS.indexOf(op.result) < 0) return null;
    return rules.rewards[op.result];
  }
  if (op.t === 'buy') {
    if (KINDS.indexOf(op.kind) < 0 || TIERS.indexOf(op.tier) < 0 || OUTCOMES.indexOf(op.outcome) < 0) return null;
    const price = rules.prices[op.kind][op.tier];
    if (!(price > 0)) return null;
    let d = -price;
    if (op.outcome === 'duplicate') d += Math.round(price * rules.duplicateRefund);
    else if (op.outcome === 'empty') d += price;   // 池空全额退款
    return d;
  }
  return null;
}

/**
 * 批量重放 ops。逐条幂等（已见过的 id 直接返回上次结果）、余额不足拒单条而不污染其它。
 * 返回 { save, results }，results 与输入 ops 一一对应。
 */
export function applyOps(save, ops, rules, now) {
  const list = Array.isArray(ops) ? ops.slice(0, OPS_QUEUE_LIMIT) : [];
  let cur = Object.assign({}, save, {
    opIds: save.opIds.slice(), opResults: save.opResults.slice(),
    telemetry: Array.isArray(save.telemetry) ? save.telemetry.slice() : []
  });
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const op = obj(list[i]);
    const id = String(op.id || '').slice(0, 80);
    if (!id) { results.push({ ok: false, error: 'missing_op_id' }); continue; }
    const seenAt = cur.opIds.indexOf(id);
    if (seenAt >= 0) { results.push(cur.opResults[seenAt] || { ok: false, error: 'duplicate_op' }); continue; }

    const delta = coinDeltaForOp(op, rules);
    if (delta === null) { results.push({ ok: false, error: 'invalid_op' }); continue; }
    const nextCoins = cur.coins + delta;
    if (nextCoins < 0) { results.push({ ok: false, error: 'insufficient_coins', coins: cur.coins }); continue; }

    cur.coins = Math.max(0, Math.round(nextCoins));
    cur.opIds.push(id);
    const res = { ok: true, coins: cur.coins, delta: delta };
    cur.opResults.push(res);
    results.push(res);
    // 检测层：成功的动作留痕（含客户端上报的 result/outcome 原值，供审计）。
    // 这里只追加观测，绝不参与上面的金币判定，确保「标记不阻断」。
    cur.telemetry.push({ at: now, t: op.t, k: op.t === 'reward' ? op.result : op.outcome, d: delta });
  }
  // 账本只保留最近 N 条，下标对齐
  if (cur.opIds.length > OPS_QUEUE_LIMIT) {
    const cut = cur.opIds.length - OPS_QUEUE_LIMIT;
    cur.opIds = cur.opIds.slice(cut);
    cur.opResults = cur.opResults.slice(cut);
  }
  if (cur.telemetry.length > SIGNAL_CFG.windowCap) {
    cur.telemetry = cur.telemetry.slice(cur.telemetry.length - SIGNAL_CFG.windowCap);
  }
  // 风险快照随结算刷新；失败时沿用旧档（含旧 risk），不让检测影响权威写入。
  const scored = scoreRisk(cur, now, rules);
  cur.risk = { score: scored.score, flags: scored.flags, level: scored.level, at: now };
  cur.rev = save.rev + 1;
  cur.updatedAt = now;
  if (!sizeOk(cur)) return { save: save, results: results, error: 'save_too_large' };
  return { save: cur, results: results, error: null };
}

/**
 * 只读风险打分：扫 telemetry 最近窗口，返回 { score, flags, level, detail }。
 * 纯函数，不改 save、不影响金币；调用方自行决定是否写入 save.risk。
 * 每个 flag 是一次独立的异常信号，score = 命中数，level 取档位。
 */
export function scoreRisk(save, now, rules) {
  const cfg = SIGNAL_CFG;
  const ev = (save && Array.isArray(save.telemetry)) ? save.telemetry : [];
  const r = obj(rules);
  const flags = [];
  const detail = {};

  // 时间窗口：只统计 now-windowMs 之后的事件；at 缺失（旧档）的按窗口内处理
  const recent = ev.filter(e => e && (typeof e.at !== 'number' || e.at >= now - cfg.windowMs));
  const rewards = recent.filter(e => e.t === 'reward');
  const buys = recent.filter(e => e.t === 'buy');

  // ① 金币流速：用窗口内绝对净增判突发。除以窗口长度会把「30 局挤在 30 秒」
  //    摊薄成 6 次/分钟而漏报——作弊恰恰是突发，所以这里看总量不看均值。
  let net = 0;
  for (let i = 0; i < recent.length; i++) net += int(recent[i].d, 0, -100000, 100000);
  detail.coinsInWindow = Math.max(0, net);
  if (detail.coinsInWindow > cfg.coinsWindowMax) flags.push('coin_velocity');

  // ② reward 频率：同样看窗口内绝对条数
  detail.rewardsInWindow = rewards.length;
  if (rewards.length > cfg.rewardWindowMax) flags.push('reward_velocity');

  // ③ 胜率：达样本门槛才判，防小样本误杀
  const wins = rewards.filter(e => e.k === 'win').length;
  if (rewards.length >= cfg.winSampleMin) {
    const winRate = wins / rewards.length;
    detail.winRate = Math.round(winRate * 1000) / 1000;
    if (winRate > cfg.winRateMax) flags.push('win_rate');
  }

  // ④ 退款率：empty + duplicate 都退钱，占比过高说明在薅退款
  const refunds = buys.filter(e => e.k === 'empty' || e.k === 'duplicate').length;
  if (buys.length >= cfg.buySampleMin) {
    const refundRate = refunds / buys.length;
    detail.refundRate = Math.round(refundRate * 1000) / 1000;
    if (refundRate > cfg.refundRateMax) flags.push('refund_rate');
  }

  const score = flags.length;
  let level = RISK_LEVELS.CLEAN;
  if (score >= 3) level = RISK_LEVELS.HARD;
  else if (score === 2) level = RISK_LEVELS.SOFT;
  else if (score === 1) level = RISK_LEVELS.OBSERVE;
  return { score: score, flags: flags, level: level, detail: detail };
}

/** 回给前端的存档视图：不含内部账本，避免把 opIds 暴露出去。 */
export function publicSave(save) {
  return {
    rev: save.rev,
    coins: save.coins,
    inventory: save.inventory,
    profile: save.profile,
    seeded: !!save.seeded,
    updatedAt: save.updatedAt,
    // 风险快照给后台审计；telemetry 明细不外泄（可能含逐笔行为，且占体积）
    risk: save.risk || { score: 0, flags: [], level: 0, at: 0 }
  };
}
