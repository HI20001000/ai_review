import { collectIssuesForSource } from "./combinedReport.js";
import { isPlainObject, normaliseReportObject } from "./shared.js";

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

function clonePlain(value) {
    if (Array.isArray(value)) {
        return value.map((item) => clonePlain(item));
    }
    if (isPlainObject(value)) {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = clonePlain(entry);
        }
        return result;
    }
    return value;
}

function pickFirstString(candidates, options = {}) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const allowEmpty = Boolean(options.allowEmpty);

    for (const candidate of list) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed || (allowEmpty && candidate !== undefined && candidate !== null)) {
                return allowEmpty ? candidate : trimmed;
            }
        } else if (candidate && typeof candidate === "object") {
            const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
            if (message) {
                return message;
            }
        }
    }

    return "";
}

function pickErrorMessage(candidates) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const candidate of list) {
        if (!candidate) continue;
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                return trimmed;
            }
        } else if (candidate && typeof candidate === "object") {
            const errorValue =
                typeof candidate.error === "string"
                    ? candidate.error
                    : typeof candidate.message === "string"
                    ? candidate.message
                    : null;
            if (typeof errorValue === "string" && errorValue.trim()) {
                return errorValue.trim();
            }
        }
    }
    return "";
}

function normaliseTimestamp(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        return trimmed;
    }
    return null;
}

function normaliseIssues(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }

    const results = [];
    for (const issue of issues) {
        if (!issue) continue;
        if (isPlainObject(issue)) {
            const clone = { ...issue };
            const lineCandidate =
                clone.line ?? clone.line_number ?? clone.lineNumber ?? clone.startLine ?? null;
            const columnCandidate =
                clone.column ?? clone.column_number ?? clone.columnNumber ?? clone.startColumn ?? null;
            const severityCandidate = clone.severity ?? clone.level ?? null;

            const lineNumber = normaliseNumber(lineCandidate);
            if (lineNumber !== null) {
                clone.line = lineNumber;
            }
            const columnNumber = normaliseNumber(columnCandidate);
            if (columnNumber !== null) {
                clone.column = columnNumber;
            }
            if (severityCandidate && typeof severityCandidate === "string") {
                clone.severity = severityCandidate.trim();
            }

            const statement = pickFirstString(
                [clone.statement, clone.sql, clone.segment, clone.text, clone.raw],
                { allowEmpty: true }
            );
            if (statement) {
                clone.statement = normaliseSqlText(statement);
            }

            if (typeof clone.source !== "string" && typeof clone.analysis_source === "string") {
                clone.source = clone.analysis_source;
            }

            results.push(clone);
        } else if (typeof issue === "string") {
            const trimmed = issue.trim();
            if (trimmed) {
                results.push({ message: trimmed });
            }
        }
    }
    return results;
}

function normaliseSegments(segments, chunks) {
    const segmentList = Array.isArray(segments) ? segments : [];
    const chunkList = Array.isArray(chunks) ? chunks : [];

    const results = [];
    const appendSegment = (segment, index) => {
        if (!segment && segment !== 0) return;

        if (isPlainObject(segment)) {
            const clone = { ...segment };
            const text = pickFirstString(
                [clone.text, clone.segment, clone.sql, clone.answer, clone.raw, clone.statement],
                { allowEmpty: true }
            );
            if (text) {
                clone.text = normaliseSqlText(text);
            }
            const indexValue = normaliseNumber(clone.index);
            clone.index = indexValue !== null ? indexValue : index + 1;
            if (typeof clone.id !== "string" || !clone.id.trim()) {
                clone.id = String(clone.index);
            }
            const totalValue = normaliseNumber(clone.total);
            if (totalValue !== null) {
                clone.total = totalValue;
            }
            if (!Array.isArray(clone.lines) && clone.startLine !== undefined && clone.endLine !== undefined) {
                const startLine = normaliseNumber(clone.startLine);
                const endLine = normaliseNumber(clone.endLine);
                if (startLine !== null || endLine !== null) {
                    clone.lines = [startLine, endLine].filter((value) => value !== null);
                }
            }
            results.push(clone);
            return;
        }

        if (typeof segment === "string") {
            const text = segment.trim();
            if (text) {
                results.push({
                    id: String(index + 1),
                    index: index + 1,
                    text,
                    total: segmentList.length || chunkList.length || null
                });
            }
        }
    };

    if (segmentList.length) {
        segmentList.forEach((segment, index) => appendSegment(segment, index));
    }

    if (results.length === 0 && chunkList.length) {
        chunkList.forEach((chunk, index) => {
            if (!chunk) return;
            if (typeof chunk === "string") {
                const trimmed = chunk.trim();
                if (trimmed) {
                    results.push({
                        id: String(index + 1),
                        index: index + 1,
                        total: chunkList.length,
                        text: trimmed
                    });
                }
                return;
            }

            const normalised = isPlainObject(chunk) ? clonePlain(chunk) : {};
            const text = pickFirstString(
                [normalised.answer, normalised.rawAnalysis, normalised.raw, normalised.text],
                { allowEmpty: true }
            );
            const label = text ? normaliseSqlText(text) : "";
            const indexValue = normaliseNumber(normalised.index);
            const totalValue = normaliseNumber(normalised.total);
            results.push({
                ...normalised,
                id:
                    typeof normalised.id === "string" && normalised.id.trim()
                        ? normalised.id
                        : String(indexValue !== null ? indexValue : index + 1),
                index: indexValue !== null ? indexValue : index + 1,
                total: totalValue !== null ? totalValue : chunkList.length,
                text: label
            });
        });
    }

    return results;
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
