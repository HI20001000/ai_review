import {
    collectIssuesForSource,
    normaliseReportSourceKey,
    remapIssuesToSource,
    dedupeIssues,
    buildSummaryDetailList
} from "./combinedReport.js";

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function toStringList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (item == null) return "";
            return typeof item === "string" ? item : String(item);
        });
    }
    if (value == null) return [];
    return [typeof value === "string" ? value : String(value)];
}

function toNumberList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const numeric = Number(item);
                return Number.isFinite(numeric) ? numeric : null;
            })
            .filter((item) => item !== null);
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? [numeric] : [];
}

function buildStaticIssueDetail(issue, index, context) {
    const ruleList = toStringList(issue?.rule_ids);
    if (!ruleList.length) {
        ruleList.push(...toStringList(issue?.ruleId));
        ruleList.push(...toStringList(issue?.rule_id));
        ruleList.push(...toStringList(issue?.rule));
    }

    const severityList = toStringList(issue?.severity_levels);
    if (!severityList.length) {
        severityList.push(...toStringList(issue?.severity));
        severityList.push(...toStringList(issue?.level));
    }

    const messageList = toStringList(issue?.issues);
    if (!messageList.length) {
        messageList.push(...toStringList(issue?.message));
        messageList.push(...toStringList(issue?.description));
    }

    const recommendationList = toStringList(issue?.recommendation);
    if (!recommendationList.length) {
        recommendationList.push(...toStringList(issue?.修改建議));
        recommendationList.push(...toStringList(issue?.modificationAdvice));
    }

    const evidenceList = toStringList(issue?.evidence_list);
    if (!evidenceList.length) {
        evidenceList.push(...toStringList(issue?.evidence));
    }

    const columnList = toNumberList(issue?.column);
    if (!columnList.length) {
        columnList.push(...toNumberList(issue?.columns));
    }

    const detailCount = Math.max(
        messageList.length,
        ruleList.length,
        severityList.length,
        recommendationList.length,
        columnList.length,
        evidenceList.length
    );

    const details = [];
    for (let detailIndex = 0; detailIndex < detailCount; detailIndex += 1) {
        const ruleCandidate = ruleList[detailIndex] ?? ruleList[0] ?? "";
        const messageCandidate = messageList[detailIndex] ?? messageList[0] ?? "";
        const severityCandidate = severityList[detailIndex] ?? severityList[0] ?? "";
        const recommendationCandidate = recommendationList[detailIndex] ?? recommendationList[0] ?? "";
        const evidenceCandidate = evidenceList[detailIndex] ?? evidenceList[0] ?? "";
        const columnCandidate = columnList[detailIndex] ?? columnList[0] ?? null;

        const ruleId =
            typeof ruleCandidate === "string"
                ? ruleCandidate.trim()
                : String(ruleCandidate ?? "").trim();
        const message =
            typeof messageCandidate === "string"
                ? messageCandidate.trim()
                : String(messageCandidate ?? "").trim();
        const severityRaw =
            typeof severityCandidate === "string"
                ? severityCandidate.trim()
                : String(severityCandidate ?? "").trim();
        const severityKey = severityRaw ? severityRaw.toUpperCase() : "未標示";
        let severityClass = "info";
        if (!severityRaw || severityKey === "未標示") {
            severityClass = "muted";
        } else if (severityKey.includes("CRIT") || severityKey.includes("ERR")) {
            severityClass = "error";
        } else if (severityKey.includes("WARN")) {
            severityClass = "warn";
        }
        const columnNumber = Number(columnCandidate);
        const column = Number.isFinite(columnNumber) ? columnNumber : null;
        const suggestion =
            typeof recommendationCandidate === "string"
                ? recommendationCandidate.trim()
                : String(recommendationCandidate ?? "").trim();
        const evidence =
            typeof evidenceCandidate === "string" ? evidenceCandidate : String(evidenceCandidate ?? "");

        details.push({
            key: `${index}-detail-${detailIndex}`,
            index: details.length + 1,
            ruleId,
            severity: severityRaw,
            severityLabel: severityKey,
            severityClass,
            message,
            column,
            suggestion,
            evidence
        });
    }

    if (!details.length) {
        details.push({
            key: `${index}-detail-0`,
            index: 1,
            ruleId: "",
            severity: "",
            severityLabel: "未標示",
            severityClass: "muted",
            message: "",
            column: null,
            suggestion: "",
            evidence: typeof issue?.evidence === "string" ? issue.evidence : ""
        });
    }

    details.forEach((detail) => {
        const severityLabel = detail.severityLabel || "未標示";
        context.severityCounts.set(
            severityLabel,
            (context.severityCounts.get(severityLabel) || 0) + 1
        );
        if (detail.ruleId) {
            context.ruleCounts.set(detail.ruleId, (context.ruleCounts.get(detail.ruleId) || 0) + 1);
        }
    });

    const objectName =
        (typeof issue?.object === "string" && issue.object.trim()) ||
        (typeof issue?.object_name === "string" && issue.object_name.trim()) ||
        "";

    let line = Number(issue?.line);
    if (!Number.isFinite(line)) line = null;

    const snippet = typeof issue?.snippet === "string" ? issue.snippet : "";
    const snippetLines = snippet ? snippet.replace(/\r\n?/g, "\n").split("\n") : [];

    const codeLines = snippetLines.map((lineText, idx) => {
        const rawText = lineText.replace(/\r$/, "");
        const number = line !== null ? line + idx : null;
        const displayNumber = number !== null ? String(number) : "";
        const safeHtml = escapeHtml(rawText);
        return {
            key: `${index}-line-${idx}`,
            number,
            displayNumber,
            raw: rawText,
            html: safeHtml.length ? safeHtml : "&nbsp;",
            highlight: false
        };
    });

    if (codeLines.length) {
        let highlightApplied = false;
        if (line !== null) {
            codeLines.forEach((codeLine) => {
                if (codeLine.number === line) {
                    codeLine.highlight = true;
                    highlightApplied = true;
                }
            });
        }

        if (!highlightApplied) {
            const fallbackIndex = codeLines.findIndex((item) => item.raw.trim().length > 0);
            const indexToHighlight = fallbackIndex >= 0 ? fallbackIndex : 0;
            if (codeLines[indexToHighlight]) {
                codeLines[indexToHighlight].highlight = true;
            }
        }
    }

    const suggestionList = details
        .map((detail) => (typeof detail.suggestion === "string" ? detail.suggestion.trim() : ""))
        .filter((value) => value);

    const fixedCode =
        (typeof issue?.fixed_code === "string" && issue.fixed_code.trim()) ||
        (typeof issue?.fixedCode === "string" && issue.fixedCode.trim()) ||
        "";

    const primaryDetail = details[0];
    const primaryRuleId = details.find((detail) => detail.ruleId)?.ruleId || "";
    const primaryMessage = primaryDetail?.message || "";
    const primarySeverity = primaryDetail?.severity || "";
    const primarySeverityLabel = primaryDetail?.severityLabel || "未標示";
    const primarySeverityClass = primaryDetail?.severityClass || "info";
    const primaryEvidence =
        (typeof issue?.evidence === "string" && issue.evidence) || primaryDetail?.evidence || "";

    const columns = columnList;
    const columnPrimary = columns.length ? columns[0] : null;

    return {
        key: `${primaryRuleId || "issue"}-${index}`,
        index: index + 1,
        ruleId: primaryRuleId,
        ruleIds: ruleList
            .map((value) => (typeof value === "string" ? value.trim() : String(value ?? "").trim()))
            .filter(Boolean),
        severity: primarySeverity,
        severityLabel: primarySeverityLabel,
        severityClass: primarySeverityClass,
        message: primaryMessage,
        objectName,
        line,
        column: columns,
        columnPrimary,
        snippet,
        evidence: primaryEvidence,
        suggestion: suggestionList[0] || "",
        suggestionList,
        fixedCode,
        codeLines,
        details
    };
}

function buildStaticIssueDetails(issues, options = {}) {
    const severityCounts = new Map();
    const ruleCounts = new Map();

    const normalisedIssues = (Array.isArray(issues) ? issues : []).map((issue, index) =>
        buildStaticIssueDetail(issue, index, {
            severityCounts,
            ruleCounts
        })
    );

    const summaryObject = options.summaryObject;
    if (summaryObject?.by_rule && typeof summaryObject.by_rule === "object") {
        for (const [rule, count] of Object.entries(summaryObject.by_rule)) {
            const key = typeof rule === "string" && rule.trim() ? rule.trim() : "";
            const numeric = Number(count);
            if (!Number.isFinite(numeric)) continue;
            const previous = ruleCounts.get(key) || 0;
            ruleCounts.set(key || "未分類", Math.max(previous, numeric));
        }
    }

    const severityBreakdown = Array.from(severityCounts.entries()).map(([label, count]) => ({
        label,
        count
    }));
    severityBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const ruleBreakdown = Array.from(ruleCounts.entries())
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .map(([label, count]) => ({
            label: label || "未分類",
            count
        }));
    ruleBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    return { issues: normalisedIssues, severityBreakdown, ruleBreakdown };
}

function normaliseSummaryKey(value) {
    return typeof value === "string" ? value.toLowerCase() : "";
}

export function buildStaticRawSourceText(state) {
    if (!state || typeof state !== "object") return "";
    const issues = collectStaticReportIssues(state);
    try {
        return JSON.stringify({ issues });
    } catch (error) {
        console.warn("[reports] Failed to stringify static issue payload", error);
    }
    return "";
}

export function buildStaticReportDetails({
    state,
    parsedReport = null,
    aggregatedIssues = [],
    summaryRecords = [],
    combinedSummaryRecord = null,
    globalSummary = null
} = {}) {
    const safeState = state && typeof state === "object" ? state : {};
    const parsed =
        parsedReport && typeof parsedReport === "object"
            ? parsedReport
            : safeState.parsedReport && typeof safeState.parsedReport === "object"
            ? safeState.parsedReport
            : null;
    const reports = parsed?.reports && typeof parsed.reports === "object" ? parsed.reports : null;
    const staticReport = extractStaticReport(reports);

    const fallbackIssues = Array.isArray(parsed?.issues)
        ? parsed.issues
        : Array.isArray(staticReport?.issues)
        ? staticReport.issues
        : [];

    const aggregatedList = Array.isArray(aggregatedIssues) ? aggregatedIssues : [];
    const useAggregatedIssues = aggregatedList.length > 0 || fallbackIssues.length === 0;
    const rawIssues = useAggregatedIssues ? aggregatedList : fallbackIssues;

    const rawStaticSummary =
        staticReport && typeof staticReport === "object" && staticReport.summary !== undefined
            ? staticReport.summary
            : null;
    const summaryCandidate = parsed?.summary !== undefined ? parsed.summary : rawStaticSummary;
    const summary = summaryCandidate ?? null;
    const summaryObject = summary && typeof summary === "object" ? summary : null;
    const staticSummaryObject =
        rawStaticSummary && typeof rawStaticSummary === "object" ? rawStaticSummary : summaryObject;

    const staticSummaryDetails = buildSummaryDetailList(staticSummaryObject, {
        omitKeys: ["by_rule", "byRule", "sources"]
    });
    const staticMetadata =
        staticReport && typeof staticReport.metadata === "object" && !Array.isArray(staticReport.metadata)
            ? staticReport.metadata
            : null;
    const staticMetadataDetails = buildSummaryDetailList(staticMetadata);

    const { issues, severityBreakdown, ruleBreakdown } = buildStaticIssueDetails(rawIssues, {
        summaryObject: staticSummaryObject
    });

    const summaryKeyed =
        combinedSummaryRecord ||
        (Array.isArray(summaryRecords)
            ? summaryRecords.find(
                  (record) => normaliseSummaryKey(record?.source) === normaliseSummaryKey("combined")
              )
            : null);

    let total = null;
    if (summaryKeyed) {
        const combinedTotal = Number(summaryKeyed.total_issues ?? summaryKeyed.totalIssues);
        if (Number.isFinite(combinedTotal)) {
            total = combinedTotal;
        }
    }
    if (!Number.isFinite(total)) {
        total = useAggregatedIssues ? aggregatedList.length : safeState.issueSummary?.totalIssues;
    }
    if (!Number.isFinite(total) && summaryObject) {
        const candidate = Number(summaryObject.total_issues ?? summaryObject.totalIssues);
        if (Number.isFinite(candidate)) {
            total = candidate;
        }
    }
    if (!Number.isFinite(total)) {
        let computedTotal = 0;
        for (const issue of rawIssues) {
            if (Array.isArray(issue?.issues) && issue.issues.length) {
                const filtered = issue.issues.filter((entry) => typeof entry === "string" && entry.trim());
                computedTotal += filtered.length || issue.issues.length;
            } else if (typeof issue?.message === "string" && issue.message.trim()) {
                computedTotal += 1;
            }
        }
        total = computedTotal;
    }

    const summaryText = typeof summary === "string" ? summary.trim() : "";

    const staticAnalysis =
        safeState.analysis?.staticReport && typeof safeState.analysis.staticReport === "object"
            ? safeState.analysis.staticReport
            : null;

    const staticSourceValue =
        globalSummary?.sources?.static_analyzer || globalSummary?.sources?.staticAnalyzer || null;

    const sourceSummaryConfig = {
        metricsSources: [staticSourceValue, staticSummaryObject],
        statusCandidates: [
            staticSourceValue?.status,
            staticSummaryObject?.status,
            staticSummaryObject?.status_label,
            staticSummaryObject?.statusLabel,
            staticAnalysis?.summary?.status,
            staticAnalysis?.status,
            safeState.analysis?.enrichmentStatus
        ],
        errorCandidates: [
            staticSourceValue?.error_message,
            staticSourceValue?.errorMessage,
            staticSummaryObject?.error_message,
            staticSummaryObject?.errorMessage,
            staticAnalysis?.summary?.error_message,
            staticAnalysis?.summary?.errorMessage,
            staticAnalysis?.error
        ],
        generatedAtCandidates: [
            staticSourceValue?.generated_at,
            staticSourceValue?.generatedAt,
            staticSummaryObject?.generated_at,
            staticSummaryObject?.generatedAt,
            staticAnalysis?.generatedAt,
            staticAnalysis?.summary?.generated_at,
            staticAnalysis?.summary?.generatedAt,
            safeState.generatedAt,
            safeState.analysis?.generatedAt
        ]
    };

    return {
        staticReport,
        summary,
        summaryObject,
        summaryText,
        staticSummary: staticSummaryObject,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues,
        severityBreakdown,
        ruleBreakdown,
        totalIssues: Number.isFinite(total) ? Number(total) : null,
        sourceSummaryConfig
    };
}

export function collectStaticReportIssues(state) {
    return collectIssuesForSource(state, ["static_analyzer"]);
}

export function extractStaticReport(reports) {
    if (!reports || typeof reports !== "object") {
        return null;
    }
    return reports.static_analyzer || reports.staticAnalyzer || null;
}

export function mergeStaticReportIntoAnalysis({ state, baseAnalysis, reports, difyTarget }) {
    const staticReport = extractStaticReport(reports);
    if (!staticReport || typeof staticReport !== "object") {
        return { difyTarget, staticReport: null };
    }

    const existingStatic =
        baseAnalysis.staticReport && typeof baseAnalysis.staticReport === "object"
            ? baseAnalysis.staticReport
            : null;
    const mergedStatic = existingStatic ? { ...existingStatic } : {};
    Object.assign(mergedStatic, staticReport);

    if (staticReport.summary && typeof staticReport.summary === "object") {
        mergedStatic.summary = {
            ...(existingStatic?.summary && typeof existingStatic.summary === "object"
                ? existingStatic.summary
                : {}),
            ...staticReport.summary
        };
    } else if (existingStatic?.summary && typeof existingStatic.summary === "object") {
        mergedStatic.summary = { ...existingStatic.summary };
    }

    baseAnalysis.staticReport = mergedStatic;

    const enrichment = staticReport.enrichment;
    let nextDifyTarget = difyTarget;
    if (enrichment !== undefined && enrichment !== null) {
        if (!nextDifyTarget) {
            nextDifyTarget = {};
        }
        if (typeof enrichment === "string" && enrichment.trim()) {
            if (!nextDifyTarget.report || !nextDifyTarget.report.trim()) {
                nextDifyTarget.report = enrichment.trim();
            }
        } else if (enrichment && typeof enrichment === "object") {
            nextDifyTarget.raw = enrichment;
            if (!nextDifyTarget.report || !nextDifyTarget.report.trim()) {
                try {
                    nextDifyTarget.report = JSON.stringify(enrichment);
                } catch (error) {
                    console.warn("[Report] Failed to stringify static enrichment", error);
                }
            }
        }
    }

    const enrichmentStatus =
        typeof baseAnalysis.enrichmentStatus === "string"
            ? baseAnalysis.enrichmentStatus
            : typeof state.analysis?.enrichmentStatus === "string"
            ? state.analysis.enrichmentStatus
            : "";

    const staticSummary =
        baseAnalysis.staticReport?.summary && typeof baseAnalysis.staticReport.summary === "object"
            ? baseAnalysis.staticReport.summary
            : null;

    if (staticSummary) {
        if (enrichmentStatus) {
            const hasStatus =
                typeof staticSummary.status === "string" ||
                typeof staticSummary.status_label === "string" ||
                typeof staticSummary.statusLabel === "string";
            if (!hasStatus) {
                staticSummary.status = enrichmentStatus;
            }
        }
        if (
            !staticSummary.generated_at &&
            !staticSummary.generatedAt &&
            (state.generatedAt || state.analysis?.generatedAt)
        ) {
            staticSummary.generated_at = state.analysis?.generatedAt || state.generatedAt;
        }
    }

    return { difyTarget: nextDifyTarget, staticReport: mergedStatic };
}

export function preferStaticIssues(state, reports, sourceKey = "static_analyzer") {
    const normalisedKey = normaliseReportSourceKey(sourceKey);
    if (!state || !normalisedKey) {
        return [];
    }

    const issues = [];
    const parsedReports = state.parsedReport?.reports;
    const reportEntry = extractStaticReport(parsedReports || reports);

    if (Array.isArray(reportEntry?.issues)) {
        issues.push(...remapIssuesToSource(reportEntry.issues, sourceKey));
    }

    const aggregated =
        reportEntry?.aggregated && typeof reportEntry.aggregated === "object"
            ? reportEntry.aggregated
            : null;
    if (aggregated && Array.isArray(aggregated.issues)) {
        issues.push(...remapIssuesToSource(aggregated.issues, sourceKey));
    }

    const analysisReport =
        state.analysis?.staticReport && typeof state.analysis.staticReport === "object"
            ? state.analysis.staticReport
            : null;
    if (Array.isArray(analysisReport?.issues)) {
        issues.push(...remapIssuesToSource(analysisReport.issues, sourceKey));
    }

    return dedupeIssues(issues);
}

export default {
    buildStaticRawSourceText,
    buildStaticReportDetails,
    collectStaticReportIssues,
    extractStaticReport,
    mergeStaticReportIntoAnalysis,
    preferStaticIssues
};
