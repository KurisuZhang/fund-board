"""本地 Flask 服务（149 版看板的 Python 后端）。

启动：
    python3 local/server.py            # 默认 127.0.0.1:8765，自动打开浏览器
    python3 local/server.py --port 9000 --no-open

接口：
    GET  /                 看板页面（与 GitHub Pages 静态版同一套 assets）
    GET  /api/dashboard    一次算好的完整数据（含图表数据），60 秒缓存；?refresh=1 强制刷新
    GET  /api/config       读取本地配置（持仓成本等）
    POST /api/config       写入本地配置
    GET  /api/history      历史运行记录
    GET  /api/health       健康检查
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import socket
import sys
import threading
import time
import webbrowser

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "local"))

import backtest as backtest_mod  # noqa: E402
import datafeed  # noqa: E402
import scoring  # noqa: E402
import store  # noqa: E402

RULES_PATH = os.path.join(BASE_DIR, "shared", "scoring_rules.json")
CONFIG_PATH = os.path.join(BASE_DIR, "data", "config.json")
LAST_PAYLOAD_PATH = os.path.join(BASE_DIR, "data", "last_payload.json")
DEFAULT_CONFIG = {"costPrice": None, "shares": None, "weights": None, "chartPoints": 120}
CACHE_TTL = 60.0

app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "assets"), static_url_path="/assets")
_cache: dict = {"payload": None, "ts": 0.0, "lock": threading.Lock()}


def load_rules() -> dict:
    with open(RULES_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f) or {})
        except (OSError, json.JSONDecodeError):
            pass
    return cfg


def save_config(patch: dict) -> dict:
    cfg = load_config()
    for key in ("costPrice", "shares", "weights"):
        if key in patch:
            cfg[key] = patch[key]
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


def apply_weights(rules: dict, weights) -> dict:
    if not isinstance(weights, dict):
        return rules
    try:
        f = float(weights.get("fundamental", 0))
        v = float(weights.get("volume", 0))
        t = float(weights.get("technical", 0))
    except (TypeError, ValueError):
        return rules
    if f < 0 or v < 0 or t < 0 or (f + v + t) <= 0:
        return rules
    out = copy.deepcopy(rules)
    out["weights"] = {"fundamental": f, "volume": v, "technical": t}
    return out


def build_payload(force: bool = False) -> dict:
    with _cache["lock"]:
        fresh = _cache["payload"] is not None and (time.time() - _cache["ts"]) < CACHE_TTL
        if fresh and not force:
            return _cache["payload"]

        config = load_config()
        rules = apply_weights(load_rules(), config.get("weights"))
        feed = datafeed.DataFeed(rules)
        inp, meta = feed.build_input()
        score = scoring.score_dashboard(inp, rules)
        try:
            store.save_run(score, meta)
        except Exception as exc:  # noqa: BLE001
            meta.setdefault("warnings", []).append("历史落库失败：%s" % exc)

        n = int(config.get("chartPoints") or 120)
        etf_bars = inp["etf"]["bars"]
        closes = [b["c"] for b in etf_bars]
        ma20 = scoring_sma(closes, 20)
        ma60 = scoring_sma(closes, 60)
        payload = {
            "mode": "local",
            "meta": dict(meta, mode="local", rulesVersion=rules.get("version"),
                         fetchedAtIso=time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(meta["fetchedAt"]))),
            "score": score,
            "config": config,
            "charts": {
                "etf": [
                    {"d": etf_bars[i]["d"], "c": etf_bars[i]["c"], "h": etf_bars[i]["h"],
                     "l": etf_bars[i]["l"], "v": etf_bars[i]["v"],
                     "ma20": ma20[i], "ma60": ma60[i]}
                    for i in range(max(0, len(etf_bars) - n), len(etf_bars))
                ],
                "etfQuote": {
                    "price": inp["etf"].get("price"), "changePct": inp["etf"].get("changePct"),
                    "turnoverPct": inp["etf"].get("turnoverPct"),
                    "amountWan": inp["etf"].get("amountWan"),
                },
                "index": [{"d": b["d"], "c": b["c"]} for b in inp["index"]["bars"][-n:]],
                "futures": [
                    {"d": b["d"], "c": b["c"]} for b in inp["futures"]["bars"][-(n + 40):]
                ],
                "futuresRealtime": inp["futures"].get("realtime"),
                "stocks": [
                    {"code": s["code"], "name": s["name"], "price": s.get("price"),
                     "changePct": s.get("changePct"), "pe": s.get("pe"),
                     "marketCap": s.get("marketCap"),
                     "aboveMa20": above_ma20(s.get("bars") or [], 20)}
                    for s in inp["stocks"]
                ],
                "news": [
                    {"ts": item["ts"], "title": item["title"], "url": item.get("url", ""),
                     "source": item.get("source", "")}
                    for item in inp["news"][:15]
                ],
            },
        }
        try:
            os.makedirs(os.path.dirname(LAST_PAYLOAD_PATH), exist_ok=True)
            with open(LAST_PAYLOAD_PATH, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except OSError:
            pass
        _cache["payload"] = payload
        _cache["ts"] = time.time()
        return payload


def load_last_payload():
    if not os.path.exists(LAST_PAYLOAD_PATH):
        return None
    try:
        with open(LAST_PAYLOAD_PATH, encoding="utf-8") as f:
            payload = json.load(f)
        payload["mode"] = "local"
        return payload
    except (OSError, json.JSONDecodeError):
        return None


def scoring_sma(values: list, window: int):
    out = []
    for i in range(len(values)):
        if i + 1 < window:
            out.append(None)
        else:
            chunk = values[i + 1 - window: i + 1]
            out.append(round(sum(chunk) / window, 4))
    return out


def above_ma20(bars: list, window: int):
    if len(bars) < window:
        return None
    closes = [b["c"] for b in bars]
    ma = sum(closes[-window:]) / window
    return closes[-1] >= ma


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/backtest")
@app.route("/backtest.html")
def backtest_page():
    return send_from_directory(BASE_DIR, "backtest.html")


@app.route("/shared/<path:filename>")
def shared_files(filename):
    return send_from_directory(os.path.join(BASE_DIR, "shared"), filename)


@app.route("/api/backtest")
def backtest_api():
    hold = request.args.get("hold", type=int) or 5
    try:
        return jsonify(run_backtest(hold=hold))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "ts": time.time()})


@app.route("/api/dashboard")
def dashboard():
    force = request.args.get("refresh") in ("1", "true", "yes")
    try:
        payload = build_payload(force=force)
        return jsonify(payload)
    except Exception as exc:  # noqa: BLE001
        stale = load_last_payload()
        if stale:
            stale.setdefault("meta", {}).setdefault("warnings", []).append(
                "本次抓取失败，展示上次成功数据：%s" % exc)
            stale["meta"]["stale"] = True
            return jsonify(stale)
        return jsonify({"mode": "local", "error": str(exc)}), 500


@app.route("/api/config", methods=["GET", "POST"])
def config():
    if request.method == "GET":
        return jsonify(load_config())
    patch = request.get_json(silent=True) or {}
    try:
        cfg = save_config(patch)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400
    _cache["ts"] = 0.0  # 权重变更后下次请求重新计算
    return jsonify(cfg)


@app.route("/api/history")
def history():
    return jsonify({"runs": store.recent_runs(120)})


def run_backtest(hold: int = 5) -> dict:
    rules = load_rules()
    feed = datafeed.DataFeed(rules)
    etf = feed.stock_kline(rules["instruments"]["etf"]["code"], 500)
    futures = feed.futures_kline(rules["instruments"]["futures"]["symbol"])
    bench = feed.index_kline(rules["instruments"]["bench"]["code"], 500)
    result = backtest_mod.run_backtest(etf, futures, bench, rules, hold=hold)
    result["warnings"] = feed.warnings
    return result


def free_port(start: int, tries: int = 12) -> int:
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口（%d-%d）" % (start, start + tries))


def main() -> None:
    ap = argparse.ArgumentParser(description="储能电池涨跌看板 本地服务")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--no-browser-delay", action="store_true")
    args = ap.parse_args()

    port = free_port(args.port)
    url = "http://127.0.0.1:%d" % port
    print("=" * 62)
    print(" 储能电池涨跌看板 · 本地版")
    print(" 地址: %s" % url)
    print(" 数据: 腾讯行情 / 新浪指数·期货·新闻（免费公开接口）")
    print(" 提示: 页面右上角可强制刷新；首次加载约需 3-5 秒")
    print("=" * 62)
    if not args.no_open:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
