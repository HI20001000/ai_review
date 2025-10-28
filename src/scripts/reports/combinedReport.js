export function normaliseReportSourceKey(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function findEntryBySourceKey(container, sourceKey) {
    if (!container || typeof container !== "object") {
        return null;
    }
    const target = normaliseReportSourceKey(sourceKey);
    if (!target) return null;
    for (const [key, value] of Object.entries(container)) {
        if (normaliseReportSourceKey(key) === target) {
            return value && typeof value === "object" ? value : null;
        }
    }
    return null;
}

export function cloneIssueWithSource(issue, sourceKey, options = {}) {
    let result = issue;

    if (issue && typeof issue === "object" && !Array.isArray(issue)) {
        const target = normaliseReportSourceKey(sourceKey);

        if (target) {
            const existingKeys = [
                normaliseReportSourceKey(issue.source),
                normaliseReportSourceKey(issue.analysis_source),
                normaliseReportSourceKey(issue.analysisSource)
            ].filter(Boolean);

            if (options.force) {
                const base = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
                const { analysis_source: _analysisSource, analysisSource: _analysisSourceCamel, ...rest } = base;
                result = { ...rest, source: sourceKey };
            } else if (existingKeys.includes(target)) {
                result = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
            } else if (existingKeys.length === 0) {
                result = { ...issue, source: sourceKey };
            }
        }
    }

    return result;
}

export function remapIssuesToSource(issues, sourceKey, options = {}) {
    if (!Array.isArray(issues)) {
        return [];
    }
    return issues.map((issue) => cloneIssueWithSource(issue, sourceKey, options));
}

function sortObjectKeys(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sortObjectKeys(item));
    }
    const sorted = {};
    Object.keys(value)
        .sort()
        .forEach((key) => {
            sorted[key] = sortObjectKeys(value[key]);
        });
    return sorted;
}

function createIssueKey(issue) {
    if (issue && typeof issue === "object") {
        try {
            return JSON.stringify(sortObjectKeys(issue));
        } catch (error) {
            console.warn("[reports] Failed to stringify issue for dedupe", error, issue);
        }
    }
    if (typeof issue === "string") {
        return issue;
    }
    return String(issue);
}

export function dedupeIssues(list) {
    const seen = new Set();
    const result = [];
    for (const issue of list || []) {
        const key = createIssueKey(issue);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(issue);
    }
    return result;
}

export function collectIssuesForSource(state, sourceKeys) {
    if (!state) return [];
    const sources = Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys];
    const sourceSet = new Set(sources.map((key) => normaliseReportSourceKey(key)));
    const results = [];

    const pushIssue = (issue, fallbackSourceKey = null, forceSource = false) => {
        if (issue === null || issue === undefined) {
            return;
        }
        let candidate = issue;
        if (fallbackSourceKey) {
            candidate = cloneIssueWithSource(candidate, fallbackSourceKey, { force: forceSource });
        }
        results.push(candidate);
    };

    const removeIssuesBySource = (normalisedKey) => {
        if (!normalisedKey) {
            return;
        }
        for (let index = results.length - 1; index >= 0; index -= 1) {
            const existing = results[index];
            if (!existing || typeof existing !== "object") {
                continue;
            }
            const existingKey =
                normaliseReportSourceKey(existing.source) ||
                normaliseReportSourceKey(existing.analysis_source) ||
                normaliseReportSourceKey(existing.analysisSource) ||
                normaliseReportSourceKey(existing.from);
            if (existingKey === normalisedKey) {
                results.splice(index, 1);
            }
        }
    };

    const parsedIssues = state.parsedReport?.issues;
    if (Array.isArray(parsedIssues)) {
        parsedIssues.forEach((issue) => {
            const sourceValue =
                issue?.source || issue?.analysis_source || issue?.analysisSource || issue?.from;
            const normalised = normaliseReportSourceKey(sourceValue);
            if (normalised && sourceSet.has(normalised)) {
                if (normalised === normaliseReportSourceKey("static_analyzer")) {
                    return;
                }
                pushIssue(issue);
            }
        });
    }

    const reports = state.parsedReport?.reports;
    if (reports && typeof reports === "object") {
        sources.forEach((sourceKey) => {
            const reportEntry = findEntryBySourceKey(reports, sourceKey);
            const normalisedKey = normaliseReportSourceKey(sourceKey);

            if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
                const staticKey = normaliseReportSourceKey("static_analyzer");
                const enrichedIssues = [];

                const difyEntry = findEntryBySourceKey(reports, "dify_workflow");
                if (Array.isArray(difyEntry?.issues) && difyEntry.issues.length) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(difyEntry.issues, sourceKey, { force: true })
                    );
                }

                const difyAggregated =
                    difyEntry?.aggregated && typeof difyEntry.aggregated === "object"
                        ? difyEntry.aggregated
                        : null;
                if (!enrichedIssues.length && difyAggregated && Array.isArray(difyAggregated.issues)) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(difyAggregated.issues, sourceKey, { force: true })
                    );
                }

                const aggregated =
                    reportEntry?.aggregated && typeof reportEntry.aggregated === "object"
                        ? reportEntry.aggregated
                        : null;
                if (!enrichedIssues.length && aggregated && Array.isArray(aggregated.issues)) {
                    enrichedIssues.push(...remapIssuesToSource(aggregated.issues, sourceKey));
                }

                if (!enrichedIssues.length && Array.isArray(state.dify?.issues) && state.dify.issues.length) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(state.dify.issues, sourceKey, { force: true })
                    );
                }

                if (!enrichedIssues.length && reportEntry && Array.isArray(reportEntry.issues)) {
                    enrichedIssues.push(...remapIssuesToSource(reportEntry.issues, sourceKey));
                }

                if (enrichedIssues.length) {
                    removeIssuesBySource(staticKey);
                    dedupeIssues(enrichedIssues).forEach((issue) => pushIssue(issue));
                }
            } else {
                if (reportEntry && Array.isArray(reportEntry.issues)) {
                    reportEntry.issues.forEach((issue) => pushIssue(issue, sourceKey));
                }
                const aggregated =
                    reportEntry?.aggregated && typeof reportEntry.aggregated === "object"
                        ? reportEntry.aggregated
                        : null;
                if (aggregated && Array.isArray(aggregated.issues)) {
                    aggregated.issues.forEach((issue) => pushIssue(issue, sourceKey));
                }
            }
        });
    }

    const analysisIssues = state.analysis?.issues;
    if (Array.isArray(analysisIssues)) {
        analysisIssues.forEach((issue) => {
            const sourceValue =
                issue?.source || issue?.analysis_source || issue?.analysisSource || issue?.from;
            const normalised = normaliseReportSourceKey(sourceValue);
            if (normalised && sourceSet.has(normalised)) {
                pushIssue(issue);
            }
        });
    }

    const difyIssues = state.dify?.issues;
    if (Array.isArray(difyIssues)) {
        difyIssues.forEach((issue) => {
            const targetKey = normaliseReportSourceKey(issue?.source) || normaliseReportSourceKey("dify_workflow");
            if (sourceSet.has(targetKey)) {
                pushIssue(issue);
            }
        });
    }

    const dmlIssues = state.dml?.issues;
    if (Array.isArray(dmlIssues)) {
        dmlIssues.forEach((issue) => {
            const targetKey =
                normaliseReportSourceKey(issue?.source) || normaliseReportSourceKey("dml_prompt");
            if (sourceSet.has(targetKey)) {
                pushIssue(issue);
            }
        });
    }

    const sourceKeySet = new Set(sources.map((key) => normaliseReportSourceKey(key)));

    if (sourceKeySet.has(normaliseReportSourceKey("static_analyzer"))) {
        const reports = state.analysis && typeof state.analysis === "object" ? state.analysis : null;
        if (reports?.staticReport && typeof reports.staticReport === "object") {
            const staticIssues = reports.staticReport.issues;
            if (Array.isArray(staticIssues)) {
                dedupeIssues(remapIssuesToSource(staticIssues, "static_analyzer")).forEach((issue) =>
                    pushIssue(issue)
                );
            }
        }
    }

    if (sourceKeySet.has(normaliseReportSourceKey("dml_prompt"))) {
        const dmlReport = state.analysis?.dmlReport && typeof state.analysis.dmlReport === "object"
            ? state.analysis.dmlReport
            : null;
        if (Array.isArray(dmlReport?.issues)) {
            dedupeIssues(remapIssuesToSource(dmlReport.issues, "dml_prompt")).forEach((issue) =>
                pushIssue(issue)
            );
        }
    }

    return dedupeIssues(results);
}

export function collectAggregatedIssues(state) {
    if (!state) return [];
    const staticIssues = collectIssuesForSource(state, ["static_analyzer"]);
    const aiIssues = collectIssuesForSource(state, ["dml_prompt"]);
    const combined = dedupeIssues([...staticIssues, ...aiIssues]);
    if (combined.length > 0) {
        return combined;
    }

    const difyIssues = collectIssuesForSource(state, ["dify_workflow"]);
    if (difyIssues.length > 0) {
        return dedupeIssues([
            ...remapIssuesToSource(difyIssues, "static_analyzer", { force: true }),
            ...aiIssues
        ]);
    }

    const parsedIssues = Array.isArray(state.parsedReport?.issues)
        ? remapIssuesToSource(state.parsedReport.issues, "static_analyzer")
        : [];
    if (parsedIssues.length > 0) {
        return dedupeIssues([...parsedIssues, ...aiIssues]);
    }

    const staticFallback = Array.isArray(state.analysis?.staticReport?.issues)
        ? remapIssuesToSource(state.analysis.staticReport.issues, "static_analyzer")
        : [];
    if (staticFallback.length > 0) {
        return dedupeIssues([...staticFallback, ...aiIssues]);
    }

    const dmlIssues = Array.isArray(state.dml?.issues)
        ? dedupeIssues(state.dml.issues)
        : [];
    if (dmlIssues.length > 0) {
        return dmlIssues;
    }

    return [];
}

export function updateIssueSummaryTotals(state) {
    if (!state) return;
    const combinedIssues = collectAggregatedIssues(state);
    const total = Number.isFinite(combinedIssues.length) ? combinedIssues.length : null;
    if (total === null) {
        return;
    }
    if (!state.issueSummary || typeof state.issueSummary !== "object") {
        state.issueSummary = { totalIssues: total };
        return;
    }
    state.issueSummary.totalIssues = total;
}

export function extractSummaryCandidate(state, sourceKey) {
    if (!state) return null;
    if (sourceKey) {
        const normalisedKey = normaliseReportSourceKey(sourceKey);
        if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
            const staticSummary = state.analysis?.staticReport?.summary;
            if (staticSummary && typeof staticSummary === "object" && !Array.isArray(staticSummary)) {
                return staticSummary;
            }
        }
        if (normalisedKey === normaliseReportSourceKey("dml_prompt")) {
            const dmlSummary = state.dml?.summary || state.analysis?.dmlSummary;
            if (dmlSummary && typeof dmlSummary === "object" && !Array.isArray(dmlSummary)) {
                return dmlSummary;
            }
        }
        if (normalisedKey === normaliseReportSourceKey("dify_workflow")) {
            const difySummary = state.analysis?.dify?.summary;
            if (difySummary && typeof difySummary === "object" && !Array.isArray(difySummary)) {
                return difySummary;
            }
        }
    }

    return null;
}

function normaliseTimestampValue(value) {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || null;
    }
    return null;
}

export function buildSummaryRecord(summarySource, options) {
    const issues = Array.isArray(options.issues) ? options.issues : [];
    const record = {
        source: options.source,
        label: options.label,
        total_issues: issues.length
    };

    if (summarySource && typeof summarySource === "object" && !Array.isArray(summarySource)) {
        const statusValue =
            typeof summarySource.status === "string"
                ? summarySource.status
                : typeof summarySource.status_label === "string"
                ? summarySource.status_label
                : typeof summarySource.statusLabel === "string"
                ? summarySource.statusLabel
                : "";
        if (statusValue && statusValue.trim()) {
            record.status = statusValue.trim();
        }
        const generatedAtValue =
            summarySource.generated_at ??
            summarySource.generatedAt ??
            summarySource.generated_at_display ??
            summarySource.generatedAtDisplay ??
            null;
        const normalisedTimestamp = normaliseTimestampValue(generatedAtValue);
        if (normalisedTimestamp) {
            record.generated_at = normalisedTimestamp;
        }
        const errorValue =
            typeof summarySource.error_message === "string"
                ? summarySource.error_message
                : typeof summarySource.errorMessage === "string"
                ? summarySource.errorMessage
                : "";
        if (errorValue && errorValue.trim()) {
            record.error_message = errorValue.trim();
        }
        const messageValue =
            typeof summarySource.message === "string" ? summarySource.message : summarySource.note;
        if (messageValue && typeof messageValue === "string" && messageValue.trim()) {
            record.message = messageValue.trim();
        }
    } else if (typeof summarySource === "string") {
        const trimmed = summarySource.trim();
        if (trimmed) {
            record.message = trimmed;
        }
    }

    return record;
}

export function buildSourceSummaryRecord(state, options) {
    const summaryCandidate = extractSummaryCandidate(state, options.sourceKey);
    return buildSummaryRecord(summaryCandidate, {
        source: options.sourceKey,
        label: options.label,
        issues: options.issues
    });
}

export function buildCombinedSummaryRecord(state, options) {
    const globalSummary = state?.parsedReport?.summary || null;
    return buildSummaryRecord(globalSummary, {
        source: "combined",
        label: options.label || "聚合報告",
        issues: options.issues
    });
}

export function buildAggregatedSummaryRecords(state, staticIssues, aiIssues, aggregatedIssues = null) {
    const records = [];
    records.push(
        buildSourceSummaryRecord(state, {
            sourceKey: "static_analyzer",
            label: "靜態分析器",
            issues: staticIssues
        })
    );
    records.push(
        buildSourceSummaryRecord(state, {
            sourceKey: "dml_prompt",
            label: "AI審查",
            issues: aiIssues
        })
    );
    records.push(
        buildCombinedSummaryRecord(state, {
            label: "聚合報告",
            issues:
                Array.isArray(aggregatedIssues) && aggregatedIssues.length
                    ? aggregatedIssues
                    : dedupeIssues([...staticIssues, ...aiIssues])
        })
    );
    return records;
}

export function buildSummaryDetailList(source, options = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        return [];
    }

    const omit = new Set(options.omitKeys || []);
    const details = [];

    for (const [key, rawValue] of Object.entries(source)) {
        if (omit.has(key)) continue;
        if (rawValue === null || rawValue === undefined) continue;
        if (typeof rawValue === "object") continue;

        let value;
        if (typeof rawValue === "boolean") {
            value = rawValue ? "是" : "否";
        } else {
            value = String(rawValue);
        }

        const label = typeof key === "string" && key.trim() ? key : "-";
        details.push({ label, value });
    }

    return details;
}

export default {
    normaliseReportSourceKey,
    findEntryBySourceKey,
    cloneIssueWithSource,
    remapIssuesToSource,
    dedupeIssues,
    collectIssuesForSource,
    collectAggregatedIssues,
    updateIssueSummaryTotals,
    extractSummaryCandidate,
    buildSummaryRecord,
    buildSourceSummaryRecord,
    buildCombinedSummaryRecord,
    buildAggregatedSummaryRecords,
    buildSummaryDetailList
};
