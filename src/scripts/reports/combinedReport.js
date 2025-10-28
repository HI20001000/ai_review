import {
    cloneIssueWithSource,
    dedupeIssues,
    findEntryBySourceKey,
    normaliseReportSourceKey,
    remapIssuesToSource
} from "./shared.js";

/**
 * Collect issues originating from the provided report sources.
 *
 * @param {Record<string, any>} state - Workspace state containing parsed reports and in-memory analysis.
 * @param {string | string[]} sourceKeys - Report source identifiers to gather issues for.
 * @returns {Array<any>} Flattened issue list tagged with the originating source.
 */
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

/**
 * Gather a best-effort set of aggregated issues across static analysis, AI reviews and Dify workflows.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @returns {Array<any>} Aggregated and deduplicated issue list.
 */
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

/**
 * Update the `issueSummary.totalIssues` property on the supplied state in place.
 *
 * @param {Record<string, any>} state - Workspace report state subject to mutation.
 * @returns {void}
 */
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

/**
 * Extract a summary object matching the requested report source from state.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {string} sourceKey - Desired source identifier.
 * @returns {Record<string, any> | null} Summary candidate or null when not available.
 */
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

/**
 * Build a normalised summary record suitable for UI presentation.
 *
 * @param {Record<string, any> | string | null} summarySource - Source summary data.
 * @param {{ source: string, label: string, issues?: Array<any> }} options - Render options.
 * @returns {Record<string, any>} Normalised summary payload.
 */
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

/**
 * Build a summary record scoped to a particular report source.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {{ sourceKey: string, label: string, issues?: Array<any> }} options - Source configuration.
 * @returns {Record<string, any>} Summary record.
 */
export function buildSourceSummaryRecord(state, options) {
    const summaryCandidate = extractSummaryCandidate(state, options.sourceKey);
    return buildSummaryRecord(summaryCandidate, {
        source: options.sourceKey,
        label: options.label,
        issues: options.issues
    });
}

/**
 * Construct a combined summary record derived from the global report summary.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {{ label?: string, issues?: Array<any> }} options - Presentation overrides.
 * @returns {Record<string, any>} Summary record for the combined view.
 */
export function buildCombinedSummaryRecord(state, options) {
    const globalSummary = state?.parsedReport?.summary || null;
    return buildSummaryRecord(globalSummary, {
        source: "combined",
        label: options.label || "聚合報告",
        issues: options.issues
    });
}

/**
 * Produce a trio of summary records for static, AI and combined report contexts.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {Array<any>} staticIssues - Static report issues.
 * @param {Array<any>} aiIssues - AI review issues.
 * @param {Array<any> | null} [aggregatedIssues] - Optional pre-aggregated issues.
 * @returns {Array<Record<string, any>>} Summary records in display order.
 */
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

/**
 * Convert a summary-like object into labelled detail rows for UI consumption.
 *
 * @param {Record<string, any>} source - Summary object to flatten.
 * @param {{ omitKeys?: string[] }} [options] - Keys to omit from the output.
 * @returns {Array<{ label: string, value: string }>} Detail rows.
 */
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
