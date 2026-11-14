/**
 * 顶栏 Steam 登录入口（OpenID 2.0）
 *
 * 只做三件事：读 /api/auth/steam/me 显示身份、点按钮跳登录、点退出清会话。
 * 登录是可选增强：不登录照样能玩单机与联机，服务端只对建房 / 加入按 uid 限流。
 *
 * 身份只认服务端签发的 uid。SteamID64 仅用于展示与个人页链接，
 * 不参与任何业务判定 —— 内部 uid 与 SteamID 是解耦的两层。
 */
(function () {
  'use strict';

  var SLOT_ID = 'steamAuthSlot';
  var PROFILE_KEY = 'wowpinball.profile.v1';
  var NICK_MAX = 12;
  var REASONS = {
    'state_mismatch': '登录状态不匹配，请重试',
    'state_invalid': '登录请求已过期，请重试',
    'return_to_mismatch': '回跳地址校验失败',
    'signature_invalid': 'Steam 签名校验未通过',
    'verify_unreachable': '连不上 Steam 校验服务，请稍后重试',
    'nonce_replayed': '该登录断言已被使用，请重新发起',
    'rate_limited': '尝试过于频繁，请稍后再试',
    'bad_claimed_id': 'SteamID 格式异常',
    'account_resolve_failed': '账号写入失败，请稍后重试',
    'auth_not_configured': '站点尚未配置登录密钥'
  };
  var started = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function failReason() {
    try {
      var q = new URLSearchParams(location.search);
      return q.get('steam') === 'error' ? (q.get('reason') || 'unknown') : '';
    } catch (e) { return ''; }
  }
  function cleanNick(v) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, NICK_MAX);
  }

  /** 首次登录且本地还没设昵称时，用 Steam 昵称预填（用户仍可在昵称弹层里改）。 */
  function autoFillNick(me) {
    if (!me || !me.logged || !me.nick) return;
    var raw = null;
    try { raw = JSON.parse(window.localStorage.getItem(PROFILE_KEY)); } catch (e) { raw = null; }
    if (raw && cleanNick(raw.name)) return;           // 尊重用户已有昵称
    var nick = cleanNick(me.nick);
    if (!nick) return;
    try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: nick })); } catch (e) {}
    var input = document.getElementById('nameInput');
    if (input && !input.value) input.value = nick;
    try { window.dispatchEvent(new CustomEvent('wowpinball:profile-update', { detail: { name: nick } })); }
    catch (e) {}
  }

  function render(slot, me, reason) {
    slot.innerHTML = '';
    if (reason) {
      slot.appendChild(el('span', 'steam-auth-err', REASONS[reason] || ('登录失败：' + reason)));
    }
    if (me && me.logged) {
      var box = el('span', 'steam-user');
      if (me.avatar) {
        var img = el('img', 'steam-avatar');
        img.src = me.avatar;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        box.appendChild(img);
      }
      /* 昵称是主标识、SteamID64 是副信息。
         服务端有 Web API Key 时走官方 GetPlayerSummaries；没 Key 时回退到
         Steam 社区公开 XML 档案抓昵称（不需要 $5 门槛）。两端都拿不到才只留 ID，
         再用「Steam 玩家」占位，但绝不把占位文案当成登录结果。 */
      var sid = String((me && me.steamId) || '').trim();
      var nick = String((me && me.nick) || '').trim();
      if (nick) {
        var nickEl = el('span', 'steam-nick', nick);
        nickEl.title = nick + (sid ? ' · SteamID64：' + sid : '');
        box.appendChild(nickEl);
      }
      if (sid) {
        var idEl = el('span', 'steam-id', sid);
        idEl.title = 'SteamID64：' + sid + ' · 点击复制';
        idEl.addEventListener('click', function () {
          // writeText 返回 Promise：页面失焦 / 非安全上下文 / 用户拒权都会异步拒绝，
          // 同步 try 拦不住，必须同时挂 catch，否则控制台会留未处理异常。
          try {
            var p = (navigator.clipboard && navigator.clipboard.writeText)
              ? navigator.clipboard.writeText(sid) : null;
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (e) {}
        });
        box.appendChild(idEl);
      }
      if (!sid && !nick) box.appendChild(el('span', 'steam-nick', 'Steam 玩家'));
      box.title = nick
        ? (nick + (sid ? ' · SteamID64：' + sid : ''))
        : (sid ? 'SteamID64：' + sid : 'Steam 账号已登录');
      slot.appendChild(box);
      var out = el('button', 'ghost-btn steam-logout-btn', '退出');
      out.type = 'button';
      out.title = '退出 Steam 登录（不会删除本地游戏进度）';
      out.addEventListener('click', async function () {
        out.disabled = true;
        try {
          await fetch('/api/auth/steam/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        } catch (e) {}
        load();
      });
      slot.appendChild(out);
    } else {
      var btn = el('button', 'ghost-btn steam-login-btn', 'Steam 登录');
      btn.type = 'button';
      btn.title = '用 Steam 账号登录，获得稳定身份；不登录也能正常游玩';
      btn.addEventListener('click', function () {
        window.location.href = '/api/auth/steam/login';
      });
      slot.appendChild(btn);
    }
  }

  var slotRef = null;
  function load() {
    if (!slotRef) return;
    fetch('/api/auth/steam/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { logged: false }; })
      .then(function (me) {
        autoFillNick(me);
        render(slotRef, me, failReason());
        window.SteamAuthState = me;   // 供房间 / 其它模块读取 uid（只读）
      })
      .catch(function () { render(slotRef, { logged: false }, failReason()); });
  }

  function init() {
    if (started) return;
    slotRef = document.getElementById(SLOT_ID);
    if (!slotRef) return;
    started = true;
    load();
    // 从 Steam 回跳后地址栏会带 ?steam=ok，清掉避免刷新时重复提示
    try {
      if (new URLSearchParams(location.search).get('steam') === 'ok' && window.history.replaceState) {
        var u = new URL(location.href);
        u.searchParams.delete('steam'); u.searchParams.delete('mock');
        window.history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
