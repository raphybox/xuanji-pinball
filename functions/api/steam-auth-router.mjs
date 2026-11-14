/**
 * Steam 登录路由 · Worker 与本地 server.js 共用的单源处理器
 *
 * 协议全过程（不需要 AppID / Steamworks 合作伙伴 / 商店页 / API Key）：
 *   GET /api/auth/steam/login      → 302 到 steamcommunity.com/openid/login(checkid_setup)
 *   GET /api/auth/steam/callback   → 取断言，POST 回 Steam 做 check_authentication
 *                                    签名通过后从 claimed_id 里取 17 位 SteamID64
 *   GET /api/auth/steam/me         → 当前会话身份（业务只拿 uid）
 *   POST/GET /api/auth/steam/logout→ 清会话
 *
 * 风控（用户强调「Steam 不保证是真人」）：登录/回调/断言 nonce 都在服务端按
 * uid 或 IP 维度限流；房间接口通过 guard() 复用同一套限流。
 *
 * 依赖通过 deps 注入，便于离线测试与本地内存实现：
 *   secret / apiKey / fetchImpl / store / devMock / now
 */

import * as SA from './steam-auth.mjs';

export const RATE = {
  login: { limit: 20, windowMs: 60 * 1000 },
  callback: { limit: 30, windowMs: 60 * 1000 },
  nonce: { limit: 1, windowMs: 10 * 60 * 1000 },
  roomCreate: { limit: 10, windowMs: 60 * 1000 },
  roomLookup: { limit: 30, windowMs: 60 * 1000 },
  roomOther: { limit: 60, windowMs: 60 * 1000 }
};

const PREFIX = '/api/auth/steam/';

function jsonRes(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})
  });
}
function redirect(location, extraHeaders) {
  const h = new Headers({ 'Location': location, 'Cache-Control': 'no-store' });
  (extraHeaders || []).forEach(v => h.append('Set-Cookie', v));
  return new Response(null, { status: 302, headers: h });
}
function homeUrl(request, params) {
  const u = new URL(request.url);
  u.pathname = '/';
  u.search = '';
  Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k]));
  return u.toString();
}
/** Worker 里 CF-Connecting-IP 由平台注入，可信；本地回落到 local。 */
function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim().slice(0, 64);
  const xf = request.headers.get('X-Forwarded-For');
  if (xf) return xf.split(',')[0].trim().slice(0, 64);
  return 'local';
}
function cookieFlags(request) {
  return { secure: new URL(request.url).protocol === 'https:' };
}

export function createAuthRouter(deps) {
  const cfg = Object.assign({
    secret: '', apiKey: '', devMock: false,
    fetchImpl: (...a) => fetch(...a),
    store: null,
    now: () => Date.now(),
    log: () => {}
  }, deps || {});

  async function rate(key, action) {
    if (!cfg.store || typeof cfg.store.rate !== 'function') return { ok: true, retryAfterMs: 0 };
    try {
      const c = RATE[action] || RATE.roomOther;
      return await cfg.store.rate({ key: key, limit: c.limit, windowMs: c.windowMs });
    } catch (e) {
      // 存储故障不应该把登录整个打死，但要在日志里留痕（风控降级）
      cfg.log('rate_store_error', String((e && e.message) || e));
      return { ok: true, retryAfterMs: 0, degraded: true };
    }
  }

  /** 从会话 cookie 解出内部 uid；服务端不信任前端传来的任何 uid。 */
  async function identity(request) {
    const ip = clientIp(request);
    const cookies = SA.parseCookies(request.headers.get('Cookie'));
    const token = cookies[SA.SESSION_COOKIE];
    if (!token || !cfg.secret) return { logged: false, uid: null, steamId: '', ip: ip };
    const s = await SA.readSession(cfg.secret, token, cfg.now());
    if (!s || !s.uid) return { logged: false, uid: null, steamId: '', ip: ip };
    return { logged: true, uid: s.uid, steamId: s.sid || '', ip: ip, exp: s.exp };
  }

  /** 供房间等非鉴权接口调用：按 uid（未登录按 IP）做服务端限流。 */
  async function guard(request, action) {
    const id = await identity(request);
    const key = SA.rateKeyOf(id.uid, action, id.ip);
    const r = await rate(key, action);
    return { ok: r.ok, identity: id, retryAfterMs: r.retryAfterMs || 0 };
  }

  async function issueSession(request, steamId, profile) {
    const acc = await cfg.store.resolve({
      provider: 'steam', providerUid: steamId,
      nick: profile.nick || '', avatar: profile.avatar || ''
    });
    if (!acc || acc.error || !acc.uid) throw new Error('account_resolve_failed');
    const token = await SA.makeSession(cfg.secret, { uid: acc.uid, steamId: steamId }, cfg.now());
    const f = cookieFlags(request);
    return [
      SA.setCookie(SA.SESSION_COOKIE, token, { secure: f.secure, maxAge: Math.floor(SA.SESSION_TTL_MS / 1000) }),
      SA.setCookie(SA.STATE_COOKIE, '', { secure: f.secure, maxAge: 0 })
    ];
  }

  async function fetchSteamProfile(steamId) {
    /* 1) 有 Web API Key：官方 GetPlayerSummaries，最稳（受 SLA 保障）。
          需要开发账号在 Steam 商店消费满 $5 才能领 Key。 */
    if (cfg.apiKey) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        let j = null;
        try {
          const r = await cfg.fetchImpl(SA.playerSummariesUrl(cfg.apiKey, steamId), { signal: ctrl.signal });
          if (r.ok) j = await r.json();
        } finally { clearTimeout(t); }
        const p = SA.parsePlayerSummary(j, steamId);
        if (p.nick) { cfg.log('steam_profile_source', 'webapi'); return p; }
      } catch (e) { cfg.log('steam_webapi_failed', String((e && e.message) || e)); }
    }
    /* 2) 没 Key（或官方没给昵称）：Steam 社区公开 XML 档案。
          不需要 API Key / 不需要 $5 门槛；这是公开网页端点，可能受 Steam 侧
          限流、隐私设置或 CDN 拦截影响，因此失败必须静默降级，绝不阻断登录。 */
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      let text = '';
      try {
        const r = await cfg.fetchImpl(SA.communityProfileUrl(steamId), {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'XuanJiPinball-Auth/1.0 (+https://xjdz.de5.net)',
            'Accept': 'application/xml, text/xml, */*'
          }
        });
        if (r.ok) text = await r.text();
      } finally { clearTimeout(t); }
      const p = SA.parseCommunityXml(text, steamId);
      if (p.nick) { cfg.log('steam_profile_source', 'community_xml'); return p; }
      cfg.log('steam_community_empty', steamId);
    } catch (e) { cfg.log('steam_community_failed', String((e && e.message) || e)); }
    /* 资料拿不到只影响昵称 / 头像，登录本身照常完成，前端仍有 SteamID64 兜底 */
    return { nick: '', avatar: '' };
  }

  /** 返回 Response 表示本路由接管；返回 null 表示不是鉴权路径。 */
  async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname.indexOf(PREFIX) !== 0) return null;
    const act = url.pathname.slice(PREFIX.length).replace(/\/+$/, '').toLowerCase();
    const ip = clientIp(request);
    const cookies = SA.parseCookies(request.headers.get('Cookie'));
    const f = cookieFlags(request);

    /* ---- 当前身份：任何情况下都不报错，最差返回未登录 ---- */
    if (act === 'me' && request.method === 'GET') {
      const id = await identity(request);
      if (!id.logged) return jsonRes({ logged: false, uid: null, provider: 'steam' });
      let nick = '', avatar = '';
      if (cfg.store && typeof cfg.store.get === 'function') {
        try {
          const r = await cfg.store.get(id.uid);
          if (r && r.account) { nick = r.account.nick || ''; avatar = r.account.avatar || ''; }
        } catch (e) {}
      }
      return jsonRes({
        logged: true, uid: id.uid, provider: 'steam',
        steamId: id.steamId,              // 仅用于展示 / 个人页链接，业务主键永远是 uid
        nick: nick, avatar: avatar
      });
    }

    /* ---- 退出登录 ---- */
    if (act === 'logout') {
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': SA.setCookie(SA.SESSION_COOKIE, '', { secure: f.secure, maxAge: 0 }), 'Cache-Control': 'no-store' }
      });
    }

    /* 以下动作都要签名密钥；线上没配 secret 时明确拒绝，绝不用弱密钥签发会话 */
    if (!cfg.secret || !cfg.store) return jsonRes({ error: 'auth_not_configured' }, 503);

    /* ---- 本地开发 mock：不走 Steam 也能把完整链路（resolve/限流/会话）跑通 ---- */
    if (act === 'mock' && cfg.devMock) {
      const sid = String(url.searchParams.get('steamid') || '76561198000000000');
      if (!SA.steamIdFromClaimed('https://steamcommunity.com/openid/id/' + sid)) {
        return jsonRes({ error: 'bad_steamid' }, 400);
      }
      const ok = await rate(SA.rateKeyOf(null, 'mock.login', ip), 'login');
      if (!ok.ok) return jsonRes({ error: 'rate_limited' }, 429);
      const profile = { nick: String(url.searchParams.get('nick') || '本地测试玩家').slice(0, 32), avatar: '' };
      const headers = await issueSession(request, sid, profile);
      return redirect(homeUrl(request, { steam: 'ok', mock: '1' }), headers);
    }

    /* ---- 1) 跳到 Steam 社区登录 ---- */
    if (act === 'login' && request.method === 'GET') {
      const ok = await rate(SA.rateKeyOf(null, 'login', ip), 'login');
      if (!ok.ok) return jsonRes({ error: 'rate_limited' }, 429);
      const state = await SA.makeState(cfg.secret, SA.newNonce(), cfg.now());
      const returnTo = SA.callbackUrlOf(request.url) + '?state=' + encodeURIComponent(state);
      const realm = SA.realmOf(request.url);
      return redirect(SA.buildLoginUrl(realm, returnTo), [
        SA.setCookie(SA.STATE_COOKIE, state, { secure: f.secure, maxAge: Math.floor(SA.STATE_TTL_MS / 1000) })
      ]);
    }

    /* ---- 2) 回跳：校验断言 → 回传 Steam 验签 → 取 SteamID64 ---- */
    if (act === 'callback' && request.method === 'GET') {
      const fail = reason => redirect(homeUrl(request, { steam: 'error', reason: reason }), [
        SA.setCookie(SA.STATE_COOKIE, '', { secure: f.secure, maxAge: 0 })
      ]);
      const ok = await rate(SA.rateKeyOf(null, 'callback', ip), 'callback');
      if (!ok.ok) return fail('rate_limited');

      // CSRF：URL 里的 state 必须与签名 cookie 完全一致，且签名未过期
      const urlState = url.searchParams.get('state') || '';
      const cookieState = cookies[SA.STATE_COOKIE] || '';
      if (!urlState || !cookieState || urlState !== cookieState) return fail('state_mismatch');
      const st = await SA.readState(cfg.secret, urlState, cfg.now());
      if (!st) return fail('state_invalid');

      const a = SA.collectAssertion(request.url);
      const shapeErr = SA.validateAssertionShape(a, request.url);
      if (shapeErr) return fail(shapeErr);

      // 断言 nonce 只允许用一次，防重放
      const nonceCheck = await rate('nonce:' + String(a['openid.response_nonce']).slice(0, 160), 'nonce');
      if (!nonceCheck.ok) return fail('nonce_replayed');

      let verifyText = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const r = await cfg.fetchImpl(SA.STEAM_LOGIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
            body: SA.buildVerifyBody(a),
            signal: ctrl.signal
          });
          if (!r.ok) return fail('verify_http_' + r.status);
          verifyText = await r.text();
        } finally { clearTimeout(timer); }
      } catch (e) {
        cfg.log('steam_verify_failed', String((e && e.message) || e));
        return fail('verify_unreachable');
      }
      if (!SA.parseVerifyResponse(verifyText)) return fail('signature_invalid');

      const steamId = SA.steamIdFromClaimed(a['openid.claimed_id']);
      if (!steamId) return fail('bad_claimed_id');

      const profile = await fetchSteamProfile(steamId);
      let headers;
      try { headers = await issueSession(request, steamId, profile); }
      catch (e) { return fail('account_resolve_failed'); }
      cfg.log('steam_login_ok', steamId);
      return redirect(homeUrl(request, { steam: 'ok' }), headers);
    }

    return jsonRes({ error: 'unknown_auth_action' }, 404);
  }

  return { handle: handle, identity: identity, guard: guard, RATE: RATE };
}
