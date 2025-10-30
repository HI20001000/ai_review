import express from "express";
import pool from "./lib/db.js";
import { ensureSchema } from "./lib/ensureSchema.js";
import { getDifyConfigSummary, partitionContent, requestDifyReport } from "./lib/difyClient.js";
import { analyseSqlToReport, buildSqlReportPayload, isSqlPath } from "./lib/sqlAnalyzer.js";

const app = express();

app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || "10mb" }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        const duration = Date.now() - start;
        console.log(
            `[api] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${duration}ms)`
        );
    });
    res.on("error", (error) => {
        console.error(`[api] ${req.method} ${req.originalUrl || req.url} stream error`, error);
    });
    next();
});

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedOrigins.length) {
        res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});

function mapProjectRow(row) {
    return {
        id: row.id,
        name: row.name,
        mode: row.mode,
        createdAt: Number(row.created_at) || Date.now()
    };
}

function mapNodeRow(row) {
    return {
        key: row.node_key,
        projectId: row.project_id,
        type: row.type,
        name: row.name,
        path: row.path,
        parent: row.parent || "",
        size: Number(row.size) || 0,
        lastModified: Number(row.last_modified) || 0,
        mime: row.mime || "",
        isBig: Boolean(row.is_big)
    };
}

function safeParseArray(jsonText, { fallback = [] } = {}) {
    if (!jsonText) return Array.isArray(fallback) ? fallback : [];
    try {
        const parsed = JSON.parse(jsonText);
        return Array.isArray(parsed) ? parsed : Array.isArray(fallback) ? fallback : [];
    } catch (error) {
        console.warn("[reports] Failed to parse JSON column", { jsonText, error });
        return Array.isArray(fallback) ? fallback : [];
    }
}

function safeSerialiseForLog(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return `[unserialisable: ${error?.message || error}]`;
    }
}

function logReportPersistenceStage(label, value) {
    if (typeof console === "undefined" || typeof console.log !== "function") {
        return;
    }
    console.log(`[reports] ${label}: ${safeSerialiseForLog(value)}`);
}

function toIsoString(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        const time = value.getTime();
        if (Number.isFinite(time)) {
            return new Date(time).toISOString();
        }
        return null;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    return null;
}

function extractAnalysisFromChunks(chunks) {
    if (!Array.isArray(chunks)) return null;
    for (const chunk of chunks) {
        const raw = typeof chunk?.rawAnalysis === "string" ? chunk.rawAnalysis : null;
        if (raw && raw.trim()) {
            return { result: raw };
        }
        const nested = chunk?.raw?.analysisResult || chunk?.raw?.rawAnalysis;
        if (typeof nested === "string" && nested.trim()) {
            return { result: nested };
        }
    }
    return null;
}

function safeParseReport(reportText) {
    if (typeof reportText !== "string") {
        return null;
    }
    const trimmed = reportText.trim();
    if (!trimmed) {
        return null;
    }
    if (!/^\s*[\[{]/.test(trimmed)) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return null;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => clonePlainValue(entry));
    }
    if (isPlainObject(value)) {
        const clone = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
                continue;
            }
            clone[key] = clonePlainValue(entry);
        }
        return clone;
    }
    return value;
}

function sanitiseCombinedReportJson(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    try {
        const parsed = JSON.parse(trimmed);
        const summary = Array.isArray(parsed?.summary)
            ? parsed.summary.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        const issues = Array.isArray(parsed?.issues)
            ? parsed.issues.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        return JSON.stringify({ summary, issues }, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to sanitise combined report JSON", error);
        return trimmed;
    }
}

function sanitiseIssuesJson(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    try {
        const parsed = JSON.parse(trimmed);
        const issues = Array.isArray(parsed?.issues)
            ? parsed.issues.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        return JSON.stringify({ issues }, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to sanitise issues JSON", error);
        return trimmed;
    }
}

function mapReportRow(row) {
    const chunks = safeParseArray(row.chunks_json);
    const segments = safeParseArray(row.segments_json);
    const parsedReport = safeParseReport(row.report);
    const reportsBlock =
        parsedReport && typeof parsedReport === "object" && !Array.isArray(parsedReport.reports)
            ? parsedReport.reports
            : parsedReport && typeof parsedReport.reports === "object"
            ? parsedReport.reports
            : {};
    const staticReport =
        reportsBlock?.static_analyzer || reportsBlock?.staticAnalyzer || null;
    const dmlReport = reportsBlock?.dml_prompt || reportsBlock?.dmlPrompt || null;
    const difyReport = reportsBlock?.dify_workflow || reportsBlock?.difyWorkflow || null;

    let analysis = extractAnalysisFromChunks(chunks);
    const ensureAnalysis = () => {
        if (!analysis) {
            analysis = {};
        }
        return analysis;
    };

    if (parsedReport && typeof parsedReport === "object") {
        const target = ensureAnalysis();
        if (parsedReport.summary && typeof parsedReport.summary === "object") {
            target.combinedSummary = parsedReport.summary;
        }
        if (Array.isArray(parsedReport.issues)) {
            target.combinedIssues = parsedReport.issues;
        }
    }

    if (staticReport && typeof staticReport === "object") {
        const target = ensureAnalysis();
        target.staticReport = staticReport;
    }

    if (difyReport && typeof difyReport === "object") {
        const target = ensureAnalysis();
        target.difyReport = difyReport;
        if (difyReport.summary && typeof difyReport.summary === "object") {
            target.difySummary = difyReport.summary;
        }
        if (Array.isArray(difyReport.issues)) {
            target.difyIssues = difyReport.issues;
        }
    }

    if (dmlReport && typeof dmlReport === "object") {
        const target = ensureAnalysis();
        target.dmlReport = dmlReport;
        if (Array.isArray(dmlReport.issues)) {
            target.dmlIssues = dmlReport.issues;
        }
        if (Array.isArray(dmlReport.segments)) {
            target.dmlSegments = dmlReport.segments;
        }
        if (dmlReport.aggregated && typeof dmlReport.aggregated === "object") {
            target.dmlAggregated = dmlReport.aggregated;
        }
        if (dmlReport.summary && typeof dmlReport.summary === "object") {
            target.dmlSummary = dmlReport.summary;
        }
        if (dmlReport.generatedAt || dmlReport.generated_at) {
            target.dmlGeneratedAt = dmlReport.generatedAt || dmlReport.generated_at;
        }
        if (typeof dmlReport.conversationId === "string" && dmlReport.conversationId) {
            target.dmlConversationId = dmlReport.conversationId;
        }
    }

    const combinedReportJson = sanitiseCombinedReportJson(row.combined_report_json || "");
    const staticReportJson = sanitiseIssuesJson(row.static_report_json || "");
    const aiReportJson = sanitiseIssuesJson(row.ai_report_json || "");

    return {
        projectId: row.project_id,
        path: row.path,
        report: row.report || "",
        chunks,
        segments,
        analysis,
        dml: dmlReport || null,
        dify: difyReport || null,
        staticReport: staticReport || null,
        conversationId: row.conversation_id || "",
        userId: row.user_id || "",
        generatedAt: toIsoString(row.generated_at),
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
        combinedReportJson,
        staticReportJson,
        aiReportJson
    };
}

function normaliseSnippetSelection(selection) {
    if (!selection || typeof selection !== "object") {
        return null;
    }
    if (typeof selection.content !== "string") {
        return null;
    }
    const content = selection.content;
    const start = Number(selection.startLine);
    const end = Number(selection.endLine);
    const startColumnRaw = Number(selection.startColumn);
    const endColumnRaw = Number(selection.endColumn);
    const providedLineCount = Number(selection.lineCount);
    const label = typeof selection.label === "string" ? selection.label.trim() : "";
    const meta = {};
    if (Number.isFinite(start)) {
        meta.startLine = Math.max(1, Math.floor(start));
    }
    if (Number.isFinite(end)) {
        meta.endLine = Math.max(1, Math.floor(end));
    }
    if (Number.isFinite(startColumnRaw) && startColumnRaw > 0) {
        meta.startColumn = Math.max(1, Math.floor(startColumnRaw));
    }
    if (Number.isFinite(endColumnRaw) && endColumnRaw > 0) {
        meta.endColumn = Math.max(1, Math.floor(endColumnRaw));
    }
    if (meta.startLine !== undefined && meta.endLine !== undefined && meta.endLine < meta.startLine) {
        const temp = meta.startLine;
        meta.startLine = meta.endLine;
        meta.endLine = temp;
        if (meta.startColumn !== undefined || meta.endColumn !== undefined) {
            const columnTemp = meta.startColumn;
            meta.startColumn = meta.endColumn;
            meta.endColumn = columnTemp;
        }
    }
    if (meta.startLine !== undefined && meta.endLine === undefined) {
        meta.endLine = meta.startLine;
    }
    if (meta.endLine !== undefined && meta.startLine === undefined) {
        meta.startLine = meta.endLine;
    }
    if (
        meta.startLine !== undefined &&
        meta.endLine !== undefined &&
        meta.startLine === meta.endLine &&
        meta.startColumn !== undefined &&
        meta.endColumn !== undefined &&
        meta.endColumn < meta.startColumn
    ) {
        const columnTemp = meta.startColumn;
        meta.startColumn = meta.endColumn;
        meta.endColumn = columnTemp;
    }
    if (Number.isFinite(providedLineCount) && providedLineCount > 0) {
        meta.lineCount = Math.max(1, Math.floor(providedLineCount));
    } else if (meta.startLine !== undefined && meta.endLine !== undefined) {
        meta.lineCount = meta.endLine - meta.startLine + 1;
    }
    if (label) {
        meta.label = label;
    }
    const hasMeta = Object.keys(meta).length > 0;
    return {
        content,
        meta: hasMeta ? meta : null
    };
}

async function upsertReport({
    projectId,
    path,
    report,
    chunks,
    segments,
    conversationId,
    userId,
    generatedAt,
    combinedReportJson,
    staticReportJson,
    aiReportJson
}) {
    if (!projectId || !path) {
        throw new Error("Report upsert requires projectId and path");
    }
    const now = Date.now();
    const generatedTime = (() => {
        if (!generatedAt) return Number.NaN;
        if (typeof generatedAt === "number") {
            return generatedAt;
        }
        const parsed = Date.parse(generatedAt);
        return Number.isNaN(parsed) ? Number.NaN : parsed;
    })();
    const storedGeneratedAt = Number.isFinite(generatedTime) ? generatedTime : now;
    const serialisedChunks = JSON.stringify(Array.isArray(chunks) ? chunks : []);
    const serialisedSegments = JSON.stringify(Array.isArray(segments) ? segments : []);
    const safeProjectId = typeof projectId === "string" ? projectId : String(projectId);
    const safePath = typeof path === "string" ? path : String(path);
    const safeReport = typeof report === "string" ? report : "";
    const safeConversationId = typeof conversationId === "string" ? conversationId : "";
    const safeUserId = typeof userId === "string" ? userId : "";
    const safeCombinedJson = typeof combinedReportJson === "string" ? combinedReportJson : "";
    const safeStaticJson = typeof staticReportJson === "string" ? staticReportJson : "";
    const safeAiJson = typeof aiReportJson === "string" ? aiReportJson : "";

    logReportPersistenceStage("upsertReport.input", {
        projectId,
        path,
        report,
        chunks,
        segments,
        conversationId,
        userId,
        generatedAt,
        combinedReportJson,
        staticReportJson,
        aiReportJson
    });

    logReportPersistenceStage("upsertReport.serialised", {
        projectId: safeProjectId,
        path: safePath,
        report: safeReport,
        chunks: serialisedChunks,
        segments: serialisedSegments,
        conversationId: safeConversationId,
        userId: safeUserId,
        generatedAt: storedGeneratedAt,
        createdAt: now,
        updatedAt: now,
        combinedReportJson: safeCombinedJson,
        staticReportJson: safeStaticJson,
        aiReportJson: safeAiJson
    });

    await pool.query(
        `INSERT INTO reports (
            project_id,
            path,
            report,
            chunks_json,
            segments_json,
            conversation_id,
            user_id,
            generated_at,
            created_at,
            updated_at,
            combined_report_json,
            static_report_json,
            ai_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            report = VALUES(report),
            chunks_json = VALUES(chunks_json),
            segments_json = VALUES(segments_json),
            conversation_id = VALUES(conversation_id),
            user_id = VALUES(user_id),
            generated_at = VALUES(generated_at),
            updated_at = VALUES(updated_at),
            combined_report_json = VALUES(combined_report_json),
            static_report_json = VALUES(static_report_json),
            ai_report_json = VALUES(ai_report_json)`,
        [
            safeProjectId,
            safePath,
            safeReport,
            serialisedChunks,
            serialisedSegments,
            safeConversationId,
            safeUserId,
            storedGeneratedAt,
            now,
            now,
            safeCombinedJson,
            safeStaticJson,
            safeAiJson
        ]
    );
}

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

app.get("/api/projects", async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, name, mode, created_at FROM projects ORDER BY name ASC"
        );
        res.json(rows.map(mapProjectRow));
    } catch (error) {
        next(error);
    }
});

app.post("/api/projects", async (req, res, next) => {
    try {
        const { id, name, mode, createdAt } = req.body || {};
        if (!id || !name || !mode) {
            res.status(400).json({ message: "Missing required project fields" });
            return;
        }
        const createdAtValue = Number(createdAt) || Date.now();
        await pool.query(
            `INSERT INTO projects (id, name, mode, created_at)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), mode = VALUES(mode), created_at = VALUES(created_at)`,
            [id, name, mode, createdAtValue]
        );
        res.status(201).json({ id, name, mode, createdAt: createdAtValue });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/projects/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM projects WHERE id = ?", [id]);
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.get("/api/projects/:projectId/nodes", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const [rows] = await pool.query(
            `SELECT node_key, project_id, type, name, path, parent, size, last_modified, mime, is_big
             FROM nodes
             WHERE project_id = ?
             ORDER BY path ASC`,
            [projectId]
        );
        res.json(rows.map(mapNodeRow));
    } catch (error) {
        next(error);
    }
});

async function insertNodes(connection, projectId, nodes) {
    if (!nodes.length) return;
    const chunkSize = Number(process.env.NODE_INSERT_BATCH || "400");
    for (let i = 0; i < nodes.length; i += chunkSize) {
        const chunk = nodes.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const values = chunk.flatMap((node) => [
            node.key,
            projectId,
            node.type,
            node.name,
            node.path,
            node.parent || "",
            Number(node.size) || 0,
            Number(node.lastModified) || 0,
            node.mime || "",
            node.isBig ? 1 : 0
        ]);
        await connection.query(
            `INSERT INTO nodes (node_key, project_id, type, name, path, parent, size, last_modified, mime, is_big)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                project_id = VALUES(project_id),
                type = VALUES(type),
                name = VALUES(name),
                path = VALUES(path),
                parent = VALUES(parent),
                size = VALUES(size),
                last_modified = VALUES(last_modified),
                mime = VALUES(mime),
                is_big = VALUES(is_big)`,
            values
        );
    }
}

app.post("/api/projects/:projectId/nodes", async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
        const { projectId } = req.params;
        const payload = req.body || {};
        const nodes = Array.isArray(payload) ? payload : payload.nodes;
        if (!Array.isArray(nodes)) {
            res.status(400).json({ message: "Request body must be an array of nodes or { nodes: [] }" });
            return;
        }
        await connection.beginTransaction();
        await connection.query("DELETE FROM nodes WHERE project_id = ?", [projectId]);
        await insertNodes(connection, projectId, nodes);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback().catch(() => {});
        next(error);
    } finally {
        connection.release();
    }
});

app.get("/api/projects/:projectId/reports", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const [rows] = await pool.query(
            `SELECT project_id, path, report, chunks_json, segments_json, conversation_id, user_id, generated_at, created_at, updated_at,
                    combined_report_json, static_report_json, ai_report_json
             FROM reports
             WHERE project_id = ?
             ORDER BY path ASC`,
            [projectId]
        );
        res.json({
            projectId,
            reports: rows.map(mapReportRow)
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/reports/dify", async (req, res, next) => {
    const { projectId, projectName, path, content, userId, files } = req.body || {};
    let resolvedUserId = typeof userId === "string" ? userId.trim() : "";

    try {
        if (!projectId || !path || typeof content !== "string") {
            res.status(400).json({ message: "Missing projectId, path, or content for report generation" });
            return;
        }
        if (!content.trim()) {
            res.status(400).json({ message: "檔案內容為空，無法生成報告" });
            return;
        }
        resolvedUserId = typeof userId === "string" ? userId.trim() : "";
        if (isSqlPath(path)) {
            console.log(`[sql] Running static SQL analysis project=${projectId} path=${path}`);
            let sqlAnalysis;
            try {
                sqlAnalysis = await analyseSqlToReport(content, {
                    projectId,
                    projectName,
                    path,
                    userId: resolvedUserId,
                    files
                });
            } catch (error) {
                console.error("[sql] Failed to analyse SQL", error);
                res.status(502).json({ message: error?.message || "SQL 靜態分析失敗" });
                return;
            }

            const reportPayload = buildSqlReportPayload({
                analysis: sqlAnalysis.analysis,
                content,
                dify: sqlAnalysis.dify,
                difyError: sqlAnalysis.difyError,
                dml: sqlAnalysis.dml,
                dmlError: sqlAnalysis.dmlError
            });
            await upsertReport({
                projectId,
                path,
                report: reportPayload.report,
                chunks: reportPayload.chunks,
                segments: reportPayload.segments,
                conversationId: reportPayload.conversationId,
                userId: resolvedUserId,
                generatedAt: reportPayload.generatedAt,
                combinedReportJson: reportPayload.combinedReportJson,
                staticReportJson: reportPayload.staticReportJson,
                aiReportJson: reportPayload.aiReportJson
            });
            const savedAtIso = new Date().toISOString();
            res.json({
                projectId,
                path,
                ...reportPayload,
                savedAt: savedAtIso,
                difyError:
                    reportPayload.difyErrorMessage ||
                    (sqlAnalysis.difyError ? sqlAnalysis.difyError.message || String(sqlAnalysis.difyError) : undefined),
                dmlError:
                    reportPayload.dmlErrorMessage ||
                    (sqlAnalysis.dmlError ? sqlAnalysis.dmlError.message || String(sqlAnalysis.dmlError) : undefined)
            });
            return;
        }

        const segments = partitionContent(content);
        const summary = getDifyConfigSummary();
        console.log(
            `[dify] Generating report project=${projectId} path=${path} segments=${segments.length} maxSegmentChars=${summary.maxSegmentChars}`
        );

        const result = await requestDifyReport({
            projectName: projectName || projectId,
            filePath: path,
            content,
            userId,
            segments,
            files
        });
        const resolvedGeneratedAt = result?.generatedAt || new Date().toISOString();
        await upsertReport({
            projectId,
            path,
            report: result?.report,
            chunks: result?.chunks,
            segments: result?.segments,
            conversationId: result?.conversationId,
            userId: resolvedUserId,
            generatedAt: resolvedGeneratedAt
        });
        const savedAtIso = new Date().toISOString();
        res.json({
            projectId,
            path,
            ...result,
            savedAt: savedAtIso
        });
    } catch (error) {
        console.error("[dify] Failed to generate report", error);

        const errorMessage = typeof error?.message === "string" ? error.message : "";
        const shouldFallback =
            errorMessage && errorMessage.toLowerCase().includes("aggregatedreports is not defined");

        if (shouldFallback && projectId && path) {
            const fallbackGeneratedAt = new Date().toISOString();
            const fallbackCombined = buildFallbackCombinedReport(errorMessage, fallbackGeneratedAt);
            const combinedJson = JSON.stringify(fallbackCombined);
            const savedAtIso = new Date().toISOString();

            try {
                await upsertReport({
                    projectId,
                    path,
                    report: "",
                    chunks: [],
                    segments: [],
                    conversationId: "",
                    userId: resolvedUserId,
                    generatedAt: fallbackGeneratedAt,
                    combinedReportJson: combinedJson,
                    staticReportJson: EMPTY_ISSUES_JSON,
                    aiReportJson: EMPTY_ISSUES_JSON
                });
            } catch (persistError) {
                console.error("[dify] Failed to persist fallback report", persistError);
                const status = errorMessage.includes("not configured") ? 500 : 502;
                res.status(status).json({ message: errorMessage || "Failed to generate report" });
                return;
            }

            res.json({
                projectId,
                path,
                report: "",
                chunks: [],
                segments: [],
                conversationId: "",
                generatedAt: fallbackGeneratedAt,
                combinedReportJson: combinedJson,
                staticReportJson: EMPTY_ISSUES_JSON,
                aiReportJson: EMPTY_ISSUES_JSON,
                dify: null,
                dml: null,
                analysis: null,
                savedAt: savedAtIso,
                difyErrorMessage: errorMessage,
                dmlErrorMessage: ""
            });
            return;
        }

        const status = errorMessage.includes("not configured") ? 500 : 502;
        res.status(status).json({ message: errorMessage || "Failed to generate report" });
    }
});

app.post("/api/reports/dify/snippet", async (req, res, next) => {
    try {
        const { projectId, projectName, path, selection, userId, files } = req.body || {};
        if (!projectId || !path) {
            res.status(400).json({ message: "Missing projectId or path for snippet report generation" });
            return;
        }
        const normalised = normaliseSnippetSelection(selection);
        if (!normalised || typeof normalised.content !== "string") {
            res.status(400).json({ message: "Missing selection content for snippet report generation" });
            return;
        }
        if (!normalised.content.trim()) {
            res.status(400).json({ message: "選取內容為空，無法生成報告" });
            return;
        }

        const resolvedUserId = typeof userId === "string" ? userId.trim() : "";

        if (isSqlPath(path)) {
            console.log(`[sql] Running static SQL analysis for snippet project=${projectId} path=${path}`);
            let sqlAnalysis;
            try {
                sqlAnalysis = await analyseSqlToReport(normalised.content, {
                    projectId,
                    projectName,
                    path,
                    userId: resolvedUserId,
                    files
                });
            } catch (error) {
                console.error("[sql] Failed to analyse SQL snippet", error);
                res.status(502).json({ message: error?.message || "SQL 靜態分析失敗" });
                return;
            }
            const reportPayload = buildSqlReportPayload({
                analysis: sqlAnalysis.analysis,
                content: normalised.content,
                dify: sqlAnalysis.dify,
                difyError: sqlAnalysis.difyError
            });
            res.json({
                projectId,
                path,
                selection: normalised.meta || undefined,
                ...reportPayload,
                difyError:
                    reportPayload.difyErrorMessage ||
                    (sqlAnalysis.difyError ? sqlAnalysis.difyError.message || String(sqlAnalysis.difyError) : undefined)
            });
            return;
        }

        const segments = partitionContent(normalised.content);
        const summary = getDifyConfigSummary();
        const rangeLabel = normalised.meta
            ? `${normalised.meta.startLine ?? "-"}-${normalised.meta.endLine ?? "-"}`
            : "full";
        console.log(
            `[dify] Generating snippet report project=${projectId} path=${path} segments=${segments.length} range=${rangeLabel} maxSegmentChars=${summary.maxSegmentChars}`
        );

        const result = await requestDifyReport({
            projectName: projectName || projectId,
            filePath: path,
            content: normalised.content,
            userId,
            segments,
            files,
            selection: normalised.meta
        });

        res.json({
            projectId,
            path,
            selection: normalised.meta || undefined,
            ...result
        });
    } catch (error) {
        console.error("[dify] Failed to generate snippet report", error);
        const status = error?.message?.includes("not configured") ? 500 : 502;
        res.status(status).json({ message: error?.message || "Failed to generate snippet report" });
    }
});

app.delete("/api/projects/:projectId/nodes", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await pool.query("DELETE FROM nodes WHERE project_id = ?", [projectId]);
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

const MISSING_TABLE_ERROR_CODE = "ER_NO_SUCH_TABLE";

app.use((err, req, res, _next) => {
    if (err?.code === MISSING_TABLE_ERROR_CODE) {
        console.error(
            "API error: database schema is missing required tables",
            err
        );
        res.status(500).json({
            message:
                "Database tables are missing. Run `npm run db:init` or ensure your MySQL schema is up to date.",
            details:
                "Check that MYSQL_DATABASE points to the schema where the `projects` and `nodes` tables are created."
        });
        return;
    }

    console.error("API error", err);
    res.status(500).json({ message: err.message || "Internal Server Error" });
});

const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";

try {
    console.log("Ensuring MySQL schema before starting server...");
    await ensureSchema({ logger: console });
    console.log("MySQL schema ensured successfully.");
} catch (error) {
    console.error("Failed to ensure MySQL schema", error);
    process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
    console.log(`API server listening on http://${HOST}:${PORT}`);
});

let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}, shutting down server`);
    server.close(async (closeError) => {
        if (closeError) {
            console.error("Error while closing server", closeError);
        }
        await pool.end().catch((error) => {
            console.error("Error while closing MySQL pool", error);
        });
        process.exit(closeError ? 1 : 0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
