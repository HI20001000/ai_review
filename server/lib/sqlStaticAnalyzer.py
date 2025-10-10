# -*- coding: utf-8 -*-
"""Static SQL review helper used by the Node backend.

The script reads SQL content from STDIN (or an optional file path) and writes a
JSON report describing naming and safety issues. The implementation is based on
requirements provided by the product team.
"""
import json
import os
import re
import sys
from typing import Dict, List, Tuple

CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]")


def _idx_to_linecol(sql: str, idx: int) -> Tuple[int, int]:
    """Convert a 0-based index to a 1-based (line, column) tuple."""
    line = sql.count("\n", 0, idx) + 1
    last_nl = sql.rfind("\n", 0, idx)
    col = idx - (last_nl + 1) + 1
    return line, col


def _line_snippet(sql: str, idx: int, max_len: int = 240) -> str:
    """Return the entire line containing idx (trimmed to max_len)."""
    start = sql.rfind("\n", 0, idx) + 1
    end = sql.find("\n", idx)
    if end == -1:
        end = len(sql)
    snippet = sql[start:end].rstrip("\r")
    if len(snippet) > max_len:
        snippet = snippet[:max_len] + "..."
    return snippet


def _mask_span_with_spaces(s: str, start: int, end: int) -> str:
    """Replace the span with spaces while preserving newlines."""
    return s[:start] + "".join(" " if c != "\n" else "\n" for c in s[start:end]) + s[end:]


def _mask_comments_and_strings(sql: str) -> str:
    """Mask comment and string contents so indexes remain aligned."""
    masked = sql

    for m in re.finditer(r"/\*.*?\*/", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    for m in re.finditer(r"--.*?$", masked, flags=re.MULTILINE):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

    for m in re.finditer(r"'(?:''|[^'])*'", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, m.start(), m.end())

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


def _add_issue(
    issues: List[Dict],
    rule_id: str,
    message: str,
    sql: str,
    pos_idx: int,
    evidence: str = "",
    severity: str = "ERROR",
    obj_name: str = ""
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
            "evidence": (evidence or snippet)[:300],
        }
    )


def _check_cjk(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    match = CJK_RE.search(masked)
    if match:
        ch = match.group(0)
        _add_issue(
            issues,
            "R1_CJK_NAME",
            "檢測到中文/非 ASCII 字符（疑似用於對象/欄位命名），請改用英文命名。",
            sql,
            match.start(),
            evidence=f"...{ch}...",
        )


def _check_naming_prefixes(sql: str, issues: List[Dict]) -> None:
    for m in re.finditer(
        r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`""\[\]\w\.\$#@]+)",
        sql,
        flags=re.IGNORECASE,
    ):
        raw = m.group(1)
        name = _last_identifier(raw)
        if not name.upper().startswith("T_"):
            _add_issue(
                issues,
                "R2_PREFIX_TABLE",
                f"表名需以 T_ 開頭：發現 {name}",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=name,
            )
        if name.upper().startswith("TMP_TMP_TMP"):
            _add_issue(
                issues,
                "R3_TMP_TRIPLE",
                f"臨時表命名不得使用 TMP_TMP_TMP 前綴：發現 {name}",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=name,
            )

    for m in re.finditer(
        r"\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([`""\[\]\w\.\$#@]+)",
        sql,
        flags=re.IGNORECASE,
    ):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("V_"):
            _add_issue(
                issues,
                "R2_PREFIX_VIEW",
                f"視圖名需以 V_ 開頭：發現 {name}",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=name,
            )

    for m in re.finditer(
        r"\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+([`""\[\]\w\.\$#@]+)",
        sql,
        flags=re.IGNORECASE,
    ):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("P_"):
            _add_issue(
                issues,
                "R2_PREFIX_PROC",
                f"存儲過程需以 P_ 開頭：發現 {name}",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=name,
            )

    for m in re.finditer(
        r"\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([`""\[\]\w\.\$#@]+)",
        sql,
        flags=re.IGNORECASE,
    ):
        name = _last_identifier(m.group(1))
        if not name.upper().startswith("F_"):
            _add_issue(
                issues,
                "R2_PREFIX_FUNC",
                f"函數名需以 F_ 開頭：發現 {name}",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=name,
            )


def _check_delete_full_table(sql: str, issues: List[Dict]) -> None:
    for m in re.finditer(
        r"\bDELETE\s+FROM\s+([`""\[\]\w\.\$#@]+)([^;]*)",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        tail = m.group(2)
        if re.search(r"\bWHERE\b", tail, flags=re.IGNORECASE) is None:
            table_name = _last_identifier(m.group(1))
            _add_issue(
                issues,
                "R4_DELETE_NO_WHERE",
                f"檢測到對表 {table_name} 的全表刪除（DELETE 無 WHERE）。請使用 TRUNCATE。",
                sql,
                m.start(),
                evidence=m.group(0),
                obj_name=table_name,
            )


def _slice_from_clauses(sql: str) -> List[Tuple[int, int, str]]:
    slices: List[Tuple[int, int, str]] = []
    for m in re.finditer(r"\bFROM\b", sql, flags=re.IGNORECASE):
        start = m.end()
        end_match = re.search(
            r"\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;",
            sql[start:],
            flags=re.IGNORECASE,
        )
        end = start + end_match.start() if end_match else len(sql)
        slices.append((start, end, sql[start:end]))
    return slices


def _check_cartesian(sql: str, issues: List[Dict]) -> None:
    for start, _end, fragment in _slice_from_clauses(sql):
        if "," in fragment and re.search(r"\bJOIN\b", fragment, flags=re.IGNORECASE) is None:
            _add_issue(
                issues,
                "R5_FROM_COMMA",
                "FROM 子句使用逗號進行隱式連接，容易產生笛卡兒積。請使用顯式 JOIN ... ON。",
                sql,
                start,
                evidence=fragment.strip(),
            )

    join_iter = re.finditer(
        r"\bJOIN\b(?P<segment>.*?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in join_iter:
        segment = match.group("segment")
        if re.search(r"\bON\b|\bUSING\b|\bNATURAL\b|\bCROSS\b", segment, flags=re.IGNORECASE) is None:
            _add_issue(
                issues,
                "R5_JOIN_NO_ON",
                "出現 JOIN 但未檢測到 ON/USING/NATURAL（可能導致笛卡兒積或語義不清）。",
                sql,
                match.start(),
                evidence=("JOIN" + segment).strip(),
            )


def analyse(sql_query: str) -> Dict[str, object]:
    if not isinstance(sql_query, str):
        return {"summary": "輸入不是字符串。", "issues": []}

    issues: List[Dict[str, object]] = []
    _check_cjk(sql_query, issues)
    _check_naming_prefixes(sql_query, issues)
    _check_delete_full_table(sql_query, issues)
    _check_cartesian(sql_query, issues)

    if not issues:
        return {"summary": "代碼正常", "issues": []}

    by_rule: Dict[str, int] = {}
    for issue in issues:
        key = issue["rule_id"]
        by_rule[key] = by_rule.get(key, 0) + 1

    return {
        "summary": {
            "total_issues": len(issues),
            "by_rule": by_rule,
        },
        "issues": issues,
    }


def _load_sql_from_argv_or_stdin() -> str:
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        if data:
            return data
    if len(sys.argv) > 1:
        sql_path = sys.argv[1]
        if not os.path.exists(sql_path):
            raise FileNotFoundError(sql_path)
        with open(sql_path, "r", encoding="utf-8") as handle:
            return handle.read()
    default_path = "sql.sql"
    if os.path.exists(default_path):
        with open(default_path, "r", encoding="utf-8") as handle:
            return handle.read()
    return ""


def main() -> int:
    sql_content = _load_sql_from_argv_or_stdin()
    result = analyse(sql_content)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
