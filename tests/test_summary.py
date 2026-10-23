"""历史胜率快照：分桶口径、信号日、以及随仓库发布的 JSON 结构。"""
import json
import os

import pytest

from backtest_summary import WARMUP, bucket_stats, build_summary, daily_totals, signal_dates

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "assets", "fixtures", "backtest_summary.json")


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------------ 分桶口径
def test_bucket_uses_floor_not_round():
    """-13 应该落在 -20~-10（向下取整），而不是 -10~0。"""
    stats = bucket_stats([(-13.0, 1.0)], 10)
    assert stats[0]["bucket"] == -20
    assert stats[0]["label"] == "-20~-10"


def test_bucket_stats_aggregates_and_rounds():
    stats = bucket_stats([(-13, 2.0), (-13, -1.0), (-13, 0.0), (25, -1.0)], 10)
    low = [s for s in stats if s["bucket"] == -20][0]
    assert low["samples"] == 3
    assert low["winRate"] == 33.3           # 只有 1 个正收益
    assert low["avgReturn"] == 0.33         # (2 - 1 + 0) / 3 = 0.333…
    # 偶数样本取上中位数（index n//2），口径固定便于两端对齐
    assert low["medianReturn"] == 0.0


def test_bucket_stats_sorted_ascending():
    stats = bucket_stats([(42, 3.0), (-58, -4.0), (5, 1.0)], 10)
    assert [s["bucket"] for s in stats] == sorted(s["bucket"] for s in stats)


# ------------------------------------------------------------------ 信号日
def test_signal_dates_only_on_crossing_up():
    rows = [
        {"d": "d1", "total": 5},
        {"d": "d2", "total": 30},    # 首次越过 +25：信号
        {"d": "d3", "total": 40},    # 仍在阈值上：不算新信号
        {"d": "d4", "total": 10},    # 跌回阈值下
        {"d": "d5", "total": 26},    # 再次越过：信号
    ]
    assert signal_dates(rows, 25) == ["d2", "d5"]


def test_signal_dates_ignores_already_above_start():
    rows = [{"d": "d1", "total": 60}, {"d": "d2", "total": 61}]
    assert signal_dates(rows, 25) == []


# --------------------------------------------------------------- 逐日打分
def _fake_bars(n, start=1.0, step=0.004):
    bars = []
    price = start
    for i in range(n):
        day = "2026-01-%02d" % (i + 1) if i < 31 else "2026-02-%02d" % (i - 30)
        o = price * 0.998
        c = price * 1.002
        bars.append({"d": day, "o": round(o, 4), "h": round(max(o, c) * 1.004, 4),
                     "l": round(min(o, c) * 0.996, 4), "c": round(c, 4), "v": 1000 + i})
        price *= (1 + step)
    return bars


def _rules():
    return _read_json(os.path.join(ROOT, "shared", "scoring_rules.json"))


def test_daily_totals_length_and_bounds():
    rules = _rules()
    bars = _fake_bars(WARMUP + 12)
    rows = daily_totals(bars, bars, rules)
    assert len(rows) == 12                       # 只从 warmup 之后开始
    assert rows[0]["d"] == bars[WARMUP]["d"]
    for r in rows:
        assert -100 <= r["total"] <= 100


def test_daily_totals_skips_when_futures_missing():
    rules = _rules()
    bars = _fake_bars(WARMUP + 6)
    rows = daily_totals(bars, bars[-WARMUP + 2:], rules)   # 期货样本不足 warmup
    assert len(rows) < 6


class _FakeFeed:
    def __init__(self, bars):
        self._bars = bars

    def stock_kline(self, code, days):
        return self._bars

    def futures_kline(self, symbol):
        return self._bars


def test_build_summary_shape_offline():
    rules = _rules()
    data = build_summary(rules, hold=3, feed=_FakeFeed(_fake_bars(WARMUP + 30)))
    assert data["hold"] == 3
    assert data["bucketWidth"] == 10
    assert data["rangeStart"] <= data["rangeEnd"]
    assert data["buckets"], "至少要有分桶"
    total_samples = sum(b["samples"] for b in data["buckets"])
    assert total_samples > 0
    for b in data["buckets"]:
        assert set(["bucket", "label", "samples", "winRate", "avgReturn", "medianReturn"]) <= set(b)
        assert b["label"] == "%d~%d" % (b["bucket"], b["bucket"] + 10)


# ------------------------------------------------------ 发布的静态快照结构
def test_published_fixture_schema():
    data = _read_json(FIXTURE)
    assert data["hold"] == 5
    assert data["bucketWidth"] == 10
    assert data["minSamples"] >= 1
    assert data["rangeStart"] and data["rangeEnd"]
    assert data["rangeStart"] <= data["rangeEnd"]
    assert isinstance(data["signalDates"], list)
    assert data["note"]

    buckets = data["buckets"]
    assert buckets, "快照不能为空（页面「历史同类情形」依赖它）"
    assert [b["bucket"] for b in buckets] == sorted(b["bucket"] for b in buckets)
    for b in buckets:
        assert b["samples"] > 0
        if b["samples"] >= data["minSamples"]:
            assert 0 <= b["winRate"] <= 100
            assert b["avgReturn"] is not None


def test_published_signal_dates_inside_range():
    data = _read_json(FIXTURE)
    for d in data["signalDates"]:
        assert data["rangeStart"] <= d <= data["rangeEnd"]


def test_fixture_matches_regeneration_contract():
    """快照里的 hold/bucketWidth 必须与页面读取字段一致，避免后端算出别的口径。"""
    data = _read_json(FIXTURE)
    assert {"generatedAt", "rangeStart", "rangeEnd", "hold", "bucketWidth",
            "minSamples", "buckets", "signalDates", "note"} <= set(data)
