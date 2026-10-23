/* 看板前端：本地 Flask 版与 GitHub Pages 静态版共用。
 * 数据来源自动选择：优先 /api/dashboard（本地版），失败则浏览器直连腾讯/新浪（静态版）。
 */
(function () {
  'use strict';

  var state = { rules: null, payload: null, charts: {}, busy: false };
  var COLOR = { up: '#ff5d5d', down: '#22c55e', flat: '#8b98ac', line: '#4f8cff', ma20: '#f59e0b', ma60: '#a78bfa' };
  var STORE_KEY = 'sb_dashboard_settings_v1';

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function fmt(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return Number(x).toFixed(d === undefined ? 2 : d);
  }
  function pctText(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return (x > 0 ? '+' : '') + Number(x).toFixed(d === undefined ? 2 : d) + '%';
  }
  function cls(x) { return x > 0 ? 'up' : (x < 0 ? 'down' : 'flat'); }
  function ts2text(ts) {
    var d = new Date(ts * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ------------------------------------------------------------ 设置存储 */
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSettings(patch) {
    var s = loadSettings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式忽略 */ }
    return s;
  }

  /* ---------------------------------------------------------------- 取数 */
  async function tryLocal(force) {
    try {
      var url = '/api/dashboard' + (force ? '?refresh=1' : '');
      var resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      if (!data || data.error || !data.score) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function chartsFromInput(input, rules, n) {
    var bars = input.etf.bars || [];
    var closes = bars.map(function (b) { return b.c; });
    var ma20 = IND.sma(closes, 20), ma60 = IND.sma(closes, 60);
    var slice = function (arr) { return arr.slice(Math.max(0, arr.length - n)); };
    return {
      etf: slice(bars).map(function (b, i) {
        var idx = bars.length - n + i;
        return { d: b.d, c: b.c, h: b.h, l: b.l, v: b.v, ma20: ma20[idx], ma60: ma60[idx] };
      }),
      etfQuote: {
        price: input.etf.price, changePct: input.etf.changePct,
        turnoverPct: input.etf.turnoverPct, amountWan: input.etf.amountWan
      },
      index: slice(input.index.bars || []).map(function (b) { return { d: b.d, c: b.c }; }),
      futures: (input.futures.bars || []).slice(-(n + 40)).map(function (b) { return { d: b.d, c: b.c }; }),
      futuresRealtime: input.futures.realtime || null,
      stocks: (input.stocks || []).map(function (s) {
        var bars2 = s.bars || [];
        var above = null;
        if (bars2.length >= 20) {
          var cs = bars2.map(function (b) { return b.c; });
          var ma = cs.slice(-20).reduce(function (a, b) { return a + b; }, 0) / 20;
          above = cs[cs.length - 1] >= ma;
        }
        return { code: s.code, name: s.name, price: s.price, changePct: s.changePct,
                 pe: s.pe, marketCap: s.marketCap, aboveMa20: above };
      }),
      news: (input.news || []).slice(0, 15).map(function (it) {
        return { ts: it.ts, title: it.title, url: it.url || '', source: it.source || '' };
      })
    };
  }

  /* 碳酸锂期货的「较昨日」涨跌：实时口径用昨结算价，日线口径用上一交易日收盘价 */
  function futuresQuoteOf(charts) {
    charts = charts || {};
    var rt = charts.futuresRealtime || null;
    var arr = charts.futures || [];
    var last = arr.length ? arr[arr.length - 1] : null;
    var prev = arr.length > 1 ? arr[arr.length - 2] : null;

    if (rt && rt.price !== null && rt.price !== undefined) {
      var useSettle = rt.prevSettle !== null && rt.prevSettle !== undefined;
      var base = useSettle ? rt.prevSettle : rt.prevClose;
      if (base) {
        return {
          price: rt.price, base: base, change: rt.price - base,
          changePct: (rt.price / base - 1) * 100,
          basis: useSettle ? '较昨结算' : '较昨收',
          tag: '实时', date: rt.date || null, isRealtime: true
        };
      }
    }
    if (last && prev && prev.c) {
      return {
        price: last.c, base: prev.c, change: last.c - prev.c,
        changePct: (last.c / prev.c - 1) * 100,
        basis: '较上一交易日收盘', tag: '日线', date: last.d || null, isRealtime: false
      };
    }
    if (last) {
      return { price: last.c, base: null, change: null, changePct: null,
               basis: '', tag: '日线', date: last.d || null, isRealtime: false };
    }
    return { price: null, base: null, change: null, changePct: null, basis: '', tag: '', date: null, isRealtime: false };
  }

  async function loadStatic(force) {
    var cacheKey = 'sb_static_cache_v1';
    var ttl = (state.rules.fetch.cache_ttl_seconds || 900) * 1000;
    if (!force) {
      try {
        var cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.at < ttl) return cached.payload;
      } catch (e) { /* ignore */ }
    }
    setProgress('正在抓取行情…');
    var built = await FEED.buildInput(state.rules, function (done, total) {
      setProgress('个股日线 ' + done + '/' + total);
    });
    setProgress('计算打分…');
    var score = SCORING.scoreDashboard(built.input, state.rules);
    var payload = {
      mode: 'static',
      meta: built.meta,
      score: score,
      config: {},
      charts: chartsFromInput(built.input, state.rules, 120)
    };
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), payload: payload })); } catch (e) { /* 超配额忽略 */ }
    return payload;
  }

  function setProgress(text) {
    var box = $('#loadingBox');
    if (box) box.querySelector('.txt').textContent = text;
  }

  /* ---------------------------------------------------------------- 渲染 */
  function render(payload) {
    state.payload = payload;
    var meta = payload.meta || {};
    var score = payload.score || {};
    var charts = payload.charts || {};

    /* 头部 */
    $('#modeBadge').textContent = payload.mode === 'local' ? '本地版 · 含期货实时价' : 'GitHub Pages 静态版';
    $('#modeBadge').className = 'badge ok';
    var dataBadge = $('#dataBadge');
    dataBadge.textContent = (meta.isIntraday ? '盘中数据 · ' : '收盘数据 · ') + (meta.dataDate || '—');
    dataBadge.className = 'badge ' + (meta.isIntraday ? 'ok' : '');
    $('#fetchedAt').textContent = '抓取于 ' + (meta.fetchedAtIso || ts2text(meta.fetchedAt || Date.now() / 1000));

    /* 信号灯 */
    var lamp = $('#lamp');
    lamp.className = 'lamp ' + (score.label === '偏多' ? 'bull' : (score.label === '偏空' ? 'bear' : (score.label === '数据缺失' ? '' : 'flat')));
    $('#lampLabel').textContent = score.label || '—';
    $('#lampLabel').className = 'lamp-label ' + (score.label === '偏多' ? 'up' : (score.label === '偏空' ? 'down' : 'flat'));
    $('#lampScore').innerHTML = '综合得分 <b class="' + cls(score.total) + '">' + fmt(score.total, 1) + '</b> / ±100　强度 ' + fmt(score.strength, 1);
    var band = $('#lampBand');
    band.textContent = '偏多 ≥ +' + state.rules.signal.bull + '　偏空 ≤ ' + state.rules.signal.bear + '　区间内为中性';

    /* 事实卡 */
    renderFacts(charts, score);

    /* 明细表 */
    renderItems(score);

    /* 图表 */
    drawEtf(charts.etf || []);
    drawScores(score);
    drawFutures(charts.futures || [], charts.futuresRealtime);
    var fHint = document.getElementById('futuresHint');
    if (fHint) {
      var fqHead = futuresQuoteOf(charts);
      fHint.innerHTML = '连续合约 · 元/吨　<b class="' + cls(fqHead.changePct) + '">'
        + (fqHead.change === null ? '—' : (fqHead.change > 0 ? '▲ +' : (fqHead.change < 0 ? '▼ ' : '— ')) + fmt(fqHead.change, 0))
        + '</b>' + (fqHead.changePct === null ? '' : '（' + pctText(fqHead.changePct) + '）');
    }
    drawStocks(charts.stocks || []);

    /* 新闻 */
    renderNews(charts.news || []);

    /* 持仓 */
    renderPosition(charts.etfQuote || {}, payload.config || {});

    /* 提示与页脚 */
    var warnBox = $('#warnBox');
    var msgs = (score.notes || []).slice();
    (meta.warnings || []).forEach(function (w) { msgs.push('数据源：' + w); });
    if (meta.futuresSource === 'daily') msgs.push('期货为日线口径（浏览器无法直连新浪实时报价），盘中用最近收盘价代替，涨跌按上一交易日收盘价计算。');
    warnBox.innerHTML = msgs.length ? msgs.map(function (m) { return '· ' + m; }).join('<br>') : '';
    warnBox.className = 'notice' + (msgs.length ? ' show' : '');
    $('#sources').textContent = (meta.sources || []).join('、') || '—';
    $('#rulesVer').textContent = score.rulesVersion || meta.rulesVersion || '—';
    $('#loading').style.display = 'none';
  }

  function renderFacts(charts, score) {
    var box = $('#facts');
    box.innerHTML = '';
    var q = charts.etfQuote || {};
    var fq = futuresQuoteOf(charts);
    var stocks = charts.stocks || [];
    var above = stocks.filter(function (s) { return s.aboveMa20 === true; }).length;
    var valid = stocks.filter(function (s) { return s.aboveMa20 !== null && s.aboveMa20 !== undefined; }).length;

    var items = [
      { k: 'ETF 最新价', v: fmt(q.price, 3), n: pctText(q.changePct), nc: cls(q.changePct) },
      { k: '碳酸锂（连续）', v: fmt(fq.price, 0),
        n: futuresFactNote(fq),
        nc: cls(fq.changePct),
        tip: fq.base ? ('对比基准 ' + fmt(fq.base, 0) + ' 元/吨（' + fq.basis + '）') : '' },
      { k: '加权 PE(TTM)', v: itemValueOf(score, 'valuation'), n: '板块估值水位' },
      { k: '站上 MA20 广度', v: above + '/' + valid, n: valid ? fmt(above / valid * 100, 0) + '% 个股在均线上' : '样本不足' }
    ];
    items.forEach(function (it) {
      var card = el('div', 'fact');
      card.appendChild(el('div', 'k', it.k));
      var v = el('div', 'v', it.v);
      if (it.nc) v.className = 'v ' + it.nc;
      card.appendChild(v);
      var n = el('div', 'n');
      n.innerHTML = it.n || '';
      if (it.nc) n.className = 'n ' + it.nc + ' with-change';
      card.appendChild(n);
      if (it.tip) card.title = it.tip;
      box.appendChild(card);
    });
  }

  function futuresChangeText(fq) {
    if (fq.change === null || fq.change === undefined) return '暂无对比数据';
    var arrow = fq.change > 0 ? '▲' : (fq.change < 0 ? '▼' : '—');
    return arrow + ' ' + (fq.change > 0 ? '+' : '') + fmt(fq.change, 0) + ' 元/吨（'
      + pctText(fq.changePct) + '）';
  }

  /* 事实卡里的三行说明：单位口径 / 当日涨跌 / 对比基准 */
  function futuresFactNote(fq) {
    var html = '元/吨 · ' + (fq.tag || '—');
    if (fq.change === null || fq.change === undefined) return html + '<br>暂无对比数据';
    html += '<br>' + futuresChangeText(fq);
    if (fq.basis && fq.base !== null && fq.base !== undefined) {
      html += '<br><span class="sub">' + fq.basis + ' ' + fmt(fq.base, 0) + '</span>';
    }
    return html;
  }

  function itemValueOf(score, key) {
    var groups = score.components || [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) {
        if (groups[i].items[j].key === key) return groups[i].items[j].value;
      }
    }
    return '—';
  }

  function renderItems(score) {
    var tbody = $('#itemBody');
    tbody.innerHTML = '';
    (score.components || []).forEach(function (g) {
      var tr = el('tr', 'dim-row');
      tr.appendChild(el('td', null, g.label + '（权重 ' + g.weight + '）'));
      tr.appendChild(el('td', 'score ' + cls(g.score), fmt(g.score, 1) + ' / ' + fmt(g.max, 0)));
      tr.appendChild(el('td', null, fmt(g.ratio, 0) + '% 得分率'));
      tr.appendChild(el('td', 'reason', ''));
      tbody.appendChild(tr);
      g.items.forEach(function (it) {
        var row = el('tr');
        row.appendChild(el('td', null, it.label));
        var sc = el('td', 'score ' + cls(it.score), fmt(it.score, 1) + ' / ' + fmt(it.max, 0));
        if (it.missing) sc.appendChild(el('span', 'tag-missing', '缺失'));
        row.appendChild(sc);
        row.appendChild(el('td', null, it.value));
        row.appendChild(el('td', 'reason', it.reason));
        tbody.appendChild(row);
      });
    });
  }

  function renderNews(news) {
    var ul = $('#newsList');
    ul.innerHTML = '';
    if (!news.length) {
      ul.appendChild(el('li', 'flat', '近 48 小时未抓到相关新闻（或新闻源暂时不可用）。'));
      return;
    }
    news.forEach(function (n) {
      var li = el('li');
      var a = el('a', null, n.title);
      a.href = n.url || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
      li.appendChild(el('span', 'meta', ts2text(n.ts) + (n.source ? ' · ' + n.source : '')));
      ul.appendChild(li);
    });
  }

  function renderPosition(quote, cfg) {
    var settings = loadSettings();
    var cost = settings.costPrice !== undefined ? settings.costPrice : cfg.costPrice;
    var input = $('#costPrice');
    if (cost && !input.value) input.value = cost;
    var price = quote.price;
    updatePL(price);

    function onChange() {
      var v = parseFloat(input.value);
      saveSettings({ costPrice: isFinite(v) ? v : null });
      updatePL(price);
      if (state.payload && state.payload.mode === 'local') {
        fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ costPrice: isFinite(v) ? v : null })
        }).catch(function () { /* 忽略 */ });
      }
    }
    input.onchange = onChange;
    input.oninput = function () { updatePL(price); };
  }

  function updatePL(price) {
    var input = $('#costPrice');
    var cost = parseFloat(input.value);
    var plBox = $('#plBox'), note = $('#plNote');
    if (!isFinite(cost) || cost <= 0 || !isFinite(price) || price === null) {
      plBox.textContent = '—';
      plBox.className = 'pl flat';
      note.textContent = '填入你的持仓成本价，即可看到浮动盈亏（只存在本机浏览器）。';
      return;
    }
    var ret = (price / cost - 1) * 100;
    plBox.textContent = pctText(ret);
    plBox.className = 'pl ' + cls(ret);
    note.textContent = '成本 ' + fmt(cost, 3) + ' → 现价 ' + fmt(price, 3) + '，' +
      (ret >= 0 ? '每份浮盈 ' : '每份浮亏 ') + fmt(Math.abs(price - cost), 3) + ' 元';
  }

  /* ---------------------------------------------------------------- 图表 */
  function chartOf(id) {
    var dom = document.getElementById(id);
    if (!dom) return null;
    if (!state.charts[id]) state.charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    return state.charts[id];
  }

  var AXIS_COMMON = {
    axisLine: { lineStyle: { color: '#2a3444' } },
    axisLabel: { color: '#8b98ac', fontSize: 10.5 },
    splitLine: { lineStyle: { color: '#1c2431' } }
  };

  function drawEtf(bars) {
    var chart = chartOf('etfChart');
    if (!chart) return;
    var dates = bars.map(function (b) { return b.d; });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#101722', borderColor: '#2a3444',
        textStyle: { color: '#e6edf6', fontSize: 11.5 } },
      legend: { data: ['收盘', 'MA20', 'MA60'], top: 0, textStyle: { color: '#8b98ac', fontSize: 11 } },
      grid: [{ left: 52, right: 16, top: 30, height: '56%' }, { left: 52, right: 16, top: '74%', height: '16%' }],
      xAxis: [
        { type: 'category', data: dates, ...AXIS_COMMON, axisLabel: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, ...AXIS_COMMON, axisLabel: { show: false } }
      ],
      yAxis: [
        { scale: true, ...AXIS_COMMON },
        { gridIndex: 1, ...AXIS_COMMON, axisLabel: { show: false }, splitLine: { show: false } }
      ],
      series: [
        { name: '收盘', type: 'line', data: bars.map(function (b) { return b.c; }), showSymbol: false,
          lineStyle: { width: 1.8, color: COLOR.line }, itemStyle: { color: COLOR.line } },
        { name: 'MA20', type: 'line', data: bars.map(function (b) { return b.ma20; }), showSymbol: false,
          lineStyle: { width: 1.2, color: COLOR.ma20 }, itemStyle: { color: COLOR.ma20 } },
        { name: 'MA60', type: 'line', data: bars.map(function (b) { return b.ma60; }), showSymbol: false,
          lineStyle: { width: 1.2, color: COLOR.ma60 }, itemStyle: { color: COLOR.ma60 } },
        { name: '成交额', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: bars.map(function (b) { return b.v; }),
          itemStyle: { color: '#2f4a6d' } }
      ]
    }, true);
  }

  function drawScores(score) {
    var chart = chartOf('scoreChart');
    if (!chart) return;
    var names = [], values = [], colors = [];
    (score.components || []).forEach(function (g) {
      g.items.forEach(function (it) {
        names.push(it.label.replace(/（.*?）/g, ''));
        values.push(it.score);
        colors.push(it.score > 0 ? COLOR.up : (it.score < 0 ? COLOR.down : COLOR.flat));
      });
    });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: '#101722', borderColor: '#2a3444', textStyle: { color: '#e6edf6', fontSize: 11.5 } },
      grid: { left: 116, right: 34, top: 12, bottom: 18 },
      xAxis: { type: 'value', ...AXIS_COMMON },
      yAxis: { type: 'category', data: names.reverse(), ...AXIS_COMMON, inverse: true },
      series: [{
        type: 'bar', data: values.reverse().map(function (v, i) {
          return { value: v, itemStyle: { color: colors[colors.length - 1 - i], borderRadius: 3 } };
        }),
        label: { show: true, position: 'right', color: '#aeb9c9', fontSize: 10.5,
          formatter: function (p) { return (p.value > 0 ? '+' : '') + p.value; } },
        barWidth: '55%'
      }]
    }, true);
  }

  function drawFutures(bars, realtime) {
    var chart = chartOf('futuresChart');
    if (!chart) return;
    var closes = bars.map(function (b) { return b.c; });
    var ma20 = IND.sma(closes, 20);
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#101722', borderColor: '#2a3444',
        textStyle: { color: '#e6edf6', fontSize: 11.5 } },
      legend: { data: ['碳酸锂连续', 'MA20'], top: 0, textStyle: { color: '#8b98ac', fontSize: 11 } },
      grid: { left: 62, right: 18, top: 30, bottom: 26 },
      xAxis: { type: 'category', data: bars.map(function (b) { return b.d; }), ...AXIS_COMMON,
        axisLabel: { show: true, color: '#8b98ac', fontSize: 10, interval: Math.max(0, Math.floor(bars.length / 5)) } },
      yAxis: { scale: true, ...AXIS_COMMON, axisLabel: { color: '#8b98ac', fontSize: 10.5,
        formatter: function (v) { return (v / 1000).toFixed(0) + 'k'; } } },
      series: [
        { name: '碳酸锂连续', type: 'line', data: closes, showSymbol: false,
          lineStyle: { width: 1.8, color: '#eab308' }, itemStyle: { color: '#eab308' },
          areaStyle: { color: 'rgba(234,179,8,.10)' } },
        { name: 'MA20', type: 'line', data: ma20, showSymbol: false,
          lineStyle: { width: 1.1, color: '#f472b6' }, itemStyle: { color: '#f472b6' } }
      ]
    }, true);
  }

  function drawStocks(stocks) {
    var chart = chartOf('stocksChart');
    if (!chart) return;
    var sorted = stocks.slice().sort(function (a, b) { return (a.changePct || 0) - (b.changePct || 0); });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: '#101722', borderColor: '#2a3444', textStyle: { color: '#e6edf6', fontSize: 11.5 },
        formatter: function (ps) {
          var p = ps[0];
          return p.name + '：' + (p.value > 0 ? '+' : '') + p.value + '%';
        } },
      grid: { left: 74, right: 40, top: 8, bottom: 18 },
      xAxis: { type: 'value', ...AXIS_COMMON },
      yAxis: { type: 'category', data: sorted.map(function (s) { return s.name; }), ...AXIS_COMMON },
      series: [{
        type: 'bar', barWidth: '62%',
        data: sorted.map(function (s) {
          return { value: s.changePct === null || s.changePct === undefined ? 0 : s.changePct,
            itemStyle: { color: (s.changePct || 0) >= 0 ? COLOR.up : COLOR.down, borderRadius: 2 } };
        }),
        label: { show: true, position: 'right', color: '#aeb9c9', fontSize: 10,
          formatter: function (p) { return (p.value > 0 ? '+' : '') + p.value + '%'; } }
      }]
    }, true);
  }

  /* ---------------------------------------------------------------- 交互 */
  async function refresh(force) {
    if (state.busy) return;
    state.busy = true;
    $('#loading').style.display = 'flex';
    $('#refreshBtn').disabled = true;
    try {
      var payload = await tryLocal(force);
      if (!payload) payload = await loadStatic(force);
      render(payload);
    } catch (e) {
      $('#loading').style.display = 'none';
      var box = $('#warnBox');
      box.className = 'notice show';
      box.innerHTML = '加载失败：' + (e && e.message ? e.message : e) + '<br>请检查网络，或稍后点击「强制刷新」。';
    } finally {
      state.busy = false;
      $('#refreshBtn').disabled = false;
      $('#loading').style.display = 'none';
    }
  }

  async function init() {
    try {
      var resp = await fetch('shared/scoring_rules.json', { cache: 'no-store' });
      state.rules = await resp.json();
    } catch (e) {
      document.getElementById('warnBox').className = 'notice show';
      document.getElementById('warnBox').textContent = '规则文件 shared/scoring_rules.json 加载失败：' + e.message;
      return;
    }
    $('#thresholds').textContent = '偏多 ≥ +' + state.rules.signal.bull + '｜偏空 ≤ ' + state.rules.signal.bear;
    await refresh(false);
    window.addEventListener('resize', function () {
      Object.keys(state.charts).forEach(function (k) { state.charts[k].resize(); });
    });
    $('#refreshBtn').onclick = function () { refresh(true); };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { futuresQuoteOf: futuresQuoteOf, futuresChangeText: futuresChangeText, futuresFactNote: futuresFactNote };
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
