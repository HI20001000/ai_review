import { collectIssuesForSource } from "./combinedReport.js";

/**
 * Collect AI review issues from the workspace state.
 *
 * @param {Record<string, any>} state - Workspace state containing parsed reports and analysis snapshots.
 * @returns {Array<any>} Issues raised by the AI review pipeline.
 */
export function collectAiReviewIssues(state) {
    return collectIssuesForSource(state, ["dml_prompt"]);
}

/**
 * Extract the AI review report from a report collection.
 *
 * @param {Record<string, any>} reports - Raw reports keyed by source.
 * @returns {Record<string, any> | null} The AI review report when available.
 */
export function extractAiReviewReport(reports) {
    if (!reports || typeof reports !== "object") {
        return null;
    }
    return reports.dml_prompt || reports.dmlPrompt || null;
}

/**
 * Merge the AI review report into the provided analysis object.
 *
 * @param {{ state: Record<string, any>, baseAnalysis: Record<string, any>, reports: Record<string, any> }} params - Merge inputs.
 * @returns {{ dmlReport: Record<string, any> | null }} Normalised AI report information.
 */
export function mergeAiReviewReportIntoAnalysis({ state, baseAnalysis, reports }) {
    const dmlReport = extractAiReviewReport(reports);
    if (!dmlReport || typeof dmlReport !== "object") {
        return { dmlReport: null };
    }

    state.dml = dmlReport;
    const existingDml =
        baseAnalysis.dmlReport && typeof baseAnalysis.dmlReport === "object"
            ? baseAnalysis.dmlReport
            : null;
    const mergedDml = { ...dmlReport };
    if (existingDml) {
        Object.assign(mergedDml, existingDml);
    }
    if (dmlReport.summary && typeof dmlReport.summary === "object") {
        mergedDml.summary = {
            ...dmlReport.summary,
            ...(existingDml?.summary && typeof existingDml.summary === "object"
                ? existingDml.summary
                : {})
        };
    } else if (existingDml?.summary && typeof existingDml.summary === "object") {
        mergedDml.summary = { ...existingDml.summary };
    }
    baseAnalysis.dmlReport = mergedDml;
    if (!baseAnalysis.dmlSummary && mergedDml.summary) {
        baseAnalysis.dmlSummary = mergedDml.summary;
    }
    const dmlSummary =
        dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
    if (!state.dmlErrorMessage) {
        const dmlError =
            typeof dmlSummary?.error_message === "string"
                ? dmlSummary.error_message
                : typeof dmlSummary?.errorMessage === "string"
                ? dmlSummary.errorMessage
                : "";
        state.dmlErrorMessage = dmlError || "";
    }

    return { dmlReport: mergedDml };
}

function normaliseSqlText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function normaliseNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Transform the AI review report into UI friendly detail records.
 *
 * @param {Record<string, any>} dmlReport - Raw AI review report payload.
 * @returns {{ summary: Record<string, any> | null, details: Record<string, any> | null }}
 */
export function buildAiReviewDetails(dmlReport) {
    if (!dmlReport || typeof dmlReport !== "object") {
        return { summary: null, details: null };
    }

    const dmlSummary =
        dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
    const dmlChunks = Array.isArray(dmlReport.chunks) ? dmlReport.chunks : [];
    const segments = Array.isArray(dmlReport.segments)
        ? dmlReport.segments.map((segment, index) => {
              const chunk = dmlChunks[index] || null;
              const sql = normaliseSqlText(segment?.text ?? segment?.sql);
              const analysisText = typeof chunk?.answer === "string" ? chunk.answer : "";
              return {
                  key: `${index}-segment`,
                  index: normaliseNumber(segment?.index) ?? index + 1,
                  sql,
                  startLine: normaliseNumber(segment?.startLine),
                  endLine: normaliseNumber(segment?.endLine),
                  startColumn: normaliseNumber(segment?.startColumn),
                  endColumn: normaliseNumber(segment?.endColumn),
                  analysis: analysisText,
                  raw: chunk?.raw || null
              };
          })
        : [];

    const aggregatedText = typeof dmlReport.report === "string" ? dmlReport.report.trim() : "";
    const humanReadableText =
        typeof dmlReport.reportText === "string" ? dmlReport.reportText.trim() : "";
    const aggregatedIssues = Array.isArray(dmlReport.issues) ? dmlReport.issues : [];
    const aggregatedObject =
        dmlReport.aggregated && typeof dmlReport.aggregated === "object"
            ? dmlReport.aggregated
            : null;
    const errorMessage =
        typeof dmlReport.error === "string"
            ? dmlReport.error
            : typeof dmlSummary?.error_message === "string"
            ? dmlSummary.error_message
            : typeof dmlSummary?.errorMessage === "string"
            ? dmlSummary.errorMessage
            : "";
    const status = typeof dmlSummary?.status === "string" ? dmlSummary.status : "";
    const generatedAt = dmlReport.generatedAt || dmlSummary?.generated_at || dmlSummary?.generatedAt || null;
    const conversationId =
        typeof dmlReport.conversationId === "string" ? dmlReport.conversationId : "";

    return {
        summary: dmlSummary,
        details: {
            summary: dmlSummary,
            segments,
            reportText: humanReadableText || aggregatedText,
            aggregatedText,
            aggregated: aggregatedObject,
            issues: aggregatedIssues,
            error: errorMessage,
            status,
            generatedAt,
            conversationId
        }
    };
}

export default {
    collectAiReviewIssues,
    extractAiReviewReport,
    mergeAiReviewReportIntoAnalysis,
    buildAiReviewDetails
};
