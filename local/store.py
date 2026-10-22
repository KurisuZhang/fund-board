"""本地历史留存（sqlite）。

当前只能抓到"当期"的 PE 与新闻，无法回溯估值分位与情绪历史，
因此每次运行把结果落库，随着时间积累即可支持"分数历史分位"等后续功能。
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "history.db")


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS runs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               ts REAL NOT NULL,
               data_date TEXT,
               total REAL,
               label TEXT,
               detail TEXT
           )"""
    )
    conn.commit()
    return conn


def save_run(score: dict, meta: dict) -> None:
    detail = {
        "components": [
            {"key": g["key"], "score": g["score"], "max": g["max"], "ratio": g["ratio"],
             "items": [{k: it[k] for k in ("key", "score", "max", "missing")} for it in g["items"]]}
            for g in score.get("components", [])
        ],
        "meta": {k: meta.get(k) for k in ("dataDate", "isIntraday", "indexLevel", "benchLevel")},
    }
    conn = _connect()
    with conn:
        conn.execute(
            "INSERT INTO runs (ts, data_date, total, label, detail) VALUES (?,?,?,?,?)",
            (time.time(), meta.get("dataDate"), score.get("total"), score.get("label"),
             json.dumps(detail, ensure_ascii=False)),
        )
    conn.close()


def recent_runs(limit: int = 120) -> list[dict]:
    if not os.path.exists(DB_PATH):
        return []
    conn = _connect()
    rows = conn.execute(
        "SELECT ts, data_date, total, label FROM runs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    out = [{"ts": r[0], "dataDate": r[1], "total": r[2], "label": r[3]} for r in rows]
    out.reverse()
    return out
