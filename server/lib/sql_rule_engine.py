# -*- coding: utf-8 -*-
"""SQL rule engine used for static analysis when reviewing .sql files."""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Dict, List, Tuple

CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]")


# ---------- position helpers ----------
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
    snippet = sql[start:end].rstrip("\r")
    if len(snippet) > max_len:
        snippet = snippet[:max_len] + "..."
    return snippet


# ---------- masking comments & strings (keeps positions) ----------
def _mask_span_with_spaces(text: str, start: int, end: int) -> str:
    return text[:start] + "".join("\n" if ch == "\n" else " " for ch in text[start:end]) + text[end:]


def _mask_comments_and_strings(sql: str) -> str:
    """Replace comment/string contents with spaces but keep newlines & length."""
    masked = sql

    for match in re.finditer(r"/\*.*?\*/", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    for match in re.finditer(r"--.*?$", masked, flags=re.MULTILINE):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    for match in re.finditer(r"'(?:''|[^'])*'", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    for match in re.finditer(r'"(?:""|[^"])*"', masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    return masked


# ---------- token helpers ----------
def _last_identifier(name_token: str) -> str:
    token = name_token.strip()
    if "." in token:
        token = token.split(".")[-1]
    if token.startswith("[") and token.endswith("]"):
        token = token[1:-1]
    token = token.strip('`"')
    return token


def _add_issue(
    issues: List[Dict],
    rule_id: str,
    message: str,
    sql: str,
    pos_idx: int,
    evidence: str = "",
    severity: str = "ERROR",
    obj_name: str = "",
) -> None:
    line, col = _idx_to_linecol(sql, pos_idx)
    snippet = _line_snippet(sql, pos_idx)
    issues.append(
        {
            "rule_id": rule_id,
            "severity": severity,
            "message": message,
            "object": obj_name,
            "line": line,
            "column": col,
            "snippet": snippet,
            # 留空等待未來由 Dify 生成的修改建議填入
            "evidence": "",
        }
    )


# ---------- rule checks ----------
def _check_cjk(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    match = CJK_RE.search(masked)
    if match:
        ch = match.group(0)
        _add_issue(
            issues,
            "R1_CJK_NAME",
            "检测到中文/非 ASCII 字符（疑似用于对象/列命名），应使用英文单词/短语/缩写。",
            sql,
            match.start(),
            evidence=f"...{ch}...",
        )


def _check_naming_prefixes(sql: str, issues: List[Dict]) -> None:
    table_re = re.finditer(
        r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w\.\$#@]+)',
        sql,
        flags=re.IGNORECASE,
    )
    for match in table_re:
        raw = match.group(1)
        name = _last_identifier(raw)
        if not name.upper().startswith("T_"):
            _add_issue(
                issues,
                "R2_PREFIX_TABLE",
                f"表名需以 T_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )
        if name.upper().startswith("TMP_TMP_TMP"):
            _add_issue(
                issues,
                "R3_TMP_TRIPLE",
                f"中间表命名不得使用 TMP_TMP_TMP 前缀：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    view_re = re.finditer(
        r'\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([`"\[\]\w\.\$#@]+)',
        sql,
        flags=re.IGNORECASE,
    )
    for match in view_re:
        name = _last_identifier(match.group(1))
        if not name.upper().startswith("V_"):
            _add_issue(
                issues,
                "R2_PREFIX_VIEW",
                f"视图名需以 V_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    proc_re = re.finditer(
        r'\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+([`"\[\]\w\.\$#@]+)',
        sql,
        flags=re.IGNORECASE,
    )
    for match in proc_re:
        name = _last_identifier(match.group(1))
        if not name.upper().startswith("P_"):
            _add_issue(
                issues,
                "R2_PREFIX_PROC",
                f"存储过程名需以 P_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    func_re = re.finditer(
        r'\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([`"\[\]\w\.\$#@]+)',
        sql,
        flags=re.IGNORECASE,
    )
    for match in func_re:
        name = _last_identifier(match.group(1))
        if not name.upper().startswith("F_"):
            _add_issue(
                issues,
                "R2_PREFIX_FUNC",
                f"函数名需以 F_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )


def _check_delete_full_table(sql: str, issues: List[Dict]) -> None:
    delete_re = re.finditer(
        r'\bDELETE\s+FROM\s+([`"\[\]\w\.\$#@]+)([^;]*)',
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in delete_re:
        tail = match.group(2) or ""
        if re.search(r"\bWHERE\b", tail, flags=re.IGNORECASE) is None:
            table_name = _last_identifier(match.group(1))
            _add_issue(
                issues,
                "R4_DELETE_NO_WHERE",
                f"检测到对表 {table_name} 的全表删除（DELETE 无 WHERE）。请使用 TRUNCATE。",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=table_name,
            )


def _slice_from_clauses(sql: str) -> List[Tuple[int, int, str]]:
    slices: List[Tuple[int, int, str]] = []
    for match in re.finditer(r"\bFROM\b", sql, flags=re.IGNORECASE):
        start = match.end()
        remainder = sql[start:]
        boundary = re.search(r"\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;", remainder, flags=re.IGNORECASE)
        end = start + boundary.start() if boundary else len(sql)
        slices.append((start, end, sql[start:end]))
    return slices


def _check_cartesian(sql: str, issues: List[Dict]) -> None:
    for start, _end, fragment in _slice_from_clauses(sql):
        if "," in fragment and re.search(r"\bJOIN\b", fragment, flags=re.IGNORECASE) is None:
            _add_issue(
                issues,
                "R5_FROM_COMMA",
                "FROM 子句使用逗号进行隐式连接，容易产生笛卡尔积。请使用显式 JOIN ... ON。",
                sql,
                start,
                evidence=fragment.strip(),
            )

    join_re = re.finditer(
        r"\bJOIN\b(?P<seg>.*?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in join_re:
        segment = match.group("seg") or ""
        if re.search(r"\bON\b|\bUSING\b|\bNATURAL\b|\bCROSS\b", segment, flags=re.IGNORECASE) is None:
            _add_issue(
                issues,
                "R5_JOIN_NO_ON",
                "出现 JOIN 但未检测到 ON/USING/NATURAL（可能导致笛卡尔积或语义不清）。",
                sql,
                match.start(),
                evidence=("JOIN" + segment).strip(),
            )


# ---------- main ----------
def main(sql_query: str) -> Dict[str, str]:
    if not isinstance(sql_query, str):
        result = json.dumps({"summary": "输入不是字符串。", "issues": []}, ensure_ascii=False)
        return {"result": result}

    issues: List[Dict] = []
    sql = sql_query

    _check_cjk(sql, issues)
    _check_naming_prefixes(sql, issues)
    _check_delete_full_table(sql, issues)
    _check_cartesian(sql, issues)

    if not issues:
        payload: Dict = {"summary": "代码正常", "issues": []}
    else:
        by_rule: Dict[str, int] = {}
        for issue in issues:
            by_rule[issue["rule_id"]] = by_rule.get(issue["rule_id"], 0) + 1
        payload = {"summary": {"total_issues": len(issues), "by_rule": by_rule}, "issues": issues}

    result = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"result": result}


def _read_sql_from_stdin_or_file() -> str:
    data = sys.stdin.read()
    if data:
        return data

    if len(sys.argv) > 1:
        sql_file = sys.argv[1]
        if os.path.exists(sql_file):
            with open(sql_file, "r", encoding="utf-8") as handle:
                return handle.read()
        raise FileNotFoundError(f"文件 {sql_file} 不存在")

    return ""


def _emit_json(payload: Dict) -> None:
    data = json.dumps(payload, ensure_ascii=False)
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        sql_content = _read_sql_from_stdin_or_file()
        report = main(sql_content)
    except Exception as exc:  # pragma: no cover
        _emit_json({"error": str(exc)})
        sys.exit(1)

    _emit_json(report)
