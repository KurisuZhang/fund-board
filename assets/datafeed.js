/* 浏览器端数据抓取（GitHub Pages 静态模式，无后端）。
 *
 * 可用性已在 2026-10 实测：
 *   腾讯 qt.gtimg.cn / web.ifzq.gtimg.cn  -> 带 access-control-allow-origin: * （可直接 fetch）
 *   新浪 jsonp_v2/jsonp.php               -> JSONP，跨域可用
 *   新浪滚动新闻 / 7x24 快讯               -> 支持 ?callback= （JSONP）
 * 拿不到：新浪实时报价 hq.sinajs.cn 对 github.io 来源返回 403，
 *         故期货盘中价缺失，用日线最新收盘代替（页面标注口径）。
 */
(function (global) {
  'use strict';

  var UA_TIMEOUT = 8000;
  var jsonpSeq = 0;

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error((label || '请求') + ' 超时')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function fetchJson(url, label, retries) {
    retries = retries === undefined ? 2 : retries;
    var lastErr;
    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        var resp = await withTimeout(fetch(url, { cache: 'no-store' }), UA_TIMEOUT, label);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var text = await resp.text();
        if (!text) throw new Error('空响应');
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(400 * (attempt + 1));
      }
    }
    throw new Error((label || url) + ' 失败：' + (lastErr && lastErr.message));
  }

  async function fetchGbk(url, label, retries) {
    retries = retries === undefined ? 2 : retries;
    var lastErr;
    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        var resp = await withTimeout(fetch(url, { cache: 'no-store' }), UA_TIMEOUT, label);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var buf = await resp.arrayBuffer();
        if (!buf || buf.byteLength === 0) throw new Error('空响应');
        return new TextDecoder('gbk').decode(buf);
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(400 * (attempt + 1));
      }
    }
    throw new Error((label || url) + ' 失败：' + (lastErr && lastErr.message));
  }

  function jsonp(urlTemplate, timeout) {
    /* 兼容两种格式：
     *   1) 回调式（新浪新闻）：...&callback=NAME  -> 返回后调用 window[NAME](data)
     *   2) 变量式（新浪K线）：.../var%20NAME=/... -> 返回 var NAME=([...])
     * 先挂一个函数占位；若脚本用 var 覆盖了它，则 onload 时直接读该全局变量。
     */
    timeout = timeout || 7000;
    /* 新浪只接受 [A-Za-z] 开头、且不含下划线前缀的回调名（"__x" 会返回 callback illegal character） */
    var name = 'sdjsonp' + (++jsonpSeq) + String(Math.floor(Math.random() * 1e9));
    var url = urlTemplate.replace('__CB__', name);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var done = false, viaCallback = false;

      function finish(err, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { script.remove(); } catch (e) { /* noop */ }
        try { delete global[name]; } catch (e) { global[name] = undefined; }
        if (err) reject(err); else resolve(value);
      }

      var timer = setTimeout(function () { finish(new Error('JSONP 超时')); }, timeout);

      global[name] = function (payload) { viaCallback = true; finish(null, payload); };
      script.onload = function () {
        if (viaCallback) return;
        var value = global[name];
        finish(null, typeof value === 'function' ? undefined : value);
      };
      script.onerror = function () { finish(new Error('JSONP 加载失败')); };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  /* ------------------------------------------------------------- 腾讯行情 */
  function parseTencentQuotes(raw) {
    var out = {};
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].trim();
      if (line.indexOf('=') < 0 || line.indexOf('"') < 0) continue;
      var varName = line.split('=')[0].trim();
      var code = varName.indexOf('v_') === 0 ? varName.slice(2) : '';
      if (!code) continue;
      var body = line.split('=')[1].trim().replace(/^"/, '').replace(/"$/, '');
      var f = body.split('~');
      if (f.length < 50) continue;
      out[code] = {
        code: code, name: f[1],
        price: num(f[3]), prevClose: num(f[4]), open: num(f[5]),
        high: num(f[33]), low: num(f[34]), changePct: num(f[32]),
        volumeHand: num(f[36]), amountWan: num(f[37]), turnoverPct: num(f[38]),
        pe: num(f[39]), floatCapYi: num(f[44]), marketCapYi: num(f[45]),
        pb: num(f[46]), yearHigh: num(f[47]), yearLow: num(f[48]), time: f[30]
      };
    }
    return out;
  }

  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  async function quotes(codes) {
    var raw = await fetchGbk('https://qt.gtimg.cn/q=' + codes.join(','), '腾讯行情');
    return parseTencentQuotes(raw);
  }

  /* ------------------------------------------------------------- 日线数据 */
  function tencentRows(rows) {
    var bars = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || r.length < 6) continue;
      var o = Number(r[1]), c = Number(r[2]), h = Number(r[3]), l = Number(r[4]), v = Number(r[5]);
      if (!isFinite(o) || !isFinite(c)) continue;
      bars.push({ d: r[0], o: o, h: h, l: l, c: c, v: v, a: v * 100.0 * c });
    }
    return bars;
  }

  function limitPctOf(code) {
    var body = (code.indexOf('sh') === 0 || code.indexOf('sz') === 0) ? code.slice(2) : code;
    if (body.indexOf('688') === 0 || body.indexOf('300') === 0 || body.indexOf('301') === 0) return 0.20;
    return 0.10;
  }

  /* 识别并修复份额拆分/大比例分红造成的价格跳变（新浪不复权序列会遇到） */
  function adjustSplits(bars, code) {
    if (!bars || bars.length < 2) return { bars: bars || [], events: [] };
    var limit = limitPctOf(code);
    var events = [];
    for (var i = 1; i < bars.length; i++) {
      var prev = Number(bars[i - 1].c), cur = Number(bars[i].c);
      if (!(prev > 0) || !(cur > 0)) continue;
      var ratio = cur / prev;
      if (Math.abs(ratio - 1) > limit + 0.02) events.push({ idx: i, ratio: ratio });
    }
    if (!events.length) return { bars: bars, events: [] };

    var mult = new Array(bars.length);
    var running = 1, evMap = {};
    for (var e = 0; e < events.length; e++) evMap[events[e].idx] = events[e].ratio;
    for (var j = bars.length - 1; j >= 0; j--) {
      mult[j] = running;
      if (evMap[j] !== undefined) running *= evMap[j];
    }
    var out = [];
    for (var k = 0; k < bars.length; k++) {
      var b = bars[k];
      if (mult[k] === 1) { out.push(b); continue; }
      out.push({
        d: b.d, o: Number(b.o) * mult[k], h: Number(b.h) * mult[k],
        l: Number(b.l) * mult[k], c: Number(b.c) * mult[k],
        v: Number(b.v || 0) / mult[k], a: b.a
      });
    }
    var info = events.map(function (ev) {
      return { date: bars[ev.idx].d, ratio: ev.ratio,
               prevClose: Number(bars[ev.idx - 1].c), close: Number(bars[ev.idx].c) };
    });
    return { bars: out, events: info };
  }

  async function stockKline(code, days) {
    /* 优先腾讯（前复权）；腾讯限流返回 501 时回落新浪（不复权），保证页面不空白 */
    try {
      var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,,,' + days + ',qfq';
      var data = await fetchJson(url, code + ' 日线', 1);
      var node = (data && data.data && data.data[code]) || {};
      var bars = tencentRows(node.qfqday || node.day || []);
      if (bars.length) return adjustSplits(bars, code).bars;
    } catch (e) { /* 走回落 */ }
    var fallback = await indexKline(code, days);
    return adjustSplits(fallback, code).bars;
  }

  async function indexKline(symbol, days) {
    var url = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/var%20__CB__=/'
      + 'CN_MarketData.getKLineData?symbol=' + symbol + '&scale=240&ma=no&datalen=' + days;
    var rows = await jsonp(url);
    var bars = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      bars.push({
        d: r.day, o: Number(r.open), h: Number(r.high), l: Number(r.low),
        c: Number(r.close), v: Number(r.volume || 0), a: null
      });
    }
    return bars;
  }

  async function futuresKline(symbol) {
    var url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20__CB__=/'
      + 'InnerFuturesNewService.getDailyKLine?symbol=' + symbol;
    var rows = await jsonp(url);
    var bars = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      bars.push({
        d: r.d, o: Number(r.o), h: Number(r.h), l: Number(r.l),
        c: Number(r.c), v: Number(r.v || 0), a: null
      });
    }
    return bars;
  }

  /* --------------------------------------------------------------- 新闻 */
  function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').trim(); }

  async function newsRoll(pages) {
    var out = [];
    for (var p = 1; p <= pages; p++) {
      var url = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=50&page=' + p + '&callback=__CB__';
      try {
        var data = await jsonp(url);
        var list = (data && data.result && data.result.data) || [];
        for (var i = 0; i < list.length; i++) {
          out.push({ ts: Number(list[i].ctime || 0), title: stripTags(list[i].title), url: list[i].url || '', source: 'roll' });
        }
      } catch (e) { /* 单页失败不影响整体 */ }
    }
    return out;
  }

  async function newsZhibo(pages) {
    var out = [];
    for (var p = 1; p <= pages; p++) {
      var url = 'https://zhibo.sina.com.cn/api/zhibo/feed?page=' + p
        + '&page_size=30&zhibo_id=152&tag_id=0&dire=f&dpc=1&callback=__CB__';
      try {
        var data = await jsonp(url);
        var feed = (((data || {}).result || {}).data || {}).feed || {};
        var list = feed.list || [];
        for (var i = 0; i < list.length; i++) {
          out.push({
            ts: parseTs(list[i].create_time), title: stripTags(list[i].rich_text),
            url: list[i].docurl || '', source: 'zhibo'
          });
        }
      } catch (e) { /* 忽略 */ }
    }
    return out;
  }

  function parseTs(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(v);
    if (isFinite(n) && n > 0) return n;
    var m = String(v).replace('T', ' ').match(/^(\d{4})-(\d{2})-(\d{2})[ ]?(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return 0;
    // 北京时间 -> epoch
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 - 8 * 3600;
  }

  function filterNews(items, relevance) {
    var seen = {}, out = [];
    items.sort(function (a, b) { return b.ts - a.ts; });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.title) continue;
      var key = it.title.slice(0, 40);
      if (seen[key]) continue;
      if (relevance && relevance.length) {
        var hit = false;
        for (var k = 0; k < relevance.length; k++) {
          if (it.title.indexOf(relevance[k]) >= 0) { hit = true; break; }
        }
        if (!hit) continue;
      }
      seen[key] = 1;
      out.push(it);
    }
    return out;
  }

  /* --------------------------------------------------------- 并发限流队列 */
  function pool(items, worker, concurrency, onProgress) {
    return new Promise(function (resolve) {
      var results = new Array(items.length);
      var idx = 0, running = 0, done = 0;
      if (!items.length) return resolve(results);
      function next() {
        if (idx >= items.length && running === 0) return resolve(results);
        while (running < concurrency && idx < items.length) {
          (function (i) {
            running++;
            Promise.resolve(worker(items[i], i)).then(function (v) {
              results[i] = v;
            }).catch(function () {
              results[i] = null;
            }).then(function () {
              running--; done++;
              if (onProgress) onProgress(done, items.length);
              next();
            });
          })(idx++);
        }
      }
      next();
    });
  }

  /* ------------------------------------------------------------ 组装输入 */
  async function buildInput(rules, onProgress) {
    var inst = rules.instruments;
    var fetchCfg = rules.fetch;
    var etfCode = inst.etf.code;
    var watch = rules.watchlist;
    var warnings = [];
    var sources = [];

    function mark(name) { if (sources.indexOf(name) < 0) sources.push(name); }
    function warn(msg) { warnings.push(msg); }

    var snapTasks = quotes([etfCode].concat(watch.map(function (w) { return w.code; })))
      .then(function (s) { mark('腾讯行情'); return s; })
      .catch(function (e) { warn('行情快照失败：' + e.message); return {}; });

    var etfBarsTask = stockKline(etfCode, fetchCfg.etf_days)
      .then(function (b) { mark('腾讯日线'); return b; })
      .catch(function (e) { warn('ETF日线失败：' + e.message); return []; });

    var indexTask = indexKline(inst.index.code, fetchCfg.index_days)
      .then(function (b) { mark('新浪指数日线'); return b; })
      .catch(function (e) { warn('指数日线失败：' + e.message); return []; });

    var benchTask = indexKline(inst.bench.code, fetchCfg.bench_days)
      .then(function (b) { return b; })
      .catch(function () { return []; });

    var futuresTask = futuresKline(inst.futures.symbol)
      .then(function (b) { mark('新浪期货日线'); return b; })
      .catch(function (e) { warn('期货日线失败：' + e.message); return []; });

    var newsTask = Promise.all([newsRoll(3), newsZhibo(8)]).then(function (r) {
      mark('新浪新闻');
      return r[0].concat(r[1]);
    }).catch(function (e) { warn('新闻失败：' + e.message); return []; });

    var snap = await snapTasks;
    var etfBars = await etfBarsTask;

    var stockBars = await pool(watch, function (w) {
      return stockKline(w.code, fetchCfg.stock_days).catch(function () { return []; });
    }, fetchCfg.stock_concurrency, function (done, total) {
      if (onProgress) onProgress(done, total);
    });

    var indexBars = await indexTask;
    var benchBars = await benchTask;
    var futuresBars = await futuresTask;
    var rawNews = await newsTask;

    var stocks = watch.map(function (w, i) {
      var q = snap[w.code] || {};
      return {
        code: w.code, name: w.name,
        price: q.price === undefined ? null : q.price,
        changePct: q.changePct === undefined ? null : q.changePct,
        pe: q.pe === undefined ? null : q.pe,
        marketCap: q.marketCapYi === undefined ? null : q.marketCapYi,
        turnoverPct: q.turnoverPct === undefined ? null : q.turnoverPct,
        bars: stockBars[i] || []
      };
    });

    var news = filterNews(rawNews, rules.fundamental.news.relevance);
    var minNews = rules.fundamental.news.min_samples;
    if (news.length < minNews) {
      warn('浏览器端免费新闻源覆盖有限（新浪关键词搜索接口不支持跨域），静态版新闻情绪常会缺失并被自动归一；'
        + '需要完整情绪样本请本地运行 local/server.py（同一天实测可达 20+ 条相关新闻）。');
    }
    var etfSnap = snap[etfCode] || {};
    var now = Date.now() / 1000;
    var today = new Date();
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    var todayStr = '' + today.getFullYear() + pad(today.getMonth() + 1) + pad(today.getDate());

    var input = {
      etf: {
        code: etfCode, name: inst.etf.name,
        price: etfSnap.price !== undefined ? etfSnap.price : (etfBars.length ? etfBars[etfBars.length - 1].c : null),
        prevClose: etfSnap.prevClose === undefined ? null : etfSnap.prevClose,
        changePct: etfSnap.changePct === undefined ? null : etfSnap.changePct,
        turnoverPct: etfSnap.turnoverPct === undefined ? null : etfSnap.turnoverPct,
        amountWan: etfSnap.amountWan === undefined ? null : etfSnap.amountWan,
        bars: etfBars
      },
      index: { code: inst.index.code, name: inst.index.name, bars: indexBars },
      bench: { code: inst.bench.code, name: inst.bench.name, bars: benchBars },
      futures: {
        symbol: inst.futures.symbol, name: inst.futures.name,
        bars: futuresBars, close: futuresBars.length ? futuresBars[futuresBars.length - 1].c : null,
        realtime: null
      },
      stocks: stocks,
      news: news,
      asOf: now,
      dataWarnings: []
    };

    var top = stocks.slice().sort(function (a, b) { return (b.marketCap || 0) - (a.marketCap || 0); }).slice(0, 10);
    var meta = {
      fetchedAt: now,
      dataDate: etfBars.length ? etfBars[etfBars.length - 1].d : '',
      isIntraday: !!(etfSnap.time && String(etfSnap.time).slice(0, 8) === todayStr),
      sources: sources,
      warnings: warnings,
      futuresSource: 'daily',
      watchlistTop: top.map(function (s) {
        return { code: s.code, name: s.name, changePct: s.changePct, price: s.price };
      }),
      indexLevel: indexBars.length ? indexBars[indexBars.length - 1].c : null,
      benchLevel: benchBars.length ? benchBars[benchBars.length - 1].c : null,
      snapshotCount: Object.keys(snap).length,
      mode: 'static'
    };

    return { input: input, meta: meta };
  }

  global.FEED = {
    quotes: quotes,
    stockKline: stockKline,
    indexKline: indexKline,
    futuresKline: futuresKline,
    newsRoll: newsRoll,
    newsZhibo: newsZhibo,
    filterNews: filterNews,
    buildInput: buildInput,
    parseTencentQuotes: parseTencentQuotes,
    adjustSplits: adjustSplits,
    limitPctOf: limitPctOf,
    parseTs: parseTs,
    pool: pool
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
