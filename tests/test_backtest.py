import pytest

import backtest


def bars(closes, start_day=1):
    out = []
    for i, c in enumerate(closes):
        out.append({"d": "2026-%02d-%02d" % ((i + start_day) // 28 % 12 + 1, (i + start_day) % 28 + 1),
                    "o": c, "h": c * 1.01, "l": c * 0.99, "c": c, "v": 1e6, "a": c * 1e8})
    return out


def fut(closes):
    out = []
    for i, c in enumerate(closes):
        out.append({"d": "2026-%02d-%02d" % ((i + 1) // 28 % 12 + 1, (i + 1) % 28 + 1),
                    "o": c, "h": c, "l": c, "c": c, "v": 1e4, "a": None})
    return out


def rules():
    import json, os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "shared", "scoring_rules.json"), encoding="utf-8") as f:
        return json.load(f)


def test_backtest_runs_and_shapes():
    etf = bars([1.0 + 0.002 * i for i in range(200)])
    futures = fut([90000 + 20 * i for i in range(200)])
    bench = bars([4000 + i for i in range(200)])
    res = backtest.run_backtest(etf, futures, bench, rules(), hold=5)
    assert "stats" in res and "events" in res and "equity" in res
    assert res["stats"]["hold"] == 5
    assert isinstance(res["events"], list)
    assert len(res["equity"]) > 0


def test_backtest_hold_is_clamped():
    etf = bars([1.0 + 0.002 * i for i in range(200)])
    futures = fut([90000 + 20 * i for i in range(200)])
    res = backtest.run_backtest(etf, futures, [], rules(), hold=99)
    assert res["stats"]["hold"] <= 20


def test_backtest_flat_market_has_few_signals():
    etf = bars([1.0] * 200)
    futures = fut([90000.0] * 200)
    res = backtest.run_backtest(etf, futures, [], rules(), hold=5)
    assert isinstance(res["events"], list)
    assert res["stats"]["signalCount"] == len(res["events"])


def test_strategy_equity_starts_at_zero():
    etf = bars([1.0 + 0.001 * i for i in range(120)])
    eq = backtest._buyhold_equity(etf, 100)
    assert eq[0]["v"] == 0.0
    assert len(eq) == 20
