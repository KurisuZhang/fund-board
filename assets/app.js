/* 看板编排：取数 → 打分 → 渲染（结论区 / 图表 / 明细 / 持仓 / 新闻） */
(function () {
  'use strict';

  var state = {
    rules: null, payload: null, summary: null, busy: false, firstPaint: true,
    costPrice: null, quotePrice: null
  };

  var SETTINGS_KEY = 'sb_dashboard_settings_v1';
  var CACHE_KEY = 'sb_static_cache_v1';

  /* --------------------------------------------------------------- 工具 */
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
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
    if (!ts) return '';
    var d = new Date(ts * 1000);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveSettings(patch) {
    var cur = loadSettings();
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cur)); } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------- 结论区计算 */
  /* 一句话结论：纯机械模板，不写主观判断 */
  function narrativeOf(score) {
    var comps = score.components || [];
    if (!comps.length) return '暂无可用于判断的数据。';
    var words = function (g) {
      var ratio = g.max ? Math.abs(g.score) / g.max * 100 : 0;
      var strong = ratio >= 55, mild = ratio >= 22;
      if (g.score > 0) return strong ? '偏强' : (mild ? '略强' : '持平');
      if (g.score < 0) return strong ? '偏弱' : (mild ? '略弱' : '持平');
      return '持平';
    };
    var dims = comps.map(function (g) {
      return g.label + ' ' + fmt(g.score, 0) + '/' + fmt(g.max, 0) + ' ' + words(g);
    }).join('、');

    var weakest = null, strongest = null;
    comps.forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if (it.missing) return;
        if (!weakest || it.score < weakest.score) weakest = it;
        if (!strongest || it.score > strongest.score) strongest = it;
      });
    });

    var tail = '';
    if (weakest && weakest.score < 0) {
      tail = '；最拖后腿的是「' + shortLabel(weakest.label) + '」' + fmt(weakest.score, 0) + ' 分';
    }
    if (strongest && strongest.score > 0) {
      tail += (tail ? '，' : '；') + '支撑来自「' + shortLabel(strongest.label) + '」+' + fmt(strongest.score, 0) + ' 分';
    }
    if ((score.missing || []).length) {
      tail += '（' + score.missing.join('、') + ' 数据缺失，已按权重归一）';
    }
    var head = score.total >= 25 ? '短线偏多' : (score.total <= -25 ? '短线偏空' : '短线纠结、方向不明');
    return head + '：' + dims + tail + '。';
  }

  function shortLabel(label) { return String(label || '').replace(/（.*?）/g, ''); }

  /* 多空力量：按子项满分加权 */
  function bullBear(score) {
    var bull = 0, bear = 0, contributors = [];
    (score.components || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if ({}.hasOwnProperty.call(it, 'missing') && it.missing) return;
        if (it.score > 0) bull += it.score;
        if (it.score < 0) bear += -it.score;
        if (Math.abs(it.score) >= 4) {
          contributors.push({ label: shortLabel(it.label), score: it.score });
        }
      });
    });
    contributors.sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); });
    return { bull: Math.round(bull * 10) / 10, bear: Math.round(bear * 10) / 10, top: contributors.slice(0, 3) };
  }

  /* 关键价位：什么情况下结论会翻转 */
  function keyLevels(charts, score, rules) {
    var out = [];
    var fund = (rules && rules.fundamental) || {};

    var etf = (charts.etf || []);
    var last = etf.length ? etf[etf.length - 1] : null;
    if (last && last.ma20 && last.c) {
      var gap = (last.ma20 / last.c - 1) * 100;
      out.push({
        label: gap >= 0 ? '收复 MA20 还需' : '跌破 MA20 幅度',
        value: pctText(Math.abs(gap), 1),
        note: 'MA20 ' + fmt(last.ma20, 3),
        tone: gap >= 0 ? 'up' : 'down'
      });
    }

    var breadth = null;
    (score.components || []).forEach(function (g) {
      (g.items || []).forEach(function (it) { if (it.key === 'breadth') breadth = it; });
    });
    if (breadth && breadth.value) {
      var m = String(breadth.value).match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        var above = parseInt(m[1], 10), total = parseInt(m[2], 10);
        var need = Math.max(0, Math.ceil(total * 0.5) - above);
        out.push({
          label: '广度回到 50%',
          value: need > 0 ? '+' + need + ' 只翻红' : '已达标',
          note: above + '/' + total + ' 在均线上',
          tone: need > 0 ? 'down' : 'up'
        });
      }
    }

    var bull = (rules && rules.signal && rules.signal.bull) || 25;
    var toNeutral = bull - (score.total || 0);
    out.push({
      label: '综合分转为偏多',
      value: toNeutral > 0 ? '+' + fmt(toNeutral, 1) + ' 分' : '已触发',
      note: '阈值 +' + bull,
      tone: toNeutral > 0 ? 'flat' : 'up'
    });

    var fb = charts.futures || [];
    if (fb.length >= 20) {
      var closes = fb.map(function (b) { return b.c; });
      var ma = window.IND ? IND.sma(closes, 20) : null;
      var maLast = ma && ma[ma.length - 1];
      var price = closes[closes.length - 1];
      if (maLast && price) {
        var fgap = (maLast / price - 1) * 100;
        out.push({
          label: '碳酸锂回到 MA20',
          value: fgap >= 0 ? pctText(Math.abs(fgap), 1) : '已在均线上方',
          note: 'MA20 ' + fmt(maLast, 0) + ' 元/吨',
          tone: fgap >= 0 ? 'up' : 'flat'
        });
      }
    }
    return out;
  }

  /* 历史同类情形的胜率 */
  function winRateOf(score, summary) {
    if (!summary || !summary.buckets || !summary.buckets.length) return null;
    var width = summary.bucketWidth || 10;
    var total = score.total || 0;
    var key = Math.floor(total / width) * width;
    var hit = null;
    summary.buckets.forEach(function (b) { if (b.bucket === key) hit = b; });
    if (!hit) return { empty: true, bucket: key, label: bucketLabel(key, width), summary: summary };
    return {
      bucket: key, label: hit.label || bucketLabel(key, width),
      samples: hit.samples, winRate: hit.winRate, avgReturn: hit.avgReturn,
      medianReturn: hit.medianReturn, hold: summary.hold || 5,
      enough: hit.samples >= (summary.minSamples || 8), summary: summary
    };
  }
  function bucketLabel(bucket, width) {
    return bucketRange(bucket, width);
  }
  function bucketRange(bucket, width) {
    return bucket + '~' + (bucket + width);
  }

  /* ---------------------------------------------------------- 数据加载 */
  async function tryLocal(force) {
    try {
      var url = '/api/dashboard' + (force ? '?refresh=1' : '');
      var resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      if (!data || data.error || !data.score) return null;
      return data;
    } catch (e) { return null; }
  }

  function chartsFromInput(input, rules, n) {
    var bars = input.etf.bars || [];
    var closes = bars.map(function (b) { return b.c; });
    var ma20 = IND.sma(closes, 20), ma60 = IND.sma(closes, 60);
    var slice = function (arr) { return arr.slice(Math.max(0, arr.length - n)); };
    return {
      etf: slice(bars).map(function (b, i) {
        var idx = bars.length - n + i;
        return { d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ma20: ma20[idx], ma60: ma60[idx] };
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

  async function loadStatic(force) {
    var ttl = ((state.rules.fetch && state.rules.fetch.cache_ttl_seconds) || 900) * 1000;
    if (!force) {
      try {
        var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
        if (cached && Date.now() - cached.at < ttl) return cached.payload;
      } catch (e) { /* 忽略 */ }
    }
    setProgress('正在抓取行情…');
    var built = await FEED.buildInput(state.rules, function (done, total) {
      setProgress('个股日线 ' + done + '/' + total);
    });
    setProgress('计算打分…');
    var score = SCORING.scoreDashboard(built.input, state.rules);
    var payload = {
      mode: 'static', meta: built.meta, score: score, config: {},
      charts: chartsFromInput(built.input, state.rules, 120)
    };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), payload: payload })); } catch (e) { /* 配额 */ }
    return payload;
  }

  /* 历史统计快照：本地版优先用后端现算，静态版读随仓库发布的 JSON */
  async function loadSummary() {
    try {
      var resp = await fetch('/api/summary', { cache: 'no-store' });
      if (resp.ok) {
        var live = await resp.json();
        if (live && live.buckets && live.buckets.length) return live;
      }
    } catch (e) { /* 静态模式下没有后端 */ }
    try {
      var r2 = await fetch('assets/fixtures/backtest_summary.json', { cache: 'no-store' });
      if (r2.ok) return await r2.json();
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function setProgress(text) {
    var box = $('#skeleton');
    if (!box) return;
    var line = box.querySelector('.sk-progress');
    if (line) line.textContent = text;
  }

  /* ---------------------------------------------------------------- 渲染 */
  function render(payload) {
    state.payload = payload;
    var meta = payload.meta || {};
    var score = payload.score || {};
    var charts = payload.charts || {};

    $('#modeBadge').textContent = payload.mode === 'local' ? '本地版 · 含期货实时价' : 'GitHub Pages 静态版';
    $('#modeBadge').className = 'badge ok';
    var dataBadge = $('#dataBadge');
    dataBadge.textContent = (meta.isIntraday ? '盘中 · ' : '收盘 · ') + dataDateText(meta);
    dataBadge.title = meta.isIntraday
      ? '盘中报价抓取于 ' + (meta.fetchedAtIso || '刚刚') + '；日线仍昨日收盘'
      : '日线收盘数据';
    dataBadge.className = 'badge ' + (meta.isIntraday ? 'live' : '');
    $('#fetchedAt').textContent = '抓取于 ' + (meta.fetchedAtIso || ts2text(meta.fetchedAt || Date.now() / 1000));

    renderDial(score);
    renderVerdict(score);
    renderFacts(charts, score);
    renderChips(charts, score);
    renderWinRate(score);
    renderItems(score);
    renderHeat(charts.stocks || []);
    renderNews(charts.news || []);
    renderPosition(charts.etfQuote || {}, payload.config || {});
    renderWarnings(meta, score);

    $('#sources').textContent = (meta.sources || []).join('、') || '—';
    $('#rulesVer').textContent = score.rulesVersion || meta.rulesVersion || '—';
    $('#thresholds').textContent = '偏多 ≥ +' + state.rules.signal.bull + '，偏空 ≤ ' + state.rules.signal.bear;

    var sk = $('#skeleton');
    var content = $('#content');
    if (sk) sk.hidden = true;
    if (content && content.hidden) content.hidden = false;

    /* 容器可见后再初始化图表，否则 ECharts 会拿到 0 尺寸 */
    CHARTS.render(payload, {
      signalDates: (state.summary && state.summary.signalDates) || [],
      costPrice: currentCost(charts)
    });
    requestAnimationFrame(function () { CHARTS.resize(); });

    if (state.firstPaint && window.MOTION) {
      MOTION.staggerIn(content.querySelectorAll('.card, .chips .chip'), { stagger: 40 });
    }
    state.firstPaint = false;
  }

  /* 数据日期：盘中用抓取当天（日线还没更新到今日），收盘用最后一根日线 */
  function renderDial(score) {
    var total = score.total || 0;
    var bands = $('#dialBands');
    if (bands && !bands.dataset.done) {
      var segs = [[-100, -25, 'bear'], [-25, 25, 'flat'], [25, 100, 'bull']];
      segs.forEach(function (s) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', arcPath(s[0], s[1]));
        p.setAttribute('class', 'dial-band ' + s[2]);
        bands.appendChild(p);
      });
      bands.dataset.done = '1';
    }
    var needle = $('#dialNeedle');
    if (needle) {
      needle.style.transform = 'rotate(0deg)';
      var target = total * 0.9;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { needle.style.transform = 'rotate(' + target + 'deg)'; });
      });
    }
    var label = $('#dialLabel');
    if (label) {
      label.textContent = score.label || '—';
      label.className = 'dial-label ' + cls(score.total >= 25 ? 1 : (score.total <= -25 ? -1 : 0));
    }
    var band = $('#dialBand');
    if (band) band.textContent = '中性区间 ±' + state.rules.signal.bull;

    var scoreEl = $('#dialScore');
    if (scoreEl && window.MOTION) {
      MOTION.countUp(scoreEl, 0, total, {
        digits: 1, duration: 700,
        format: function (v) { return (v > 0 ? '+' : '') + v.toFixed(1); }
      });
    } else if (scoreEl) {
      scoreEl.textContent = (total > 0 ? '+' : '') + total.toFixed(1);
    }
    scoreEl.className = cls(total);
  }

  function dataDateText(meta) {
    meta = meta || {};
    if (meta.isIntraday) {
      var iso = meta.fetchedAtIso || '';
      if (iso.length >= 10) return iso.slice(0, 10);
    }
    return meta.dataDate || '—';
  }

  function arcPath(from, to) {
    var theta = function (s) { return 180 - (s + 100) * 0.9; };
    var pt = function (deg) {
      var rad = deg * Math.PI / 180;
      return [100 + 85 * Math.cos(rad), 105 - 85 * Math.sin(rad)];
    };
    var a = pt(theta(from)), b = pt(theta(to));
    return 'M' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
      'A85 85 0 0 1 ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2);
  }

  function renderVerdict(score) {
    var text = $('#narrative');
    if (text) text.textContent = narrativeOf(score);

    var bb = bullBear(score);
    var total = bb.bull + bb.bear || 1;
    var bullPct = bb.bull / total * 100;
    var bullBar = $('#bullBar'), bearBar = $('#bearBar');
    if (bullBar) bullBar.style.width = bullPct.toFixed(1) + '%';
    if (bearBar) bearBar.style.width = (100 - bullPct).toFixed(1) + '%';
    var bv = $('#bullVal'), ev = $('#bearVal');
    if (bv && window.MOTION) {
      MOTION.countUp(bv, 0, bb.bull, { digits: 1, duration: 600, format: function (v) { return v.toFixed(1); } });
    } else if (bv) { bv.textContent = bb.bull.toFixed(1); }
    if (ev && window.MOTION) {
      MOTION.countUp(ev, 0, bb.bear, { digits: 1, duration: 600, format: function (v) { return v.toFixed(1); } });
    } else if (ev) { ev.textContent = bb.bear.toFixed(1); }
    var strength = $('.strength');
    if (strength && bb.top.length) {
      strength.title = '贡献最大：' + bb.top.map(function (c) {
        return c.label + ' ' + (c.score > 0 ? '+' : '') + fmt(c.score, 0);
      }).join('、');
    }
  }

  function renderFacts(charts, score) {
    var box = $('#facts');
    if (!box) return;
    box.innerHTML = '';
    var q = charts.etfQuote || {};
    var fq = futuresQuoteOf(charts);
    var stocks = charts.stocks || [];
    var above = stocks.filter(function (s) { return s.aboveMa20 === true; }).length;
    var valid = stocks.filter(function (s) { return s.aboveMa20 !== null && s.aboveMa20 !== undefined; }).length;

    var items = [
      { k: 'ETF 最新价', v: fmt(q.price, 3), n: pctText(q.changePct), nc: cls(q.changePct) },
      { k: '碳酸锂（连续）', v: fmt(fq.price, 0), n: futuresFactNote(fq), nc: cls(fq.changePct),
        tip: fq.base ? ('对比基准 ' + fmt(fq.base, 0) + ' 元/吨（' + fq.basis + '）') : '' },
      { k: '加权 PE(TTM)', v: itemValueOf(score, 'valuation'), n: '板块估值水位' },
      { k: '站上 MA20 广度', v: above + '/' + valid,
        n: valid ? fmt(above / valid * 100, 0) + '% 个股在均线上' : '样本不足',
        progress: valid ? above / valid * 100 : null }
    ];
    items.forEach(function (it) {
      var card = el('div', 'fact');
      card.appendChild(el('div', 'k', it.k));
      var v = el('div', 'v', it.v);
      if (it.nc) v.className = 'v ' + it.nc;
      card.appendChild(v);
      var n = el('div', 'n');
      n.innerHTML = it.n || '';
      if (it.nc) n.className = 'n with-change ' + it.nc;
      card.appendChild(n);
      if (it.progress !== undefined && it.progress !== null) {
        var bar = el('div', 'mini-bar');
        var fill = el('span', 'mini-fill');
        fill.style.width = it.progress.toFixed(0) + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
      }
      if (it.tip) card.title = it.tip;
      box.appendChild(card);
    });
  }

  function renderChips(charts, score) {
    var box = $('#chips');
    if (!box) return;
    box.innerHTML = '';
    keyLevels(charts, score, state.rules).forEach(function (c) {
      var chip = el('div', 'chip ' + (c.tone || 'flat'));
      chip.appendChild(el('span', 'chip-label', c.label));
      chip.appendChild(el('b', 'chip-value', c.value));
      chip.appendChild(el('span', 'chip-note', c.note || ''));
      box.appendChild(chip);
    });
  }

  function renderWinRate(score) {
    var body = $('#wrBody');
    if (!body) return;
    var wr = winRateOf(score, state.summary);
    if (!wr) {
      body.innerHTML = '<span class="flat">暂无统计快照：运行 <code>python3 local/backtest_summary.py</code> 生成。</span>';
      return;
    }
    if (wr.empty) {
      body.innerHTML = '<span class="flat">得分 ' + wr.bucket + ' 附近暂无历史样本。</span>';
      return;
    }
    if (!wr.enough) {
      body.innerHTML = '<span class="flat">历史样本仅 ' + wr.samples + ' 次，样本不足，仅供参考。</span>';
      return;
    }
    body.innerHTML =
      '<div class="wr-line">得分落在 <b>' + wr.label + '</b> 时，持有 ' + wr.hold + ' 日' +
      '上涨概率 <b class="' + cls(wr.winRate - 50) + '">' + fmt(wr.winRate, 1) + '%</b></div>' +
      '<div class="wr-sub">样本 ' + wr.samples + ' 次　平均 ' + pctText(wr.avgReturn) +
      '　中位数 ' + pctText(wr.medianReturn) +
      '　统计截至 ' + ((wr.summary && wr.summary.generatedAt) || '—') + '</div>';
  }

  function renderItems(score) {
    var box = $('#items');
    if (!box) return;
    box.innerHTML = '';
    (score.components || []).forEach(function (g, gi) {
      var acc = el('div', 'acc' + (gi === 0 ? ' open' : ''));
      var head = el('button', 'acc-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', gi === 0 ? 'true' : 'false');
      head.innerHTML = '<span class="acc-title">' + g.label + '</span>' +
        '<span class="acc-sub">权重 ' + g.weight + '</span>' +
        '<span class="acc-score ' + cls(g.score) + '">' + fmt(g.score, 1) + ' / ' + fmt(g.max, 0) + '</span>' +
        '<span class="acc-ratio">' + fmt(g.ratio, 0) + '%</span>' +
        '<span class="acc-arrow">▾</span>';
      acc.appendChild(head);

      var body = el('div', 'acc-body');
      var inner = el('div', 'acc-inner');
      (g.items || []).forEach(function (it) {
        var row = el('div', 'item-row');
        var name = el('div', 'item-name', shortLabel(it.label));
        if (it.missing) name.appendChild(el('span', 'tag-missing', '缺失'));
        row.appendChild(name);
        row.appendChild(el('div', 'item-value', it.value || '—'));

        var barWrap = el('div', 'item-bar');
        var half = it.max ? Math.min(50, Math.abs(it.score) / it.max * 50) : 0;
        var fill = el('span', 'item-fill ' + cls(it.score));
        if (it.score >= 0) fill.style.left = '50%';
        else fill.style.right = '50%';
        fill.style.width = half + '%';
        barWrap.appendChild(el('span', 'item-axis'));
        barWrap.appendChild(fill);
        row.appendChild(barWrap);

        row.appendChild(el('div', 'item-score ' + cls(it.score), fmt(it.score, 1)));
        var reason = el('div', 'item-reason', it.reason || '');
        reason.title = it.reason || '';
        row.appendChild(reason);
        inner.appendChild(row);
      });
      body.appendChild(inner);
      acc.appendChild(body);

      head.addEventListener('click', function () {
        var open = acc.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      box.appendChild(acc);
    });
  }

  /* 板块温度：23 个方块，颜色深浅表示涨跌幅 */
  function renderHeat(stocks) {
    var box = $('#heatGrid');
    if (!box) return;
    box.innerHTML = '';
    var note = $('#heatNote');
    var list = stocks.slice().sort(function (a, b) { return (b.changePct || 0) - (a.changePct || 0); });
    if (!list.length) {
      if (note) note.textContent = '暂无个股数据';
      return;
    }
    list.forEach(function (s) {
      var pct = s.changePct === null || s.changePct === undefined ? 0 : s.changePct;
      var tile = el('div', 'heat-tile');
      var light = document.documentElement.dataset.theme === 'light';
      var alpha = Math.min(light ? 0.5 : 0.85, 0.14 + Math.abs(pct) / 6 * (light ? 0.36 : 0.7));
      tile.style.background = pct >= 0
        ? 'rgba(255,93,93,' + alpha.toFixed(2) + ')'
        : 'rgba(34,197,94,' + alpha.toFixed(2) + ')';
      var name = el('span', 'heat-name', String(s.name || s.code).replace(/股份有限公司|科技|集团/g, ''));
      var val = el('span', 'heat-pct', (pct > 0 ? '+' : '') + fmt(pct, 2) + '%');
      tile.appendChild(name);
      tile.appendChild(val);
      tile.title = s.name + ' ' + (pct > 0 ? '+' : '') + fmt(pct, 2) + '%' +
        (s.aboveMa20 === null || s.aboveMa20 === undefined ? '' : (s.aboveMa20 ? '　站上 MA20' : '　跌破 MA20'));
      box.appendChild(tile);
    });
    if (note) {
      var up = list.filter(function (s) { return (s.changePct || 0) > 0; }).length;
      note.innerHTML = '上涨 <b class="up">' + up + '</b> 只 · 下跌 <b class="down">' + (list.length - up) +
        '</b> 只 · 站上 MA20 <b>' + list.filter(function (s) { return s.aboveMa20 === true; }).length + '</b> 只';
    }
  }

  /* 新闻：情绪标签 + 关键词高亮 + 时间分组 */
  function renderNews(news) {
    var ul = $('#newsList');
    if (!ul) return;
    ul.innerHTML = '';
    if (!news.length) {
      ul.appendChild(el('li', 'flat', '近 48 小时未抓到相关新闻（或新闻源暂时不可用）。'));
      return;
    }
    var cfg = (state.rules && state.rules.fundamental && state.rules.fundamental.news) || {};
    var pos = cfg.positive || [], neg = cfg.negative || [];
    var now = Date.now() / 1000;
    var groups = { '今天': [], '昨天': [], '更早': [] };
    news.forEach(function (n) {
      var age = now - (n.ts || now);
      var key = age < 86400 ? '今天' : (age < 172800 ? '昨天' : '更早');
      groups[key].push(n);
    });

    Object.keys(groups).forEach(function (g) {
      if (!groups[g].length) return;
      ul.appendChild(el('li', 'news-group', g));
      groups[g].forEach(function (n) {
        var li = el('li', 'news-item');
        var score = 0;
        pos.forEach(function (k) { if (n.title.indexOf(k) >= 0) score++; });
        neg.forEach(function (k) { if (n.title.indexOf(k) >= 0) score--; });
        var tag = el('span', 'sent ' + (score > 0 ? 'up' : (score < 0 ? 'down' : 'flat')),
          score > 0 ? '正面' : (score < 0 ? '负面' : '中性'));
        li.appendChild(tag);
        var a = el('a', null, n.title);
        a.href = n.url || '#';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
        li.appendChild(el('span', 'meta', ts2text(n.ts) + (n.source ? ' · ' + n.source : '')));
        ul.appendChild(li);
      });
    });
  }

  /* ?cost=0.66 可临时带入成本价（截图 / 分享用，不写入 localStorage） */
  function costFromQuery() {
    try {
      var v = parseFloat(new URLSearchParams(location.search).get('cost'));
      return isFinite(v) && v > 0 ? v : null;
    } catch (e) { return null; }
  }

  function renderPosition(quote, cfg) {
    var settings = loadSettings();
    state.costPrice = costFromQuery() || (settings.costPrice !== undefined && settings.costPrice !== null
      ? settings.costPrice : (cfg.costPrice || null));
    var input = $('#costPrice');
    if (input && state.costPrice && !input.value) input.value = state.costPrice;
    state.quotePrice = quote.price;      /* 刷新后价格会变，盈亏必须跟着最新价走 */
    updatePL();

    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.addEventListener('input', function () { updatePL(); });
    input.addEventListener('change', function () {
      var v = parseFloat(input.value);
      var valid = isFinite(v) && v > 0;
      state.costPrice = valid ? v : null;
      saveSettings({ costPrice: valid ? v : null });
      updatePL();
      if (state.payload && state.payload.mode === 'local') {
        fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ costPrice: valid ? v : null })
        }).catch(function () { /* 忽略 */ });
      }
      redrawCost();
    });
  }

  function currentCost(charts) {
    var input = $('#costPrice');
    var v = input ? parseFloat(input.value) : NaN;
    if (isFinite(v) && v > 0) return v;
    return state.costPrice && isFinite(state.costPrice) ? state.costPrice : null;
  }

  function redrawCost() {
    if (!state.payload) return;
    CHARTS.drawEtf(state.payload.charts || {}, {
      signalDates: (state.summary && state.summary.signalDates) || [],
      costPrice: currentCost(state.payload.charts || {})
    });
  }

  function updatePL() {
    var price = state.quotePrice;
    var input = $('#costPrice');
    var cost = input ? parseFloat(input.value) : NaN;
    var plBox = $('#plBox'), note = $('#plNote');
    if (!plBox) return;
    var invalid = input && input.value !== '' && (!isFinite(cost) || cost <= 0);
    if (invalid) {
      plBox.textContent = '—';
      plBox.className = 'pl flat';
      if (note) {
        note.textContent = '成本价需为大于 0 的数字。';
        note.className = 'pl-note warn';
      }
      return;
    }
    if (note) note.className = 'pl-note';
    if (!isFinite(cost) || cost <= 0 || !isFinite(price) || price === null) {
      plBox.textContent = '—';
      plBox.className = 'pl flat';
      if (note) note.textContent = '填入成本价后自动计算，并在上方 K 线图上画出成本线。';
      return;
    }
    var ret = (price / cost - 1) * 100;
    plBox.textContent = pctText(ret);
    plBox.className = 'pl ' + cls(ret);
    if (note) {
      note.textContent = '成本 ' + fmt(cost, 3) + ' → 现价 ' + fmt(price, 3) + '，' +
        (ret >= 0 ? '每份浮盈 ' : '每份浮亏 ') + fmt(Math.abs(price - cost), 3) + ' 元';
    }
  }

  function renderWarnings(meta, score) {
    var box = $('#warnBox');
    if (!box) return;
    var msgs = (score.notes || []).slice();
    (meta.warnings || []).forEach(function (w) { msgs.push('数据源：' + w); });
    if (meta.futuresSource === 'daily') {
      msgs.push('期货为日线口径（浏览器无法直连新浪实时报价），涨跌按上一交易日收盘价计算。');
    }
    if (!msgs.length) {
      box.className = 'notice';
      box.innerHTML = '';
      return;
    }
    box.className = 'notice show';
    box.innerHTML = '<button class="notice-head" type="button" aria-expanded="false">⚠ 数据提示 ' +
      msgs.length + ' 条 <span class="arrow">▾</span></button>' +
      '<div class="notice-body">' + msgs.map(function (m) { return '· ' + m; }).join('<br>') + '</div>';
    var head = box.querySelector('.notice-head');
    head.addEventListener('click', function () {
      var open = box.classList.toggle('open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* futures 卡片口径（导出给测试复用） */
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

  function futuresChangeText(fq) {
    if (fq.change === null || fq.change === undefined) return '暂无对比数据';
    var arrow = fq.change > 0 ? '▲' : (fq.change < 0 ? '▼' : '—');
    return arrow + ' ' + (fq.change > 0 ? '+' : '') + fmt(fq.change, 0) + ' 元/吨（'
      + pctText(fq.changePct) + '）';
  }

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

  /* ---------------------------------------------------------------- 交互 */
  async function refresh(force) {
    if (state.busy) return;
    state.busy = true;
    var btn = $('#refreshBtn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    document.body.classList.add('fetching');
    try {
      var payload = await tryLocal(force);
      if (!payload) payload = await loadStatic(force);
      if (!state.summary) state.summary = await loadSummary();
      render(payload);
    } catch (e) {
      var box = $('#warnBox');
      if (box) {
        box.className = 'notice show open';
        box.innerHTML = '<div class="notice-body">加载失败：' + (e && e.message ? e.message : e) +
          '<br>请检查网络，或稍后点击「刷新」。</div>';
      }
      var sk = $('#skeleton');
      if (sk) sk.hidden = true;
      var content = $('#content');
      if (content && !state.payload) content.hidden = false;
    } finally {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
      document.body.classList.remove('fetching');
    }
  }

  async function init() {
    try {
      var resp = await fetch('shared/scoring_rules.json', { cache: 'no-store' });
      state.rules = await resp.json();
    } catch (e) {
      var box = $('#warnBox');
      if (box) {
        box.className = 'notice show open';
        box.innerHTML = '<div class="notice-body">规则文件 shared/scoring_rules.json 加载失败：' + e.message + '</div>';
      }
      return;
    }

    state.summary = await loadSummary();
    await refresh(false);

    window.addEventListener('resize', function () { CHARTS.resize(); });
    if ('ResizeObserver' in window) {
      var ro = new ResizeObserver(function () { CHARTS.resize(); });
      ['etfChart', 'wfChart', 'lithiumChart'].forEach(function (id) {
        var node = document.getElementById(id);
        if (node) ro.observe(node);
      });
    }
    window.addEventListener('themechange', function () {
      if (state.payload) {
        CHARTS.render(state.payload, {
          signalDates: (state.summary && state.summary.signalDates) || [],
          costPrice: currentCost(state.payload.charts || {})
        });
      }
    });
    var rb = $('#refreshBtn');
    if (rb) rb.onclick = function () { refresh(true); };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      futuresQuoteOf: futuresQuoteOf,
      futuresChangeText: futuresChangeText,
      futuresFactNote: futuresFactNote,
      narrativeOf: narrativeOf,
      bullBear: bullBear,
      keyLevels: keyLevels,
      winRateOf: winRateOf,
      dataDateText: dataDateText
    };
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
