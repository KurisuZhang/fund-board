"""两端一致性：用 quickjs 执行 assets/*.js，与 Python 结果逐项比对。

若 .deps/quickjs 不存在（他人克隆仓库后），此测试自动 skip，并提示安装方式。
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
        import quickjs  # noqa: F401
        return quickjs
    except Exception:
        return None


quickjs = _load_quickjs()
pytestmark = pytest.mark.skipif(
    quickjs is None, reason="未安装 quickjs（pip install --target .deps/quickjs quickjs）"
)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def js_engine():
    ctx = quickjs.Context()
    ctx.eval(_read(os.path.join(ROOT, "assets", "indicators.js")))
    ctx.eval(_read(os.path.join(ROOT, "assets", "scoring.js")))
    return ctx


def _js_score(ctx, sample, rules):
    ctx.eval("var SAMPLE=" + json.dumps(sample, ensure_ascii=False) + ";")
    ctx.eval("var RULES=" + json.dumps(rules, ensure_ascii=False) + ";")
    out = ctx.eval("JSON.stringify(SCORING.scoreDashboard(SAMPLE, RULES))")
    return json.loads(out)


def _py_score(sample, rules):
    import scoring

    return scoring.score_dashboard(sample, rules)


@pytest.fixture(params=["golden_sample"])
def payload(request):
    sample = json.loads(_read(os.path.join(ROOT, "tests", "fixtures", "sample_input.json")))
    rules = json.loads(_read(os.path.join(ROOT, "shared", "scoring_rules.json")))
    return sample, rules


def test_js_matches_python_on_fixture(js_engine, payload):
    sample, rules = payload
    py = _py_score(sample, rules)
    js = _js_score(js_engine, sample, rules)

    assert js["label"] == py["label"]
    assert js["total"] == pytest.approx(py["total"], abs=1e-9)
    assert js["strength"] == pytest.approx(py["strength"], abs=1e-9)
    assert sorted(js["missing"]) == sorted(py["missing"])
    assert len(js["components"]) == len(py["components"])

    for jg, pg in zip(js["components"], py["components"]):
        assert jg["key"] == pg["key"]
        assert jg["score"] == pytest.approx(pg["score"], abs=1e-9)
        assert jg["max"] == pytest.approx(pg["max"], abs=1e-9)
        assert jg["ratio"] == pytest.approx(pg["ratio"], abs=1e-9)
        assert len(jg["items"]) == len(pg["items"])
        for ji, pi in zip(jg["items"], pg["items"]):
            assert ji["key"] == pi["key"]
            assert ji["missing"] == pi["missing"], ji["key"]
            assert ji["score"] == pytest.approx(pi["score"], abs=1e-9), ji["key"]
            assert ji["max"] == pytest.approx(pi["max"], abs=1e-9), ji["key"]


def test_js_matches_python_on_degraded_input(js_engine, payload):
    sample, rules = payload
    degraded = json.loads(json.dumps(sample))
    degraded["futures"] = {"bars": []}
    degraded["news"] = []
    degraded["stocks"] = []
    py = _py_score(degraded, rules)
    js = _js_score(js_engine, degraded, rules)
    assert js["total"] == pytest.approx(py["total"], abs=1e-9)
    assert sorted(js["missing"]) == sorted(py["missing"])


def test_js_matches_python_on_empty_input(js_engine, payload):
    _, rules = payload
    empty = {"etf": {"bars": []}, "stocks": [], "news": [], "futures": {"bars": []}, "asOf": 1.8e9}
    py = _py_score(empty, rules)
    js = _js_score(js_engine, empty, rules)
    assert js["label"] == py["label"] == "数据缺失"
    assert js["total"] == py["total"] == 0.0


def test_golden_file_is_current(js_engine, payload):
    """assets/fixtures/golden.json 必须与实际打分一致（防止改规则忘记重新生成）。"""
    sample, rules = payload
    golden = json.loads(_read(os.path.join(ROOT, "assets", "fixtures", "golden.json")))
    js = _js_score(js_engine, sample, rules)
    assert js["total"] == pytest.approx(golden["total"], abs=1e-9)
    assert js["label"] == golden["label"]


def test_backtest_js_matches_python(js_engine, payload):
    """回测算法两端一致（同一份 ETF/期货样本，不含基准指数）。"""
    import backtest

    sample, rules = payload
    py = backtest.run_backtest(sample["etf"]["bars"], sample["futures"]["bars"], [], rules, hold=5)
    ctx = js_engine
    ctx.eval("var RULES_B=" + json.dumps(rules, ensure_ascii=False) + ";")
    ctx.eval("var FUT_B=" + json.dumps(sample["futures"]["bars"], ensure_ascii=False) + ";")
    ctx.eval("var ETF_B=" + json.dumps(sample["etf"]["bars"], ensure_ascii=False) + ";")
    ctx.eval("var module={exports:{}}; var exports=module.exports;")
    ctx.eval(_read(os.path.join(ROOT, "assets", "backtest.js")))
    js = json.loads(ctx.eval("JSON.stringify(module.exports.runBacktest(ETF_B,FUT_B,[],RULES_B,5))"))
    assert js["stats"] == py["stats"]
    assert js["events"] == py["events"]
