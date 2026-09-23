'use strict';
// محادثة خاصة بين شخصين - مباشرة بدون تحديث (Long Polling)
// بدون أي مكتبات خارجية - يعمل بـ Node.js فقط

const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ---------- الإعدادات (من متغيرات البيئة) ----------
const PORT = process.env.PORT || 3000;
const TTL_MS = (parseFloat(process.env.TTL_MINUTES) || 5) * 60 * 1000;
const SECRET = process.env.COOKIE_SECRET || '';
const USERS = [
  { name: (process.env.USER1_NAME || '').trim(), pass: process.env.USER1_PASSWORD || '' },
  { name: (process.env.USER2_NAME || '').trim(), pass: process.env.USER2_PASSWORD || '' }
];

if (!USERS[0].name || !USERS[0].pass || !USERS[1].name || !USERS[1].pass || SECRET.length < 32) {
  console.error('خطأ: يجب ضبط USER1_NAME و USER1_PASSWORD و USER2_NAME و USER2_PASSWORD و COOKIE_SECRET (32 حرف على الأقل).');
  process.exit(1);
}

// ---------- أدوات مساعدة ----------
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEq(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function sign(t) { return crypto.createHmac('sha256', SECRET).update(t).digest('hex'); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function makeSession(slot) {
  const p = slot + '.' + (Date.now() + 30 * 24 * 3600 * 1000);
  return p + '.' + sign(p);
}

function readSession(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return -1;
  const parts = m[1].split('.');
  if (parts.length !== 3) return -1;
  const sig = sign(parts[0] + '.' + parts[1]);
  if (parts[2].length !== sig.length) return -1;
  if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(sig))) return -1;
  if (Number(parts[1]) < Date.now()) return -1;
  const slot = Number(parts[0]);
  return slot === 0 || slot === 1 ? slot : -1;
}

function cookieHeader(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return 'sid=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
}

function send(res, status, type, body, extra) {
  const headers = Object.assign({
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, 'application/json', JSON.stringify(obj)); }
function redirect(res, where, extra) {
  res.writeHead(303, Object.assign({ Location: where, 'Cache-Control': 'no-store' }, extra || {}));
  res.end();
}

function readBody(req, cb) {
  let data = '';
  let big = false;
  req.on('data', function (c) {
    data += c;
    if (data.length > 10000) { big = true; req.destroy(); }
  });
  req.on('end', function () { if (!big) cb(querystring.parse(data)); });
}

// ---------- حالة المحادثة (في الذاكرة فقط) ----------
let messages = [];
let version = 1;
let nextId = 1;
let waiters = [];

function renderMessages(slot) {
  if (!messages.length) return '<div class="empty">لا توجد رسائل</div>';
  return messages.map(function (m) {
    const mine = m.slot === slot;
    const rtl = /[\u0600-\u06FF\u0750-\u077F]/.test(m.text);
    return '<div class="row ' + (mine ? 'me' : 'them') + '">' +
      '<div class="bub" dir="' + (rtl ? 'rtl' : 'ltr') + '" style="text-align:' + (rtl ? 'right' : 'left') + '">' +
      (mine ? '' : '<b>' + esc(USERS[m.slot].name) + '</b><br>') +
      esc(m.text) + '</div></div>';
  }).join('');
}

function snapshot(slot) { return { v: version, html: renderMessages(slot) }; }

function bump() {
  version++;
  const list = waiters;
  waiters = [];
  list.forEach(function (w) {
    clearTimeout(w.timer);
    sendJson(w.res, 200, snapshot(w.slot));
  });
}

// حذف الرسائل المنتهية تلقائيًا
setInterval(function () {
  const now = Date.now();
  const before = messages.length;
  messages = messages.filter(function (m) { return m.exp > now; });
  if (messages.length !== before) bump();
}, 1000);

// ---------- الصفحات ----------
const CSS = 'body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#ece5dd;color:#111}' +
  '#top{background:#075e54;color:#fff;padding:8px 10px;overflow:hidden}' +
  '#top .n{font-size:16px;font-weight:bold}' +
  '#top .s{font-size:11px;opacity:.8}' +
  '#top form{display:inline;margin:0}' +
  '#top .b{float:left;margin-right:6px}' +
  '#top input[type=submit]{font-size:12px;padding:4px 8px}' +
  '#box{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px;height:300px}' +
  '.row{margin:4px 0;overflow:hidden}' +
  '.row.me{text-align:right}.row.them{text-align:left}' +
  '.bub{display:inline-block;max-width:80%;padding:6px 10px;border-radius:10px;font-size:16px;word-wrap:break-word}' +
  '.me .bub{background:#dcf8c6}.them .bub{background:#fff}' +
  '.empty{text-align:center;color:#777;margin-top:20px}' +
  '#f{margin:0;padding:8px;background:#f0f0f0;white-space:nowrap}' +
  '#t{width:70%;-webkit-box-sizing:border-box;box-sizing:border-box;font-size:16px;padding:8px}' +
  '#f input[type=submit]{width:26%;font-size:16px;padding:8px 0}' +
  '.card{max-width:320px;margin:40px auto;background:#fff;padding:20px;border-radius:10px}' +
  '.card input[type=text],.card input[type=password]{width:100%;-webkit-box-sizing:border-box;box-sizing:border-box;font-size:16px;padding:8px;margin:6px 0 12px}' +
  '.card input[type=submit]{font-size:16px;padding:8px 20px}' +
  '.err{color:#c00;margin-bottom:10px}';

const HEAD = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>محادثة</title>';

function loginPage(error) {
  return HEAD + '<style>' + CSS + '</style></head><body><div class="card">' +
    '<h3>تسجيل الدخول</h3>' +
    (error ? '<div class="err">' + esc(error) + '</div>' : '') +
    '<form method="post" action="/login">' +
    'اسم المستخدم<input type="text" name="u" autocomplete="off" autocapitalize="off" autocorrect="off">' +
    'كلمة المرور<input type="password" name="p">' +
    '<input type="submit" value="دخول"></form></div></body></html>';
}

function chatPage(slot) {
  const ttl = +(TTL_MS / 60000).toFixed(1);
  return HEAD +
    '<noscript><meta http-equiv="refresh" content="6"></noscript>' +
    '<style>' + CSS + '</style></head><body>' +
    '<div id="top">' +
    '<div class="b"><form id="clr" method="post" action="/clear"><input type="submit" value="حذف المحادثة"></form> ' +
    '<form method="post" action="/logout"><input type="submit" value="خروج"></form></div>' +
    '<div class="n">' + esc(USERS[slot].name) + '</div>' +
    '<div class="s">تُحذف الرسائل بعد ' + ttl + ' دقيقة</div></div>' +
    '<div id="box">' + renderMessages(slot) + '</div>' +
    '<form id="f" method="post" action="/send">' +
    '<input type="text" name="text" id="t" autocomplete="off" autocapitalize="off" maxlength="1000"> ' +
    '<input type="submit" value="إرسال"></form>' +
    '<script>' + CLIENT_JS.replace('__VER__', String(version)) + '</script>' +
    '</body></html>';
}

// كود المتصفح: مكتوب بصيغة قديمة (ES3) ليعمل على iOS 5.1.1
const CLIENT_JS = '(function(){' +
  'var box=document.getElementById("box"),f=document.getElementById("f"),t=document.getElementById("t"),c=document.getElementById("clr");' +
  'var ver=__VER__,gen=0,cur=null;' +
  'function ajax(m,u,b,cb){var x=new XMLHttpRequest();x.open(m,u,true);' +
  'x.setRequestHeader("X-Requested-With","XMLHttpRequest");' +
  'if(m==="POST")x.setRequestHeader("Content-Type","application/x-www-form-urlencoded");' +
  'x.onreadystatechange=function(){if(x.readyState===4)cb(x.status,x.responseText)};' +
  'x.send(b||null);return x}' +
  'function fit(){var h=window.innerHeight-box.offsetTop-f.offsetHeight-4;if(h<120)h=120;box.style.height=h+"px"}' +
  'function show(h){box.innerHTML=h;box.scrollTop=box.scrollHeight}' +
  'function poll(my){cur=ajax("GET","/poll?v="+ver+"&_="+new Date().getTime(),null,function(s,r){' +
  'if(my!==gen)return;' +
  'if(s===401){location.href="/";return}' +
  'if(s===200){var d=null;try{d=JSON.parse(r)}catch(e){}' +
  'if(d){if(d.v!==ver){ver=d.v;if(d.html!==undefined)show(d.html)}poll(my);return}}' +
  'setTimeout(function(){if(my===gen)poll(my)},3000)})}' +
  'function start(){gen++;if(cur){try{cur.abort()}catch(e){}}poll(gen)}' +
  'f.onsubmit=function(){var v=t.value.replace(/^\\s+|\\s+$/g,"");if(!v)return false;t.value="";' +
  'ajax("POST","/send","text="+encodeURIComponent(v),function(s){if(s!==200){t.value=v;if(s===401)location.href="/"}});return false};' +
  'c.onsubmit=function(){if(!confirm("حذف المحادثة كاملة من الجهازين؟"))return false;ajax("POST","/clear","",function(){});return false};' +
  'window.onresize=fit;window.onorientationchange=fit;window.onfocus=start;window.onpageshow=start;' +
  'fit();box.scrollTop=box.scrollHeight;start();' +
  '})();';

// ---------- محاولات الدخول الفاشلة ----------
const fails = {};
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function tooMany(ip) {
  const f = fails[ip];
  return f && f.count >= 10 && Date.now() - f.first < 10 * 60 * 1000;
}
function noteFail(ip) {
  const f = fails[ip];
  if (!f || Date.now() - f.first > 10 * 60 * 1000) fails[ip] = { count: 1, first: Date.now() };
  else f.count++;
}

// ---------- الخادم ----------
const server = http.createServer(function (req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, 'text/plain', 'bad request'); }
  const path = url.pathname;
  const isPost = req.method === 'POST';
  const xhr = req.headers['x-requested-with'] === 'XMLHttpRequest';

  if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');

  // تسجيل الدخول
  if (path === '/login' && isPost) {
    const ip = clientIp(req);
    if (tooMany(ip)) return send(res, 429, 'text/html', loginPage('محاولات كثيرة، انتظر عشر دقائق'));
    return readBody(req, function (b) {
      const u = String(b.u || '').trim();
      const p = String(b.p || '');
      for (let i = 0; i < 2; i++) {
        if (safeEq(u, USERS[i].name) && safeEq(p, USERS[i].pass)) {
          delete fails[ip];
          return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, makeSession(i), 2592000) });
        }
      }
      noteFail(ip);
      send(res, 401, 'text/html', loginPage('اسم المستخدم أو كلمة المرور غير صحيحة'));
    });
  }

  const slot = readSession(req);

  if (path === '/' && req.method === 'GET') {
    return slot < 0 ? send(res, 200, 'text/html', loginPage()) : send(res, 200, 'text/html', chatPage(slot));
  }

  if (slot < 0) {
    return xhr ? sendJson(res, 401, { error: 'login' }) : redirect(res, '/');
  }

  // حماية بسيطة من الطلبات القادمة من مواقع أخرى
  if (isPost && req.headers.origin && req.headers.origin.replace(/^https?:\/\//, '') !== req.headers.host) {
    return send(res, 403, 'text/plain', 'forbidden');
  }

  // انتظار رسالة جديدة (Long Polling)
  if (path === '/poll' && req.method === 'GET') {
    const v = parseInt(url.searchParams.get('v'), 10);
    if (v !== version) return sendJson(res, 200, snapshot(slot));
    const w = { slot: slot, res: res };
    w.timer = setTimeout(function () {
      waiters = waiters.filter(function (x) { return x !== w; });
      sendJson(res, 200, { v: version });
    }, 20000);
    waiters.push(w);
    req.on('close', function () {
      clearTimeout(w.timer);
      waiters = waiters.filter(function (x) { return x !== w; });
    });
    return;
  }

  // إرسال رسالة
  if (path === '/send' && isPost) {
    return readBody(req, function (b) {
      const text = String(b.text || '').trim().slice(0, 1000);
      if (text) {
        messages.push({ id: nextId++, slot: slot, text: text, exp: Date.now() + TTL_MS });
        if (messages.length > 200) messages.shift();
        bump();
      }
      xhr ? sendJson(res, 200, { ok: true }) : redirect(res, '/');
    });
  }

  // حذف المحادثة كاملة
  if (path === '/clear' && isPost) {
    return readBody(req, function () {
      messages = [];
      bump();
      xhr ? sendJson(res, 200, { ok: true }) : redirect(res, '/');
    });
  }

  // خروج
  if (path === '/logout' && isPost) {
    return readBody(req, function () {
      redirect(res, '/', { 'Set-Cookie': cookieHeader(req, '', 0) });
    });
  }

  send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('الخادم يعمل على المنفذ ' + PORT);
});
