/* 验证：从同一触发源（范围判定）分叉出的多条逻辑链路，其「伤害·结算」模块的
   持续伤害(跟随) 必须逐节点独立。某分支没开持续伤害、或它的半径/每秒伤害/
   时长不同，都不能污染其他分支（修复前读合并对象 grp.damage，dotRadius 取最大、
   dotEnable 取「或」，导致上层分支的半径把下层持续伤害区撑大）。

   本测试复刻 game.js applyExtraModules 与 admin.js burstGroup 的「逐节点生成持续掉血区」
   口径（即本次修复后的逻辑），作为该行为的守护。 */
const SM = require('../skill-modules.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 复刻修复后的「逐节点生成持续掉血区」：只把 dotEnable 且 dotDps>0 的节点各自生成一片 zone
function spawnDotZonesFixed(grp) {
  const zones = [];
  (grp.damageList || []).forEach(function (dm) {
    if (!dm || !dm.dotEnable || !(Number(dm.dotDps) > 0)) return;
    zones.push({ cfg: dm, radius: Number(dm.dotRadius) || 70, dps: Number(dm.dotDps) || 0 });
  });
  return zones;
}
// 复刻修复前的「合并对象」口径：取合并 damage 生成唯一一片 zone
function spawnDotZonesOld(grp) {
  const dm = grp.damage || {};
  if (dm && dm.dotEnable && Number(dm.dotDps) > 0) return [{ cfg: dm, radius: Number(dm.dotRadius) || 70, dps: Number(dm.dotDps) || 0 }];
  return [];
}

// 用户拓扑：范围判定 → 上分支(元素→修饰特效→伤害A：瞬间, dotEnable=false, dotRadius=200, base=20)
//                    范围判定 → 下分支(伤害B：持续, dotEnable=true, dotRadius=70, dotDps=8)
const range = SM.node('range', 40, 90, { radius: 60, maxTargets: 20, scope: 'global' });
const element = SM.node('element', 320, 20, { element: 'ice', damage: 0, damagePct: 0 });
const fxUp = SM.node('fx', 600, 20, { effect: 'ice/frost-nova', attach: 'follow', scale: 1 });
const dmgA = SM.node('damage', 600, 200, { base: 20, dotEnable: false, dotRadius: 200, dotDps: 0, dotDuration: 6 });
const dmgB = SM.node('damage', 320, 240, { base: 0, dotEnable: true, dotRadius: 70, dotDps: 8, dotDuration: 6 });

const g = SM.makeGraph(
  [range, element, fxUp, dmgA, dmgB],
  [
    { from: range.id, to: element.id },
    { from: element.id, to: fxUp.id },
    { from: fxUp.id, to: dmgA.id },
    { from: range.id, to: dmgB.id },
  ]
);
const C = SM.compile({ name: 'branchIso', graph: g });
const onHit = C.events.onHit;

console.log('=== 编译产物 ===');
console.log('  damageList 节点数 =', onHit.damageList.length);
onHit.damageList.forEach(d => console.log('    node dotEnable=' + d.dotEnable + ' dotRadius=' + (d.dotRadius||0) + ' dotDps=' + (d.dotDps||0)));
console.log('  合并对象 damage.dotRadius =', onHit.damage.dotRadius, ' dotEnable =', onHit.damage.dotEnable);

console.log('=== 修复前（合并对象口径）—— 应被判定为污染 ===');
const oldZones = spawnDotZonesOld(onHit);
ok('修复前只生成 1 片（唯一合并区）', oldZones.length === 1);
// dotRadius 不在 MERGE_MAX 内 → 合并时按数值「求和」：上层 200 + 下层 70 = 270，
// 既不是上层想要的 200，也不是下层想要的 70，是串味产生的错误值。
ok('修复前该区半径 = 270（200+70 求和，明显串味）', oldZones.length === 1 && oldZones[0].radius === 270);
ok('修复前半径 ≠ 下层想要的 70（污染证据）', oldZones.length === 1 && oldZones[0].radius !== 70);

console.log('=== 修复后（逐节点口径）—— 期望分支隔离 ===');
const newZones = spawnDotZonesFixed(onHit);
ok('修复后只生成 1 片（来自下分支）', newZones.length === 1);
ok('修复后该区半径 = 下分支自己的 70（未被上层 200 污染）', newZones.length === 1 && newZones[0].radius === 70);
ok('修复后上分支(dotEnable=false)未生成持续掉血区', newZones.every(z => z.radius !== 200));

// 进一步：两条分支都开持续伤害时，应各自独立成区、互不影响
const dmgA2 = SM.node('damage', 600, 200, { base: 20, dotEnable: true, dotRadius: 200, dotDps: 5, dotDuration: 6 });
const dmgB2 = SM.node('damage', 320, 240, { base: 0, dotEnable: true, dotRadius: 70, dotDps: 8, dotDuration: 6 });
const g2 = SM.makeGraph(
  [range, element, fxUp, dmgA2, dmgB2],
  [
    { from: range.id, to: element.id },
    { from: element.id, to: fxUp.id },
    { from: fxUp.id, to: dmgA2.id },
    { from: range.id, to: dmgB2.id },
  ]
);
const C2 = SM.compile({ name: 'branchIso2', graph: g2 });
const z2 = spawnDotZonesFixed(C2.events.onHit);
ok('双开持续伤害时生成 2 片独立区', z2.length === 2);
ok('两片区半径分别为 200 与 70（各自独立）', z2.some(z=>z.radius===200) && z2.some(z=>z.radius===70));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
