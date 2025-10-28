import {
    collectIssuesForSource,
    normaliseReportSourceKey,
    remapIssuesToSource,
    dedupeIssues
} from "./combinedReport.js";

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
    collectStaticReportIssues,
    extractStaticReport,
    mergeStaticReportIntoAnalysis,
    preferStaticIssues
};
