/**
 * Steam OpenID 2.0 登录 · 纯逻辑核心（Worker / Node 单源）
 *
 * 适用范围（Steam 官方 WebAPI 文档）：「用户希望登录该网站或将自己的帐户与该网站绑定」。
 * 只证明「这个人是某个 SteamID64」，不是正版凭证、不能判断他是否拥有某个 AppID。
 * 不需要 AppID / Steamworks 合作伙伴身份 / 商店页面 / Web API Key 即可完成登录校验。
 *
 * 为什么是 .mjs：项目没有 package.json，Node 默认把 .js 当 CommonJS；
 * .mjs 让 cf-worker.js（ESM import）与 server.js（CJS 里的动态 import()）
 * 复用同一份实现，不需要维护两份协议代码。
 *
 * 本文件只做纯计算与协议编解码，不碰网络 / 存储：网络与账号存储由
 * steam-auth-router.mjs 注入，便于离线回归测试。
 */

export const STEAM_LOGIN_URL = 'https://steamcommunity.com/openid/login';
export const OPENID_NS = 'http://specs.openid.net/auth/2.0';
export const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
export const STEAM_API_SUMMARIES = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/';
/* Steam 社区公开档案（XML）：不需要 Web API Key，也就绕开了「开发者账号消费满 $5」的门槛。
   这是公开网页端点而非受 SLA 保障的 Web API，因此只作为无 Key 时的兜底，
   有 Key 仍优先走 GetPlayerSummaries。 */
export const STEAM_COMMUNITY_XML = 'https://steamcommunity.com/profiles/';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 会话 30 天
export const STATE_TTL_MS = 10 * 60 * 1000;                // 登录 state 10 分钟
export const SESSION_COOKIE = 'wowp_session';
export const STATE_COOKIE = 'wowp_steam_state';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* -------------------------------------------------------------------------
   1. 签名令牌：HMAC-SHA256 + base64url
   用 purpose 做域分离，state 的签名不能拿去当 session 用。
   ------------------------------------------------------------------------- */
function b64uFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret, purpose) {
  return crypto.subtle.importKey(
    'raw', enc.encode(String(purpose) + ':' + String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

/** 签发自包含令牌：body.payload 用 JSON，整体 body.signature 做 HMAC 校验。 */
export async function signToken(secret, purpose, payload, now = Date.now()) {
  const body = Object.assign({}, payload, { k: purpose, iat: now });
  const raw = b64uFromBytes(enc.encode(JSON.stringify(body)));
  const key = await hmacKey(secret, purpose);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)));
  return raw + '.' + b64uFromBytes(sig);
}

/** 校验签名 / kind / 有效期；任何异常一律返回 null，绝不抛给调用方。 */
export async function verifyToken(secret, purpose, token, now = Date.now()) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const key = await hmacKey(secret, purpose);
    const good = await crypto.subtle.verify('HMAC', key, bytesFromB64u(parts[1]), enc.encode(parts[0]));
    if (!good) return null;
    const obj = JSON.parse(dec.decode(bytesFromB64u(parts[0])));
    if (!obj || obj.k !== purpose) return null;
    if (typeof obj.exp !== 'number' || !(obj.exp > now)) return null;
    if (typeof obj.iat !== 'number' || obj.iat > now + 60 * 1000) return null;
    return obj;
  } catch (e) { return null; }
}

export async function makeState(secret, nonce, now = Date.now()) {
  return signToken(secret, 'steam.state', { nonce: nonce, exp: now + STATE_TTL_MS }, now);
}
export async function readState(secret, token, now = Date.now()) {
  return verifyToken(secret, 'steam.state', token, now);
}

/** 会话载荷只带内部 uid：业务层永远拿 uid 做主键，SteamID 只存在于 identity 层。 */
export async function makeSession(secret, account, now = Date.now()) {
  return signToken(secret, 'steam.session', {
    uid: account.uid,
    sid: account.steamId || '',
    exp: now + SESSION_TTL_MS
  }, now);
}
export async function readSession(secret, token, now = Date.now()) {
  return verifyToken(secret, 'steam.session', token, now);
}

/* -------------------------------------------------------------------------
   2. OpenID 2.0 请求 / 断言
   ------------------------------------------------------------------------- */
export function realmOf(requestUrl) {
  const u = new URL(requestUrl);
  return u.origin + '/';
}
export function callbackUrlOf(requestUrl) {
  const u = new URL(requestUrl);
  return u.origin + '/api/auth/steam/callback';
}

/** checkid_setup：把用户送到 Steam 社区登录页，登录完回跳 return_to。 */
export function buildLoginUrl(realm, returnTo) {
  const u = new URL(STEAM_LOGIN_URL);
  u.searchParams.set('openid.ns', OPENID_NS);
  u.searchParams.set('openid.mode', 'checkid_setup');
  u.searchParams.set('openid.return_to', returnTo);
  u.searchParams.set('openid.realm', realm);
  u.searchParams.set('openid.identity', IDENTIFIER_SELECT);
  u.searchParams.set('openid.claimed_id', IDENTIFIER_SELECT);
  return u.toString();
}

/** 取出回调 URL 里全部 openid.* 断言字段（其它业务参数忽略）。 */
export function collectAssertion(requestUrl) {
  const out = {};
  for (const [k, v] of new URL(requestUrl).searchParams) {
    if (k.indexOf('openid.') === 0) out[k] = v;
  }
  return out;
}

/** 把回跳 URL 里的 openid.* 参数剥掉，得到与 return_to 可比的基准 URL。 */
export function stripAssertion(requestUrl) {
  const u = new URL(requestUrl);
  const keep = [];
  for (const [k, v] of u.searchParams) if (k.indexOf('openid.') !== 0) keep.push([k, v]);
  const q = new URLSearchParams();
  keep.forEach(([k, v]) => q.append(k, v));
  const s = q.toString();
  return u.origin + u.pathname + (s ? '?' + s : '');
}

/** claimed_id 必须是 steamcommunity.com/openid/id/ 下的 17 位 SteamID64。
 *  用 URL 解析而不是正则匹配整串，避免 steamcommunity.com.evil.com 这类绕过。 */
export function steamIdFromClaimed(claimed) {
  try {
    const u = new URL(String(claimed || ''));
    if (u.hostname !== 'steamcommunity.com') return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const m = /^\/openid\/id\/(7656119\d{10})$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

/** 回跳断言的形状校验（签名真伪仍必须由 Steam 的 check_authentication 确认）。 */
export function validateAssertionShape(a, requestUrl) {
  if (!a || typeof a !== 'object') return 'missing_assertion';
  if (a['openid.ns'] !== OPENID_NS) return 'bad_ns';
  if (a['openid.mode'] !== 'id_res') return 'bad_mode';
  const ep = a['openid.op_endpoint'];
  if (ep !== STEAM_LOGIN_URL && ep !== STEAM_LOGIN_URL.replace('https:', 'http:')) return 'bad_op_endpoint';
  if (!a['openid.assoc_handle'] || !a['openid.signed'] || !a['openid.sig']) return 'missing_signature';
  if (!a['openid.response_nonce']) return 'missing_nonce';
  if (a['openid.return_to'] !== stripAssertion(requestUrl)) return 'return_to_mismatch';
  const claimed = a['openid.claimed_id'];
  if (claimed !== a['openid.identity']) return 'claimed_identity_mismatch';
  if (!steamIdFromClaimed(claimed)) return 'bad_claimed_id';
  return null;
}

/** check_authentication：把收到的断言原样回传，只把 mode 换掉。 */
export function buildVerifyBody(a) {
  const q = new URLSearchParams();
  Object.keys(a).forEach(k => q.set(k, a[k]));
  q.set('openid.mode', 'check_authentication');
  return q.toString();
}

export function parseVerifyResponse(text) {
  return /^is_valid\s*:\s*true\s*$/m.test(String(text || ''));
}

/* -------------------------------------------------------------------------
   3. 会话 cookie
   ------------------------------------------------------------------------- */
export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
export function setCookie(name, value, opts = {}) {
  const bits = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) bits.push('Secure');
  const age = opts.maxAge == null ? 0 : opts.maxAge;
  bits.push('Max-Age=' + age);
  if (age <= 0) bits.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return bits.join('; ');
}

/* -------------------------------------------------------------------------
   4. 内部 uid 与限流（用户强调：uid 与 SteamID 必须解耦）
   uid 是随机内部主键，SteamID 只是 accounts.identities 里的一条记录；
   将来换成别的登录方式，只要往同一个 uid 追加 identity，业务数据不受影响。
   ------------------------------------------------------------------------- */
export function newUid() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'u_' + b64uFromBytes(b);
}
export function newNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64uFromBytes(b);
}
export function rateKeyOf(uid, action, ip) {
  // 未登录时按来源 IP 兜底，登录后一律按 uid 维度
  return String(action) + ':' + String(uid || ('ip:' + String(ip || 'unknown')));
}
/** 滑动窗口判定；hits 由存储层提供，返回是否放行与清理后的时间戳数组。 */
export function rateAllow(hits, limit, windowMs, now = Date.now()) {
  const fresh = (Array.isArray(hits) ? hits : []).filter(t => typeof t === 'number' && t > now - windowMs);
  if (fresh.length >= limit) return { ok: false, hits: fresh, retryAfterMs: Math.max(1, fresh[0] + windowMs - now) };
  fresh.push(now);
  return { ok: true, hits: fresh };
}

/** 可选的 Steam 资料：没有 Web API Key 时完全不调用，登录照常可用。 */
export function playerSummariesUrl(apiKey, steamId) {
  const u = new URL(STEAM_API_SUMMARIES);
  u.searchParams.set('key', apiKey);
  u.searchParams.set('steamids', steamId);
  return u.toString();
}
export function parsePlayerSummary(json, steamId) {
  try {
    const list = json && json.response && json.response.players;
    const p = Array.isArray(list) && list.find(x => String(x.steamid) === String(steamId));
    if (!p) return { nick: '', avatar: '' };
    return {
      nick: cleanNickname(p.personaname),
      avatar: safeAvatarUrl(p.avatarfull || p.avatar)
    };
  } catch (e) { return { nick: '', avatar: '' }; }
}

/** 无 API Key 时的兜底：解析 Steam 社区公开 XML 档案。 */
export function communityProfileUrl(steamId) {
  return STEAM_COMMUNITY_XML + String(steamId) + '/?xml=1';
}
function cdata(tag, src) {
  const m = new RegExp('<' + tag + '>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</' + tag + '>').exec(src)
    || new RegExp('<' + tag + '>\\s*([^<]*?)\\s*</' + tag + '>').exec(src);
  return m ? String(m[1]).trim() : '';
}
function cleanNickname(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 32);
}
function safeAvatarUrl(v) {
  const s = String(v == null ? '' : v).trim();
  return /^https:\/\//.test(s) ? s.slice(0, 256) : '';
}
export function parseCommunityXml(text, steamId) {
  try {
    const s = String(text || '');
    // 必须核对返回的 steamID64：防止代理缓存串号或拿到错误中间页
    const idm = /<steamID64>\s*(\d{17})\s*<\/steamID64>/.exec(s);
    if (!idm || idm[1] !== String(steamId)) return { nick: '', avatar: '' };
    return {
      nick: cleanNickname(cdata('steamID', s)),
      avatar: safeAvatarUrl(cdata('avatarFull', s))
    };
  } catch (e) { return { nick: '', avatar: '' }; }
}
