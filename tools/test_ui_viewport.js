/**
 * 界面编辑器「预览视口 = 游戏页视口」回归
 *
 * 背景：.app 是 max-width:1240 的自适应布局。以前预览 iframe 死写 1280px，
 * 而游戏页用的是浏览器实际宽度，右对齐按钮组的基准相差两百多像素；
 * 所有 dx/dy 绝对覆盖就出现「编辑器里摆好、网页里偏移」。
 * 另外编辑态两行 Steam 样例留在文档流里会把 .topbar 撑高约 40px，
 * 让下面所有区块整体下移。这里锁住这两处修复，防止以后被改回去。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}

const admin = read('admin.js');
const adminCss = read('admin.css');
const css = read('styles.css');

console.log('\n1) 预览 iframe 视口跟随浏览器窗口');
ok('不再有写死的 UI_W = 1280 基准', !/const\s+UI_W\s*=\s*1280/.test(admin));
ok('UI_H 仍保留为预览设计高度', /const UI_H = 860;/.test(admin));
ok('uiViewportW 取 window.innerWidth', /function uiViewportW\(\)[\s\S]{0,320}window\.innerWidth/.test(admin));
ok('异常窄窗口有兜底值', /w > 320 \? w : 1280/.test(admin));
ok('可锁定基准宽（消除两窗口 .app 居中差）',
  /function uiViewportW\(\)[\s\S]{0,180}S\.ui\.baseW/.test(admin) &&
  /if \(locked > 320\) return locked;/.test(admin));
ok('锁定宽有输入控件与事件', /id="uiBaseW"[^>]*data-change="ui-base-w"/.test(admin) && /case 'ui-base-w'/.test(admin));
ok('默认 1:1 实际大小预览', /scale: 1, baseW: 0/.test(admin) && /\[1, '100% · 实际大小'\]/.test(admin));
ok('同宽打开游戏页', /if \(!S\.ui\.baseW \|\| Math\.abs\(base - window\.innerWidth\) <= 2\) window\.open\('index\.html', '_blank'\)/.test(admin));
ok('视图设置刷新后保留', /UI_VIEW_KEY = 'wow-ui-view'/.test(admin) && /saveUiView\(\)/.test(admin) && /case 'ui-base-w'[\s\S]{0,240}saveUiView\(\)/.test(admin));
ok('applyUiScale 先算动态视口宽', /function applyUiScale\(\)[\s\S]{0,120}const vpW = uiViewportW\(\)/.test(admin));
ok('iframe 宽高由 JS 写入（覆盖 CSS 的 1280）',
  /frame\.style\.width = vpW \+ 'px'/.test(admin) && /frame\.style\.height = UI_H \+ 'px'/.test(admin));
ok('fit 缩放按动态宽度计算', /s = availW \/ frameW;/.test(admin) && !/availW \/ UI_W/.test(admin));
ok('缩放后的占位尺寸同步用实际 iframe 宽', /inner\.style\.width = \(frameW \* s\) \+ 'px'/.test(admin));
ok('补偿 iframe 滚动条造成的 7.5px 居中差',
  /frame\.offsetWidth - doc\.documentElement\.clientWidth/.test(admin) && /frameW = vpW \+ sb/.test(admin));
ok('窗口变化无条件重算（不只是 fit 档）',
  /addEventListener\('resize'[\s\S]{0,180}if \(S\.tab === 'ui'\)[\s\S]{0,120}setTimeout\(applyUiScale, 120\)/.test(admin));
ok('工具栏显示当前基准宽度', /id="uiVpLabel"/.test(admin) && /lab\.textContent =/.test(admin) && /vpW \+ 'px'/.test(admin));
ok('基准标签有样式', /\.ui-vp-label \{/.test(adminCss));
ok('锁定宽输入框有样式', /\.ui-tb-label \.input\.ui-base-w \{/.test(adminCss));
ok('基准标签显示实际大小/锁定状态', /lab\.textContent = \(S\.ui\.baseW \? '锁定 ' : '基准 '\)/.test(admin) && /实际大小 1:1/.test(admin));

console.log('\n2) 编辑态样例不撑高顶栏');
ok('dock 改为矮占位且脱离 flex 拉伸',
  /\.ui-edit-mode \.steam-dock \{[^}]*position: relative[^}]*height: 34px[^}]*flex: none/.test(css));
ok('dock 保留最小宽度（自身图层仍可点选）', /\.ui-edit-mode \.steam-dock \{[^}]*min-width: 160px/.test(css));
ok('样例绝对定位、不参与文档流高度',
  /\.ui-edit-mode \.steam-auth-slot \{[^}]*position: absolute; left: 0; top: 0/.test(css));
ok('样例仍有可见底色与虚线框',
  /\.ui-edit-mode \.steam-auth-slot \{[^}]*background: rgba\(10, 15, 23/.test(css) &&
  /border: 1px dashed rgba\(217, 164, 65/.test(css));
ok('两行样例结构未被破坏', /\.ui-edit-mode \.steam-auth-slot \.steam-sample-row \{ display: flex/.test(css) &&
  /\.ui-edit-mode \.steam-auth-slot \.steam-user/.test(css));

console.log('\n3) 大括号配平');
[['admin.js', admin], ['admin.css', adminCss], ['styles.css', css]].forEach(([f, s]) => {
  let o = 0, c = 0;
  for (const ch of s) { if (ch === '{') o++; else if (ch === '}') c++; }
  ok(f + ' ' + o + '/' + c, o === c);
});

console.log('\n' + (fail ? 'FAILED ' + fail + ' 项' : 'ALL PASS ' + pass + ' 项'));
if (fail) process.exitCode = 1;
