/* 技术指标计算 —— 与 local/indicators.py 逐行对应。
 * 所有函数对"数据不足"返回 null，不抛异常。
 * 浏览器下挂到 globalThis.IND；quickjs/node 下同时 module.exports。
 */
(function (global) {
  'use strict';

  function nums(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      out.push(v === null || v === undefined ? null : Number(v));
    }
    return out;
  }

  function sma(values, window) {
    var vals = nums(values);
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (i + 1 < window) { out.push(null); continue; }
      var ok = true, acc = 0;
      for (var j = i + 1 - window; j <= i; j++) {
        if (vals[j] === null) { ok = false; break; }
        acc += vals[j];
      }
      out.push(ok ? acc / window : null);
    }
    return out;
  }

  function ema(values, window) {
    var vals = nums(values);
    var out = [];
    var k = 2.0 / (window + 1.0);
    var prev = null;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v === null) { out.push(prev); continue; }
      prev = prev === null ? v : v * k + prev * (1.0 - k);
      out.push(prev);
    }
    return out;
  }

  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var fe = ema(closes, fast), se = ema(closes, slow);
    var dif = [];
    for (var i = 0; i < fe.length; i++) {
      dif.push(fe[i] === null || se[i] === null ? null : fe[i] - se[i]);
    }
    var dea = ema(dif, signal);
    var hist = [];
    for (var j = 0; j < dif.length; j++) {
      hist.push(dif[j] === null || dea[j] === null ? null : (dif[j] - dea[j]) * 2.0);
    }
    return { dif: dif, dea: dea, hist: hist };
  }

  function rsi(closes, window) {
    var vals = nums(closes);
    var out = [];
    for (var i = 0; i < vals.length; i++) out.push(null);
    for (var i2 = window; i2 < vals.length; i2++) {
      var gains = 0, losses = 0, ok = true;
      for (var j = i2 - window + 1; j <= i2; j++) {
        var a = vals[j - 1], b = vals[j];
        if (a === null || b === null) { ok = false; break; }
        var diff = b - a;
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      if (!ok) continue;
      var avgGain = gains / window, avgLoss = losses / window;
      if (avgLoss === 0) out[i2] = avgGain > 0 ? 100.0 : 50.0;
      else out[i2] = 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
    }
    return out;
  }

  function percentileRank(values, window) {
    var vals = [];
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v !== null && v !== undefined) vals.push(Number(v));
    }
    if (vals.length < window || window <= 0) return null;
    var chunk = vals.slice(vals.length - window);
    var cur = chunk[chunk.length - 1];
    var cnt = 0;
    for (var k = 0; k < chunk.length; k++) if (chunk[k] <= cur) cnt++;
    return cnt / window * 100.0;
  }

  function pctChange(closes, window) {
    var vals = [];
    for (var i = 0; i < closes.length; i++) {
      var v = closes[i];
      if (v !== null && v !== undefined) vals.push(Number(v));
    }
    if (vals.length < window + 1) return null;
    var base = vals[vals.length - 1 - window];
    if (base === 0) return null;
    return (vals[vals.length - 1] / base - 1.0) * 100.0;
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function roundScore(x) {
    return Math.floor(x + 0.5);
  }

  function round1(x) {
    return Math.floor(x * 10.0 + 0.5) / 10.0;
  }

  function pickByMax(buckets, value) {
    for (var i = 0; i < buckets.length; i++) {
      if (value <= buckets[i].max) return buckets[i];
    }
    return null;
  }

  function pickByMin(buckets, value) {
    var ordered = buckets.slice().sort(function (a, b) { return b.min - a.min; });
    for (var i = 0; i < ordered.length; i++) {
      if (value >= ordered[i].min) return ordered[i];
    }
    return null;
  }

  var IND = {
    sma: sma, ema: ema, macd: macd, rsi: rsi,
    percentileRank: percentileRank, pctChange: pctChange,
    clamp: clamp, roundScore: roundScore, round1: round1,
    pickByMax: pickByMax, pickByMin: pickByMin
  };

  global.IND = IND;
  if (typeof module !== 'undefined' && module.exports) module.exports = IND;
})(typeof globalThis !== 'undefined' ? globalThis : this);
