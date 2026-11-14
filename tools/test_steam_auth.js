/**
 * Steam OpenID 2.0 登录回归测试（离线，不连 Steam）
 * 运行：node tools/test_steam_auth.js
 *
 * 覆盖：checkid_setup URL、断言形状校验、check_authentication 回传、
 * SteamID64 提取、HMAC 会话防伪造、CSRF state、nonce 防重放、
 * 内部 uid 与 SteamID 解耦、按 uid 限流、login→callback→me→logout 全链路。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const API = path.join(ROOT, 'functions', 'api');
const murl = f => pathToFileURL(path.join(API, f)).href;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const SECRET = 'test-secret-do-not-ship';
const SID = '76561198012345678';
const CLAIMED = 'https://steamcommunity.com/openid/id/' + SID;
const COMMUNITY_XML_OK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><profile>
  <steamID64>${SID}</steamID64>
  <steamID><![CDATA[Raphybox]]></steamID>
  <privacyState>friendsonly</privacyState>
  <avatarFull><![CDATA[https://avatars.fastly.steamstatic.com/abc_full.jpg]]></avatarFull>
</profile>`;
let nonceSeq = 0;

function cookieHeaderFrom(res, name) {
  const full = cookieFullFrom(res, name);
  return full ? full.split(';')[0] : '';
}
function cookieFullFrom(res, name) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return list.find(c => c.indexOf(name + '=') === 0) || '';
}
function makeCallback(loginRes, claimed, overrides) {
  const loc = new URL(loginRes.headers.get('Location'));
  const returnTo = loc.searchParams.get('openid.return_to');
  const state = new URL(returnTo).searchParams.get('state');
  const cb = new URL(returnTo);
  const a = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimed || CLAIMED,
    'openid.identity': claimed || CLAIMED,
    'openid.return_to': returnTo,
    'openid.response_nonce': '2026-11-15T00:00:00Z-' + (++nonceSeq) + '-' + Math.random().toString(36).slice(2),
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'ZmFrZS1zaWduYXR1cmU='
  };
  Object.assign(a, overrides || {});
  Object.keys(a).forEach(k => cb.searchParams.set(k, a[k]));
  return { url: cb.toString(), state: state, returnTo: returnTo };
}

(async () => {
  const SA = await import(murl('steam-auth.mjs'));
  const { createAuthRouter } = await import(murl('steam-auth-router.mjs'));
  const { memoryStore } = await import(murl('steam-store.mjs'));

  /* ------------------------------------------------------------------ */
  section('1) OpenID 2.0 请求与 URL');
  {
    const realm = SA.realmOf('https://xjdz.de5.net/api/auth/steam/login');
    const ret = SA.callbackUrlOf('https://xjdz.de5.net/api/auth/steam/login') + '?state=abc';
    const u = new URL(SA.buildLoginUrl(realm, ret));
    ok('realm 为站点根', realm === 'https://xjdz.de5.net/');
    ok('登录目标为 Steam 社区', u.origin === 'https://steamcommunity.com' && u.pathname === '/openid/login');
    ok('mode = checkid_setup', u.searchParams.get('openid.mode') === 'checkid_setup');
    ok('ns = OpenID 2.0', u.searchParams.get('openid.ns') === SA.OPENID_NS);
    ok('realm / return_to 正确', u.searchParams.get('openid.realm') === realm && u.searchParams.get('openid.return_to') === ret);
    ok('identifier_select', u.searchParams.get('openid.identity') === SA.IDENTIFIER_SELECT &&
      u.searchParams.get('openid.claimed_id') === SA.IDENTIFIER_SELECT);
    ok('URL 里不含 AppID / API Key', !/appid|key=/i.test(u.toString()));
    ok('本地 http 也能推导 realm', SA.realmOf('http://127.0.0.1:8787/x') === 'http://127.0.0.1:8787/');
  }

  section('2) claimed_id → SteamID64（防域名伪造）');
  {
    ok('合法 17 位 ID', SA.steamIdFromClaimed(CLAIMED) === SID);
    ok('http 版兼容', SA.steamIdFromClaimed('http://steamcommunity.com/openid/id/' + SID) === SID);
    ok('伪装域名被拒', SA.steamIdFromClaimed('https://steamcommunity.com.evil.com/openid/id/' + SID) === null);
    ok('子域被拒', SA.steamIdFromClaimed('https://evil.steamcommunity.com/openid/id/' + SID) === null);
    ok('非 7656119 前缀被拒', SA.steamIdFromClaimed('https://steamcommunity.com/openid/id/12345678901234567') === null);
    ok('位数不对被拒', SA.steamIdFromClaimed('https://steamcommunity.com/openid/id/7656119801234567') === null);
    ok('目录不对被拒', SA.steamIdFromClaimed('https://steamcommunity.com/profiles/' + SID) === null);
    ok('空值被拒', SA.steamIdFromClaimed('') === null && SA.steamIdFromClaimed(null) === null);
  }

  section('3) 断言形状与 check_authentication 回传');
  {
    const loginRes = { headers: new Headers({ Location: 'https://steamcommunity.com/openid/login?openid.return_to=' +
      encodeURIComponent('https://xjdz.de5.net/api/auth/steam/callback?state=s1') }) };
    const cb = makeCallback(loginRes);
    const a = SA.collectAssertion(cb.url);
    ok('只收集 openid.* 字段', Object.keys(a).every(k => k.indexOf('openid.') === 0) && Object.keys(a).length === 10);
    ok('stripAssertion 保留 state 并去掉断言', SA.stripAssertion(cb.url) === cb.returnTo);
    ok('合法断言通过', SA.validateAssertionShape(a, cb.url) === null);
    ok('return_to 被篡改', SA.validateAssertionShape(a, cb.url + '&x=1') !== null ||
      SA.validateAssertionShape(Object.assign({}, a, { 'openid.return_to': 'https://evil.com/' }), cb.url) === 'return_to_mismatch');
    ok('claimed_id ≠ identity', SA.validateAssertionShape(Object.assign({}, a, { 'openid.identity': CLAIMED + 'x' }), cb.url) === 'claimed_identity_mismatch');
    ok('mode 被改', SA.validateAssertionShape(Object.assign({}, a, { 'openid.mode': 'cancel' }), cb.url) === 'bad_mode');
    ok('缺签名', SA.validateAssertionShape(Object.assign({}, a, { 'openid.sig': '' }), cb.url) === 'missing_signature');
    ok('伪造 op_endpoint', SA.validateAssertionShape(Object.assign({}, a, { 'openid.op_endpoint': 'https://evil.com/openid/login' }), cb.url) === 'bad_op_endpoint');
    ok('伪造 claimed_id', SA.validateAssertionShape(Object.assign({}, a, {
      'openid.claimed_id': 'https://evil.com/openid/id/' + SID,
      'openid.identity': 'https://evil.com/openid/id/' + SID
    }), cb.url) === 'bad_claimed_id');

    const body = new URLSearchParams(SA.buildVerifyBody(a));
    ok('mode 换成 check_authentication', body.get('openid.mode') === 'check_authentication');
    ok('断言原样回传', body.get('openid.sig') === a['openid.sig'] && body.get('openid.return_to') === a['openid.return_to']);
    ok('解析 is_valid:true', SA.parseVerifyResponse('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    ok('拒绝 is_valid:false', !SA.parseVerifyResponse('ns:...\nis_valid:false\n'));
    ok('拒绝空响应', !SA.parseVerifyResponse(''));
  }

  section('4) 签名会话 / state 防伪造');
  {
    const t = await SA.makeSession(SECRET, { uid: 'u_abc', steamId: SID }, 1000);
    const s = await SA.readSession(SECRET, t, 2000);
    ok('会话可解出 uid', s && s.uid === 'u_abc' && s.sid === SID);
    ok('改 payload 被拒', await SA.readSession(SECRET, t.slice(0, -3) + 'AAA', 2000) === null);
    ok('错密钥被拒', await SA.readSession('other-secret', t, 2000) === null);
    ok('乱串被拒', await SA.readSession(SECRET, 'garbage', 2000) === null);
    ok('过期被拒', await SA.readSession(SECRET, t, 1000 + SA.SESSION_TTL_MS + 1) === null);
    const st = await SA.makeState(SECRET, 'n1', 1000);
    ok('state 可校验', !!(await SA.readState(SECRET, st, 2000)));
    ok('state 不能当 session 用', await SA.readSession(SECRET, st, 2000) === null);
    ok('session 不能当 state 用', await SA.readState(SECRET, t, 2000) === null);
    ok('篡改 kind 被拒', await SA.verifyToken(SECRET, 'steam.session', await SA.signToken(SECRET, 'other', { exp: 9999999999999 }), 2000) === null);
  }

  section('5) Cookie 与内部 uid');
  {
    const c = SA.setCookie('wowp_session', 'a.b-c_d', { secure: true, maxAge: 3600 });
    ok('HttpOnly / Secure / SameSite / Path', /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c));
    ok('值做 URL 编码', /wowp_session=a\.b-c_d/.test(c));
    ok('本地 http 不写 Secure', !/Secure/.test(SA.setCookie('x', 'y', { secure: false, maxAge: 60 })));
    ok('清除带 Expires', /Expires=Thu, 01 Jan 1970/.test(SA.setCookie('x', '', { secure: false, maxAge: 0 })));
    ok('parseCookies 解码', SA.parseCookies('a=1; wowp_session=a.b-c_d')['wowp_session'] === 'a.b-c_d');
    const u1 = SA.newUid(), u2 = SA.newUid();
    ok('uid 是内部主键格式', /^u_[A-Za-z0-9_-]{10,}$/.test(u1) && u1 !== u2);
    ok('uid 不含 SteamID（解耦）', u1.indexOf(SID) < 0 && u1.indexOf('7656119') < 0);
    ok('nonce 随机', SA.newNonce() !== SA.newNonce());
  }

  section('6) 滑动窗口限流');
  {
    const r1 = SA.rateAllow([], 3, 1000, 5000);
    ok('前 3 次放行', r1.ok && r1.hits.length === 1);
    const r2 = SA.rateAllow(r1.hits.concat([5001, 5002]), 3, 1000, 5003);
    ok('窗口内超额拒绝', !r2.ok && r2.retryAfterMs > 0);
    const r3 = SA.rateAllow([1000, 1001], 3, 1000, 5000);
    ok('过期记录被清掉', r3.ok && r3.hits.length === 1);
    ok('rateKey 按 uid 优先', SA.rateKeyOf('u_1', 'roomCreate', '1.2.3.4') === 'roomCreate:u_1');
    ok('未登录按 IP 兜底', SA.rateKeyOf(null, 'roomCreate', '1.2.3.4') === 'roomCreate:ip:1.2.3.4');
  }

  section('7) 可选 Steam 资料（没 Key 也要能登录）');
  {
    const u = new URL(SA.playerSummariesUrl('KEY123', SID));
    ok('GetPlayerSummaries 地址正确', u.host === 'api.steampowered.com' && u.searchParams.get('steamids') === SID && u.searchParams.get('key') === 'KEY123');
    const p = SA.parsePlayerSummary({ response: { players: [{ steamid: SID, personaname: '测试玩家', avatarfull: 'https://a.jpg' }] } }, SID);
    ok('昵称头像可解析', p.nick === '测试玩家' && p.avatar === 'https://a.jpg');
    ok('空列表降级', SA.parsePlayerSummary({ response: { players: [] } }, SID).nick === '');
    ok('非 https 头像被丢', SA.parsePlayerSummary({ response: { players: [{ steamid: SID, personaname: 'x', avatarfull: 'javascript:alert(1)' }] } }, SID).avatar === '');

    const xu = SA.communityProfileUrl(SID);
    ok('社区档案地址无需 Key', xu === 'https://steamcommunity.com/profiles/' + SID + '/?xml=1' && !/key=/i.test(xu));
    const xp = SA.parseCommunityXml(COMMUNITY_XML_OK, SID);
    ok('免 Key 解析出昵称与头像', xp.nick === 'Raphybox' && xp.avatar.indexOf('https://avatars.') === 0);
    ok('steamID64 不匹配时拒绝（防缓存串号）', SA.parseCommunityXml(COMMUNITY_XML_OK, '76561198999999999').nick === '');
    ok('缺 CDATA 也能解析纯文本昵称', SA.parseCommunityXml('<profile><steamID64>' + SID + '</steamID64><steamID>PlainName</steamID></profile>', SID).nick === 'PlainName');
    ok('非 XML / 空响应返回空', SA.parseCommunityXml('is_valid:true\n', SID).nick === '' && SA.parseCommunityXml('', SID).nick === '');
    ok('控制字符被清理', SA.parseCommunityXml('<profile><steamID64>' + SID + '</steamID64><steamID><![CDATA[A\u0001B   C]]></steamID></profile>', SID).nick === 'A B C');
  }

  section('8) 账号存储：uid 与 SteamID 解耦 + 换登录方式余地');
  {
    const store = memoryStore();
    const a1 = await store.resolve({ provider: 'steam', providerUid: SID, nick: 'A' });
    const a2 = await store.resolve({ provider: 'steam', providerUid: SID, nick: 'B' });
    ok('同一 SteamID → 同一 uid', a1.uid === a2.uid);
    ok('昵称可更新', a2.nick === 'B' && a2.loginCount === 2);
    const a3 = await store.resolve({ provider: 'steam', providerUid: '76561198999999999' });
    ok('不同 SteamID → 不同 uid', a3.uid !== a1.uid);
    ok('uid 不含 SteamID', a1.uid.indexOf(SID) < 0);
    const link = await store.link({ uid: a1.uid, provider: 'future', providerUid: 'abc123' });
    ok('可把新登录方式绑到同一 uid', link.ok === true && link.identityCount === 2);
    const bound = await store.link({ uid: a3.uid, provider: 'future', providerUid: 'abc123' });
    ok('同一外部身份不能绑到两个 uid', bound.error === 'identity_bound_to_other_account');
    ok('取账号返回 uid 与资料', (await store.get(a1.uid)).account.uid === a1.uid);
    ok('取不存在的账号返回 null', (await store.get('nope')).account === null);
    const r = await store.rate({ key: 'k', limit: 2, windowMs: 60000 });
    const r2 = await store.rate({ key: 'k', limit: 2, windowMs: 60000 });
    const r3 = await store.rate({ key: 'k', limit: 2, windowMs: 60000 });
    ok('存储层限流生效', r.ok && r2.ok && !r3.ok);
  }

  section('9) 路由全链路（mock Steam 验签）');
  {
    const store = memoryStore();
    let verifyText = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n';
    const calls = [];
    const router = createAuthRouter({
      secret: SECRET, apiKey: '', store: store, devMock: false,
      fetchImpl: async (url, init) => {
        calls.push({ url: url, init: init });
        if (url === SA.STEAM_LOGIN_URL) return new Response(verifyText);
        if (String(url).indexOf(SA.STEAM_COMMUNITY_XML) === 0) return new Response(COMMUNITY_XML_OK);
        return new Response('{}');
      }
    });
    const mkReq = (url, cookie) => new Request(url, { headers: cookie ? { Cookie: cookie } : {} });

    const me0 = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/me'));
    ok('未登录 me → logged:false', (await me0.json()).logged === false);

    const login = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/login'));
    ok('login 返回 302', login.status === 302);
    ok('Location 指向 Steam', new URL(login.headers.get('Location')).host === 'steamcommunity.com');
    const stateCookie = cookieHeaderFrom(login, SA.STATE_COOKIE);
    ok('下发签名 state cookie', /^wowp_steam_state=/.test(stateCookie));

    const cb = makeCallback(login);
    const callback = await router.handle(mkReq(cb.url, stateCookie));
    ok('callback 302 回首页', callback.status === 302 && new URL(callback.headers.get('Location')).pathname === '/');
    ok('真的向 Steam 回传了断言', calls.some(c => c.init.method === 'POST' && c.url === SA.STEAM_LOGIN_URL));
    ok('回传 body 是 check_authentication', new URLSearchParams(calls[0].init.body).get('openid.mode') === 'check_authentication');
    ok('无 API Key 时回退到 Steam 社区公开档案', calls.some(c => c.url === SA.communityProfileUrl(SID)));
    const sessionCookie = cookieHeaderFrom(callback, SA.SESSION_COOKIE);
    ok('下发 session cookie', /^wowp_session=/.test(sessionCookie));
    ok('同时清除 state cookie', /Max-Age=0/.test(cookieFullFrom(callback, SA.STATE_COOKIE)));

    const me1 = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/me', sessionCookie));
    const j1 = await me1.json();
    ok('me 返回 logged:true 与 uid', j1.logged === true && /^u_/.test(j1.uid));
    ok('me 返回 SteamID 仅用于展示', j1.steamId === SID && j1.provider === 'steam');
    ok('业务主键不等于 SteamID', j1.uid !== SID);
    ok('免 Key 也能拿到并保存 Steam 昵称', j1.nick === 'Raphybox');
    ok('头像同步落到账号', String(j1.avatar).indexOf('https://avatars.') === 0);

    const g = await router.guard(mkReq('https://xjdz.de5.net/api/room/create', sessionCookie), 'roomCreate');
    ok('guard 能识别登录态 uid', g.ok && g.identity.uid === j1.uid);

    const logout = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/logout', sessionCookie));
    ok('logout 204 并清 cookie', logout.status === 204 && /Max-Age=0/.test(cookieFullFrom(logout, SA.SESSION_COOKIE)));

    /* 各类失败必须拒绝签发会话 */
    const failCase = async (name, mutate, verify, expectReason) => {
      const lg = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/login'));
      const c = makeCallback(lg);
      if (mutate) mutate(c);
      verifyText = verify == null ? 'is_valid:true\n' : verify;
      const ck = cookieHeaderFrom(lg, SA.STATE_COOKIE);
      const usedCookie = mutate && mutate.usesCookie === false ? '' : ck;
      const r = await router.handle(mkReq(c.url, usedCookie));
      const loc = new URL(r.headers.get('Location'));
      const reason = loc.searchParams.get('reason');
      const sc = cookieFullFrom(r, SA.SESSION_COOKIE);
      const hasSession = sc.indexOf('wowp_session=') === 0 && !/Max-Age=0/.test(sc);
      ok(name, reason === expectReason && !hasSession, 'reason=' + reason + ' session=' + hasSession);
      verifyText = 'is_valid:true\n';
    };
    const badSig = c => { c.url = c.url.replace(/openid\.sig=[^&]*/, 'openid.sig=tampered'); };
    const badState = c => { c.url = c.url.replace(/state=[^&]*/, 'state=forged'); };
    const badReturn = c => { c.url = c.url.replace(/openid\.return_to=[^&]*/, 'openid.return_to=' + encodeURIComponent('https://evil.com/')); };
    await failCase('Steam 验签失败 → 拒绝', badSig, 'is_valid:false\n', 'signature_invalid');
    await failCase('CSRF state 不匹配 → 拒绝', badState, 'is_valid:true\n', 'state_mismatch');
    await failCase('return_to 被篡改 → 拒绝', badReturn, 'is_valid:true\n', 'return_to_mismatch');
    await failCase('无 state cookie → 拒绝', (() => { const f = c => {}; f.usesCookie = false; return f; })(), 'is_valid:true\n', 'state_mismatch');

    /* nonce 重放：同一断言用第二次 */
    {
      const lg = await router.handle(mkReq('https://xjdz.de5.net/api/auth/steam/login'));
      const c = makeCallback(lg);
      const ck = cookieHeaderFrom(lg, SA.STATE_COOKIE);
      await router.handle(mkReq(c.url, ck));
      const again = await router.handle(mkReq(c.url, ck));
      ok('同一断言重放被拒', new URL(again.headers.get('Location')).searchParams.get('reason') === 'nonce_replayed');
    }

    /* 没配密钥不许签发会话 */
    {
      const r0 = createAuthRouter({ secret: '', store: store, devMock: false });
      const r = await r0.handle(mkReq('https://xjdz.de5.net/api/auth/steam/login'));
      ok('缺 SESSION_SECRET → 503', r.status === 503);
      ok('缺密钥时 me 仍可正常返回未登录', (await (await r0.handle(mkReq('https://xjdz.de5.net/api/auth/steam/me'))).json()).logged === false);
    }

    /* mock 只在本地开发开启 */
    {
      const local = createAuthRouter({ secret: SECRET, store: memoryStore(), devMock: true });
      const prod = createAuthRouter({ secret: SECRET, store: memoryStore(), devMock: false });
      const m = await local.handle(mkReq('http://127.0.0.1:8787/api/auth/steam/mock?steamid=' + SID + '&nick=本地'));
      ok('本地 mock 可完成登录', m.status === 302 && /^wowp_session=/.test(cookieHeaderFrom(m, SA.SESSION_COOKIE)));
      ok('线上 mock 路径不可用', (await prod.handle(mkReq('https://xjdz.de5.net/api/auth/steam/mock'))).status === 404);
      ok('mock 拒绝非法 SteamID', (await local.handle(mkReq('http://127.0.0.1:8787/api/auth/steam/mock?steamid=123'))).status === 400);
    }
  }

  section('10) 源码接线与既有玩法不被破坏');
  {
    const worker = fs.readFileSync(path.join(ROOT, 'cf-worker.js'), 'utf8');
    const wr = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const game = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const front = fs.readFileSync(path.join(ROOT, 'steam-login.js'), 'utf8');
    ok('Worker 导出 AccountHub', /export \{ AccountHub \}/.test(worker));
    ok('Worker 分发鉴权路由', /\/api\/auth\/steam\//.test(worker) && /authFor\(env\)\.handle/.test(worker));
    ok('线上 devMock 恒为 false', /devMock: false/.test(worker));
    ok('wrangler 有 AUTH binding', /"name": "AUTH", "class_name": "AccountHub"/.test(wr));
    ok('wrangler 有 v2 migration', /"tag": "v2", "new_sqlite_classes": \["AccountHub"\]/.test(wr));
    ok('SESSION_SECRET 未明文写进 vars', !/"SESSION_SECRET"\s*:/.test(wr));
    ok('只对 create/lookup 限流，poll 不限流', /roomAct === 'create'/.test(worker) && /'roomLookup'/.test(worker) && !/'roomPoll'/.test(worker));
    ok('本地服务复用同一 router', /getSteamRouter/.test(srv) && /createAuthRouter/.test(srv));
    ok('本地默认开 mock', /STEAM_OPENID_MOCK !== '0'/.test(srv));
    ok('页面挂载 Steam 登录位与脚本', /id="steamAuthSlot"/.test(html) && /steam-login\.js/.test(html));
    ok('game.js 监听 profile 更新', /wowpinball:profile-update/.test(game));
    ok('前端样式存在', /\.steam-login-btn/.test(css));
    const routerSrc = fs.readFileSync(path.join(API, 'steam-auth-router.mjs'), 'utf8');
    ok('顶栏以 Steam 昵称为主标识', /steam-nick', nick/.test(front) && /font-weight: 600/.test(css));
    ok('有昵称时不再渲染可见 ID', /if \(nick\) \{[\s\S]{0,260}\} else if \(sid\)/.test(front));
    ok('SteamID64 只进悬停提示', /nickEl\.title = nick \+ \(sid \? ' · SteamID64：' \+ sid/.test(front) && /box\.title = nick/.test(front));
    ok('无昵称时仍有 ID 兜底且可复制', /else if \(sid\)/.test(front) && /navigator\.clipboard/.test(front));
    ok('占位文案仅作最后兜底', /'Steam 玩家'/.test(front) && /\} else \{/.test(front));
    ok('徽标收窄、ID 兜底可截断', /max-width: 190px/.test(css) && /max-width: 118px/.test(css));
    ok('服务端无 Key 回退社区档案', /communityProfileUrl\(steamId\)/.test(routerSrc) && /parseCommunityXml\(text, steamId\)/.test(routerSrc));
    ok('有 Key 时仍优先官方 Web API', /if \(cfg\.apiKey\)/.test(routerSrc) && /playerSummariesUrl\(cfg\.apiKey/.test(routerSrc));
    ok('资料抓取失败不阻断登录', /return \{ nick: '', avatar: '' \};/.test(routerSrc));
    ok('前端只用 uid 不拿 SteamID 做业务', /window\.SteamAuthState = me/.test(front) && !/uid\s*=\s*me\.steamId/.test(front));
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' 项' : 'ALL PASS ' + pass + ' 项'));
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
