const CJK_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u;

function idxToLineCol(sql, index) {
    const preceding = index > 0 ? sql.slice(0, index) : "";
    const line = (preceding.match(/\n/g) || []).length + 1;
    const lastNewline = sql.lastIndexOf("\n", index - 1);
    const column = index - (lastNewline + 1) + 1;
    return { line, column };
}

function lineSnippet(sql, index, maxLength = 240) {
    const start = Math.max(sql.lastIndexOf("\n", index - 1) + 1, 0);
    let end = sql.indexOf("\n", index);
    if (end === -1) {
        end = sql.length;
    }
    let snippet = sql.slice(start, end).replace(/\r$/, "");
    if (snippet.length > maxLength) {
        snippet = `${snippet.slice(0, maxLength)}...`;
    }
    return snippet;
}

function maskMatchesWithSpaces(source, pattern, flags) {
    const regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
    const chars = Array.from(source);
    let match;
    while ((match = regex.exec(source)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        for (let i = start; i < end; i += 1) {
            if (chars[i] !== "\n") {
                chars[i] = " ";
            }
        }
        if (match[0].length === 0) {
            regex.lastIndex += 1;
        }
    }
    return chars.join("");
}

function maskCommentsAndStrings(sql) {
    let masked = sql;
    masked = maskMatchesWithSpaces(masked, "/\\*.*?\\*/", "gs");
    masked = maskMatchesWithSpaces(masked, "--.*?$", "gm");
    masked = maskMatchesWithSpaces(masked, "'(?:''|[^'])*'", "gs");
    masked = maskMatchesWithSpaces(masked, '"(?:""|[^"])*"', "gs");
    return masked;
}

function lastIdentifier(token) {
    let result = token.trim();
    if (result.includes(".")) {
        const parts = result.split(".");
        result = parts[parts.length - 1];
    }
    if (result.startsWith("[") && result.endsWith("]")) {
        result = result.slice(1, -1);
    }
    result = result.replace(/^`|`$/g, "").replace(/^"|"$/g, "");
    return result;
}

function addIssue(issues, { ruleId, message, sql, index, evidence = "", severity = "ERROR", objectName = "" }) {
    const { line, column } = idxToLineCol(sql, index);
    const snippet = lineSnippet(sql, index);
    issues.push({
        rule_id: ruleId,
        severity,
        message,
        object: objectName,
        line,
        column,
        snippet,
        evidence: (evidence || snippet).slice(0, 300),
    });
}

function checkCjk(sql, issues) {
    const masked = maskCommentsAndStrings(sql);
    const match = masked.match(CJK_REGEX);
    if (match && match.index !== undefined) {
        addIssue(issues, {
            ruleId: "R1_CJK_NAME",
            message: "检测到中文/非 ASCII 字符（疑似用于对象/列命名），应使用英文单词/短语/缩写。",
            sql,
            index: match.index,
            evidence: `...${match[0]}...`,
        });
    }
}

function checkNamingPrefixes(sql, issues) {
    const tableRegex = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w\.\$#@]+)/gi;
    let match;
    while ((match = tableRegex.exec(sql)) !== null) {
        const rawName = match[1];
        const name = lastIdentifier(rawName);
        if (!name.toUpperCase().startsWith("T_")) {
            addIssue(issues, {
                ruleId: "R2_PREFIX_TABLE",
                message: `表名需以 T_ 开头：发现 ${name}`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: name,
            });
        }
        if (name.toUpperCase().startsWith("TMP_TMP_TMP")) {
            addIssue(issues, {
                ruleId: "R3_TMP_TRIPLE",
                message: `中间表命名不得使用 TMP_TMP_TMP 前缀：发现 ${name}`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: name,
            });
        }
        if (match[0].length === 0) {
            tableRegex.lastIndex += 1;
        }
    }

    const viewRegex = /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([`"\[\]\w\.\$#@]+)/gi;
    while ((match = viewRegex.exec(sql)) !== null) {
        const name = lastIdentifier(match[1]);
        if (!name.toUpperCase().startsWith("V_")) {
            addIssue(issues, {
                ruleId: "R2_PREFIX_VIEW",
                message: `视图名需以 V_ 开头：发现 ${name}`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: name,
            });
        }
        if (match[0].length === 0) {
            viewRegex.lastIndex += 1;
        }
    }

    const procRegex = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+([`"\[\]\w\.\$#@]+)/gi;
    while ((match = procRegex.exec(sql)) !== null) {
        const name = lastIdentifier(match[1]);
        if (!name.toUpperCase().startsWith("P_")) {
            addIssue(issues, {
                ruleId: "R2_PREFIX_PROC",
                message: `存储过程名需以 P_ 开头：发现 ${name}`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: name,
            });
        }
        if (match[0].length === 0) {
            procRegex.lastIndex += 1;
        }
    }

    const funcRegex = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([`"\[\]\w\.\$#@]+)/gi;
    while ((match = funcRegex.exec(sql)) !== null) {
        const name = lastIdentifier(match[1]);
        if (!name.toUpperCase().startsWith("F_")) {
            addIssue(issues, {
                ruleId: "R2_PREFIX_FUNC",
                message: `函数名需以 F_ 开头：发现 ${name}`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: name,
            });
        }
        if (match[0].length === 0) {
            funcRegex.lastIndex += 1;
        }
    }
}

function checkDeleteFullTable(sql, issues) {
    const deleteRegex = /\bDELETE\s+FROM\s+([`"\[\]\w\.\$#@]+)([^;]*)/gi;
    let match;
    while ((match = deleteRegex.exec(sql)) !== null) {
        const tail = match[2] || "";
        if (!/\bWHERE\b/i.test(tail)) {
            const tableName = lastIdentifier(match[1]);
            addIssue(issues, {
                ruleId: "R4_DELETE_NO_WHERE",
                message: `检测到对表 ${tableName} 的全表删除（DELETE 无 WHERE）。请使用 TRUNCATE。`,
                sql,
                index: match.index,
                evidence: match[0],
                objectName: tableName,
            });
        }
        if (match[0].length === 0) {
            deleteRegex.lastIndex += 1;
        }
    }
}

function sliceFromClauses(sql) {
    const slices = [];
    const fromRegex = /\bFROM\b/gi;
    let match;
    while ((match = fromRegex.exec(sql)) !== null) {
        const start = match.index + match[0].length;
        const tail = sql.slice(start);
        const boundaryRegex = /\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;/i;
        const boundaryMatch = boundaryRegex.exec(tail);
        const end = boundaryMatch ? start + boundaryMatch.index : sql.length;
        slices.push({ start, end, fragment: sql.slice(start, end) });
        if (match[0].length === 0) {
            fromRegex.lastIndex += 1;
        }
    }
    return slices;
}

function checkCartesian(sql, issues) {
    const slices = sliceFromClauses(sql);
    slices.forEach(({ start, fragment }) => {
        if (fragment.includes(",") && !/\bJOIN\b/i.test(fragment)) {
            addIssue(issues, {
                ruleId: "R5_FROM_COMMA",
                message: "FROM 子句使用逗号进行隐式连接，容易产生笛卡尔积。请使用显式 JOIN ... ON。",
                sql,
                index: start,
                evidence: fragment.trim(),
            });
        }
    });

    const joinRegex = /\bJOIN\b([\s\S]*?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)/gi;
    let match;
    while ((match = joinRegex.exec(sql)) !== null) {
        const segment = match[1] || "";
        if (!/\bON\b|\bUSING\b|\bNATURAL\b|\bCROSS\b/i.test(segment)) {
            addIssue(issues, {
                ruleId: "R5_JOIN_NO_ON",
                message: "出现 JOIN 但未检测到 ON/USING/NATURAL（可能导致笛卡尔积或语义不清）。",
                sql,
                index: match.index,
                evidence: `JOIN${segment}`.trim(),
            });
        }
        if (match[0].length === 0) {
            joinRegex.lastIndex += 1;
        }
    }
}

function runStaticSqlAnalysis(sqlText) {
    if (typeof sqlText !== "string") {
        return {
            result: JSON.stringify({ summary: "输入不是字符串。", issues: [] }, null, 2),
        };
    }

    const issues = [];
    const sql = sqlText || "";

    checkCjk(sql, issues);
    checkNamingPrefixes(sql, issues);
    checkDeleteFullTable(sql, issues);
    checkCartesian(sql, issues);

    let payload;
    if (issues.length === 0) {
        payload = { summary: "代码正常", issues: [] };
    } else {
        const byRule = issues.reduce((acc, issue) => {
            const key = issue.rule_id;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        payload = {
            summary: {
                total_issues: issues.length,
                by_rule: byRule,
            },
            issues,
        };
    }

    return {
        result: JSON.stringify(payload, null, 2),
    };
}

export async function analyseSqlToReport(sqlText) {
    return runStaticSqlAnalysis(sqlText);
}

export function buildSqlReportPayload({ analysis, content, dify, difyError }) {
    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";
    const difyReport = typeof dify?.report === "string" && dify.report.trim().length
        ? dify.report
        : rawReport;
    const difyChunks = Array.isArray(dify?.chunks) && dify.chunks.length
        ? dify.chunks
        : null;
    const annotatedChunks = difyChunks
        ? difyChunks.map((chunk, index) => ({
              ...chunk,
              rawAnalysis: index === 0 ? rawReport : chunk.rawAnalysis
          }))
        : [
              {
                  index: 1,
                  total: 1,
                  answer: rawReport,
                  raw: rawReport,
                  rawAnalysis: rawReport
              }
          ];
    const segments = dify?.segments && Array.isArray(dify.segments) && dify.segments.length
        ? dify.segments
        : [rawReport || content || ""];
    let finalReport = difyReport;
    if (finalReport && finalReport.trim()) {
        try {
            JSON.parse(finalReport);
        } catch (_error) {
            finalReport = rawReport;
        }
    } else {
        finalReport = rawReport;
    }
    const generatedAt = dify?.generatedAt || new Date().toISOString();
    const difyErrorMessage = difyError ? difyError.message || String(difyError) : "";
    const enrichmentStatus = dify ? "succeeded" : "failed";

    const originalResult = typeof analysis?.result === "string" ? analysis.result : rawReport;
    const analysisPayload =
        analysis && typeof analysis === "object" ? { ...analysis } : originalResult ? {} : null;

    if (analysisPayload) {
        if (originalResult && typeof analysisPayload.originalResult !== "string") {
            analysisPayload.originalResult = originalResult;
        }
        if (rawReport && typeof analysisPayload.rawReport !== "string") {
            analysisPayload.rawReport = rawReport;
        }
        if (finalReport && finalReport.trim()) {
            analysisPayload.result = finalReport;
        } else if (!analysisPayload.result && rawReport) {
            analysisPayload.result = rawReport;
        }
        analysisPayload.enriched = Boolean(dify);
        if (!analysisPayload.enrichmentStatus) {
            analysisPayload.enrichmentStatus = enrichmentStatus;
        }
        if (difyErrorMessage) {
            analysisPayload.difyErrorMessage = difyErrorMessage;
        } else if (!dify) {
            analysisPayload.difyErrorMessage = "";
        }
    }

    return {
        report: finalReport,
        conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
        chunks: annotatedChunks,
        segments,
        generatedAt,
        analysis: analysisPayload,
        rawReport,
        dify: dify || null,
        source: dify ? "sql-rule-engine+dify" : "sql-rule-engine",
        enrichmentStatus,
        difyErrorMessage: difyErrorMessage || undefined
    };
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
