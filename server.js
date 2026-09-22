/**
 * 小鸡快跑 · 基金加仓雷达 —— 可选后端
 * ═══════════════════════════════════════════════════════════════════════
 * 说明：index.html 是**纯静态单文件**，在 GitHub Pages 等纯静态托管上可
 *       独立运行，不需要本文件。本文件用于两种情况：
 *         1) 想在电脑/局域网上跑一份，手机同 WiFi 直接访问；
 *         2) 浏览器直连公开行情接口失败时，作为同源代理兜底
 *            （前端检测到直连失败会自动切到 /api/nav 与 /api/kline）。
 *
 * 启动：node server.js        默认 http://localhost:3000
 *       PORT=8080 node server.js
 *
 * 接口：
 *   GET /api/ping                        健康检查
 *   GET /api/nav?code=007466             基金全历史净值（代理天天基金）
 *   GET /api/kline?sym=sh512890&bars=130  日K线（代理腾讯财经）
 *   GET /api/search?key=红利低波          基金搜索（代理腾讯 smartbox）
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 带超时与重定向跟随的 GET，返回 utf-8 文本 */
function httpGet(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(res.headers.location, headers, timeout));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout || 15000, () => { req.destroy(); reject(new Error('上游超时')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, times) {
  let last;
  for (let i = 0; i < (times || 2); i++) {
    try { return await fn(); } catch (e) { last = e; if (i < (times || 2) - 1) await sleep(250); }
  }
  throw last;
}

/* ───────────────────── 1. 基金净值（天天基金） ───────────────────── */

/**
 * pingzhongdata 是 JS 变量赋值文件，用 script 标签可在任意站点加载。
 * 这里把它解析成精简 JSON，只保留名称与净值序列，减小传输体积。
 * 净值序列格式：[时间戳(ms), 单位净值, 当日涨跌%, 分红说明, 累计净值]
 */
async function fetchFundNav(code) {
  const url = 'https://fund.eastmoney.com/pingzhongdata/' + code + '.js?t=' + Date.now();
  const r = await withRetry(() => httpGet(url, { Referer: 'https://fund.eastmoney.com/' }, 18000), 2);
  if (r.status !== 200) throw new Error('上游 HTTP ' + r.status);

  const nameM = r.text.match(/var fS_name\s*=\s*"([^"]*)"/);
  const trendM = r.text.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!nameM || !trendM) throw new Error('未找到该基金代码');

  let arr;
  try { arr = JSON.parse(trendM[1]); } catch (e) { throw new Error('净值序列解析失败'); }
  if (!arr.length) throw new Error('净值序列为空');

  const trend = arr.map((t) => [
    t.x,
    t.y,
    isFinite(parseFloat(t.equityReturn)) ? parseFloat(t.equityReturn) : 0,
    t.unitMoney || '',
  ]);

  return { code, name: nameM[1], bars: trend.length, trend };
}

/* ────────────────────── 2. 日K线（腾讯财经） ────────────────────── */

async function fetchKline(sym, bars) {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
    + sym + ',day,,,' + bars + ',qfq';
  const r = await withRetry(() => httpGet(url, { Referer: 'https://gu.qq.com/' }, 15000), 2);
  let j;
  try { j = JSON.parse(r.text); } catch (e) { throw new Error('K线解析失败'); }
  const node = j && j.data && j.data[sym];
  if (!node) throw new Error('无此标的：' + sym);
  const arr = node.qfqday || node.day;
  if (!arr || !arr.length) throw new Error('K线为空：' + sym);
  return { sym, bars: arr.length, rows: arr.map((x) => [x[0], parseFloat(x[1]), parseFloat(x[2]), parseFloat(x[3]), parseFloat(x[4])]) };
}

/* ───────────────────── 3. 基金搜索 ──────────────────── */

/**
 * ① 天天基金 fundsuggest：名称搜索最可靠（支持中文关键词）
 * ② 腾讯 smartbox：仅在查询是 6 位代码时返回基金类型，作为代码兜底
 */
async function searchFund(key) {
  try {
    const url = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(key);
    const r = await httpGet(url, { Referer: 'https://fund.eastmoney.com/' }, 12000);
    const j = JSON.parse(r.text);
    const out = [];
    if (Array.isArray(j.Datas)) {
      j.Datas.forEach((it) => {
        if (it && /^\d{6}$/.test(it.CODE || '')) out.push({ code: it.CODE, name: it.NAME || '', type: it.CATEGORYDESC || '' });
      });
    }
    if (out.length) return out;
  } catch (e) { /* 继续尝试下一条通路 */ }

  const r2 = await httpGet('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(key) + '&t=all', {}, 12000);
  const m = r2.text.match(/v_hint="([\s\S]*)"/);
  if (!m) return [];
  let decoded = m[1];
  try { decoded = JSON.parse('"' + m[1] + '"'); } catch (e) { /* 保留原文 */ }
  const out2 = [];
  decoded.split('^').forEach((p) => {
    const f = p.split('~');
    if (f.length >= 3 && f[0] === 'jj' && /^\d{6}$/.test(f[1])) out2.push({ code: f[1], name: f[2], type: '场外基金' });
  });
  return out2;
}

/* ───────────────────────── HTTP 服务 ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const cache = new Map();
function cached(key, ttl, producer) {
  const c = cache.get(key), now = Date.now();
  if (c && now - c.t < ttl) return Promise.resolve(c.v);
  return Promise.resolve(producer()).then((v) => { cache.set(key, { t: now, v }); return v; });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const P = u.pathname, q = u.searchParams;

  try {
    if (P === '/api/ping') return sendJson(res, 200, { ok: true, name: '小鸡快跑', ts: Date.now() });

    if (P === '/api/nav') {
      const code = (q.get('code') || '').trim();
      if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'code 需为 6 位数字' });
      const data = await cached('nav:' + code, 10 * 60 * 1000, () => fetchFundNav(code));
      return sendJson(res, 200, data);
    }

    if (P === '/api/kline') {
      const sym = (q.get('sym') || '').trim();
      const bars = Math.min(Math.max(parseInt(q.get('bars') || '130', 10) || 130, 10), 500);
      if (!/^[a-zA-Z.]{2,10}\d{0,6}$/.test(sym)) return sendJson(res, 400, { error: 'sym 不合法' });
      const data = await cached('k:' + sym + ':' + bars, 3 * 60 * 1000, () => fetchKline(sym, bars));
      return sendJson(res, 200, data);
    }

    if (P === '/api/search') {
      const key = (q.get('key') || '').trim();
      if (!key) return sendJson(res, 400, { error: '缺少 key' });
      const list = await cached('s:' + key, 10 * 60 * 1000, () => searchFund(key));
      return sendJson(res, 200, { list });
    }

    // ── 静态文件：与 server.js 同目录（index.html 就在旁边）──
    let fp = P === '/' ? '/index.html' : decodeURIComponent(P);
    const root = __dirname;
    const full = path.join(root, fp);
    if (!full.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    sendJson(res, 502, { error: e.message || '上游取数失败' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lan = '';
  Object.keys(nets).forEach((k) => {
    (nets[k] || []).forEach((x) => { if (x.family === 'IPv4' && !x.internal) lan = x.address; });
  });
  console.log('🐥 小鸡快跑 已启动');
  console.log('   本机  http://localhost:' + PORT);
  if (lan) console.log('   手机  http://' + lan + ':' + PORT + '   （需与电脑同一 WiFi）');
});
