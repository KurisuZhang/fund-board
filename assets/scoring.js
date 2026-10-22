/* 打分引擎 —— 与 local/scoring.py 逐行对应。
 * 读取 shared/scoring_rules.json，输入归一化行情，输出总分/信号灯/子项明细。
 */
(function (global) {
  'use strict';

  var _IND = global.IND || (typeof require === 'function' ? require('./indicators.js') : null);
  if (!_IND) throw new Error('indicators.js 必须先加载');

  function fmt(x, d) { return Number(x).toFixed(d); }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

  function closesOf(bars) {
    var out = [];
    for (var i = 0; i < bars.length; i++) out.push(Number(bars[i].c));
    return out;
  }

  function amountsOf(bars) {
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var a = b.a;
      if (a === undefined || a === null) a = Number(b.c) * Number(b.v || 0) * 100.0;
      out.push(Number(a));
    }
    return out;
  }

  function item(key, label, score, mx, value, reason, missing) {
    return {
      key: key, label: label, score: score, max: mx,
      value: value, reason: reason, missing: !!missing
    };
  }
  function missingItem(key, label, mx, reason) {
    return item(key, label, 0, mx, '—', reason, true);
  }

  /* ------------------------------------------------------------ 基本面 */
  function scoreCost(futures, cfg) {
    var mx = cfg.max;
    var bars = (futures && futures.bars) || [];
    var closes = closesOf(bars);
    var need = Math.max(cfg.pct_window, cfg.chg_window, cfg.ma_window) + 1;
    if (closes.length < need) {
      return missingItem('cost', cfg.label, mx, '期货日线不足 ' + need + ' 根，无法计算');
    }
    var cur = closes[closes.length - 1];
    var pts = [], notes = [];

    var ma = _IND.sma(closes, cfg.ma_window)[closes.length - 1];
    if (cur >= ma) { pts.push(cfg.trend_above); notes.push('站上MA' + cfg.ma_window + '(+' + cfg.trend_above + ')'); }
    else { pts.push(cfg.trend_below); notes.push('跌破MA' + cfg.ma_window + '(' + cfg.trend_below + ')'); }

    var rank = _IND.percentileRank(closes, cfg.pct_window);
    if (rank !== null) {
      if (rank <= cfg.pct_low_max) {
        pts.push(cfg.pct_low_score);
        notes.push(cfg.pct_window + '日分位' + fmt(rank, 0) + '%处低位(+' + cfg.pct_low_score + ')');
      } else if (rank >= cfg.pct_high_min) {
        pts.push(cfg.pct_high_score);
        notes.push(cfg.pct_window + '日分位' + fmt(rank, 0) + '%处高位(' + cfg.pct_high_score + ')');
      } else {
        notes.push(cfg.pct_window + '日分位' + fmt(rank, 0) + '%(中性)');
      }
    }

    var chg = _IND.pctChange(closes, cfg.chg_window);
    if (chg !== null) {
      if (chg >= cfg.chg_mild_min && chg <= cfg.chg_mild_max) {
        pts.push(cfg.chg_mild_score);
        notes.push(cfg.chg_window + '日涨' + fmt(chg, 0) + '%温和回暖(+' + cfg.chg_mild_score + ')');
      } else if (chg > cfg.chg_hot_min) {
        pts.push(cfg.chg_hot_score);
        notes.push(cfg.chg_window + '日涨' + fmt(chg, 0) + '%过快、成本挤压(' + cfg.chg_hot_score + ')');
      } else if (chg < cfg.chg_weak_max) {
        pts.push(cfg.chg_weak_score);
        notes.push(cfg.chg_window + '日跌' + fmt(chg, 0) + '%需求走弱(' + cfg.chg_weak_score + ')');
      } else {
        notes.push(cfg.chg_window + '日涨跌' + fmt(chg, 1) + '%(中性)');
      }
    }

    var score = _IND.clamp(pts.reduce(function (a, b) { return a + b; }, 0), -mx, mx);
    return item('cost', cfg.label, _IND.roundScore(score), mx,
      fmt(cur, 0) + ' 元/吨', notes.join('；'));
  }

  function scoreValuation(stocks, cfg) {
    var mx = cfg.max;
    var valid = [];
    for (var i = 0; i < stocks.length; i++) {
      var s = stocks[i];
      var pe = s.pe, mc = s.marketCap;
      if (pe === null || pe === undefined) continue;
      pe = Number(pe);
      if (!(pe > cfg.pe_min && pe <= cfg.pe_max)) continue;
      if (!(Number(mc || 0) > 0)) continue;
      valid.push(s);
    }
    if (valid.length < 3) {
      return missingItem('valuation', cfg.label, mx,
        '有效PE样本不足（' + valid.length + '只），已剔除亏损/异常值');
    }
    var wsum = 0, psum = 0;
    for (var j = 0; j < valid.length; j++) {
      wsum += Number(valid[j].marketCap);
      psum += Number(valid[j].pe) * Number(valid[j].marketCap);
    }
    var peW = psum / wsum;
    var bucket = _IND.pickByMax(cfg.buckets, peW);
    var score = bucket ? Number(bucket.score) : 0;
    var tag = score > 0 ? '低估' : (score === 0 ? '合理' : '偏贵');
    var reason = '加权PE ' + fmt(peW, 1) + ' 倍（样本' + valid.length + '只），处于' + tag + '区间';
    return item('valuation', cfg.label, _IND.roundScore(score), mx, fmt(peW, 1) + '×', reason);
  }

  function scoreBreadth(stocks, cfg) {
    var mx = cfg.max, above = 0, total = 0;
    for (var i = 0; i < stocks.length; i++) {
      var closes = closesOf((stocks[i].bars) || []);
      if (closes.length < cfg.ma_window) continue;
      var win = closes.slice(closes.length - cfg.ma_window);
      var ma = mean(win);
      total += 1;
      if (closes[closes.length - 1] >= ma) above += 1;
    }
    if (total < cfg.min_samples) {
      return missingItem('breadth', cfg.label, mx, '有效样本不足（' + total + '/' + cfg.min_samples + '）');
    }
    var pct = above / total * 100.0;
    var bucket = _IND.pickByMin(cfg.buckets, pct);
    var score = bucket ? Number(bucket.score) : 0;
    var tag = score > 0 ? '板块广度健康' : (score === 0 ? '广度中性' : '多数个股失守均线');
    var reason = above + '/' + total + ' 只站上MA' + cfg.ma_window + ' = ' + fmt(pct, 0) + '%，' + tag;
    return item('breadth', cfg.label, _IND.roundScore(score), mx, above + '/' + total, reason);
  }

  function scoreNews(news, asOf, cfg) {
    var mx = cfg.max;
    var start = asOf - cfg.window_hours * 3600.0;
    var items = [];
    for (var i = 0; i < (news || []).length; i++) {
      if (Number(news[i].ts || 0) >= start) items.push(news[i]);
    }
    if (items.length < cfg.min_samples) {
      return missingItem('news', cfg.label, mx,
        '近' + cfg.window_hours + '小时相关新闻仅 ' + items.length + ' 条，样本不足');
    }
    var posKw = cfg.positive, negKw = cfg.negative;
    var posCnt = 0, negCnt = 0, posHits = {}, negHits = {};
    for (var j = 0; j < items.length; j++) {
      var title = String(items[j].title || '');
      var php = 0, nhp = 0, k;
      for (k = 0; k < posKw.length; k++) if (title.indexOf(posKw[k]) >= 0) php++;
      for (k = 0; k < negKw.length; k++) if (title.indexOf(negKw[k]) >= 0) nhp++;
      if (php > nhp) {
        posCnt++;
        for (k = 0; k < posKw.length; k++) if (title.indexOf(posKw[k]) >= 0) posHits[posKw[k]] = (posHits[posKw[k]] || 0) + 1;
      } else if (nhp > php) {
        negCnt++;
        for (k = 0; k < negKw.length; k++) if (title.indexOf(negKw[k]) >= 0) negHits[negKw[k]] = (negHits[negKw[k]] || 0) + 1;
      }
    }
    var net = (posCnt - negCnt) / items.length;
    var score = _IND.roundScore(cfg.scale * _IND.clamp(net / cfg.min_net_for_full, -1.0, 1.0));
    score = _IND.clamp(score, -mx, mx);
    function top3(hits) {
      var arr = [];
      for (var kk in hits) if (Object.prototype.hasOwnProperty.call(hits, kk)) arr.push([kk, hits[kk]]);
      arr.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)); });
      return arr.slice(0, 3);
    }
    var reason = '近' + cfg.window_hours + '小时 ' + items.length + ' 条相关：正面' + posCnt + ' / 负面' + negCnt;
    var tp = top3(posHits), tn = top3(negHits);
    if (tp.length) reason += '；正面词 ' + tp.map(function (x) { return x[0] + '(' + x[1] + ')'; }).join(',');
    if (tn.length) reason += '；负面词 ' + tn.map(function (x) { return x[0] + '(' + x[1] + ')'; }).join(',');
    return item('news', cfg.label, score, mx, items.length + ' 条', reason);
  }

  /* -------------------------------------------------------------- 量能 */
  function scoreExpansion(etf, cfg) {
    var mx = cfg.max;
    var bars = etf.bars || [];
    var amounts = amountsOf(bars), closes = closesOf(bars);
    var need = Math.max(cfg.long_window, cfg.short_window) + 1;
    if (amounts.length < need || closes.length < need) {
      return missingItem('expansion', cfg.label, mx, '成交额序列不足 ' + need + ' 根');
    }
    var shortAvg = mean(amounts.slice(amounts.length - cfg.short_window));
    var longAvg = mean(amounts.slice(amounts.length - cfg.long_window));
    if (!(longAvg > 0)) return missingItem('expansion', cfg.label, mx, '成交额均值为0');
    var ratio = shortAvg / longAvg;
    var ret = (closes[closes.length - 1] / closes[closes.length - 1 - cfg.short_window] - 1.0) * 100.0;
    var dir = ret > cfg.flat_return_pct ? 'up' : (ret < -cfg.flat_return_pct ? 'down' : 'flat');
    var score = 0;
    if (dir !== 'flat') {
      var table = cfg.table.filter(function (t) { return t.dir === dir; })
        .sort(function (a, b) { return b.ratio_min - a.ratio_min; });
      for (var i = 0; i < table.length; i++) {
        if (ratio >= table[i].ratio_min) { score = Number(table[i].score); break; }
      }
    }
    var tag = dir === 'up' ? (ratio >= 1.0 ? '放量上涨' : '缩量上涨')
      : (dir === 'down' ? (ratio >= 1.0 ? '放量下跌' : '缩量下跌') : '横盘');
    var reason = cfg.short_window + '日均额/' + cfg.long_window + '日均额 = ' + fmt(ratio, 2)
      + '，近' + cfg.short_window + '日涨跌 ' + fmt(ret, 1) + '%（' + tag + '）';
    return item('expansion', cfg.label, _IND.roundScore(score), mx, fmt(ratio, 2) + '×', reason);
  }

  function scorePriceVolume(etf, cfg) {
    var mx = cfg.max;
    var bars = etf.bars || [];
    var amounts = amountsOf(bars), closes = closesOf(bars);
    var w = cfg.window;
    if (closes.length < w + 1) return missingItem('price_volume', cfg.label, mx, '日线不足 ' + (w + 1) + ' 根');
    var matches = 0, considered = 0;
    for (var i = closes.length - w; i < closes.length; i++) {
      var dc = closes[i] - closes[i - 1];
      var da = amounts[i] - amounts[i - 1];
      var sc = dc > 0 ? 1 : (dc < 0 ? -1 : 0);
      var sa = da > 0 ? 1 : (da < 0 ? -1 : 0);
      if (sc === 0 || sa === 0) continue;
      considered++;
      if (sc === sa) matches++;
    }
    if (considered < cfg.min_samples) {
      return missingItem('price_volume', cfg.label, mx, '有效样本不足（' + considered + '）');
    }
    var ratio = matches / considered;
    var score = _IND.roundScore(mx * (2.0 * ratio - 1.0));
    var reason = '近' + w + '日量价同向 ' + matches + '/' + considered + ' = ' + fmt(ratio * 100, 0) + '%（'
      + (ratio >= 0.5 ? '量价配合' : '量价背离') + '）';
    return item('price_volume', cfg.label, score, mx, fmt(ratio * 100, 0) + '%', reason);
  }

  function scoreCloseStrength(etf, cfg) {
    /* 收盘强度 = 收盘价在当日 [最低,最高] 区间的位置（近 N 日均值），只依赖 OHLC */
    var mx = cfg.max;
    var bars = etf.bars || [];
    if (bars.length < cfg.window) return missingItem('close_strength', cfg.label, mx, '日线不足 ' + cfg.window + ' 根');
    var positions = [];
    for (var i = bars.length - cfg.window; i < bars.length; i++) {
      var b = bars[i];
      var high = Number(b.h), low = Number(b.l), close = Number(b.c);
      positions.push(high > low ? (close - low) / (high - low) : 0.5);
    }
    if (positions.length < cfg.min_samples) return missingItem('close_strength', cfg.label, mx, '有效样本不足');
    var mp = mean(positions);
    var score = _IND.roundScore(mx * (2.0 * mp - 1.0));
    var tag = mp > 0.55 ? '收在偏高位置、尾盘偏强' : (mp < 0.45 ? '收在偏低位置、尾盘偏弱' : '居中');
    var reason = '近' + positions.length + '日收盘位于日内区间 ' + fmt(mp * 100, 0) + '% 处（' + tag + '）';
    return item('close_strength', cfg.label, score, mx, fmt(mp * 100, 0) + '%', reason);
  }

  function scoreBreakout(etf, cfg) {
    var mx = cfg.max;
    var bars = etf.bars || [];
    if (bars.length < cfg.min_samples) return missingItem('breakout', cfg.label, mx, '日线不足 ' + cfg.min_samples + ' 根');
    var w = cfg.window;
    var prev = bars.slice(bars.length - w - 1, bars.length - 1);
    var highs = prev.map(function (b) { return Number(b.h); });
    var lows = prev.map(function (b) { return Number(b.l); });
    var avgAmt = mean(amountsOf(prev));
    var last = bars[bars.length - 1];
    var lastAmt = amountsOf([last])[0];
    var okVol = avgAmt > 0 && lastAmt > cfg.ratio_min * avgAmt;
    var score = 0, reason;
    var maxHigh = Math.max.apply(null, highs);
    var minLow = Math.min.apply(null, lows);
    if (Number(last.c) > maxHigh && okVol) {
      score = Number(cfg.score);
      reason = '创' + w + '日新高且成交额 ' + fmt(lastAmt / avgAmt, 1) + ' 倍于均额';
    } else if (Number(last.c) < minLow && okVol) {
      score = -Number(cfg.score);
      reason = '创' + w + '日新低且成交额 ' + fmt(lastAmt / avgAmt, 1) + ' 倍于均额';
    } else {
      reason = '未突破 ' + w + ' 日区间（' + (okVol ? '放量' : '量能不足') + '）';
    }
    return item('breakout', cfg.label, score, mx,
      fmt(avgAmt > 0 ? lastAmt / avgAmt : 0, 2) + '×', reason);
  }

  /* -------------------------------------------------------------- 技术 */
  function scoreMa(etf, cfg) {
    var mx = cfg.max;
    var closes = closesOf(etf.bars || []);
    if (closes.length < cfg.long) return missingItem('ma', cfg.label, mx, '日线不足 ' + cfg.long + ' 根');
    var s = _IND.sma(closes, cfg.short)[closes.length - 1];
    var m = _IND.sma(closes, cfg.mid)[closes.length - 1];
    var l = _IND.sma(closes, cfg.long)[closes.length - 1];
    var score, reason;
    if (s > m && m > l) { score = cfg.full_bull; reason = 'MA' + cfg.short + '>MA' + cfg.mid + '>MA' + cfg.long + ' 多头排列'; }
    else if (s < m && m < l) { score = cfg.full_bear; reason = 'MA' + cfg.short + '<MA' + cfg.mid + '<MA' + cfg.long + ' 空头排列'; }
    else if (s > m && m < l) { score = cfg.partial_bull; reason = '短中期转强、长期均线仍压制'; }
    else { score = cfg.partial_bear; reason = '短期走弱、长期均线仍上行'; }
    return item('ma', cfg.label, Number(score), mx, fmt(s, 3) + '/' + fmt(m, 3) + '/' + fmt(l, 3), reason);
  }

  function scoreMacd(etf, cfg) {
    var mx = cfg.max;
    var closes = closesOf(etf.bars || []);
    if (closes.length < cfg.min_samples) return missingItem('macd', cfg.label, mx, '日线不足 ' + cfg.min_samples + ' 根');
    var res = _IND.macd(closes, cfg.fast, cfg.slow, cfg.signal);
    var dif = res.dif[res.dif.length - 1];
    var dea = res.dea[res.dea.length - 1];
    var hist = res.hist;
    var hNow = hist[hist.length - 1], hPrev = hist[hist.length - 2];
    var rising = hNow > hPrev, score, reason;
    if (dif > dea && rising) { score = cfg.strong; reason = 'DIF在DEA上方且红柱放大'; }
    else if (dif > dea) { score = cfg.weak; reason = 'DIF在DEA上方但动能收敛'; }
    else if (dif < dea && rising) { score = -cfg.weak; reason = 'DIF在DEA下方但绿柱收敛'; }
    else { score = -cfg.strong; reason = 'DIF在DEA下方且绿柱放大'; }
    return item('macd', cfg.label, Number(score), mx, 'DIF ' + fmt(dif, 3) + ' / DEA ' + fmt(dea, 3), reason);
  }

  function scorePosition(etf, cfg) {
    var mx = cfg.max;
    var closes = closesOf(etf.bars || []);
    var need = Math.max(cfg.min_samples, cfg.rsi_window + 1);
    if (closes.length < need) return missingItem('position', cfg.label, mx, '日线不足 ' + cfg.min_samples + ' 根');
    var r = _IND.rsi(closes, cfg.rsi_window)[closes.length - 1];
    var ma = _IND.sma(closes, cfg.bias_window)[closes.length - 1];
    var bias = ma ? (closes[closes.length - 1] - ma) / ma * 100.0 : null;
    var score, reason;
    if (r !== null && r < cfg.rsi_oversold) { score = mx; reason = 'RSI' + fmt(r, 0) + ' 超卖，反弹概率上升'; }
    else if (r !== null && r > cfg.rsi_overbought) { score = -mx; reason = 'RSI' + fmt(r, 0) + ' 超买，追高风险大'; }
    else if (bias !== null && Math.abs(bias) > cfg.bias_limit_pct) {
      score = bias > 0 ? -mx : mx;
      reason = cfg.bias_window + '日乖离率 ' + fmt(bias, 1) + '%，偏离过大';
    } else {
      score = 0;
      reason = 'RSI' + fmt(r !== null ? r : 50, 0) + '、乖离率 ' + fmt(bias !== null ? bias : 0, 1) + '%，位置中性';
    }
    return item('position', cfg.label, Number(score), mx,
      'RSI ' + fmt(r !== null ? r : 50, 0), reason);
  }

  /* ------------------------------------------------------- 汇总与信号灯 */
  function labelOf(total, rules) {
    if (total >= rules.signal.bull) return '偏多';
    if (total <= rules.signal.bear) return '偏空';
    return '中性';
  }

  function scoreDashboard(inp, rules) {
    var asOf = Number(inp.asOf || 0);
    var stocks = inp.stocks || [];
    var futures = inp.futures || {};
    var etf = inp.etf || {};
    var news = inp.news || [];

    var fc = rules.fundamental, vc = rules.volume, tc = rules.technical;

    var groups = [
      ['fundamental', '基本面', rules.weights.fundamental, [
        scoreCost(futures, fc.cost),
        scoreValuation(stocks, fc.valuation),
        scoreBreadth(stocks, fc.breadth),
        scoreNews(news, asOf, fc.news)
      ]],
      ['volume', '量能', rules.weights.volume, [
        scoreExpansion(etf, vc.expansion),
        scorePriceVolume(etf, vc.price_volume),
        scoreCloseStrength(etf, vc.close_strength),
        scoreBreakout(etf, vc.breakout)
      ]],
      ['technical', '技术', rules.weights.technical, [
        scoreMa(etf, tc.ma),
        scoreMacd(etf, tc.macd),
        scorePosition(etf, tc.position)
      ]]
    ];

    var outGroups = [], weighted = 0, weightUsed = 0, missing = [];
    for (var g = 0; g < groups.length; g++) {
      var key = groups[g][0], title = groups[g][1], weight = groups[g][2], items = groups[g][3];
      var haveMax = 0, haveScore = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].missing) { missing.push(items[i].key); continue; }
        haveMax += items[i].max;
        haveScore += items[i].score;
      }
      var ratio = haveMax > 0 ? haveScore / haveMax : 0;
      if (haveMax > 0) { weighted += ratio * weight; weightUsed += weight; }
      outGroups.push({
        key: key, label: title, weight: weight,
        score: _IND.round1(haveScore), max: _IND.round1(haveMax),
        ratio: _IND.round1(ratio * 100.0), items: items
      });
    }

    var total, label;
    if (weightUsed <= 0) { total = 0; label = '数据缺失'; }
    else {
      total = _IND.round1(weighted / weightUsed * 100.0);
      label = labelOf(total, rules);
    }

    var notes = [];
    if (missing.length) notes.push('部分子项数据缺失（' + missing.join('、') + '），已在维度内按可得项归一');
    var weightSum = rules.weights.fundamental + rules.weights.volume + rules.weights.technical;
    if (weightUsed > 0 && weightUsed < weightSum) notes.push('维度整体缺失，已按剩余维度归一（权重 ' + fmt(weightUsed, 0) + '/100）');
    if (inp.dataWarnings) notes = notes.concat(inp.dataWarnings);

    return {
      total: total, label: label, strength: _IND.round1(Math.abs(total)),
      components: outGroups, missing: missing, notes: notes,
      rulesVersion: rules.version
    };
  }

  var API = {
    scoreDashboard: scoreDashboard,
    labelOf: labelOf,
    scoreCost: scoreCost, scoreValuation: scoreValuation, scoreBreadth: scoreBreadth,
    scoreNews: scoreNews, scoreExpansion: scoreExpansion, scorePriceVolume: scorePriceVolume,
    scoreCloseStrength: scoreCloseStrength, scoreBreakout: scoreBreakout,
    scoreMa: scoreMa, scoreMacd: scoreMacd, scorePosition: scorePosition
  };

  global.SCORING = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
