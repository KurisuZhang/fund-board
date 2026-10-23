/* 全部 ECharts 图表：K线主图 / 维度瀑布 / 碳酸锂；配色从 CSS 变量读取以支持双主题 */
(function () {
  'use strict';

  var instances = {};

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function palette() {
    return {
      text: cssVar('--chart-text', '#8b98ac'),
      grid: cssVar('--chart-grid', 'rgba(255,255,255,.07)'),
      axis: cssVar('--chart-axis', '#2a3444'),
      up: cssVar('--up', '#ff5d5d'),
      down: cssVar('--down', '#22c55e'),
      neutral: cssVar('--neutral', '#eab308'),
      accent: cssVar('--accent', '#4f8cff'),
      ma20: cssVar('--ma20', '#f0b445'),
      ma60: cssVar('--ma60', '#8b7cf6'),
      lithium: cssVar('--lithium', '#eab308'),
      lithiumMa: cssVar('--lithium-ma', '#f472b6'),
      tooltipBg: cssVar('--tooltip-bg', '#101722'),
      tooltipBorder: cssVar('--tooltip-border', '#2a3444'),
      animate: !(window.MOTION && window.MOTION.simplify())
    };
  }

  function chartOf(id) {
    var dom = document.getElementById(id);
    if (!dom || !window.echarts) return null;
    var inst = instances[id];
    if (!inst || inst.isDisposed()) {
      inst = echarts.init(dom, null, { renderer: 'canvas' });
      instances[id] = inst;
    }
    return inst;
  }

  function baseTooltip(p) {
    return {
      trigger: 'axis',
      backgroundColor: p.tooltipBg,
      borderColor: p.tooltipBorder,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: cssVar('--text', '#e6edf6'), fontSize: 11.5 },
      axisPointer: { type: 'cross', label: { backgroundColor: p.tooltipBorder } }
    };
  }

  function axisCommon(p) {
    return {
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: { color: p.text, fontSize: 10.5 },
      splitLine: { lineStyle: { color: p.grid } }
    };
  }

  /* ------------------------------------------------------------ ETF 主图 */
  function drawEtf(charts, opts) {
    var inst = chartOf('etfChart');
    if (!inst) return;
    var p = palette();
    var bars = charts.etf || [];
    if (!bars.length) { inst.clear(); return; }

    var dates = bars.map(function (b) { return b.d; });
    var ohlc = bars.map(function (b) {
      var o = b.o === undefined || b.o === null ? b.c : b.o;
      return [o, b.c, b.l, b.h];
    });
    var vol = bars.map(function (b, i) {
      var rising = b.c >= (b.o === undefined || b.o === null ? b.c : b.o);
      return { value: b.v, itemStyle: { color: rising ? hexA(p.up, 0.55) : hexA(p.down, 0.55) } };
    });

    var idxByDate = {};
    dates.forEach(function (d, i) { idxByDate[d] = i; });
    var signals = (opts.signalDates || []).map(function (d) {
      var i = idxByDate[d];
      return i === undefined ? null : [i, bars[i].c];
    }).filter(function (x) { return x !== null; });

    var cost = opts.costPrice;
    var markLine = null;
    if (cost && isFinite(cost) && cost > 0) {
      markLine = {
        silent: true, symbol: 'none', animation: false,
        lineStyle: { color: p.accent, type: 'dashed', width: 1.2, opacity: .9 },
        label: {
          formatter: '成本 ' + cost.toFixed(3),
          position: 'insideEndTop', color: p.accent, fontSize: 10.5,
          backgroundColor: hexA(p.accent, 0.12), padding: [2, 5], borderRadius: 4
        },
        data: [{ yAxis: cost }]
      };
    }

    inst.setOption({
      backgroundColor: 'transparent',
      animation: p.animate,
      animationDuration: 620,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: 'inherit' },
      tooltip: Object.assign(baseTooltip(p), {
        formatter: function (ps) {
          var out = '';
          var priceSeries = null, volume = null, mover = null;
          ps.forEach(function (x) {
            if (x.seriesType === 'candlestick') priceSeries = x;
            if (x.seriesName === '成交额') volume = x;
            if (x.seriesName === 'MA20' || x.seriesName === 'MA60') mover = mover;
          });
          if (priceSeries) {
            var v = cfg(priceSeries.data);
            out += '<b>' + priceSeries.axisValue + '</b><br>' +
              '开 ' + fmtNum(v[0], 3) + '　收 ' + fmtNum(v[1], 3) + '<br>' +
              '低 ' + fmtNum(v[2], 3) + '　高 ' + fmtNum(v[3], 3);
          }
          ps.forEach(function (x) {
            if (x.seriesName === 'MA20' || x.seriesName === 'MA60') {
              if (x.data !== null && x.data !== undefined) {
                out += '<br>' + x.seriesName + ' ' + fmtNum(x.data, 3);
              }
            }
          });
          if (volume) out += '<br>成交量 ' + fmtNum(volume.data.value || volume.data, 0) + ' 手';
          return out;
        }
      }),
      legend: {
        data: ['MA20', 'MA60'], top: 4, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 3,
        textStyle: { color: p.text, fontSize: 11 }
      },
      grid: [
        { left: 54, right: 18, top: 30, height: '52%' },
        { left: 54, right: 18, top: '70%', height: '17%' }
      ],
      xAxis: [
        { type: 'category', data: dates, gridIndex: 0, boundaryGap: true, axisCommonFallback: true,
          axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false },
          axisLabel: { show: false }, splitLine: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, axisLine: { lineStyle: { color: p.axis } },
          axisTick: { show: false },
          axisLabel: { color: p.text, fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 8)) },
          splitLine: { show: false } }
      ],
      yAxis: [
        { scale: true, gridIndex: 0, axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: p.text, fontSize: 10.5, formatter: function (v) { return v.toFixed(2); } },
          splitLine: { lineStyle: { color: p.grid } } },
        { scale: true, gridIndex: 1, axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { show: false }, splitLine: { show: false } }
      ],
      dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 25, end: 100, minValueSpan: 20 }],
      series: [
        {
          name: 'K线', type: 'candlestick', data: ohlc, barMaxWidth: 13,
          itemStyle: { color: p.up, color0: p.down, borderColor: p.up, borderColor0: p.down, borderWidth: 1 },
          markLine: markLine || undefined
        },
        { name: 'MA20', type: 'line', data: bars.map(function (b) { return b.ma20; }),
          showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: p.ma20 }, itemStyle: { color: p.ma20 } },
        { name: 'MA60', type: 'line', data: bars.map(function (b) { return b.ma60; }),
          showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: p.ma60 }, itemStyle: { color: p.ma60 } },
        { name: '成交额', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vol, barMaxWidth: 13 },
        {
          name: '信号', type: 'effectScatter', data: signals, symbolSize: 7,
          rippleEffect: { scale: 2.6, brushType: 'stroke' },
          itemStyle: { color: p.accent }, z: 5,
          tooltip: { show: false }, animation: p.animate
        }
      ]
    }, { notMerge: true });
  }

  function cfg(data) {
    if (data && data.value !== undefined) return data.value;
    return data;
  }
  function fmtNum(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Number(v).toFixed(d);
  }
  function hexA(hex, alpha) {
    if (!hex) return 'rgba(120,140,170,.4)';
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* ------------------------------------------------------- 维度瀑布图 */
  function drawWaterfall(score) {
    var inst = chartOf('wfChart');
    if (!inst) return;
    var p = palette();
    var groups = (score.components || []).slice(0, 3);
    var labels = groups.map(function (g) { return g.label; });
    var deltas = groups.map(function (g) { return g.score || 0; });
    var total = score.total || 0;

    var placeholders = [], values = [], running = 0;
    deltas.forEach(function (d) {
      if (d >= 0) { placeholders.push(running); values.push(d); running += d; }
      else { running += d; placeholders.push(running); values.push(-d); }
    });
    if (total >= 0) { placeholders.push(0); values.push(total); }
    else { placeholders.push(total); values.push(-total); }
    labels.push('综合得分');

    var colors = deltas.map(function (d) { return d >= 0 ? p.up : p.down; });
    colors.push(total >= 0 ? p.up : p.down);

    inst.setOption({
      backgroundColor: 'transparent',
      animation: p.animate,
      animationDuration: 560,
      grid: { left: 46, right: 16, top: 22, bottom: 26 },
      tooltip: Object.assign(baseTooltip(p), {
        trigger: 'item',
        formatter: function (x) {
          if (x.seriesName !== '得分') return '';
          var i = x.dataIndex;
          var raw = i < deltas.length ? deltas[i] : total;
          return '<b>' + labels[i] + '</b><br>' + (raw > 0 ? '+' : '') + raw.toFixed(1) + ' 分';
        }
      }),
      xAxis: {
        type: 'category', data: labels,
        axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false },
        axisLabel: { color: p.text, fontSize: 11 }
      },
      yAxis: {
        type: 'value', axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: p.text, fontSize: 10.5 },
        splitLine: { lineStyle: { color: p.grid } }
      },
      series: [
        { name: '占位', type: 'bar', stack: 'wf', data: placeholders, silent: true,
          itemStyle: { color: 'transparent' } },
        {
          name: '得分', type: 'bar', stack: 'wf', barMaxWidth: 46,
          data: values.map(function (v, i) {
            return { value: v, itemStyle: { color: colors[i], borderRadius: 4, opacity: i === values.length - 1 ? 1 : .85 } };
          }),
          label: {
            show: true, position: 'top', fontSize: 11, fontWeight: 600,
            color: p.text,
            formatter: function (x) {
              var raw = x.dataIndex < deltas.length ? deltas[x.dataIndex] : total;
              return (raw > 0 ? '+' : '') + raw.toFixed(0);
            }
          }
        }
      ]
    }, { notMerge: true });
  }

  /* --------------------------------------------------------- 碳酸锂期货 */
  function drawLithium(charts) {
    var inst = chartOf('lithiumChart');
    if (!inst) return;
    var p = palette();
    var bars = charts.futures || [];
    if (!bars.length) { inst.clear(); return; }
    var closes = bars.map(function (b) { return b.c; });
    var ma20 = window.IND ? IND.sma(closes, 20) : [];
    var recent = closes.slice(-60).filter(function (v) { return isFinite(v); });
    var lo = recent.length ? Math.min.apply(null, recent) : null;
    var hi = recent.length ? Math.max.apply(null, recent) : null;

    inst.setOption({
      backgroundColor: 'transparent',
      animation: p.animate,
      animationDuration: 500,
      grid: { left: 58, right: 16, top: 22, bottom: 26 },
      tooltip: baseTooltip(p),
      legend: { data: ['连续合约', 'MA20'], top: 0, right: 4, itemWidth: 12, itemHeight: 3,
        textStyle: { color: p.text, fontSize: 11 } },
      xAxis: {
        type: 'category', data: bars.map(function (b) { return b.d; }),
        axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false },
        axisLabel: { color: p.text, fontSize: 10, interval: Math.max(0, Math.floor(bars.length / 5)) },
        splitLine: { show: false }
      },
      yAxis: {
        scale: true, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: p.text, fontSize: 10.5, formatter: function (v) { return (v / 1000).toFixed(0) + 'k'; } },
        splitLine: { lineStyle: { color: p.grid } }
      },
      series: [
        {
          name: '连续合约', type: 'line', data: closes, showSymbol: false, smooth: true,
          lineStyle: { width: 1.9, color: p.lithium }, itemStyle: { color: p.lithium },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: hexA(p.lithium, .22) }, { offset: 1, color: hexA(p.lithium, 0) }]
            }
          },
          markArea: (lo === null ? undefined : {
            silent: true, itemStyle: { color: hexA(p.accent, .07) },
            label: { show: true, position: 'insideTopRight', color: p.text, fontSize: 10, formatter: '近60日区间' },
            data: [[{ yAxis: lo }, { yAxis: hi }]]
          })
        },
        { name: 'MA20', type: 'line', data: ma20, showSymbol: false, smooth: true,
          lineStyle: { width: 1.2, color: p.lithiumMa }, itemStyle: { color: p.lithiumMa } }
      ]
    }, { notMerge: true });
  }

  function resize() {
    Object.keys(instances).forEach(function (k) {
      var inst = instances[k];
      if (inst && !inst.isDisposed()) inst.resize();
    });
  }

  window.CHARTS = {
    render: function (payload, opts) {
      opts = opts || {};
      var charts = payload.charts || {};
      drawEtf(charts, opts);
      drawWaterfall(payload.score || {});
      drawLithium(charts);
    },
    drawEtf: drawEtf,
    drawWaterfall: drawWaterfall,
    drawLithium: drawLithium,
    resize: resize,
    palette: palette
  };
})();
