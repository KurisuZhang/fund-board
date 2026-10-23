/* 历史验证页：本地版走 /api/backtest，GitHub Pages 静止版在浏览器内计算。
 * 口径与 local/backtest.py 一致：只用历史可得的因子（期货/量能/技术）。
 */
(function () {
  'use strict';

  var state = { rules: null, hold: 5, busy: false };

  function $(s) { return document.querySelector(s); }
  function fmt(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return Number(x).toFixed(d === undefined ? 2 : d);
  }
  function pctText(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return (x > 0 ? '+' : '') + Number(x).toFixed(d === undefined ? 2 : d) + '%';
  }
  function cls(x) { return x > 0 ? 'up' : (x < 0 ? 'down' : 'flat'); }

  /* ------------------------------------------------------------ 回测算法 */
  function barsUntil(bars, date) {
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].d <= date) out.push(bars[i]); else break;
    }
    return out;
  }

  function benchAt(benchBars, date) {
    var best = null;
    for (var i = 0; i < benchBars.length; i++) {
      if (benchBars[i].d <= date) best = benchBars[i].c; else break;
    }
    return best;
  }

  function avg(list) {
    var vals = list.filter(function (v) { return v !== null && v !== undefined && isFinite(v); });
    if (!vals.length) return 0;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }

  function runBacktest(etfBars, futuresBars, benchBars, rules, hold) {
    hold = Math.max(1, Math.min(hold | 0, 20));
    var bull = rules.signal.bull;
    var warmup = 65;
    var events = [];
    var prevBull = null;
    var maxI = etfBars.length - 1;

    for (var i = warmup; i <= maxI; i++) {
      var date = etfBars[i].d;
      var subEtf = etfBars.slice(0, i + 1);
      var subFut = barsUntil(futuresBars, date);
      if (subFut.length < 65) continue;
      var inp = {
        etf: { bars: subEtf, price: subEtf[subEtf.length - 1].c },
        futures: { bars: subFut, close: subFut[subFut.length - 1].c },
        stocks: [], news: [], asOf: 0, index: { bars: [] }, bench: { bars: [] }
      };
      var out = SCORING.scoreDashboard(inp, rules);
      var isBull = out.total >= bull;
      if (prevBull === null) { prevBull = isBull; continue; }
      if (isBull && !prevBull) {
        var entryPrice = etfBars[i].c;
        var exitIdx = Math.min(i + hold, maxI);
        var exitPrice = etfBars[exitIdx].c;
        var fwd = null, excess = null;
        if (exitIdx > i) {
          fwd = (exitPrice / entryPrice - 1) * 100;
          var bEntry = benchAt(benchBars, date);
          var bExit = benchAt(benchBars, etfBars[exitIdx].d);
          if (bEntry && bExit) excess = fwd - (bExit / bEntry - 1) * 100;
        }
        events.push({
          date: date, score: out.total, entry: entryPrice,
          exitDate: etfBars[exitIdx].d, exit: exitPrice,
          fwd: fwd === null ? null : Math.round(fwd * 100) / 100,
          excess: excess === null ? null : Math.round(excess * 100) / 100
        });
      }
      prevBull = isBull;
    }

    var closed = events.filter(function (e) { return e.fwd !== null; });
    var wins = closed.filter(function (e) { return e.fwd > 0; });
    var sorted = closed.map(function (e) { return e.fwd; }).sort(function (a, b) { return a - b; });
    var stats = {
      hold: hold,
      signalCount: events.length,
      closedCount: closed.length,
      winRate: closed.length ? Math.round(wins.length / closed.length * 1000) / 10 : null,
      avgReturn: closed.length ? Math.round(avg(closed.map(function (e) { return e.fwd; })) * 100) / 100 : null,
      medianReturn: closed.length ? sorted[Math.floor(closed.length / 2)] : null,
      avgExcess: closed.length ? Math.round(avg(closed.map(function (e) { return e.excess; })) * 100) / 100 : null,
      best: sorted.length ? sorted[sorted.length - 1] : null,
      worst: sorted.length ? sorted[0] : null,
      sampleEnough: closed.length >= 20
    };

    return { stats: stats, events: events,
             equity: strategyEquity(etfBars, closed, hold, warmup),
             buyhold: buyholdEquity(etfBars, warmup) };
  }

  function buyholdEquity(etfBars, start) {
    var base = etfBars[start].c;
    return etfBars.slice(start).map(function (b) {
      return { d: b.d, v: Math.round((b.c / base - 1) * 10000) / 100 };
    });
  }

  function strategyEquity(etfBars, events, hold, start) {
    /* 信号择时净值：只在信号持有期内满仓 ETF，其余空仓，逐日复利（与买入持有同坐标系） */
    var idxByDate = {};
    for (var i = 0; i < etfBars.length; i++) idxByDate[etfBars[i].d] = i;
    var n = etfBars.length;
    var active = new Array(n);
    for (var a = 0; a < n; a++) active[a] = 0;
    events.forEach(function (ev) {
      var ei = idxByDate[ev.date];
      if (ei === undefined) return;
      var last = Math.min(ei + hold, n - 1);
      for (var k = ei; k <= last; k++) active[k] = 1;
    });

    var curve = 1, out = [];
    for (var i2 = start; i2 < n; i2++) {
      if (active[i2] && i2 > 0 && etfBars[i2 - 1].c) {
        curve *= etfBars[i2].c / etfBars[i2 - 1].c;
      }
      out.push({ d: etfBars[i2].d, v: Math.round((curve - 1) * 10000) / 100, active: active[i2] });
    }
    return out;
  }

  /* ---------------------------------------------------------------- 取数 */
  async function fetchLocal(hold) {
    try {
      var resp = await fetch('/api/backtest?hold=' + hold, { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      if (!data || data.error || !data.stats) return null;
      return data;
    } catch (e) { return null; }
  }

  async function fetchStatic(hold) {
    setStatus('正在抓取历史日线…');
    var inst = state.rules.instruments;
    var etf = await FEED.stockKline(inst.etf.code, 500);
    var futures = await FEED.futuresKline(inst.futures.symbol);
    var bench = await FEED.indexKline(inst.bench.code, 500);
    setStatus('逐日计算信号（约需数秒）…');
    await new Promise(function (r) { setTimeout(r, 30); });
    var res = runBacktest(etf, futures, bench, state.rules, hold);
    res.warnings = ['静态版在浏览器内自行计算，期货为日线口径'];
    return res;
  }

  function setStatus(text) {
    var box = $('#status');
    if (box) { box.textContent = text; box.style.display = 'block'; }
  }

  /* ---------------------------------------------------------------- 渲染 */
  function render(data) {
    $('#status').style.display = 'none';
    var s = data.stats;
    var cards = [
      { k: '信号次数', v: s.signalCount, n: '得分翻至 ≥ +' + state.rules.signal.bull + ' 的次数' },
      { k: '胜率', v: s.winRate === null ? '—' : fmt(s.winRate, 1) + '%', n: '持有 ' + s.hold + ' 日后为正的比例', c: s.winRate >= 50 ? 'up' : 'down' },
      { k: '平均收益', v: pctText(s.avgReturn), n: '中位数 ' + pctText(s.medianReturn), c: cls(s.avgReturn) },
      { k: '平均超额', v: pctText(s.avgExcess), n: '相对沪深300', c: cls(s.avgExcess) },
      { k: '最好 / 最差', v: pctText(s.best) + ' / ' + pctText(s.worst), n: '单次持有区间' }
    ];
    var box = $('#statCards');
    box.innerHTML = '';
    cards.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'fact';
      d.innerHTML = '<div class="k">' + c.k + '</div><div class="v ' + (c.c || '') + '">' + c.v + '</div><div class="n">' + (c.n || '') + '</div>';
      box.appendChild(d);
    });

    var tip = $('#sampleTip');
    tip.style.display = s.sampleEnough ? 'none' : 'block';
    tip.textContent = '样本仅 ' + s.closedCount + ' 次（< 20），统计意义有限，请勿据此下结论。';

    drawCurve(data);

    var tbody = $('#eventBody');
    tbody.innerHTML = '';
    data.events.slice().reverse().forEach(function (e) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + e.date + '</td>'
        + '<td class="score">' + fmt(e.score, 1) + '</td>'
        + '<td>' + fmt(e.entry, 3) + ' → ' + fmt(e.exit, 3) + '</td>'
        + '<td class="score ' + cls(e.fwd) + '">' + pctText(e.fwd) + '</td>'
        + '<td class="score ' + cls(e.excess) + '">' + pctText(e.excess) + '</td>'
        + '<td>' + e.exitDate + '</td>';
      tbody.appendChild(tr);
    });

    var warn = (data.warnings || []).join('；');
    $('#btWarn').textContent = warn ? '数据提示：' + warn : '';
  }

  function drawCurve(data) {
    var dom = document.getElementById('curveChart');
    if (!dom || !window.echarts) return;
    if (!state.chart) state.chart = echarts.init(dom, null, { renderer: 'canvas' });
    var dates = data.equity.map(function (p) { return p.d; });
    state.chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#101722', borderColor: '#2a3444',
        textStyle: { color: '#e6edf6', fontSize: 11.5 } },
      legend: { data: ['信号择时净值', '买入持有'], top: 0, textStyle: { color: '#8b98ac', fontSize: 11 } },
      grid: { left: 56, right: 20, top: 32, bottom: 26 },
      xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#2a3444' } },
        axisLabel: { color: '#8b98ac', fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 6)) } },
      yAxis: { type: 'value', axisLine: { lineStyle: { color: '#2a3444' } },
        axisLabel: { color: '#8b98ac', fontSize: 10.5, formatter: '{value}%' },
        splitLine: { lineStyle: { color: '#1c2431' } } },
      series: [
        { name: '信号择时净值', type: 'line', showSymbol: false,
          data: data.equity.map(function (p) { return p.v; }),
          lineStyle: { width: 1.8, color: '#4f8cff' }, itemStyle: { color: '#4f8cff' } },
        { name: '买入持有', type: 'line', showSymbol: false,
          data: data.buyhold.map(function (p) { return p.v; }),
          lineStyle: { width: 1.2, color: '#8b98ac', type: 'dashed' }, itemStyle: { color: '#8b98ac' } }
      ]
    }, true);
  }

  async function load() {
    if (state.busy) return;
    state.busy = true;
    setStatus('加载中…');
    try {
      var data = await fetchLocal(state.hold);
      if (!data) data = await fetchStatic(state.hold);
      render(data);
    } catch (e) {
      setStatus('回测失败：' + (e && e.message ? e.message : e));
    } finally {
      state.busy = false;
    }
  }

  async function init() {
    var resp = await fetch('shared/scoring_rules.json', { cache: 'no-store' });
    state.rules = await resp.json();
    document.querySelectorAll('.hold-btn').forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll('.hold-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.hold = parseInt(btn.dataset.hold, 10);
        load();
      };
    });
    window.addEventListener('resize', function () { if (state.chart) state.chart.resize(); });
    await load();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { runBacktest: runBacktest, strategyEquity: strategyEquity };
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
