import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getDifyConfigSummary, partitionContent, requestDifyReport } from "./difyClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "sql_rule_engine.py");

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

export async function analyseSqlToReport(sqlText, options = {}) {
    const analysis = await executeSqlAnalysis(sqlText);
    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";
    const trimmedReport = rawReport.trim();

    if (!trimmedReport) {
        return { analysis, dify: null, difyError: null };
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

    console.log(
        `[sql+dify] Enriching SQL analysis project=${projectId || resolvedProjectName} path=${path || analysisFilePath} ` +
            `segments=${segments.length} maxSegmentChars=${summary.maxSegmentChars}`
    );

    try {
        const dify = await requestDifyReport({
            projectName: resolvedProjectName,
            filePath: analysisFilePath,
            content: trimmedReport,
            userId: resolvedUserId,
            segments,
            files
        });
        return { analysis, dify, difyError: null };
    } catch (error) {
        console.error("[sql+dify] Failed to enrich SQL analysis via Dify", error);
        return { analysis, dify: null, difyError: error };
    }
}

export function buildSqlReportPayload({ analysis, content, dify }) {
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
    return {
        report: finalReport,
        conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
        chunks: annotatedChunks,
        segments,
        generatedAt,
        analysis,
        rawReport,
        dify: dify || null,
        source: dify ? "sql-rule-engine+dify" : "sql-rule-engine"
    };
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
