"""页面文案 / 多空力量 / 关键价位 / 胜率分桶：直接跑 assets/app.js 的纯函数。

这些函数的输出直接显示给用户，口径错了"看起来没坏但会说错话"，所以单独锁测试。
"""
import json
import os
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


SCORE = {
    "total": -13.0,
    "label": "中性",
    "components": [
        {"label": "基本面（50）", "weight": 50, "max": 50, "score": 0.0, "ratio": 0.0, "items": [
            {"key": "cost", "label": "上游成本/景气", "max": 18, "score": -6, "value": "94180 元/吨"},
            {"key": "valuation", "label": "板块估值", "max": 12, "score": 12, "value": "17.6×"},
            {"key": "breadth", "label": "景气广度", "max": 12, "score": -12,
             "value": "1/23 只站上MA20 = 4%"},
            {"key": "news", "label": "新闻情绪", "max": 8, "score": 6, "value": "28 条"},
        ]},
        {"label": "量能（30）", "weight": 30, "max": 30, "score": -5.0, "ratio": -17, "items": [
            {"key": "expansion", "label": "成交额扩张", "max": 10, "score": -5, "value": "0.9 倍"},
        ]},
        {"label": "技术（20）", "weight": 20, "max": 20, "score": -8.0, "ratio": -40, "items": [
            {"key": "ma", "label": "均线结构", "max": 8, "score": -8, "value": "空头排列"},
        ]},
    ],
    "missing": [],
    "notes": [],
}

CHARTS = {
    "etf": [{"d": "2026-10-21", "c": 0.646, "ma20": 0.75},
            {"d": "2026-10-22", "c": 0.63, "ma20": 0.724}],
    "futures": [{"d": "2026-09-%02d" % i, "c": 100000 + i * 100} for i in range(1, 22)],
    "futuresRealtime": None,
}

SUMMARY = {
    "hold": 5, "bucketWidth": 10, "minSamples": 8, "generatedAt": "2026-10-23",
    "buckets": [
        {"bucket": -30, "label": "-30~-20", "samples": 21, "winRate": 52.4, "avgReturn": 0.05,
         "medianReturn": 0.05},
        {"bucket": -20, "label": "-20~-10", "samples": 25, "winRate": 24.0, "avgReturn": -1.85,
         "medianReturn": -1.73},
    ],
}


def _build_engine():
    c = quickjs.Context()
    c.eval("var window = { IND: null }; var module = { exports: {} };")
    c.eval(_read("assets", "app.js"))
    # app.js 是 IIFE，纯函数挂在 module.exports 上；这里提到全局方便调用
    c.eval("var narrativeOf = module.exports.narrativeOf, bullBear = module.exports.bullBear,"
           " keyLevels = module.exports.keyLevels, winRateOf = module.exports.winRateOf,"
           " futuresQuoteOf = module.exports.futuresQuoteOf,"
           " futuresChangeText = module.exports.futuresChangeText,"
           " futuresFactNote = module.exports.futuresFactNote;")
    c.eval("var SCORE = " + json.dumps(SCORE, ensure_ascii=False) + ";")
    c.eval("var CHARTS = " + json.dumps(CHARTS, ensure_ascii=False) + ";")
    c.eval("var SUMMARY = " + json.dumps(SUMMARY, ensure_ascii=False) + ";")
    c.eval('var RULES = {"signal": {"bull": 25, "bear": -25}, "fundamental": {}};')
    return c


@pytest.fixture(scope="module")
def ctx_env():
    return _build_engine()


def _json(expr):
    return json.loads(ctx_env().eval("JSON.stringify(%s)" % expr))


def ctx_env():
    """模块级单例引擎（app.js 里全是纯函数，复用即可）。"""
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = _build_engine()
    return _ENGINE


_ENGINE = None


# --------------------------------------------------------------- 一句话结论
def test_narrative_neutral_wording():
    text = _json("narrativeOf(SCORE)")
    assert text.startswith("短线纠结")
    assert "基本面（50） 0/50 持平" in text
    assert "最拖后腿的是「景气广度」-12 分" in text
    assert "支撑来自「板块估值」+12 分" in text


def test_narrative_bull_and_bear_heads():
    assert _json("narrativeOf({total: 40, components: SCORE.components}).slice(0,4)") == "短线偏多"
    assert _json("narrativeOf({total: -40, components: SCORE.components}).slice(0,4)") == "短线偏空"


def test_narrative_mentions_missing_dimensions():
    text = _json("narrativeOf({total: -10, components: SCORE.components, missing: ['新闻情绪']})")
    assert "新闻情绪" in text and "归一" in text


def test_narrative_handles_empty_score():
    assert _json("narrativeOf({components: []})") == "暂无可用于判断的数据。"


# --------------------------------------------------------------- 多空力量
def test_bull_bear_sums_and_ranks():
    bb = _json("bullBear(SCORE)")
    assert bb["bull"] == 18.0          # 12 + 6
    assert bb["bear"] == 31.0          # 6 + 12 + 5 + 8
    labels = [t["label"] for t in bb["top"]]
    assert "景气广度" in labels and "板块估值" in labels
    assert len(bb["top"]) == 3
    assert [abs(t["score"]) for t in bb["top"]] == sorted((abs(t["score"]) for t in bb["top"]), reverse=True)


def test_bull_bear_skips_missing_items():
    score = json.loads(json.dumps(SCORE))
    score["components"][0]["items"][1]["missing"] = True
    ctx_env().eval("var S2 = " + json.dumps(score, ensure_ascii=False) + ";")
    bb = _json("bullBear(S2)")
    assert bb["bull"] == 6.0           # 估值 +12 被标记缺失后不再计入


# --------------------------------------------------------------- 关键价位
def test_key_levels_ma20_gap_and_breadth():
    levels = _json("keyLevels(CHARTS, SCORE, RULES)")
    by_label = {x["label"]: x for x in levels}

    assert "收复 MA20 还需" in by_label                              # 0.724 / 0.63 - 1 ≈ +14.9%
    assert by_label["收复 MA20 还需"]["value"] == "+14.9%"
    assert by_label["收复 MA20 还需"]["tone"] == "up"

    assert by_label["广度回到 50%"]["value"] == "+11 只翻红"        # ceil(23*0.5)-1
    assert by_label["广度回到 50%"]["tone"] == "down"

    assert by_label["综合分转为偏多"]["value"] == "+38.0 分"        # 25 - (-13)
    assert by_label["综合分转为偏多"]["note"] == "阈值 +25"


def test_key_levels_marks_threshold_already_hit():
    levels = _json("keyLevels(CHARTS, {total: 30, components: []}, RULES)")
    hit = [x for x in levels if x["label"] == "综合分转为偏多"][0]
    assert hit["value"] == "已触发" and hit["tone"] == "up"


def test_key_levels_without_etf_bars_keeps_score_driven_levels():
    """没有 K 线时，MA20 / 期货价位缺失，但广度与阈值仍可给出。"""
    levels = _json("keyLevels({}, SCORE, RULES)")
    assert [x["label"] for x in levels] == ["广度回到 50%", "综合分转为偏多"]


# --------------------------------------------------------------- 胜率分桶
def test_win_rate_picks_floor_bucket():
    wr = _json("winRateOf(SCORE, SUMMARY)")
    assert wr["bucket"] == -20
    assert wr["label"] == "-20~-10"
    assert wr["samples"] == 25
    assert wr["winRate"] == 24.0
    assert wr["hold"] == 5
    assert wr["enough"] is True


def test_win_rate_marks_thin_samples():
    wr = _json("winRateOf(SCORE, {bucketWidth:10, minSamples:8, hold:5, buckets:["
                   "{bucket:-20,label:'-20~-10',samples:3,winRate:33.3,avgReturn:0.1,medianReturn:0.1}]})")
    assert wr["samples"] == 3 and wr["enough"] is False


def test_win_rate_empty_bucket():
    wr = _json("winRateOf({total: -63, components: []}, SUMMARY)")
    assert wr["empty"] is True and wr["bucket"] == -70


def test_win_rate_without_snapshot():
    assert _json("winRateOf(SCORE, null)") is None


# ---------------------------------------------- 期货卡片（回归：必须显示涨跌）
def test_futures_prefers_prev_settle_basis():
    fq = _json("futuresQuoteOf({futuresRealtime: "
                    "{price: 94180, prevSettle: 94500, prevClose: 97680, date: '2026-10-22'}})")
    assert fq["basis"] == "较昨结算"
    assert fq["change"] == -320
    assert round(fq["changePct"], 2) == -0.34


def test_futures_daily_fallback_uses_previous_close():
    fq = _json("futuresQuoteOf({futures: [{d: '2026-10-21', c: 95040}, "
                    "{d: '2026-10-22', c: 94180}]})")
    assert fq["isRealtime"] is False
    assert fq["basis"] == "较上一交易日收盘"
    assert fq["change"] == -860
    assert round(fq["changePct"], 2) == -0.9     # 页面显示 -0.90%


def test_futures_change_text_has_arrow_and_pct():
    text = _json("futuresChangeText(futuresQuoteOf({futuresRealtime:"
                      "{price: 94180, prevSettle: 94500}}))")
    assert text.startswith("▼")
    assert "-320" in text and "-0.34%" in text


def test_futures_empty_data_is_safe():
    fq = _json("futuresQuoteOf({})")
    assert fq["price"] is None
    assert _json("futuresChangeText(futuresQuoteOf({}))") == "暂无对比数据"
