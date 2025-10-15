# -*- coding: utf-8 -*-
import re
import json
from typing import List, Dict, Tuple
import os

def _idx_to_linecol(sql: str, idx: int) -> Tuple[int, int]:
    """0-based idx -> (1-based line, 1-based column)."""
    line = sql.count("\n", 0, idx) + 1
    last_nl = sql.rfind("\n", 0, idx)
    col = idx - (last_nl + 1) + 1
    return line, col

def _line_snippet(sql: str, idx: int, max_len: int = 240) -> str:
    """Extract the full line containing idx (trim to max_len)."""
    start = sql.rfind("\n", 0, idx) + 1
    end = sql.find("\n", idx)
    if end == -1:
        end = len(sql)
    s = sql[start:end].rstrip("\r")
    if len(s) > max_len:
        s = s[:max_len] + "..."
    return s

def _mask_span_with_spaces(s: str, start: int, end: int) -> str:
    return s[:start] + "".join(" " if c != "\n" else "\n" for c in s[start:end]) + s[end:]

def _mask_comments_and_strings(sql: str) -> str:
    """
    Replace comment/string contents with spaces but keep newlines & length,
    so indexes map back to the original SQL.
    """
    masked = sql

    # /* ... */  (DOTALL)
    for m in re.finditer(r"/\*.*?\*/", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    # -- ... (to end-of-line)
    # iterate again (new indexes ok since length preserved)
    for m in re.finditer(r"--.*?$", masked, flags=re.MULTILINE):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    # Single-quoted strings
    for m in re.finditer(r"'(?:''|[^'])*'", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    # Double-quoted strings
    for m in re.finditer(r'"(?:""|[^"])*"', masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    return masked

def _last_identifier(name_token: str) -> str:
    token = name_token.strip()
    if "." in token:
        token = token.split(".")[-1]
    if token.startswith("[") and token.endswith("]"):
        token = token[1:-1]
    token = token.strip('`"')
    return token

def _add_issue(issues: List[Dict], rule_id: str, message: str, sql: str,
               pos_idx: int, evidence: str = "", severity: str = "ERROR",
               obj_name: str = ""):
    line, col = _idx_to_linecol(sql, pos_idx)
    snippet = _line_snippet(sql, pos_idx)
    issues.append({
        "rule_id": rule_id,
        "severity": severity,
        "message": message,
        "object": obj_name,
        "line": line,
        "column": col,
        "snippet": snippet,
        "evidence": (evidence or snippet)[:300]
    })

CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]")

def _check_cjk(sql: str, issues: List[Dict]):
    masked = _mask_comments_and_strings(sql)
    m = CJK_RE.search(masked)
    if m:
        ch = m.group(0)
        _add_issue(
            issues,
            "R1_CJK_NAME",
            "检测到中文/非 ASCII 字符（疑似用于对象/列命名），应使用英文单词/短语/缩写。",
            sql,
            m.start(),
            evidence=f"...{ch}..."
        )

def _check_naming_prefixes(sql: str, issues: List[Dict]):
    # CREATE TABLE
    for m in re.finditer(r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`""\[\]\w\.\$#@]+)", sql, flags=re.IGNORECASE):
        raw = m.group(1)
        name = _last_identifier(raw)
        if not name.upper().startswith("T_"):
            _add_issue(issues, "R2_PREFIX_TABLE", f"表名需以 T_ 开头：发现 {name}", sql, m.start(), evidence=m.group(0), obj_name=name)
        if name.upper().startswith("TMP_TMP_TMP"):
            _add_issue(issues, "R3_TMP_TRIPLE", f"中间表命名不得使用 TMP_TMP_TMP 前缀：发现 {name}", sql, m.start(), evidence=m.group(0), obj_name=name)

    # CREATE VIEW
    for m in re.finditer(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([`""\[\]\w\.\$#@]+)", sql, flags=re.IGNORECASE):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("V_"):
            _add_issue(issues, "R2_PREFIX_VIEW", f"视图名需以 V_ 开头：发现 {name}", sql, m.start(), evidence=m.group(0), obj_name=name)

    # CREATE PROCEDURE
    for m in re.finditer(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+([`""\[\]\w\.\$#@]+)", sql, flags=re.IGNORECASE):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("P_"):
            _add_issue(issues, "R2_PREFIX_PROC", f"存储过程名需以 P_ 开头：发现 {name}", sql, m.start(), evidence=m.group(0), obj_name=name)

    # CREATE FUNCTION
    for m in re.finditer(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([`""\[\]\w\.\$#@]+)", sql, flags=re.IGNORECASE):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("F_"):
            _add_issue(issues, "R2_PREFIX_FUNC", f"函数名需以 F_ 开头：发现 {name}", sql, m.start(), evidence=m.group(0), obj_name=name)

def _check_delete_full_table(sql: str, issues: List[Dict]):
    for m in re.finditer(r"\bDELETE\s+FROM\s+([`""\[\]\w\.\$#@]+)([^;]*)", sql, flags=re.IGNORECASE | re.DOTALL):
        tail = m.group(2)
        if re.search(r"\bWHERE\b", tail, flags=re.IGNORECASE) is None:
            table_name = _last_identifier(m.group(1))
            _add_issue(
                issues,
                "R4_DELETE_NO_WHERE",
                f"检测到对表 {table_name} 的全表删除（DELETE 无 WHERE）。请使用 TRUNCATE。",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=table_name
            )

def _slice_from_clauses(sql: str) -> List[Tuple[int, int, str]]:
    """Return list of (start_idx, end_idx, text) for FROM ... (until WHERE/GROUP/ORDER/HAVING/LIMIT/; or EOF)."""
    slices = []
    for m in re.finditer(r"\bFROM\b", sql, flags=re.IGNORECASE):
        start = m.end()
        end_m = re.search(r"\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;", sql[start:], flags=re.IGNORECASE)
        end = start + end_m.start() if end_m else len(sql)
        slices.append((start, end, sql[start:end]))
    return slices

def _check_cartesian(sql: str, issues: List[Dict]):
    # 1) comma-separated implicit joins in FROM
    for start, end, frag in _slice_from_clauses(sql):
        if ("," in frag) and (re.search(r"\bJOIN\b", frag, flags=re.IGNORECASE) is None):
            _add_issue(
                issues,
                "R5_FROM_COMMA",
                "FROM 子句使用逗号进行隐式连接，容易产生笛卡尔积。请使用显式 JOIN ... ON。",
                sql,
                start,
                evidence=frag.strip()
            )

    # 2) JOIN without ON/USING/NATURAL/CROSS
    join_iter = re.finditer(
        r"\bJOIN\b(?P<seg>.*?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)",
        sql, flags=re.IGNORECASE | re.DOTALL
    )
    for jm in join_iter:
        seg = jm.group("seg")
        if re.search(r"\bON\b|\bUSING\b|\bNATURAL\b|\bCROSS\b", seg, flags=re.IGNORECASE) is None:
            _add_issue(
                issues,
                "R5_JOIN_NO_ON",
                "出现 JOIN 但未检测到 ON/USING/NATURAL（可能导致笛卡尔积或语义不清）。",
                sql,
                jm.start(),
                evidence=("JOIN" + seg).strip()
            )

def main(sql_query: str) -> dict:
    """
    入口：給定 SQL 字符串，產出僅一個鍵：result（字符串），
    其內容為 JSON 格式報告（包含每個問題的行/列、片段、对象名等）。
    返回：{"result": "<json string>"}
    """
    if not isinstance(sql_query, str):
        result = json.dumps({"summary": "输入不是字符串。", "issues": []}, ensure_ascii=False)
        return {"result": result}

    issues: List[Dict] = []

    # 规则 1：中文/非 ASCII 字符
    _check_cjk(sql_query, issues)

    # 规则 2 + 3：DDL 前缀 & 禁用 TMP_TMP_TMP*
    _check_naming_prefixes(sql_query, issues)

    # 规则 4：DELETE 全表删除
    _check_delete_full_table(sql_query, issues)

    # 规则 5：防笛卡尔积
    _check_cartesian(sql_query, issues)

    if not issues:
        payload = {"summary": "代码正常", "issues": []}
    else:
        by_rule = {}
        for it in issues:
            by_rule[it["rule_id"]] = by_rule.get(it["rule_id"], 0) + 1
        payload = {
            "summary": {
                "total_issues": len(issues),
                "by_rule": by_rule
            },
            "issues": issues
        }

    result = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"result": result}

if __name__ == "__main__":
    sql_file = "sql.sql"
    if not os.path.exists(sql_file):
        print(json.dumps({"summary": f"文件 {sql_file} 不存在", "issues": []}, ensure_ascii=False))
    else:
        with open(sql_file, "r", encoding="utf-8") as f:
            sql_content = f.read()
        report = main(sql_content)
        print(report["result"])
