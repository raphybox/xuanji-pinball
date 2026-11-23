/**
 * 作弊检测层（只标记不阻断）· 证红 → 转绿回归
 * 运行：node tools/test_cheat_detect.js
 *
 * 机制：结果类字段（outcome / result）由客户端上报，服务端无法判真伪。
 * 本层不篡改权威、不阻断任何 op，只在存档里记一份可审计的风险信号。
 *
 * 证红纪律：
 *   ① 现状基线——用坏样本证明当前经济守卫会放过它们（不误以为已经防住）；
 *   ② 检测层——同一批坏样本必须被 scoreRisk 标记；
 *   ③ 正常样本——20 局正常节奏对局必须 0 误报；
 *   ④ 边界——恰好卡在阈值下的样本必须 clean（守卫不能退化成空转门）。
 *
 * 单变量释放：本轮只新增「telemetry 观测窗口」+「scoreRisk 打分标记」两件事。
 * held_constant：价格表 / reward 金额 / SEED 上限 / opId 账本长度 / 库存来源校验 / 抽卡流程 全部不动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'functions', 'api');
const murl = f => pathToFileURL(path.join(API, f)).href;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const RULES = {
  coinsInit: 300, initialSkins: 3, duplicateRefund: 0.5,
  prices: { fruit: { normal: 60, rare: 150, precious: 360 }, skin: { normal: 80, rare: 200, precious: 480 } },
  rewards: { win: 120, draw: 60, lose: 30 }
};

(async () => {
  const SC = await import(murl('save-core.mjs'));

  section('1) 现状基线：坏样本在当前经济守卫下会通过（证明尚未防住）');
  {
    // 刷 win：短时间大量 reward win，金币够因此逐条合法
    const flood = SC.blankSave(1000, RULES);
    const ops = [];
    for (let i = 0; i < 30; i++) ops.push({ id: 'w' + i, t: 'reward', result: 'win' });
    const r = SC.applyOps(flood, ops, RULES, 1000 + 30 * 1000); // 30 秒打 30 局
    ok('刷 win 30 局全部被经济守卫接受（现状放过）',
      r.results.every(x => x.ok === true) && r.save.coins === 300 + 30 * 120,
      'coins=' + r.save.coins);

    // 谎报 empty：每次抽卡都报「池空」全额退款，金币不减
    const refund = SC.blankSave(1000, RULES);
    const rops = [];
    for (let i = 0; i < 20; i++) rops.push({ id: 'e' + i, t: 'buy', kind: 'fruit', tier: 'normal', outcome: 'empty' });
    const rr = SC.applyOps(refund, rops, RULES, 1000 + 20 * 1000);
    ok('20 次谎报 empty 全部被接受、金币零成本（现状放过）',
      rr.results.every(x => x.ok === true) && rr.save.coins === 300,
      'coins=' + rr.save.coins);

    // 塞 owned：整包 PUT 可塞任意合法 id（本轮 held_constant，不处理）
    const inv = SC.cleanInventory({ owned: Array.from({ length: 50 }, (_, i) => ({ id: 'f' + i, uid: 'x' })) });
    ok('整包 PUT 可塞 50 件合法 id（本轮刻意不处理）', inv.owned.length === 50);
  }

  section('2) 检测层存在性与结构');
  {
    ok('导出 scoreRisk', typeof SC.scoreRisk === 'function');
    ok('导出信号阈值配置', SC.SIGNAL_CFG && typeof SC.SIGNAL_CFG === 'object');
    const s = SC.blankSave(1000, RULES);
    ok('空白存档含 telemetry/risk 字段', !!s.telemetry && !!s.risk);
    ok('publicSave 暴露 risk 供审计', SC.publicSave(s).risk !== undefined);
    ok('publicSave 不暴露 telemetry 明细', SC.publicSave(s).telemetry === undefined);
  }

  section('3) 坏样本必须被标记（转绿目标）');
  {
    // 复用 §1 的两份存档，直接对其打分
    const floodOps = [];
    const floodSave = (() => {
      let s = SC.blankSave(1000, RULES);
      const ops = [];
      for (let i = 0; i < 30; i++) ops.push({ id: 'w' + i, t: 'reward', result: 'win' });
      s = SC.applyOps(s, ops, RULES, 1030000).save;
      return s;
    })();
    const a = SC.scoreRisk(floodSave, 1030000, RULES);
    ok('刷 win：命中 reward 频率 / 胜率 / 金币流速',
      a.flags.indexOf('reward_velocity') >= 0 && a.flags.indexOf('win_rate') >= 0 && a.flags.indexOf('coin_velocity') >= 0,
      JSON.stringify(a.flags));
    ok('刷 win：风险等级 ≥ 软限候选', a.level >= 2 && a.score >= 2, 'level=' + a.level + ' score=' + a.score);

    const refundSave = (() => {
      let s = SC.blankSave(1000, RULES);
      const ops = [];
      for (let i = 0; i < 20; i++) ops.push({ id: 'e' + i, t: 'buy', kind: 'fruit', tier: 'normal', outcome: 'empty' });
      return SC.applyOps(s, ops, RULES, 1020000).save;
    })();
    const b = SC.scoreRisk(refundSave, 1020000, RULES);
    ok('谎报 empty：命中退款率异常', b.flags.indexOf('refund_rate') >= 0, JSON.stringify(b.flags));
    ok('谎报 empty：风险等级 ≥ 观察', b.level >= 1, 'level=' + b.level);
  }

  section('4) 正常样本 0 误报');
  {
    // 20 局，55% 胜率，每局间隔 90 秒（正常节奏：每局单独一次提交，now 递增）
    let s = SC.blankSave(1000, RULES);
    const now = 1000 + 20 * 90000;
    for (let i = 0; i < 20; i++) {
      const result = i < 11 ? 'win' : (i < 16 ? 'draw' : 'lose');
      s = SC.applyOps(s, [{ id: 'n' + i, t: 'reward', result: result }], RULES, 1000 + i * 90000).save;
    }
    const r = SC.scoreRisk(s, now, RULES);
    ok('正常 20 局胜率 55%：0 命中', r.flags.length === 0 && r.level === 0, JSON.stringify(r.flags));
  }

  section('5) 边界样本：阈值下必须 clean（防退化成空转门）');
  {
    // 样本数不足：只打 5 局全胜，不应判胜率异常（门槛 12 局）
    let s = SC.blankSave(1000, RULES);
    const ops = [];
    for (let i = 0; i < 5; i++) ops.push({ id: 's' + i, t: 'reward', result: 'win' });
    s = SC.applyOps(s, ops, RULES, 1000 + 5 * 90000).save;
    const r = SC.scoreRisk(s, 1000 + 5 * 90000, RULES);
    ok('5 局全胜未达样本门槛：不判胜率异常', r.flags.indexOf('win_rate') < 0, JSON.stringify(r.flags));

    // 退款率刚好在阈值下：10 次 buy 里 5 次 duplicate（=0.5，阈值 0.6）
    let s2 = SC.blankSave(1000, RULES);
    const ops2 = [];
    for (let i = 0; i < 10; i++) ops2.push({ id: 'd' + i, t: 'buy', kind: 'fruit', tier: 'normal', outcome: i < 5 ? 'duplicate' : 'new' });
    s2 = SC.applyOps(s2, ops2, RULES, 1000 + 10 * 90000).save;
    const r2 = SC.scoreRisk(s2, 1000 + 10 * 90000, RULES);
    ok('退款率 0.5 在阈值下：不判退款异常', r2.flags.indexOf('refund_rate') < 0, JSON.stringify(r2.flags));
  }

  section('6) 只标记不阻断：权威与经济零改动');
  {
    const src = read(path.join('functions', 'api', 'save-core.mjs'));
    ok('applyOps 不调用 scoreRisk 做拒绝', !/scoreRisk[\s\S]{0,120}error:/.test(src));
    ok('检测不写 coins（只在 risk 字段落标记）', /risk\s*[:=]/.test(src) && /save\.risk/.test(src));
    const router = read(path.join('functions', 'api', 'save-router.mjs'));
    ok('路由未因检测新增拒绝分支', !/risk[^\n]{0,40}(429|403|400)/.test(router));
    ok('held_constant：SEED 上限仍 5000', SC.SEED_COINS_MAX === 5000);
    ok('held_constant：op 账本仍 200', SC.OPS_QUEUE_LIMIT === 200);
    // 塞 owned 后金币权威不变
    let s = SC.blankSave(1000, RULES);
    const patched = SC.patchSave(s, { inventory: { owned: [{ id: 'f0', uid: 'x' }] } }, s.rev, 1001);
    ok('塞 owned 后 coins 仍由服务端规则管（未接检测）', patched.save.coins === RULES.coinsInit);
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' 项' : 'ALL PASS ' + pass + ' 项'));
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
