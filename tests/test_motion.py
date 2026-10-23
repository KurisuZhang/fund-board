"""动效与主题：约束（时长 / 降级 / 不留内联样式）+ 行为（计数、错峰入场、主题持久化）。"""
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".deps", "quickjs"))


def _load_quickjs():
    try:
        import quickjs  # noqa: F401
        return quickjs
    except Exception:
        return None


quickjs = _load_quickjs()
pytestmark = pytest.mark.skipif(
    quickjs is None, reason="未安装 quickjs（pip install --target .deps/quickjs quickjs）"
)


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


# ------------------------------------------------------------------ CSS 约束
def test_no_transition_all():
    css = _read("assets", "style.css")
    assert "transition: all" not in css
    assert "transition-property: all" not in css


def test_reduced_motion_block_disables_animation():
    css = _read("assets", "style.css")
    block = css[css.index("@media (prefers-reduced-motion: reduce)"):]
    assert "animation-duration: .01ms" in block
    assert "transition-duration: .01ms" in block
    assert ".enter" in block


def test_duration_tokens_are_short():
    css = _read("assets", "style.css")
    tokens = dict(re.findall(r"(--dur[\w-]*):\s*(\d+)ms", css))
    assert tokens, "动效时长应该用令牌统一管理"
    for name, ms in tokens.items():
        assert int(ms) <= 650, "%s=%sms 超过 650ms" % (name, ms)


def test_transition_durations_within_budget():
    css = _read("assets", "style.css")
    body = css[: css.index("@media (prefers-reduced-motion: reduce)")]
    for decl in re.findall(r"transition:[^;]+;", body):
        if "var(" in decl:      # 走令牌的先由 token 测试覆盖
            continue
        for ms in re.findall(r"(\d+)ms", decl):
            assert int(ms) <= 650, decl


def test_entry_class_only_moves_opacity_and_transform():
    css = _read("assets", "style.css")
    rule = re.search(r"\.enter\s*\{([^}]*)\}", css)
    assert rule, "缺少 .enter 入场样式"
    body = rule.group(1)
    assert "opacity" in body
    assert "transform" in body
    assert "height" not in body and "width" not in body


# ----------------------------------------------------------------- JS 行为
SHIM = r"""
var _raf = [], _timers = [], _dispatched = [];
var __reduce = false, __cores = 8, __coarse = false;
var window = {
  matchMedia: function (q) {
    var isReduce = q.indexOf('reduced-motion') >= 0;
    var isCoarse = q.indexOf('pointer: coarse') >= 0;
    return { get matches() { return isReduce ? !!__reduce : (isCoarse ? !!__coarse : false); } };
  },
  setTimeout: function (fn, ms) { _timers.push({ fn: fn, ms: ms }); return _timers.length; },
  dispatchEvent: function (ev) { _dispatched.push(ev); return true; }
};
var navigator = {};
Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return __cores; } });
function requestAnimationFrame(fn) { _raf.push(fn); return _raf.length; }
function flushRAF(t) { var q = _raf; _raf = []; for (var i = 0; i < q.length; i++) q[i](t); }
function runTimers() { var q = _timers; _timers = []; for (var i = 0; i < q.length; i++) q[i].fn(); }
function El() {
  var set = {}, self = this;
  this.className = ''; this.style = {}; this.textContent = '';
  this.classList = {
    add: function (c) { set[c] = 1; self.className = Object.keys(set).join(' '); },
    remove: function (c) { delete set[c]; self.className = Object.keys(set).join(' '); },
    contains: function (c) { return !!set[c]; }
  };
}
"""


def _engine():
    ctx = quickjs.Context()
    ctx.eval(SHIM)
    ctx.eval(_read("assets", "motion.js"))
    ctx.eval("var MOTION = window.MOTION;")
    return ctx


def _json(ctx, expr):
    raw = ctx.eval("JSON.stringify(%s)" % expr)
    return None if raw is None else json.loads(raw)


def test_count_up_settles_immediately_when_reduced():
    ctx = _engine()
    ctx.eval("__reduce = true; var node = { textContent: '' };")
    ctx.eval("MOTION.countUp(node, 0, -13.4, { digits: 1, format: function(v){ return v.toFixed(1); } });")
    assert _json(ctx, "node.textContent") == "-13.4"
    assert _json(ctx, "_raf.length") == 0, "降级模式下不应排队动画帧"


def test_count_up_reaches_exact_value():
    ctx = _engine()
    ctx.eval("var node = { textContent: '' };")
    ctx.eval("MOTION.countUp(node, 0, 10, { digits: 1, format: function(v){ return v.toFixed(1); } });")
    assert _json(ctx, "node.textContent") == "", "动画开始前不应先写值"
    ctx.eval("flushRAF(0); flushRAF(300);")
    mid = float(_json(ctx, "node.textContent"))
    assert 0 < mid < 10, "中途应是插值"
    ctx.eval("flushRAF(600);")
    assert _json(ctx, "node.textContent") == "10.0"


def test_count_up_clamps_long_durations():
    ctx = _engine()
    ctx.eval("var node = { textContent: '' };")
    ctx.eval("MOTION.countUp(node, 0, 5, { duration: 5000, digits: 1, format: function(v){ return v.toFixed(1); } });")
    ctx.eval("flushRAF(0); flushRAF(649);")
    assert _json(ctx, "node.textContent") == "5.0", "时长上限 650ms，超过要截断"


def test_stagger_in_marks_entered_and_clears_inline_style():
    ctx = _engine()
    ctx.eval("var a = new El(), b = new El(); MOTION.staggerIn([a, b], { stagger: 40, duration: 300 });")
    assert _json(ctx, "a.className") == "enter"
    ctx.eval("flushRAF(0); flushRAF(16);")
    assert _json(ctx, "a.className") == "entered"
    assert _json(ctx, "b.style.transitionDelay") == "40ms"
    ctx.eval("runTimers();")
    assert _json(ctx, "b.style.transitionDelay") == "", "结束后必须清掉内联 transition，否则 hover 也被延迟"


def test_stagger_in_skips_reduced_motion():
    ctx = _engine()
    ctx.eval("__reduce = true; var a = new El(); MOTION.staggerIn([a]);")
    assert _json(ctx, "a.className") == ""
    assert _json(ctx, "a.style.transitionDuration") is None or _json(ctx, "a.style.transitionDuration") == ""


def test_low_end_only_for_very_weak_devices():
    ctx = _engine()
    assert _json(ctx, "MOTION.lowEndDevice()") is False
    ctx.eval("__cores = 2;")
    assert _json(ctx, "MOTION.lowEndDevice()") is True
    ctx.eval("__cores = 8; __coarse = true;")
    assert _json(ctx, "MOTION.lowEndDevice()") is False, "触屏设备不应被当成低端机"


def test_count_up_settles_even_if_raf_never_runs():
    """后台标签页 rAF 被节流时，定时器兜底必须把数字落到目标值。"""
    ctx = _engine()
    ctx.eval("var node = { textContent: '' };")
    ctx.eval("MOTION.countUp(node, 0, -7, { digits: 1, format: function(v){ return v.toFixed(1); } });")
    ctx.eval("runTimers();")
    assert _json(ctx, "node.textContent") == "-7.0"


def test_stagger_in_reveals_content_even_if_raf_never_runs():
    ctx = _engine()
    ctx.eval("var a = new El(), b = new El(); MOTION.staggerIn([a, b], { stagger: 40, duration: 300 });")
    assert _json(ctx, "a.className") == "enter"
    ctx.eval("runTimers();")
    assert _json(ctx, "a.className") == "entered"
    assert _json(ctx, "b.className") == "entered"
    assert _json(ctx, "a.style.transitionDelay") == ""


def test_observe_once_without_intersection_observer_runs_immediately():
    ctx = _engine()
    ctx.eval("var called = 0; MOTION.observeOnce({ dataset: {} }, function () { called++; });")
    assert _json(ctx, "called") == 1


# ------------------------------------------------------------------ 主题切换
THEME_SHIM = r"""
var _store = {}, _clickHandlers = [], _dispatched = [];
var localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : null; },
  setItem: function (k, v) { _store[k] = String(v); }
};
function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; }
var _btn = {
  textContent: '', attrs: {}, title: '',
  setAttribute: function (k, v) { this.attrs[k] = v; },
  addEventListener: function (ev, fn) { _clickHandlers.push(fn); }
};
var document = {
  documentElement: { dataset: {} },
  getElementById: function () { return _btn; },
  addEventListener: function () { }
};
var window = { dispatchEvent: function (ev) { _dispatched.push(ev); return true; } };
var location = { search: '' };
function URLSearchParams(q) {
  this.get = function (k) {
    var m = String(q || '').match(new RegExp('[?&]' + k + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
}
"""


def _theme_engine(search=None):
    ctx = quickjs.Context()
    ctx.eval(THEME_SHIM)
    if search:
        ctx.eval("location.search = %s;" % json.dumps(search))
    ctx.eval(_read("assets", "theme.js"))
    ctx.eval("var THEME = window.THEME;")
    return ctx


def test_theme_defaults_to_dark():
    ctx = _theme_engine()
    assert _json(ctx, "document.documentElement.dataset.theme") == "dark"
    assert _json(ctx, "THEME.current()") == "dark"
    assert _json(ctx, "_store.sb_theme_v1") is None, "默认主题不应写入 localStorage"


def test_theme_toggle_persists_and_broadcasts():
    ctx = _theme_engine()
    ctx.eval("THEME.toggle();")
    assert _json(ctx, "THEME.current()") == "light"
    assert _json(ctx, "_store.sb_theme_v1") == "light"
    assert _json(ctx, "_btn.textContent") == "☀ 浅色"
    assert _json(ctx, "_dispatched.length") == 1
    assert _json(ctx, "_dispatched[0].detail.theme") == "light"
    ctx.eval("THEME.toggle();")
    assert _json(ctx, "THEME.current()") == "dark"
    assert _json(ctx, "_store.sb_theme_v1") == "dark"


def test_theme_url_preview_does_not_persist():
    ctx = _theme_engine("?theme=light")
    assert _json(ctx, "document.documentElement.dataset.theme") == "light"
    assert _json(ctx, "_store.sb_theme_v1") is None
