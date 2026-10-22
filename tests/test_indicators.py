import json
import math
import os

import pytest

import indicators as ind


def test_sma_basic():
    assert ind.sma([1, 2, 3, 4, 5], 3) == [None, None, 2.0, 3.0, 4.0]


def test_sma_with_none_and_short_input():
    assert ind.sma([1, 2], 3) == [None, None]
    assert ind.sma([1, None, 3], 3) == [None, None, None]


def test_ema_constant_series_is_constant():
    out = ind.ema([5.0] * 10, 5)
    assert all(abs(v - 5.0) < 1e-12 for v in out)


def test_macd_constant_series_is_zero():
    res = ind.macd([7.0] * 60)
    assert abs(res["dif"][-1]) < 1e-12
    assert abs(res["dea"][-1]) < 1e-12
    assert abs(res["hist"][-1]) < 1e-12


def test_macd_uptrend_positive_dif():
    closes = [100 + i for i in range(80)]
    res = ind.macd(closes)
    assert res["dif"][-1] > 0


def test_rsi_monotonic():
    up = list(range(1, 40))
    down = list(range(40, 1, -1))
    flat = [10.0] * 40
    assert ind.rsi(up, 14)[-1] == 100.0
    assert ind.rsi(down, 14)[-1] == 0.0
    assert ind.rsi(flat, 14)[-1] == 50.0


def test_rsi_insufficient_data():
    assert ind.rsi([1, 2, 3], 14)[-1] is None


def test_percentile_rank_extremes():
    assert ind.percentile_rank(list(range(1, 61)), 60) == 100.0
    assert ind.percentile_rank(list(range(60, 0, -1)), 60) <= (1 / 60 * 100 + 1e-9)
    assert ind.percentile_rank([1, 2, 3], 60) is None


def test_pct_change():
    assert ind.pct_change([100, 110], 1) == pytest.approx(10.0)
    assert ind.pct_change([100.0], 1) is None


def test_round_score_matches_js_floor_semantics():
    assert ind.round_score(0.5) == 1.0
    assert ind.round_score(-0.5) == 0.0
    assert ind.round_score(2.5) == 3.0
    assert ind.round_score(-2.5) == -2.0
    assert ind.round_score(2.4) == 2.0


def test_bucket_pickers():
    buckets_max = [{"max": 18, "score": 12}, {"max": 28, "score": 6},
                   {"max": 40, "score": 0}, {"max": 1000000000, "score": -12}]
    assert ind.pick_by_max(buckets_max, 17.9)["score"] == 12
    assert ind.pick_by_max(buckets_max, 18.0)["score"] == 12
    assert ind.pick_by_max(buckets_max, 18.1)["score"] == 6
    assert ind.pick_by_max(buckets_max, 500)["score"] == -12

    buckets_min = [{"min": 70, "score": 12}, {"min": 50, "score": 6},
                   {"min": 30, "score": 0}, {"min": 15, "score": -6},
                   {"min": -1000000000, "score": -12}]
    assert ind.pick_by_min(buckets_min, 100)["score"] == 12
    assert ind.pick_by_min(buckets_min, 70)["score"] == 12
    assert ind.pick_by_min(buckets_min, 69.9)["score"] == 6
    assert ind.pick_by_min(buckets_min, 0)["score"] == -12


def test_clamp():
    assert ind.clamp(5, -1, 1) == 1
    assert ind.clamp(-5, -1, 1) == -1
    assert ind.clamp(0.2, -1, 1) == 0.2
