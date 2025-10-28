import { collectIssuesForSource } from "./combinedReport.js";

function clonePlain(value, seen = new WeakMap()) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const result = [];
        seen.set(value, result);
        for (const item of value) {
            result.push(clonePlain(item, seen));
        }
        return result;
    }
    const result = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) {
        result[key] = clonePlain(item, seen);
    }
    return result;
}

function normaliseReportObject(value) {
    if (!value) {
        return null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        if (/^[\[{]/.test(trimmed)) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch (error) {
                console.warn("[aiReview] Failed to parse AI review object", error, value);
                return { report: trimmed };
            }
        }
        return { report: trimmed };
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return null;
}

function normaliseTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Date.parse(trimmed);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
        return trimmed;
    }
    return null;
}

function normaliseIssues(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => (item && typeof item === "object" ? clonePlain(item) : item));
}

function pickErrorMessage(candidates) {
    let fallback = "";
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                return trimmed;
            }
            if (!fallback) {
                fallback = candidate;
            }
        }
    }
    return fallback;
}

function pickFirstString(candidates, { allowEmpty = false } = {}) {
    let fallback = "";
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                return trimmed;
            }
            if (allowEmpty && fallback === "") {
                fallback = candidate;
            }
        }
    }
    if (allowEmpty && fallback !== "") {
        return fallback;
    }
    return "";
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

function normaliseSegments(segments, chunks) {
    const segmentList = Array.isArray(segments) ? segments : [];
    const chunkList = Array.isArray(chunks) ? chunks : [];
    return segmentList.map((segment, index) => {
        const chunk = chunkList[index] || null;
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
    });
}

export function collectAiReviewIssues(state) {
    return collectIssuesForSource(state, ["dml_prompt"]);
}

export function extractAiReviewReport(reports) {
    if (!reports || typeof reports !== "object") {
        return null;
    }
    return reports.dml_prompt || reports.dmlPrompt || null;
}

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
    const mergedDml = existingDml ? { ...existingDml } : {};
    Object.assign(mergedDml, dmlReport);

    if (dmlReport.summary && typeof dmlReport.summary === "object") {
        mergedDml.summary = {
            ...(existingDml?.summary && typeof existingDml.summary === "object"
                ? existingDml.summary
                : {}),
            ...dmlReport.summary
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

export function buildAiReviewDetails(dmlReport) {
    if (!dmlReport || typeof dmlReport !== "object") {
        return { summary: null, details: null };
    }

    const dmlSummary =
        dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
    const dmlChunks = Array.isArray(dmlReport.chunks) ? dmlReport.chunks : [];
    const segments = normaliseSegments(dmlReport.segments, dmlChunks);

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
    const generatedAt =
        dmlReport.generatedAt || dmlSummary?.generated_at || dmlSummary?.generatedAt || null;
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

function normaliseAiReviewPayload(payload = {}) {
    const analysis =
        payload && typeof payload.analysis === "object" && !Array.isArray(payload.analysis)
            ? payload.analysis
            : null;

    const reportObject =
        normaliseReportObject(payload.dml) ||
        normaliseReportObject(payload.dmlReport) ||
        normaliseReportObject(analysis?.dmlReport);

    const summaryObject =
        normaliseReportObject(payload.dmlSummary) ||
        normaliseReportObject(analysis?.dmlSummary) ||
        (reportObject?.summary && typeof reportObject.summary === "object"
            ? reportObject.summary
            : null);

    const aggregatedObject =
        normaliseReportObject(payload.dmlAggregated) ||
        normaliseReportObject(analysis?.dmlAggregated) ||
        (reportObject?.aggregated && typeof reportObject.aggregated === "object"
            ? reportObject.aggregated
            : null);

    let segments = Array.isArray(payload.dmlSegments) ? payload.dmlSegments : null;
    if (!segments || !segments.length) {
        segments = Array.isArray(reportObject?.segments) ? reportObject.segments : null;
    }
    if (!segments || !segments.length) {
        segments = Array.isArray(analysis?.dmlSegments) ? analysis.dmlSegments : null;
    }
    segments = Array.isArray(segments) ? clonePlain(segments) : [];

    let issues = Array.isArray(payload.dmlIssues) ? payload.dmlIssues : null;
    if (!issues || !issues.length) {
        issues = Array.isArray(analysis?.dmlIssues) ? analysis.dmlIssues : null;
    }
    if (!issues || !issues.length) {
        issues = Array.isArray(reportObject?.issues) ? reportObject.issues : null;
    }
    if (!issues || !issues.length) {
        issues = Array.isArray(aggregatedObject?.issues) ? aggregatedObject.issues : null;
    }
    issues = normaliseIssues(issues);

    const generatedAtCandidates = [
        payload.dmlGeneratedAt,
        analysis?.dmlGeneratedAt,
        reportObject?.generatedAt,
        summaryObject?.generated_at,
        summaryObject?.generatedAt,
        payload.generatedAt
    ];
    let generatedAt = null;
    for (const candidate of generatedAtCandidates) {
        const normalised = normaliseTimestamp(candidate);
        if (normalised) {
            generatedAt = normalised;
            break;
        }
    }

    const conversationId = pickFirstString(
        [
            payload.dmlConversationId,
            analysis?.dmlConversationId,
            payload.conversationId,
            reportObject?.conversationId,
            summaryObject?.conversationId
        ],
        { allowEmpty: false }
    );

    const status = pickFirstString(
        [
            payload.dmlStatus,
            summaryObject?.status,
            analysis?.dmlSummary?.status,
            analysis?.dmlReport?.summary?.status,
            reportObject?.status
        ],
        { allowEmpty: false }
    );

    const errorMessage = pickErrorMessage([
        payload.dmlErrorMessage,
        payload.dmlError,
        analysis?.dmlErrorMessage,
        summaryObject?.error_message,
        summaryObject?.errorMessage,
        reportObject?.error
    ]);

    const report = reportObject ? clonePlain(reportObject) : null;
    const summary = summaryObject ? clonePlain(summaryObject) : null;
    const aggregated = aggregatedObject ? clonePlain(aggregatedObject) : null;

    const analysisPatch = {};
    if (report) analysisPatch.dmlReport = report;
    if (summary) analysisPatch.dmlSummary = summary;
    if (aggregated) analysisPatch.dmlAggregated = aggregated;
    if (issues.length) analysisPatch.dmlIssues = clonePlain(issues);
    if (segments.length) analysisPatch.dmlSegments = clonePlain(segments);
    if (generatedAt) analysisPatch.dmlGeneratedAt = generatedAt;
    if (conversationId) analysisPatch.dmlConversationId = conversationId;
    if (typeof errorMessage === "string") analysisPatch.dmlErrorMessage = errorMessage;
    if (status) analysisPatch.dmlStatus = status;

    const hasPatchEntries = Object.keys(analysisPatch).length > 0;

    return {
        report,
        summary,
        aggregated,
        issues,
        segments,
        status,
        errorMessage: typeof errorMessage === "string" ? errorMessage : "",
        generatedAt,
        conversationId,
        analysisPatch: hasPatchEntries ? analysisPatch : null
    };
}

function mergeAnalysisPatch(baseAnalysis, patch) {
    if (!patch) {
        return baseAnalysis || null;
    }
    const target =
        baseAnalysis && typeof baseAnalysis === "object" && !Array.isArray(baseAnalysis)
            ? { ...baseAnalysis }
            : {};
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (target[key] === value) continue;
        target[key] = value;
        changed = true;
    }
    return changed ? target : baseAnalysis || null;
}

function assignAiReviewState(state, payload) {
    if (!state || !payload) {
        return payload;
    }
    state.dml = payload.report;
    if (typeof payload.errorMessage === "string") {
        state.dmlErrorMessage = payload.errorMessage;
    } else if (!state.dmlErrorMessage) {
        state.dmlErrorMessage = "";
    }

    const mergedAnalysis = mergeAnalysisPatch(state.analysis, payload.analysisPatch);
    if (mergedAnalysis !== state.analysis) {
        state.analysis = mergedAnalysis;
    }

    return payload;
}

export function applyAiReviewResultToState(state, payload = {}) {
    const normalised = normaliseAiReviewPayload({ ...payload, analysis: payload.analysis ?? state?.analysis });
    return assignAiReviewState(state, normalised);
}

export function hydrateAiReviewStateFromRecord(state, record = {}) {
    const normalised = normaliseAiReviewPayload({ ...record, analysis: record.analysis ?? state?.analysis });
    return assignAiReviewState(state, normalised);
}

export function buildAiReviewSourceSummaryConfig({ report, globalSource, analysis } = {}) {
    const dmlReport = report && typeof report === "object" ? report : null;
    const { summary, details } = buildAiReviewDetails(dmlReport);
    const analysisState = analysis && typeof analysis === "object" ? analysis : null;

    return {
        summary,
        details,
        metricsSources: [globalSource, details?.summary, details?.aggregated].filter(Boolean),
        statusCandidates: [
            globalSource?.status,
            details?.status,
            summary?.status,
            analysisState?.dmlSummary?.status,
            analysisState?.dmlReport?.summary?.status
        ],
        errorCandidates: [
            globalSource?.error_message,
            globalSource?.errorMessage,
            details?.error,
            summary?.error_message,
            summary?.errorMessage,
            analysisState?.dmlErrorMessage
        ],
        generatedAtCandidates: [
            globalSource?.generated_at,
            globalSource?.generatedAt,
            details?.generatedAt,
            dmlReport?.generatedAt,
            summary?.generated_at,
            summary?.generatedAt,
            analysisState?.dmlGeneratedAt
        ]
    };
}

export function buildAiReviewPersistencePayload(state) {
    if (!state) {
        return null;
    }
    const payload = normaliseAiReviewPayload({
        dml: state.dml,
        dmlErrorMessage: state.dmlErrorMessage,
        dmlIssues: state.dml?.issues,
        dmlSegments: state.dml?.segments,
        dmlAggregated: state.dml?.aggregated,
        dmlSummary: state.dml?.summary,
        dmlGeneratedAt: state.analysis?.dmlGeneratedAt || state.dml?.generatedAt,
        dmlConversationId:
            state.analysis?.dmlConversationId || state.dml?.conversationId || state.conversationId,
        analysis: state.analysis
    });
    return payload.analysisPatch;
}

export default {
    collectAiReviewIssues,
    extractAiReviewReport,
    mergeAiReviewReportIntoAnalysis,
    buildAiReviewDetails,
    applyAiReviewResultToState,
    hydrateAiReviewStateFromRecord,
    buildAiReviewSourceSummaryConfig,
    buildAiReviewPersistencePayload
};
