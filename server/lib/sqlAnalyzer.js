import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "sqlStaticAnalyzer.py");

function runPythonAnalysis(sqlText) {
    const interpreters = ["python3", "python"];
    return new Promise((resolvePromise, rejectPromise) => {
        let attempt = 0;
        let child = null;
        const chunks = [];
        const errors = [];

        const start = () => {
            if (attempt >= interpreters.length) {
                rejectPromise(new Error("No Python interpreter (python3/python) found for SQL analysis"));
                return;
            }
            const command = interpreters[attempt];
            attempt += 1;
            child = spawn(command, [SCRIPT_PATH], {
                stdio: ["pipe", "pipe", "pipe"],
            });

            child.stdout.on("data", (chunk) => {
                chunks.push(Buffer.from(chunk));
            });

            child.stderr.on("data", (chunk) => {
                errors.push(Buffer.from(chunk));
            });

            child.on("error", (error) => {
                if (error.code === "ENOENT") {
                    start();
                    return;
                }
                rejectPromise(error);
            });

            child.on("close", (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errors).toString("utf8");
                    const error = new Error(stderr.trim() || `SQL analysis process exited with code ${code}`);
                    error.code = code;
                    rejectPromise(error);
                    return;
                }
                const stdout = Buffer.concat(chunks).toString("utf8");
                resolvePromise(stdout);
            });

            child.stdin.end(sqlText ?? "");
        };

        start();
    });
}

export async function analyseSqlToReport(sqlText) {
    const output = await runPythonAnalysis(sqlText || "");
    let parsed;
    try {
        parsed = JSON.parse(output);
    } catch (error) {
        const reason = output && output.trim() ? ` (output: ${output.trim()})` : "";
        throw new Error(`Failed to parse SQL analysis output${reason}`);
    }
    return parsed;
}

export function buildSqlReportPayload({ analysis, content }) {
    const safeAnalysis = analysis || {};
    const jsonText = JSON.stringify(safeAnalysis, null, 2);
    const markdown = ["```json", jsonText, "```"].join("\n");
    return {
        report: markdown,
        conversationId: "",
        chunks: [
            {
                index: 1,
                total: 1,
                answer: markdown,
                raw: safeAnalysis,
            },
        ],
        segments: [content ?? ""],
        generatedAt: new Date().toISOString(),
        analysis: safeAnalysis,
        source: "sql-static-analyzer",
    };
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
