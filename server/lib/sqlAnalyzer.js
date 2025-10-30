import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    getDifyConfigSummary,
    partitionContent,
    requestDifyJsonEnrichment,
    requestDifyReport
} from "./difyClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "sql_rule_engine.py");

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

function logSqlPayloadStage(label, value) {
    if (typeof console === "undefined" || typeof console.log !== "function") {
        return;
    }
    console.log(`[sql-report] ${label}: ${safeSerialiseForLog(value)}`);
}

function replaceRangeWithSpaces(text, start, end) {
    if (!text || start >= end) return text;
    const replacement = text
        .slice(start, end)
        .split("")
        .map((ch) => (ch === "\n" ? "\n" : " "))
        .join("");
    return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function maskBlockComments(sqlText) {
    if (!sqlText) return "";
    const blockRegex = /\/\*[\s\S]*?\*\//g;
    let masked = sqlText;
    let match;
    while ((match = blockRegex.exec(sqlText)) !== null) {
        masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
    }
    return masked;
}

function maskCommentsAndStrings(sqlText) {
    if (!sqlText) return "";
    let masked = maskBlockComments(sqlText);
    const lineRegex = /--.*?$/gm;
    let match;
    while ((match = lineRegex.exec(masked)) !== null) {
        masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
    }

    const stringPatterns = [
        /'(?:''|[^'])*'/gs,
        /"(?:""|[^"])*"/gs
    ];
    for (const pattern of stringPatterns) {
        while ((match = pattern.exec(masked)) !== null) {
            masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
        }
    }

    return masked;
}

function stripSqlComments(sqlText) {
    if (typeof sqlText !== "string" || !sqlText.length) {
        return "";
    }

    let result = "";
    let index = 0;
    const length = sqlText.length;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (index < length) {
        const char = sqlText[index];
        const next = index + 1 < length ? sqlText[index + 1] : "";

        if (!inSingleQuote && !inDoubleQuote) {
            if (char === "-" && next === "-") {
                index += 2;
                while (index < length) {
                    const lineChar = sqlText[index];
                    if (lineChar === "\r" && sqlText[index + 1] === "\n") {
                        result += "\r\n";
                        index += 2;
                        break;
                    }
                    if (lineChar === "\n" || lineChar === "\r") {
                        result += lineChar;
                        index += 1;
                        break;
                    }
                    index += 1;
                }
                continue;
            }

            if (char === "/" && next === "*") {
                index += 2;
                while (index < length) {
                    const blockChar = sqlText[index];
                    const blockNext = sqlText[index + 1];
                    if (blockChar === "*" && blockNext === "/") {
                        index += 2;
                        break;
                    }
                    if (blockChar === "\r" && blockNext === "\n") {
                        result += "\r\n";
                        index += 2;
                        continue;
                    }
                    if (blockChar === "\n" || blockChar === "\r") {
                        result += blockChar;
                        index += 1;
                        continue;
                    }
                    index += 1;
                }
                continue;
            }
        }

        result += char;

        if (char === "'" && !inDoubleQuote) {
            if (inSingleQuote) {
                if (next === "'") {
                    result += "'";
                    index += 2;
                    continue;
                }
                inSingleQuote = false;
            } else {
                inSingleQuote = true;
            }
        } else if (char === '"' && !inSingleQuote) {
            if (inDoubleQuote) {
                if (next === '"') {
                    result += '"';
                    index += 2;
                    continue;
                }
                inDoubleQuote = false;
            } else {
                inDoubleQuote = true;
            }
        }

        index += 1;
    }

    return result;
}

function findStatementTerminator(maskedSql, startIndex) {
    if (!maskedSql || startIndex >= maskedSql.length) {
        return maskedSql ? maskedSql.length : 0;
    }
    for (let index = startIndex; index < maskedSql.length; index += 1) {
        if (maskedSql[index] === ";") {
            return index + 1;
        }
    }
    return maskedSql.length;
}

function indexToLineCol(text, index) {
    const prior = text.slice(0, index);
    const line = prior.split("\n").length;
    const lastNewline = prior.lastIndexOf("\n");
    const column = index - (lastNewline === -1 ? 0 : lastNewline + 1) + 1;
    return { line, column };
}

function extractDmlStatements(sqlText) {
    if (typeof sqlText !== "string" || !sqlText.trim()) {
        return [];
    }
    const masked = maskCommentsAndStrings(sqlText);
    const regex = /\b(INSERT|UPDATE|DELETE)\b/gi;
    const segments = [];
    let match;
    while ((match = regex.exec(masked)) !== null) {
        const start = match.index;
        const end = findStatementTerminator(masked, start);
        const snippet = sqlText.slice(start, end);
        const cleanedSnippet = stripSqlComments(snippet).trim();
        if (!cleanedSnippet) continue;
        const startMeta = indexToLineCol(sqlText, start);
        const endMeta = indexToLineCol(sqlText, end);
        segments.push({
            index: segments.length + 1,
            text: cleanedSnippet,
            rawText: snippet.trim(),
            start,
            end,
            startLine: startMeta.line,
            startColumn: startMeta.column,
            endLine: endMeta.line,
            endColumn: endMeta.column
        });
    }
    return segments;
}

function parseCommand(command) {
    if (!command || typeof command !== "string") {
        return null;
    }
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    return { command: parts[0], args: parts.slice(1) };
}

function gatherPythonCandidates() {
    const envCandidates = [
        process.env.SQL_ANALYZER_PYTHON,
        process.env.PYTHON,
        process.env.PYTHON_PATH,
        process.env.PYTHON3_PATH
    ]
        .map(parseCommand)
        .filter(Boolean);

    const defaultCandidates = ["python3", "python", "py -3", "py"]
        .map(parseCommand)
        .filter(Boolean);

    const seen = new Set();
    const deduped = [];
    for (const candidate of [...envCandidates, ...defaultCandidates]) {
        const key = `${candidate.command} ${candidate.args.join(" ")}`.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}

function isMissingInterpreterError(error, stderr) {
    if (!error) return false;
    if (error.code === "ENOENT") {
        return true;
    }
    const message = [error.message, stderr].filter(Boolean).join("\n");
    return /python was not found/i.test(message);
}

function runPythonCandidate(candidate, sqlText) {
    return new Promise((resolve, reject) => {
        const args = [...candidate.args, "-u", SCRIPT_PATH];
        const child = spawn(candidate.command, args, { stdio: ["pipe", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";
        let stdinError = null;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        child.stdin.on("error", (error) => {
            stdinError = error;
        });

        child.on("error", (error) => {
            const err = error;
            err.stderr = stderr;
            reject(err);
        });

        child.on("close", (code) => {
            if (code !== 0) {
                const error = new Error(`Python analyzer exited with code ${code}`);
                error.stderr = stderr;
                if (stdinError) {
                    error.stdinError = stdinError;
                }
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });

        try {
            child.stdin.end(sqlText ?? "");
        } catch (error) {
            reject(error);
        }
    });
}

let cachedInterpreter = null;

async function executeSqlAnalysis(sqlText) {
    const candidates = cachedInterpreter ? [cachedInterpreter] : gatherPythonCandidates();
    let lastError = null;

    for (const candidate of candidates) {
        try {
            const { stdout } = await runPythonCandidate(candidate, sqlText);
            const trimmed = stdout.trim();
            if (!trimmed) {
                const emptyError = new Error("SQL 分析器未返回任何輸出");
                emptyError.stderr = stdout;
                throw emptyError;
            }
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (parseError) {
                const errorMessage = `無法解析 SQL 分析器輸出：${trimmed}`;
                const error = new Error(errorMessage);
                error.stderr = trimmed;
                if (/python was not found/i.test(trimmed)) {
                    error.missingInterpreter = true;
                }
                throw error;
            }
            if (parsed.error) {
                const engineError = new Error(parsed.error);
                engineError.stderr = parsed.error;
                throw engineError;
            }
            if (typeof parsed.result !== "string") {
                const invalidError = new Error("SQL 分析器輸出缺少 result 欄位");
                invalidError.stderr = JSON.stringify(parsed);
                throw invalidError;
            }
            cachedInterpreter = candidate;
            return parsed;
        } catch (error) {
            const stderr = error?.stderr || "";
            if (error?.missingInterpreter || isMissingInterpreterError(error, stderr)) {
                lastError = error;
                cachedInterpreter = null;
                continue;
            }
            throw error;
        }
    }

    const hint =
        "無法找到可用的 Python 執行檔。請在環境變數 SQL_ANALYZER_PYTHON 或 PYTHON_PATH 中指定完整的 python.exe 路徑，或確保 'python' 指令可用。";
    const error = new Error(lastError?.message ? `${lastError.message}\n${hint}` : hint);
    error.stderr = lastError?.stderr;
    throw error;
}

function extractJsonFromText(value) {
    if (value == null) {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return "";
        }
    }
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    const candidates = [];

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        candidates.push(fenceMatch[1].trim());
    }

    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
        candidates.push(trimmed.slice(braceStart, braceEnd + 1));
    }

    candidates.push(trimmed);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            return JSON.stringify(parsed);
        } catch (_error) {
            continue;
        }
    }

    return "";
}

function normaliseDifyOutput(dify, rawReport) {
    if (!dify || typeof dify !== "object") {
        return dify ?? null;
    }

    const resolvedReport = extractJsonFromText(dify.report ?? dify.answer ?? "");
    const normalisedReport = resolvedReport || rawReport || "";

    const normalisedChunks = Array.isArray(dify.chunks)
        ? dify.chunks.map((chunk) => ({
              ...chunk,
              answer: extractJsonFromText(chunk?.answer) || chunk?.answer || "",
              raw: chunk?.raw
          }))
        : dify.chunks;

    return {
        ...dify,
        report: normalisedReport,
        chunks: normalisedChunks,
        originalReport: typeof dify.report === "string" ? dify.report : rawReport || "",
        originalChunks: Array.isArray(dify.chunks) ? dify.chunks : undefined
    };
}

function parseStaticReport(rawReport) {
    if (typeof rawReport !== "string") {
        return null;
    }
    let candidate = rawReport.trim();
    if (!candidate) {
        return null;
    }
    for (let depth = 0; depth < 3; depth += 1) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "string") {
                const trimmed = parsed.trim();
                if (trimmed && trimmed !== candidate) {
                    candidate = trimmed;
                    continue;
                }
                break;
            }
            if (parsed && typeof parsed === "object") {
                return parsed;
            }
            break;
        } catch (error) {
            break;
        }
    }
    return null;
}

function normaliseStaticMetadata(metadata) {
    const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
    if (!base.analysis_source) {
        base.analysis_source = "static_analyzer";
    }
    if (!base.engine) {
        base.engine = "sql_rule_engine";
    }
    return base;
}

function normaliseStaticSummary(summary, fallbackExtension = ".sql") {
    const source = summary && typeof summary === "object" ? summary : {};
    const normalised = { ...source };
    const byRule = normalised.by_rule || normalised.byRule;
    if (byRule && typeof byRule === "object" && !Array.isArray(byRule)) {
        normalised.by_rule = { ...byRule };
    } else if (!normalised.by_rule) {
        normalised.by_rule = {};
    }
    if (typeof normalised.file_extension !== "string" && typeof normalised.fileExtension === "string") {
        normalised.file_extension = normalised.fileExtension;
    }
    if (typeof normalised.file_extension !== "string" && fallbackExtension) {
        normalised.file_extension = fallbackExtension;
    }
    const totalCandidate = normalised.total_issues ?? normalised.totalIssues;
    const numericTotal = Number(totalCandidate);
    if (Number.isFinite(numericTotal)) {
        normalised.total_issues = numericTotal;
    }
    if (!normalised.analysis_source) {
        normalised.analysis_source = "static_analyzer";
    }
    return normalised;
}

function normaliseDmlSummary(segments, dmlPrompt, dmlError) {
    const totalSegments = Array.isArray(segments) ? segments.length : 0;
    const chunkCount = Array.isArray(dmlPrompt?.chunks) ? dmlPrompt.chunks.length : 0;
    const hasReport = typeof dmlPrompt?.report === "string" && dmlPrompt.report.trim().length > 0;
    const summary = {
        analysis_source: "dml_prompt",
        total_segments: totalSegments,
        analyzed_segments: chunkCount || (hasReport ? totalSegments : 0),
        generated_at: dmlPrompt?.generatedAt || null
    };

    let status = "idle";
    if (totalSegments === 0) {
        status = "idle";
    } else if (dmlPrompt) {
        status = "succeeded";
    } else if (dmlError) {
        status = "failed";
    } else {
        status = "pending";
    }
    summary.status = status;

    const errorMessage = dmlError?.message || (typeof dmlError === "string" ? dmlError : "");
    if (errorMessage) {
        summary.error_message = errorMessage;
    }

    const aggregated = dmlPrompt && typeof dmlPrompt.aggregated === "object" ? dmlPrompt.aggregated : null;
    if (aggregated) {
        const aggregatedIssueCount = Array.isArray(aggregated.issues) ? aggregated.issues.length : 0;
        const aggregatedTotalCandidate = Number(aggregated.total_issues ?? aggregated.totalIssues);
        if (Number.isFinite(aggregatedTotalCandidate)) {
            summary.total_issues = aggregatedTotalCandidate;
        } else if (aggregatedIssueCount) {
            summary.total_issues = aggregatedIssueCount;
        }

        const aggregatedSeverity =
            aggregated.by_severity && typeof aggregated.by_severity === "object" && !Array.isArray(aggregated.by_severity)
                ? aggregated.by_severity
                : aggregated.bySeverity && typeof aggregated.bySeverity === "object" && !Array.isArray(aggregated.bySeverity)
                ? aggregated.bySeverity
                : null;
        if (aggregatedSeverity) {
            summary.by_severity = { ...aggregatedSeverity };
        }

        const aggregatedRules =
            aggregated.by_rule && typeof aggregated.by_rule === "object" && !Array.isArray(aggregated.by_rule)
                ? aggregated.by_rule
                : aggregated.byRule && typeof aggregated.byRule === "object" && !Array.isArray(aggregated.byRule)
                ? aggregated.byRule
                : null;
        if (aggregatedRules) {
            summary.by_rule = { ...aggregatedRules };
        }

        const messages = Array.isArray(aggregated.messages)
            ? aggregated.messages
                  .map((item) => (typeof item === "string" ? item.trim() : ""))
                  .filter((item) => item.length)
            : [];
        const messageText = typeof aggregated.message === "string" ? aggregated.message.trim() : "";
        if (messageText) {
            summary.message = messageText;
        } else if (messages.length) {
            summary.message = messages.join(" ");
        }
        if (messages.length) {
            summary.messages = messages;
        }
    }

    return summary;
}

function collectRuleCountsFromIssues(issues) {
    const result = {};
    if (!Array.isArray(issues)) {
        return result;
    }

    for (const issue of issues) {
        if (!issue || typeof issue !== "object") continue;

        const ruleValues = [];
        if (Array.isArray(issue.rule_ids)) {
            ruleValues.push(...issue.rule_ids);
        }
        if (Array.isArray(issue.ruleIds)) {
            ruleValues.push(...issue.ruleIds);
        }
        ruleValues.push(issue.rule_id, issue.ruleId, issue.rule);

        const uniqueRules = new Set();
        for (const value of ruleValues) {
            if (value === null || value === undefined) continue;
            const stringValue = typeof value === "string" ? value : String(value);
            const trimmed = stringValue.trim();
            if (!trimmed) continue;
            uniqueRules.add(trimmed);
        }

        if (!uniqueRules.size) continue;

        for (const rule of uniqueRules) {
            result[rule] = (result[rule] || 0) + 1;
        }
    }

    return result;
}

function annotateIssueSource(issue, source) {
    if (!issue || typeof issue !== "object") {
        return issue;
    }
    if (issue.source || issue.analysis_source) {
        return issue;
    }
    return { ...issue, source };
}

function normaliseDifySummary(summarySource, issueCount = 0) {
    if (!summarySource || typeof summarySource !== "object") {
        return null;
    }

    const rawSummary = summarySource.summary;
    if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
        const summary = { ...rawSummary };
        if (!summary.analysis_source && !summary.analysisSource) {
            summary.analysis_source = "dify_workflow";
        }
        if (
            summary.total_issues === undefined &&
            summary.totalIssues === undefined &&
            Number.isFinite(issueCount)
        ) {
            summary.total_issues = issueCount;
        }
        return summary;
    }

    const message = typeof rawSummary === "string" ? rawSummary.trim() : "";
    const totalCandidate = Number(summarySource.total_issues ?? summarySource.totalIssues);
    const totalIssues = Number.isFinite(totalCandidate) ? totalCandidate : issueCount;
    const summary = {
        analysis_source: "dify_workflow",
        total_issues: Number.isFinite(totalIssues) ? totalIssues : 0
    };
    if (message) {
        summary.message = message;
    }
    return summary;
}

function buildCompositeSummary(staticSummary, dmlSummary, difySummary, issues) {
    const ruleCounts = collectRuleCountsFromIssues(issues);
    const hasRuleCounts = Object.keys(ruleCounts).length > 0;
    const staticByRule =
        staticSummary?.by_rule && typeof staticSummary.by_rule === "object" && !Array.isArray(staticSummary.by_rule)
            ? { ...staticSummary.by_rule }
            : {};

    const byRule = hasRuleCounts ? ruleCounts : staticByRule;

    const fileExtension = typeof staticSummary?.file_extension === "string"
        ? staticSummary.file_extension
        : typeof staticSummary?.fileExtension === "string"
        ? staticSummary.fileExtension
        : ".sql";

    const totalIssues = Array.isArray(issues) ? issues.length : 0;

    const sources = {};
    if (staticSummary) {
        sources.static_analyzer = staticSummary;
    }
    if (dmlSummary) {
        sources.dml_prompt = dmlSummary;
    }
    if (difySummary) {
        sources.dify_workflow = difySummary;
    }

    const composite = {
        total_issues: totalIssues,
        by_rule: byRule,
        file_extension: fileExtension,
        analysis_source: "composite",
        sources
    };

    const messages = [];
    if (typeof staticSummary?.message === "string" && staticSummary.message.trim()) {
        messages.push(staticSummary.message.trim());
    }
    if (typeof difySummary?.message === "string" && difySummary.message.trim()) {
        messages.push(difySummary.message.trim());
    }
    if (messages.length) {
        composite.message = messages.join(" ");
    }

    return composite;
}

export async function analyseSqlToReport(sqlText, options = {}) {
    const analysis = await executeSqlAnalysis(sqlText);
    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";
    const trimmedReport = rawReport.trim();
    const dmlSegments = extractDmlStatements(sqlText);

    if (!trimmedReport) {
        return {
            analysis,
            dify: null,
            difyError: null,
            dml: { segments: dmlSegments, dify: null },
            dmlError: null
        };
    }

    const {
        projectId = "",
        projectName = "",
        path = "",
        userId = "",
        files = undefined
    } = options || {};

    const resolvedProjectName = projectName || projectId || "sql-report";
    const resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : undefined;
    const analysisFilePath = path ? `${path}.analysis.json` : "analysis.json";
    const segments = partitionContent(trimmedReport);
    const summary = getDifyConfigSummary();

    let dmlPrompt = null;
    let dmlError = null;
    if (dmlSegments.length) {
        const segmentTexts = dmlSegments.map((segment) => segment.text);
        const dmlFilePath = path ? `${path}.dml.txt` : "analysis.dml.txt";
        try {
            console.log(
                `[sql+dml] Running prompt analysis project=${projectId || resolvedProjectName} path=${dmlFilePath} segments=${segmentTexts.length}`
            );
            dmlPrompt = await requestDifyReport({
                projectName: resolvedProjectName,
                filePath: dmlFilePath,
                content: segmentTexts.join("\n\n"),
                userId: resolvedUserId,
                segments: segmentTexts,
                files
            });
        } catch (error) {
            dmlError = error;
            const message = error?.message || String(error);
            console.warn(
                `[sql+dml] Failed to analyse DML segments project=${projectId || resolvedProjectName} path=${dmlFilePath} :: ${message}`,
                error
            );
        }
    }

    console.log(
        `[sql+dify] Enriching SQL analysis project=${projectId || resolvedProjectName} path=${path || analysisFilePath} ` +
            `segments=${segments.length} maxSegmentChars=${summary.maxSegmentChars}`
    );

    try {
        const difyRaw = await requestDifyJsonEnrichment({
            projectName: resolvedProjectName,
            filePath: analysisFilePath,
            content: trimmedReport,
            userId: resolvedUserId,
            segments,
            files
        });
        const dify = normaliseDifyOutput(difyRaw, trimmedReport);
        return { analysis, dify, difyError: null, dml: { segments: dmlSegments, dify: dmlPrompt }, dmlError };
    } catch (error) {
        const message = error?.message || String(error);
        const locationLabel = path || analysisFilePath;
        console.warn(
            `[sql+dify] Falling back to static SQL analysis project=${projectId || resolvedProjectName} path=${locationLabel} :: ${message}`,
            error
        );
        return { analysis, dify: null, difyError: error, dml: { segments: dmlSegments, dify: dmlPrompt }, dmlError };
    }
}

export function buildSqlReportPayload({ analysis, content, dify, difyError, dml, dmlError }) {
    logSqlPayloadStage("buildSqlReportPayload.input.analysis", analysis);
    logSqlPayloadStage("buildSqlReportPayload.input.dify", dify);
    logSqlPayloadStage("buildSqlReportPayload.input.dml", dml);

    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";
    logSqlPayloadStage("analysis.rawReport", rawReport);

    const difyReport = typeof dify?.report === "string" && dify.report.trim().length
        ? dify.report
        : rawReport;
    logSqlPayloadStage("dify.report", difyReport);

    const difyChunks = Array.isArray(dify?.chunks) && dify.chunks.length
        ? dify.chunks
        : null;
    logSqlPayloadStage("dify.chunks", difyChunks);
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
    logSqlPayloadStage("chunks.annotated", annotatedChunks);
    const segments = dify?.segments && Array.isArray(dify.segments) && dify.segments.length
        ? dify.segments
        : [rawReport || content || ""];
    logSqlPayloadStage("segments.normalised", segments);

    const parsedStaticReport = parseStaticReport(rawReport) || {};
    logSqlPayloadStage("static.parsedReport", parsedStaticReport);
    const staticSummary = normaliseStaticSummary(parsedStaticReport.summary, ".sql");
    const staticIssues = Array.isArray(parsedStaticReport.issues) ? parsedStaticReport.issues : [];
    const staticIssuesWithSource = staticIssues.map((issue) => annotateIssueSource(issue, "static_analyzer"));
    const staticMetadata = normaliseStaticMetadata(parsedStaticReport.metadata);
    const staticReportPayload = {
        ...parsedStaticReport,
        summary: staticSummary,
        issues: staticIssues,
        metadata: staticMetadata
    };
    logSqlPayloadStage("static.reportPayload", staticReportPayload);

    const dmlSegments = Array.isArray(dml?.segments)
        ? dml.segments.map((segment, index) => ({
              ...segment,
              index: Number.isFinite(Number(segment?.index)) ? segment.index : index + 1
          }))
        : [];
    logSqlPayloadStage("dml.segments", dmlSegments);
    const dmlPrompt = dml?.dify || null;
    logSqlPayloadStage("dml.prompt", dmlPrompt);
    const dmlSummary = normaliseDmlSummary(dmlSegments, dmlPrompt, dmlError);
    logSqlPayloadStage("dml.summary", dmlSummary);
    const dmlChunks = Array.isArray(dmlPrompt?.chunks) ? dmlPrompt.chunks : [];
    const dmlAggregatedSource =
        dmlPrompt && typeof dmlPrompt.aggregated === "object" ? dmlPrompt.aggregated : null;
    const dmlIssuesFromPrompt = Array.isArray(dmlPrompt?.issues) ? dmlPrompt.issues : [];
    const aggregatedIssuesFallback = Array.isArray(dmlAggregatedSource?.issues)
        ? dmlAggregatedSource.issues
        : [];
    const dmlIssues = dmlIssuesFromPrompt.length ? dmlIssuesFromPrompt : aggregatedIssuesFallback;
    const dmlAggregated = (() => {
        if (!dmlAggregatedSource || typeof dmlAggregatedSource !== "object") {
            return null;
        }
        const clone = { ...dmlAggregatedSource };
        if (Array.isArray(clone.chunks)) {
            clone.chunks = clone.chunks.map((chunk) =>
                chunk && typeof chunk === "object" ? { ...chunk } : chunk
            );
        }
        if (Array.isArray(clone.issues)) {
            delete clone.issues;
        }
        return clone;
    })();
    const dmlIssuesWithSource = dmlIssues.map((issue) => annotateIssueSource(issue, "dml_prompt"));
    logSqlPayloadStage("dml.aggregated", dmlAggregated);
    logSqlPayloadStage("dml.issues", dmlIssues);
    const dmlReportText = typeof dmlPrompt?.report === "string" ? dmlPrompt.report : "";
    const dmlReportTextHuman = typeof dmlPrompt?.textReport === "string" ? dmlPrompt.textReport : "";
    const dmlConversationId = typeof dmlPrompt?.conversationId === "string" ? dmlPrompt.conversationId : "";
    const dmlGeneratedAt = dmlPrompt?.generatedAt || null;
    const dmlErrorMessage = dmlSummary.error_message || (dmlPrompt?.error ? String(dmlPrompt.error) : "");
    const dmlReportPayload = {
        type: "dml_prompt",
        summary: dmlSummary,
        segments: dmlSegments,
        report: dmlReportText,
        reportText: dmlReportTextHuman || undefined,
        chunks: dmlChunks,
        issues: dmlIssues,
        aggregated: dmlAggregated || undefined,
        conversationId: dmlConversationId,
        generatedAt: dmlGeneratedAt,
        metadata: { analysis_source: "dml_prompt" }
    };
    logSqlPayloadStage("dml.reportPayload", dmlReportPayload);

    let finalReport = difyReport && difyReport.trim() ? difyReport : rawReport;
    let parsedDify;
    if (finalReport && finalReport.trim()) {
        try {
            parsedDify = JSON.parse(finalReport);
        } catch (error) {
            parsedDify = null;
        }
    }

    const difyIssuesRaw =
        parsedDify && typeof parsedDify === "object" && Array.isArray(parsedDify.issues) ? parsedDify.issues : [];
    const difyIssuesWithSource = difyIssuesRaw.map((issue) => annotateIssueSource(issue, "dify_workflow"));
    const combinedIssues = [...staticIssuesWithSource, ...difyIssuesWithSource, ...dmlIssuesWithSource];
    const difySummary = parsedDify && typeof parsedDify === "object"
        ? normaliseDifySummary(parsedDify, difyIssuesRaw.length)
        : null;
    logSqlPayloadStage("dify.summary", difySummary);
    logSqlPayloadStage("issues.combined", combinedIssues);

    const compositeSummary = buildCompositeSummary(staticSummary, dmlSummary, difySummary, combinedIssues);
    logSqlPayloadStage("summary.composite", compositeSummary);
    const finalPayload = {
        summary: compositeSummary,
        issues: combinedIssues,
        reports: {
            static_analyzer: staticReportPayload,
            dml_prompt: dmlReportPayload
        },
        metadata: {
            analysis_source: "composite",
            components: [
                "static_analyzer",
                dmlSegments.length ? "dml_prompt" : null,
                difySummary ? "dify_workflow" : null
            ].filter(Boolean)
        }
    };
    logSqlPayloadStage("payload.final", finalPayload);

    if (parsedDify && typeof parsedDify === "object") {
        finalPayload.reports.static_analyzer.enrichment = parsedDify;
        finalPayload.reports.dify_workflow = {
            type: "dify_workflow",
            summary: difySummary,
            issues: difyIssuesRaw,
            metadata: { analysis_source: "dify_workflow" },
            raw: parsedDify
        };
    }

    if (dmlAggregated) {
        finalPayload.reports.dml_prompt.aggregated = dmlAggregated;
    }

    finalReport = JSON.stringify(finalPayload, null, 2);
    logSqlPayloadStage("report.serialised", finalReport);

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
        analysisPayload.result = finalReport;
        analysisPayload.enriched = Boolean(dify);
        if (!analysisPayload.enrichmentStatus) {
            analysisPayload.enrichmentStatus = enrichmentStatus;
        }
        analysisPayload.staticReport = staticReportPayload;
        analysisPayload.dmlReport = dmlReportPayload;
        analysisPayload.dmlSegments = dmlSegments;
        analysisPayload.dmlSummary = dmlSummary;
        analysisPayload.dmlIssues = dmlIssues;
        if (dmlAggregated) {
            analysisPayload.dmlAggregated = dmlAggregated;
        }
        analysisPayload.combinedSummary = compositeSummary;
        analysisPayload.combinedIssues = combinedIssues;
        if (parsedDify && typeof parsedDify === "object") {
            analysisPayload.difyReport = parsedDify;
            analysisPayload.difySummary = difySummary;
            analysisPayload.difyIssues = difyIssuesRaw;
        }
        if (dmlErrorMessage) {
            analysisPayload.dmlErrorMessage = dmlErrorMessage;
        }
        if (dmlConversationId) {
            analysisPayload.dmlConversationId = dmlConversationId;
        }
        if (dmlGeneratedAt) {
            analysisPayload.dmlGeneratedAt = dmlGeneratedAt;
        }
        if (difyErrorMessage) {
            analysisPayload.difyErrorMessage = difyErrorMessage;
        } else if (!dify) {
            analysisPayload.difyErrorMessage = "";
        }
    }
    logSqlPayloadStage("analysis.payload", analysisPayload);

    const sourceLabels = ["sql-rule-engine"];
    if (dmlSegments.length) {
        sourceLabels.push(dmlPrompt ? "dml-dify" : "dml");
    }
    if (dify) {
        sourceLabels.push("dify");
    }

    const result = {
        report: finalReport,
        conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
        chunks: annotatedChunks,
        segments,
        generatedAt,
        analysis: analysisPayload,
        rawReport,
        dify: dify || null,
        dml: dmlReportPayload,
        source: sourceLabels.join("+"),
        enrichmentStatus,
        difyErrorMessage: difyErrorMessage || undefined,
        dmlErrorMessage: dmlErrorMessage || undefined
    };
    logSqlPayloadStage("buildSqlReportPayload.output", result);
    return result;
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
