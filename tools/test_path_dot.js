// 验证「路径特效 → 下游持续伤害」路由：
// 拓扑 = 范围判定 → 延迟(0.8) → 路径特效(path, 间隔1, 时长5) → 伤害(dotEnable) + 事件状态(slow)
// 期望：
//  1) 路径特效节点带 _pathDot（含伤害 dot 配置，dotFollow 强制 impact）
//  2) 该伤害节点在 runtime 视图里 _routedToPath=true（不再单独生成跟随红圈）
//  3) 各节点 _delay 正确继承延迟（=0.8）
//  4) 模拟路径落点：每个落点生成一片固定判定区（弹珠走过处都留伤害）
//  5) 对照：非路径特效下游的伤害节点不被路由（保持独立跟随红圈）
const SM = require('../skill-modules.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

// ---- 用户的真实拓扑 ----
const range = SM.node('range', 40, 90, { radius: 80, maxTargets: 20, scope: 'global' });
const delay = SM.node('delay', 260, 90, { seconds: 0.8 });
const fx = SM.node('fx', 520, 40, { effect: 'nature/poison-cloud', attach: 'path', pathInterval: 1, pathDuration: 5, scale: 0.75 });
const dmg = SM.node('damage', 820, 20, { base: 0, dotEnable: true, dotDps: 12, dotRadius: 70, dotInterval: 0.5, dotDuration: 6, dotFollow: 'caster' });
const slow = SM.node('status', 820, 180, { status: 'slow', affect: 'enemy' });

const g = SM.makeGraph(
  [range, delay, fx, dmg, slow],
  [
    { from: range.id, to: delay.id },
    { from: delay.id, to: fx.id },
    { from: fx.id, to: dmg.id },
    { from: fx.id, to: slow.id }
  ]
);
const C = SM.compile({ name: 'poison-path', graph: g });

console.log('=== 路径特效路由（用户拓扑）===');
const onHit = C.events.onHit;
const fxEntry = (onHit.fx || []).find(f => f._nodeId === fx.id);
ok('路径特效节点带 _pathDot', !!(fxEntry && fxEntry._pathDot && fxEntry._pathDot.length === 1), 'fxEntry? ' + !!fxEntry);
const dc = fxEntry && fxEntry._pathDot && fxEntry._pathDot[0];
ok('  _pathDot 携带 dotDps=12', dc && Number(dc.dotDps) === 12, dc ? dc.dotDps : 'null');
ok('  _pathDot 携带 dotRadius=70', dc && Number(dc.dotRadius) === 70, dc ? dc.dotRadius : 'null');
ok('  _pathDot.dotFollow 被强制为 impact（固定落点）', dc && dc.dotFollow === 'impact', dc ? dc.dotFollow : 'null');
ok('  _pathDot 含 _routedToPath 标记', dc && dc._routedToPath === true);

const dmgEntry = (onHit.damageList || []).find(d => d._nodeId === dmg.id);
ok('伤害节点在 runtime 视图里 _routedToPath=true', !!(dmgEntry && dmgEntry._routedToPath === true), dmgEntry ? dmgEntry._routedToPath : 'null');

ok('延迟正确继承：路径特效 _delay=0.8', fxEntry && Math.abs((fxEntry._delay || 0) - 0.8) < 1e-6, fxEntry ? fxEntry._delay : 'null');
ok('延迟正确继承：伤害节点 _delay=0.8', dmgEntry && Math.abs((dmgEntry._delay || 0) - 0.8) < 1e-6, dmgEntry ? dmgEntry._delay : 'null');
const slowEntry = (onHit.status || []).find(s => s._nodeId === slow.id);
ok('延迟正确继承：事件状态 _delay=0.8', slowEntry && Math.abs((slowEntry._delay || 0) - 0.8) < 1e-6, slowEntry ? slowEntry._delay : 'null');

// ---- 模拟路径发射器落点：每个落点生成一片判定区 ----
console.log('=== 模拟路径落点生成持续伤害区 ===');
const spawned = [];
function spawnDamageDotAt(cfg, x, y) { spawned.push({ x, y, dotFollow: cfg.dotFollow, radius: cfg.dotRadius }); }
const interval = fxEntry._pathDot ? 1 : 0.15;
const duration = 5;
let age = 0, tick = 0, drops = 0;
while (age < duration) {
  age += 0.1;
  tick -= 0.1;
  if (tick > 0) continue;
  tick += interval;
  drops++;
  // stepPathEmitters 在落点 (att.x, att.y) 生成固定判定区
  fxEntry._pathDot.forEach(dc2 => spawnDamageDotAt(dc2, 100 + drops * 30, 200));
}
ok('路径持续时长 5s / 间隔 1s → 生成约 5 个落点判定区', drops >= 4 && drops <= 6, 'drops=' + drops);
ok('每个落点都生成一片判定区（数量=drops）', spawned.length === drops, 'spawned=' + spawned.length);
ok('落点判定区固定在该落点坐标（不跟随施法者）', spawned.length > 0 && spawned.every(s => s.dotFollow === 'impact'), '');
ok('落点判定区半径取自伤害配置(70)', spawned.every(s => s.radius === 70));

// ---- 对照：非路径特效下游的伤害节点不被路由 ----
console.log('=== 对照：普通（非路径）特效下游伤害不路由 ===');
const src2 = SM.node('source', 40, 80, { trigger: 'interval' });
const el2 = SM.node('element', 300, 40, { element: 'fire', damage: 10 });
const f2 = SM.node('fx', 560, 40, { effect: 'fire/fireball', attach: 'impact' });
const d2 = SM.node('damage', 820, 40, { base: 5, dotEnable: true, dotDps: 8, dotRadius: 50, dotFollow: 'caster' });
const g2 = SM.makeGraph([src2, el2, f2, d2], [
  { from: src2.id, to: el2.id }, { from: el2.id, to: f2.id }, { from: f2.id, to: d2.id }
]);
const C2 = SM.compile({ name: 'plain', graph: g2 });
const f2Entry = (C2.events.onHit.fx || []).find(f => f._nodeId === f2.id);
ok('普通特效不携带 _pathDot', !f2Entry || !f2Entry._pathDot, '');
const d2Entry = (C2.events.onHit.damageList || []).find(d => d._nodeId === d2.id);
ok('普通下游伤害不被路由（_routedToPath 未置）', !d2Entry || d2Entry._routedToPath !== true);
ok('普通下游伤害保留独立跟随红圈配置（dotFollow=caster）', d2Entry && d2Entry.dotFollow === 'caster', d2Entry ? d2Entry.dotFollow : 'null');

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
