/**
 * 后台界面编辑器：Steam 登录区必须是一组可单独编辑的图层
 * 运行：node tools/test_steam_ui_layer.js
 *
 * 用 vm 真实加载 ui-layout.js（不模拟完整 DOM），实测 schema() 与 normalize()，
 * 再静态核对编辑态样例、样式与页面挂载点。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const uiSrc = read('ui-layout.js');
const indexHtml = read('index.html');
const loginJs = read('steam-login.js');
const css = read('styles.css');

let pass = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name); process.exitCode = 1; }
};

/* ---------- 1. 真实加载 UI 运行时 ---------- */
const ctx = {
  window: { location: { search: '' } },
  document: { querySelector: () => null },
  console, Math, Object, Array, Number, String, JSON, RegExp, Date,
  parseFloat, parseInt, isFinite, setTimeout, clearTimeout
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(uiSrc, ctx);
const UI = ctx.window.WowPinballUI;

console.log('1) 图层 schema');
ok('ui-layout.js 导出 WowPinballUI', !!UI && typeof UI.schema === 'function');
const schema = UI.schema();
const steam = schema.find(s => s.id === 'steam');
ok('存在独立 steam 编辑屏', !!steam);
ok('屏名与类型正确', !!steam && /Steam/.test(steam.name) && steam.kind === 'screen');
ok('借用首页做背景（顶栏全局可见）', !!steam && steam.root === '#startScreen');
ok('不挤掉默认首屏', schema[0].id === 'start');

const EXPECT = [
  ['slot', '#steamAuthSlot'],
  ['loginBtn', '.steam-login-btn'],
  ['userBadge', '.steam-user'],
  ['avatar', '.steam-avatar'],
  ['nick', '.steam-nick'],
  ['idFallback', '.steam-id'],
  ['logoutBtn', '.steam-logout-btn'],
  ['errText', '.steam-auth-err']
];
EXPECT.forEach(([k, sel]) => {
  const it = steam && steam.items.find(x => x.k === k);
  ok('图层 ' + k + ' → ' + sel, !!it && it.sel === sel);
});
ok('整块容器与主要按钮都可单独编辑（分组标记）',
  EXPECT.filter(([k]) => k !== 'errText').every(([k]) => {
    const it = steam.items.find(x => x.k === k);
    return it && /单独编辑|文字/.test(it.group);
  }));
ok('容器图层未锁死位置尺寸', !steam.items.find(x => x.k === 'slot').lock);

console.log('\n2) 配置归一化（新增屏的 patch 能落盘）');
const raw = {
  enabled: true,
  screens: {
    steam: {
      slot: { dx: 12, dy: -6, w: 240, bg: '#112233', radius: 9, hide: false, evil: 'x' },
      loginBtn: { fs: 16, fc: '#ffcc66', img: 'data:image/png;base64,AAAA' },
      ghostKey: { fs: 99 }
    },
    start: { shopBtn: { dx: 4 } }
  }
};
const n = UI.normalize(raw);
ok('steam 屏被保留', !!n.screens.steam);
ok('位置 / 尺寸 / 背景被保留', n.screens.steam.slot.dx === 12 && n.screens.steam.slot.dy === -6 &&
  n.screens.steam.slot.w === 240 && n.screens.steam.slot.bg === '#112233');
ok('文字与素材被保留', n.screens.steam.loginBtn.fs === 16 &&
  n.screens.steam.loginBtn.fc === '#ffcc66' && !!n.screens.steam.loginBtn.img);
ok('未知字段被丢弃', !('evil' in n.screens.steam.slot));
ok('未登记的 key 被丢弃', !('ghostKey' in n.screens.steam));
ok('已有屏幕的配置不受影响', n.screens.start.shopBtn.dx === 4);
ok('非法颜色被拒', !UI.normalize({ screens: { steam: { slot: { bg: 'javascript:alert(1)' } } } }).screens.steam);

console.log('\n3) 页面挂载点与编辑态样例');
ok('index.html 有 #steamAuthSlot', /id="steamAuthSlot"/.test(indexHtml));
ok('steam-login.js 在 game.js 之后加载', indexHtml.indexOf('game.js') < indexHtml.indexOf('steam-login.js'));
ok('识别 uiEditor=1', /uiEditor=1/.test(loginJs) && /UI_EDITOR/.test(loginJs));
ok('编辑态跳过真实 /me 请求', /if \(UI_EDITOR\) \{ renderEditorSamples\(slotRef\); return; \}/.test(loginJs));
const sampleClasses = ['steam-login-btn', 'steam-user', 'steam-avatar', 'steam-nick',
  'steam-id', 'steam-logout-btn', 'steam-auth-err'];
ok('样例覆盖全部动态类名', sampleClasses.every(c => loginJs.indexOf(c) >= 0));
ok('样例带 data-ui-sample 标记', /data-ui-sample="1"/.test(loginJs));
ok('样例渲染后重放样式覆盖', /WowPinballUI\.apply\(\)/.test(loginJs));
ok('游戏态不铺样例', /renderEditorSamples/.test(loginJs) && /function render\(slot, me, reason\)/.test(loginJs));

console.log('\n4) 编辑态布局样式与配平');
ok('编辑态允许样例换行', /\.ui-edit-mode \.steam-auth-slot \{ flex-wrap: wrap/.test(css));
ok('头像样例有可见底色', /\.ui-edit-mode \.steam-auth-slot \.steam-avatar/.test(css));
ok('失败提示在编辑态强制可见', /\.ui-edit-mode \.steam-auth-slot \.steam-auth-err \{ display: inline/.test(css));
[['ui-layout.js', uiSrc], ['steam-login.js', loginJs], ['styles.css', css]].forEach(([f, s]) => {
  let o = 0, c = 0;
  for (const ch of s) { if (ch === '{') o++; else if (ch === '}') c++; }
  ok(f + ' 大括号配平 ' + o + '/' + c, o === c);
});

console.log('\n' + (process.exitCode ? 'FAILED' : 'ALL PASS ' + pass + ' 项'));
