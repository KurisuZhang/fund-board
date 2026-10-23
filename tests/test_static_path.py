"""静态版（GitHub Pages）数据通路的离线仿真测试。

用 quickjs 模拟浏览器环境：把 fetch / JSONP 的 <script> 注入 / TextDecoder 换成同步桥接到 Python requests，
然后真正跑一遍 assets/datafeed.js —— 不需要浏览器也能验证
"腾讯 fetch + 新浪 JSONP + 除权修复 + 新闻过滤 + 打分" 整条链路。

这套仿真在开发中抓出过两个真实缺陷（新闻 JSONP 回调未定义、回调名非法被新浪拒绝），
因此保留为回归测试。
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEPS = os.path.join(ROOT, ".deps", "quickjs")
sys.path.insert(0, DEPS)


def _load_quickjs():
    try:
        import quickjs
        return quickjs
    except Exception:
        return None


quickjs = _load_quickjs()
pytestmark = pytest.mark.skipif(quickjs is None, reason="未安装 quickjs（pip install --target .deps/quickjs quickjs）")


SHIM = r"""
var window = globalThis;
function fetch(url) {
  return new Promise(function (resolve, reject) {
    var text = __http_get(url);           // 失败时返回空串，由 JS 侧判定失败
    if (!text) { reject(new Error('空响应')); return; }
    resolve({
      ok: true, status: 200,
      text: function () { return Promise.resolve(text); },
      arrayBuffer: function () { return Promise.resolve({ __text: text }); }
    });
  });
}
function TextDecoder(enc) {
  this.decode = function (buf) { return buf && buf.__text !== undefined ? buf.__text : String(buf); };
}
var document = {
  head: {
    appendChild: function (script) {
      var text = __http_get(script.src);
      if (!text) { if (script.onerror) script.onerror(new Error('空响应')); return script; }
      try {
        (0, eval)(text);
        if (script.onload) script.onload();
      } catch (e) {
        if (script.onerror) script.onerror(e);
      }
      return script;
    }
  },
  createElement: function () {
    var s = { remove: function () {}, onload: null, onerror: null, _src: '' };
    Object.defineProperty(s, 'src', { get: function () { return s._src; }, set: function (v) { s._src = v; } });
    return s;
  },
  addEventListener: function () {},
  querySelector: function () { return null; },
  getElementById: function () { return null; }
};
function setTimeout(fn, ms) {
  if (ms >= 7000) return 0;               // 超时计时器：仿真中不触发
  Promise.resolve().then(fn);             // 重试退避（几百毫秒）：立即排队执行
  return 1;
}
function clearTimeout() {}
"""


@pytest.fixture(scope="module")
def browser():
    import requests

    ctx = quickjs.Context()
    try:
        ctx.set_max_stack_size(8 * 1024 * 1024)
    except Exception:  # noqa: BLE001
        pass
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (static-path-sim)"})
    stats = {"calls": 0, "fail": [], "urls": []}

    def http_get(url):
        stats["calls"] += 1
        stats["urls"].append(url)
        headers = {"Referer": "https://finance.sina.com.cn"} if "sina" in url else {}
        try:
            resp = session.get(url, headers=headers, timeout=20)
        except Exception as exc:  # noqa: BLE001
            stats["fail"].append("%s: %s" % (url[:60], exc))
            return ""
        if resp.status_code != 200:
            stats["fail"].append("HTTP %s %s" % (resp.status_code, url[:60]))
            return ""
        if "gtimg.cn" in url:
            return resp.content.decode("gbk", errors="replace")
        return resp.text

    ctx.add_callable("__http_get", http_get)
    ctx.eval(SHIM)
    for name in ("indicators.js", "scoring.js", "datafeed.js"):
        ctx.eval(open(os.path.join(ROOT, "assets", name), encoding="utf-8").read())
    return {"ctx": ctx, "stats": stats}


def _drain(ctx, limit=20000):
    for _ in range(limit):
        if not ctx.execute_pending_job():
            return
    raise AssertionError("Promise 队列未能在预期步数内清空（可能存在死循环等待）")


def _run(browser, js_call):
    ctx = browser["ctx"]
    ctx.eval("var OUT=null, ERR=null;")
    ctx.eval("%s.then(function(v){OUT=v;}).catch(function(e){ERR=String(e);});" % js_call)
    _drain(ctx)
    err = ctx.eval("ERR")
    if err:
        pytest.fail("JS 调用失败：%s" % err)
    return json.loads(ctx.eval("JSON.stringify(OUT)"))


def test_quotes_parse(browser):
    data = _run(browser, "FEED.quotes(['sz159305','sz300750'])")
    assert data["sz159305"]["price"] > 0
    assert data["sz159305"]["name"]
    assert data["sz159305"]["changePct"] is not None


def test_jsonp_index_and_futures(browser):
    idx = _run(browser, "FEED.indexKline('sz980027', 60)")
    assert len(idx) >= 30
    assert idx[-1]["c"] > 0
    fut = _run(browser, "FEED.futuresKline('LC0')")
    assert len(fut) >= 100
    assert fut[-1]["c"] > 0


def test_news_jsonp_returns_items(browser):
    roll = _run(browser, "FEED.newsRoll(1)")
    assert len(roll) > 0, "滚动新闻 JSONP 未返回数据"
    zhibo = _run(browser, "FEED.newsZhibo(1)")
    assert len(zhibo) > 0, "7x24 快讯 JSONP 未返回数据"
    assert all(item["title"] for item in roll[:5])


def test_adjust_splits_repairs_gap(browser):
    ctx = browser["ctx"]
    ctx.eval("""
      var BARS=[
        {d:'2026-05-19',o:2.1,h:2.2,l:2.0,c:2.1,v:100,a:21000},
        {d:'2026-05-20',o:2.2,h:2.25,l:2.15,c:2.203,v:110,a:24233},
        {d:'2026-05-21',o:1.06,h:1.07,l:1.05,c:1.058,v:220,a:23276},
        {d:'2026-05-22',o:1.07,h:1.09,l:1.06,c:1.079,v:210,a:22659}
      ];
      var ADJ=FEED.adjustSplits(BARS,'sz159305');
    """)
    out = json.loads(ctx.eval("JSON.stringify(ADJ.bars)"))
    ratios = [out[i]["c"] / out[i - 1]["c"] for i in range(1, len(out))]
    assert max(abs(r - 1) for r in ratios) < 0.12, "除权缺口未被修复"
    events = json.loads(ctx.eval("JSON.stringify(ADJ.events)"))
    assert len(events) == 1 and events[0]["date"] == "2026-05-21"


def test_filter_news_keeps_relevance(browser):
    ctx = browser["ctx"]
    ctx.eval("""
      var RULES_REL = ['储能','碳酸锂'];
      var ITEMS=[
        {ts:300,title:'储能招标规模超预期',url:'',source:'t'},
        {ts:200,title:'某明星离婚',url:'',source:'t'},
        {ts:100,title:'碳酸锂价格下跌',url:'',source:'t'}
      ];
      var FILTERED = FEED.filterNews(ITEMS, RULES_REL);
    """)
    out = json.loads(ctx.eval("JSON.stringify(FILTERED)"))
    assert [x["title"] for x in out] == ["储能招标规模超预期", "碳酸锂价格下跌"]


def test_full_static_pipeline_scoring(browser):
    """完整静态链路：抓数 → 组装 → 打分（真实网络）。"""
    ctx = browser["ctx"]
    rules = open(os.path.join(ROOT, "shared", "scoring_rules.json"), encoding="utf-8").read()
    ctx.eval("var RULES=" + rules + ";")
    ctx.eval("var BUILT=null, BUILT_ERR=null;")
    ctx.eval("FEED.buildInput(RULES).then(function(r){BUILT=r;}).catch(function(e){BUILT_ERR=String(e);});")
    _drain(ctx)

    err = ctx.eval("BUILT_ERR")
    assert not err, "静态链路失败：%s（失败请求：%s）" % (err, browser["stats"]["fail"][:3])

    built = json.loads(ctx.eval("JSON.stringify(BUILT)"))
    inp, meta = built["input"], built["meta"]
    assert meta["mode"] == "static"
    assert len(inp["etf"]["bars"]) >= 60
    assert len(inp["futures"]["bars"]) >= 60
    assert len(inp["stocks"]) == 23
    assert meta["dataDate"]

    bars = inp["etf"]["bars"]
    jumps = [abs(bars[i]["c"] / bars[i - 1]["c"] - 1) for i in range(1, len(bars))]
    assert max(jumps) < 0.12, "ETF 序列仍存在除权跳变"

    score = json.loads(ctx.eval("JSON.stringify(SCORING.scoreDashboard(BUILT.input, RULES))"))
    assert -100 <= score["total"] <= 100
    assert score["label"] in ("偏多", "中性", "偏空")
    json.dump({"input": inp, "meta": meta, "score": score},
              open(os.path.join(ROOT, "data", "static_path_sample.json"), "w", encoding="utf-8"),
              ensure_ascii=False)


def test_futures_change_shown_in_both_modes():
    """碳酸锂卡片必须显示「较昨日」涨跌：实时口径用昨结算，日线口径用上一交易日收盘。"""
    ctx = quickjs.Context()
    ctx.eval("""
      var window = globalThis;
      var document = {
        addEventListener: function () {}, getElementById: function () { return null; },
        querySelector: function () { return null; },
        createElement: function () { return { style: {}, appendChild: function () {} }; }
      };
      var module = { exports: {} }; var exports = module.exports;
    """)
    for name in ("indicators.js", "scoring.js", "datafeed.js", "app.js"):
        ctx.eval(open(os.path.join(ROOT, "assets", name), encoding="utf-8").read())

    # 本地口径：有实时价 → 与昨结算价比
    ctx.eval("""
      var LOCAL = { futures: [{d:'2026-10-21',c:95040},{d:'2026-10-22',c:94180}],
        futuresRealtime: {price:94180, prevSettle:94500, prevClose:97680, date:'2026-10-22'} };
      var LIVE = module.exports.futuresQuoteOf(LOCAL);
      var LIVE_NOTE = module.exports.futuresFactNote(LIVE);
    """)
    live = json.loads(ctx.eval("JSON.stringify(LIVE)"))
    assert live["isRealtime"] is True
    assert live["basis"] == "较昨结算"
    assert live["base"] == 94500
    assert round(live["change"]) == -320
    assert round(live["changePct"], 2) == -0.34
    note = ctx.eval("LIVE_NOTE")
    assert "▼" in note and "-320" in note and "较昨结算" in note and "94500" in note

    # 静态口径：无实时价 → 与上一交易日收盘比
    ctx.eval("""
      var STATIC = { futures: LOCAL.futures, futuresRealtime: null };
      var DAILY = module.exports.futuresQuoteOf(STATIC);
      var DAILY_NOTE = module.exports.futuresFactNote(DAILY);
    """)
    daily = json.loads(ctx.eval("JSON.stringify(DAILY)"))
    assert daily["isRealtime"] is False
    assert daily["basis"] == "较上一交易日收盘"
    assert daily["base"] == 95040
    assert round(daily["change"]) == -860
    note2 = ctx.eval("DAILY_NOTE")
    assert "▼" in note2 and "-860" in note2 and "95040" in note2

    # 上涨时用 ▲ 且带正号
    ctx.eval("""
      var UP = module.exports.futuresQuoteOf({futures:[{d:'d1',c:100},{d:'d2',c:105}], futuresRealtime:null});
      var UP_NOTE = module.exports.futuresFactNote(UP);
    """)
    up = json.loads(ctx.eval("JSON.stringify(UP)"))
    assert up["change"] == 5 and round(up["changePct"], 9) == 5
    assert "▲" in ctx.eval("UP_NOTE") and "+5" in ctx.eval("UP_NOTE")


# ---------------------------------------------------------------- 前端资产
def test_index_html_references_existing_assets():
    """静态版只有一个入口；脚本顺序即依赖顺序，缺一个就白屏。"""
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        html = f.read()
    import re

    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    local = [r for r in refs if not r.startswith(("http", "data:", "#"))
             and not r.startswith("/api")]
    assert local, "index.html 应该引用本地 assets"
    for rel in local:
        assert os.path.exists(os.path.join(ROOT, rel)), "缺少文件：%s" % rel

    scripts = re.findall(r'<script src="([^"]+)"', html)
    order = [os.path.basename(s) for s in scripts]
    assert order.index("echarts.min.js") < order.index("charts.js") < order.index("app.js")
    assert order.index("motion.js") < order.index("app.js")
    assert order.index("theme.js") < order.index("app.js")
    assert 'data-theme="dark"' in html, "首屏必须是深色，避免闪白"


def test_frontend_modules_parse():
    """charts.js / motion.js / theme.js 在浏览器里是独立 IIFE，这里只验证能解析且导出存在。"""
    ctx = quickjs.Context()
    ctx.eval("""
      var window = { matchMedia: function(){ return { matches: false }; },
                     addEventListener: function(){}, setTimeout: function(){ return 1; },
                     dispatchEvent: function(){}, location: { search: '' } };
      var navigator = { hardwareConcurrency: 8 };
      var localStorage = { getItem: function(){ return null; }, setItem: function(){} };
      var document = { documentElement: { dataset: {} }, getElementById: function(){ return null; },
                       querySelector: function(){ return null; }, addEventListener: function(){} };
      var CustomEvent = function(t, o){ this.type = t; this.detail = (o||{}).detail; };
      var requestAnimationFrame = function(fn){ return 1; };
      var echarts = { init: function(){ return { setOption: function(){}, resize: function(){},
                                                 isDisposed: function(){ return false; }, clear: function(){} }; } };
    """)
    for name in ("motion.js", "theme.js", "charts.js"):
        with open(os.path.join(ROOT, "assets", name), encoding="utf-8") as f:
            ctx.eval(f.read())
    assert json.loads(ctx.eval("JSON.stringify(!!window.MOTION)")) is True
    assert json.loads(ctx.eval("JSON.stringify(!!window.THEME)")) is True
    assert json.loads(ctx.eval("JSON.stringify(!!window.CHARTS)")) is True
    assert json.loads(ctx.eval("JSON.stringify(window.THEME.current())")) == "dark"


def test_summary_fixture_is_shipped_for_static_mode():
    """静态版没有后端，历史胜率只能读仓库里的 JSON；缺了页面会显示"暂无统计快照"。"""
    path = os.path.join(ROOT, "assets", "fixtures", "backtest_summary.json")
    assert os.path.exists(path), "assets/fixtures/backtest_summary.json 必须随仓库发布"
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert data["buckets"] and data["hold"] == 5
