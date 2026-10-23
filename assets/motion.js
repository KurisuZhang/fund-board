/* 动效工具：克制、可降级；只动 transform / opacity，默认时长 ≤ 650ms */
(function () {
  'use strict';

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function prefersReducedMotion() {
    return !!(reduceQuery && reduceQuery.matches);
  }

  /* 只有极弱的设备才整体降级；触屏设备照常播放动画 */
  function lowEndDevice() {
    var cores = navigator.hardwareConcurrency || 8;
    return cores <= 2;
  }

  function simplify() {
    return prefersReducedMotion() || lowEndDevice();
  }

  var easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };

  /* 数字滚动：from → to，结束帧精确落位（避免累计误差） */
  function countUp(node, from, to, opts) {
    if (!node) return;
    opts = opts || {};
    var digits = opts.digits === undefined ? 1 : opts.digits;
    var dur = Math.min(opts.duration || 600, 650);
    var fmtFn = opts.format || function (v) { return v.toFixed(digits); };

    function settle() {
      node.textContent = fmtFn(to);
    }
    if (simplify() || !isFinite(from) || !isFinite(to) || Math.abs(to - from) < 1e-9) {
      settle();
      return;
    }
    /* 兜底：标签页在后台时 rAF 会被节流甚至不跑，定时器保证最终落到目标值 */
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      settle();
    }
    window.setTimeout(finish, dur + 200);

    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      node.textContent = fmtFn(from + (to - from) * easeOutCubic(p));
      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        finish();
      }
    }
    requestAnimationFrame(step);
  }

  /* 错峰淡入：依次 fade + 轻微上移；动画结束后清掉内联样式，避免影响 hover */
  function staggerIn(nodes, opts) {
    opts = opts || {};
    var gap = opts.stagger || 40;
    var dur = opts.duration || 380;
    var cls = opts.className || 'enter';
    var list = Array.prototype.slice.call(nodes || []);
    if (!list.length) return;
    if (simplify()) {
      list.forEach(function (n) { n.classList.remove(cls); });
      return;
    }
    var longest = 0;
    list.forEach(function (n, i) {
      if (n.classList.contains('entered')) return;
      var delay = i * gap;
      longest = Math.max(longest, delay + dur);
      n.classList.add(cls);
      n.style.transitionProperty = 'opacity, transform';
      n.style.transitionDuration = dur + 'ms';
      n.style.transitionTimingFunction = 'cubic-bezier(.22,1,.36,1)';
      n.style.transitionDelay = delay + 'ms';
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        list.forEach(function (n) {
          n.classList.remove(cls);
          n.classList.add('entered');
        });
      });
    });
    /* 结束后清场：内联 transition 不能留着，否则 hover/collapse 也会被延迟。
       同时兜底移除 enter 类——后台标签页里 rAF 可能不跑，否则内容会一直隐形 */
    window.setTimeout(function () {
      list.forEach(function (n) {
        n.classList.remove(cls);
        n.classList.add('entered');
        n.style.transitionProperty = '';
        n.style.transitionDuration = '';
        n.style.transitionTimingFunction = '';
        n.style.transitionDelay = '';
      });
    }, longest + 120);
  }

  /* 只在首次进入视口时触发一次 */
  function observeOnce(node, cb) {
    if (!node) return;
    if (simplify() || !('IntersectionObserver' in window)) { cb(); return; }
    if (node.dataset.observed === '1') return;
    node.dataset.observed = '1';
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          io.disconnect();
          cb();
        }
      });
    }, { threshold: 0.2 });
    io.observe(node);
  }

  window.MOTION = {
    prefersReducedMotion: prefersReducedMotion,
    lowEndDevice: lowEndDevice,
    simplify: simplify,
    countUp: countUp,
    staggerIn: staggerIn,
    observeOnce: observeOnce
  };
})();
