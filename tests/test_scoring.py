import json
import os

import pytest

import scoring

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_rules():
    with open(os.path.join(ROOT, "shared", "scoring_rules.json"), encoding="utf-8") as f:
        return json.load(f)


RULES = load_rules()


def make_bars(closes, amount=1.0e8, volume=1.0e6):
    """构造 K 线：vwap ≈ close（收盘贴均价），便于断言主动性指标。"""
    bars = []
    for i, c in enumerate(closes):
        v = volume
        a = c * v * 100.0
        bars.append({"d": "2026-01-%02d" % (i % 28 + 1), "o": c, "h": c * 1.01,
                     "l": c * 0.99, "c": c, "v": v, "a": a * (amount / 1.0e8)})
    return bars


def base_input(closes=None, stocks=None, news=None, futures_closes=None, as_of=1.8e9):
    closes = closes or [1.0 + 0.001 * i for i in range(320)]
    futures_closes = futures_closes or [90000 + 10 * i for i in range(400)]
    return {
        "etf": {"price": closes[-1], "changePct": 0.0, "bars": make_bars(closes)},
        "index": {"bars": make_bars(closes)},
        "futures": {"bars": make_bars(futures_closes), "close": futures_closes[-1]},
        "stocks": stocks if stocks is not None else [
            {"code": "sz%06d" % i, "name": "s%d" % i, "price": 10,
             "pe": 20.0, "marketCap": 100.0, "bars": make_bars(closes[-120:])}
            for i in range(23)
        ],
        "news": news if news is not None else [
            {"ts": as_of - 3600, "title": "储能招标中标规模超预期"}
            for _ in range(10)
        ],
        "asOf": as_of,
    }


def test_total_within_bounds():
    out = scoring.score_dashboard(base_input(), RULES)
    assert -100.0 <= out["total"] <= 100.0
    assert out["label"] in ("偏多", "中性", "偏空")
    assert len(out["components"]) == 3


def test_group_maxima_sum_to_weights():
    out = scoring.score_dashboard(base_input(), RULES)
    by_key = {g["key"]: g for g in out["components"]}
    assert by_key["fundamental"]["max"] == 50
    assert by_key["volume"]["max"] == 30
    assert by_key["technical"]["max"] == 20


def test_breadth_extremes():
    all_up = [{"code": "sz%06d" % i, "name": "s", "pe": 20.0, "marketCap": 100.0,
               "bars": make_bars([1.0 + 0.01 * j for j in range(30)])} for i in range(12)]
    item = scoring.score_breadth(all_up, RULES["fundamental"]["breadth"])
    assert item["score"] == 12

    all_down = [{"code": "sz%06d" % i, "name": "s", "pe": 20.0, "marketCap": 100.0,
                 "bars": make_bars([5.0 - 0.01 * j for j in range(30)])} for i in range(12)]
    item = scoring.score_breadth(all_down, RULES["fundamental"]["breadth"])
    assert item["score"] == -12


def test_breadth_insufficient_samples_is_missing():
    few = [{"code": "sz1", "name": "s", "pe": 20.0, "marketCap": 100.0,
            "bars": make_bars([1.0] * 30)}]
    item = scoring.score_breadth(few, RULES["fundamental"]["breadth"])
    assert item["missing"] is True
    assert item["reason"].startswith("有效样本不足")


def test_valuation_drops_negative_pe():
    stocks = []
    for i in range(20):
        stocks.append({"code": "sz%06d" % i, "name": "s", "pe": -5.0, "marketCap": 100.0,
                       "bars": make_bars([1.0] * 30)})
    item = scoring.score_valuation(stocks, RULES["fundamental"]["valuation"])
    assert item["missing"] is True


def test_valuation_buckets():
    cheap = [{"code": "sz%03d" % i, "name": "s", "pe": 10.0, "marketCap": 100.0,
              "bars": make_bars([1.0] * 30)} for i in range(5)]
    assert scoring.score_valuation(cheap, RULES["fundamental"]["valuation"])["score"] == 12
    rich = [{"code": "sz%03d" % i, "name": "s", "pe": 80.0, "marketCap": 100.0,
             "bars": make_bars([1.0] * 30)} for i in range(5)]
    assert scoring.score_valuation(rich, RULES["fundamental"]["valuation"])["score"] == -12


def test_news_insufficient_samples_is_missing():
    item = scoring.score_news([{"ts": 1.8e9, "title": "储能"}], 1.8e9, RULES["fundamental"]["news"])
    assert item["missing"] is True


def test_news_polarity_signs():
    as_of = 1.8e9
    pos = [{"ts": as_of - 3600, "title": "储能招标中标，装机超预期涨价"} for _ in range(10)]
    neg = [{"ts": as_of - 3600, "title": "储能电池降价，行业亏损产能过剩"} for _ in range(10)]
    assert scoring.score_news(pos, as_of, RULES["fundamental"]["news"])["score"] > 0
    assert scoring.score_news(neg, as_of, RULES["fundamental"]["news"])["score"] < 0


def test_cost_missing_when_futures_absent():
    inp = base_input()
    inp["futures"] = {"bars": []}
    out = scoring.score_dashboard(inp, RULES)
    assert "cost" in out["missing"]
    assert "cost" not in [i["key"] for g in out["components"] for i in g["items"] if not i["missing"]]


def test_renormalization_note_when_missing():
    inp = base_input()
    inp["futures"] = {"bars": []}
    inp["news"] = []
    out = scoring.score_dashboard(inp, RULES)
    assert any("归一" in n for n in out["notes"])
    assert any("归一" in n for n in out["notes"])


def test_no_data_at_all():
    inp = {"etf": {"bars": []}, "stocks": [], "news": [], "futures": {"bars": []}, "asOf": 1.8e9}
    out = scoring.score_dashboard(inp, RULES)
    assert out["label"] == "数据缺失"
    assert out["total"] == 0.0


def test_signal_labels():
    assert scoring.label_of(25.0, RULES) == "偏多"
    assert scoring.label_of(24.9, RULES) == "中性"
    assert scoring.label_of(-25.0, RULES) == "偏空"
    assert scoring.label_of(-24.9, RULES) == "中性"


def test_scoring_is_deterministic():
    a = scoring.score_dashboard(base_input(), RULES)
    b = scoring.score_dashboard(base_input(), RULES)
    assert json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)


def test_uptrend_scores_above_downtrend():
    up = scoring.score_dashboard(base_input(closes=[1.0 + 0.004 * i for i in range(320)]), RULES)
    down = scoring.score_dashboard(base_input(closes=[3.0 - 0.004 * i for i in range(320)]), RULES)
    assert up["total"] > down["total"]
