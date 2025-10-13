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
        const stdinErrors = [];
        let settled = false;

        const resolveSafe = (value) => {
            if (!settled) {
                settled = true;
                resolvePromise(value);
            }
        };

        const rejectSafe = (error) => {
            if (!settled) {
                settled = true;
                rejectPromise(error);
            }
        };

        const start = () => {
            if (attempt >= interpreters.length) {
                rejectSafe(new Error("No Python interpreter (python3/python) found for SQL analysis"));
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

            child.stdin.on("error", (error) => {
                if (!error) {
                    return;
                }
                const code = error.code || "";
                if (code === "EPIPE" || code === "EOF" || code === "ECONNRESET") {
                    const message = `stdin error: ${error.message || code}`;
                    errors.push(Buffer.from(`${message}\n`));
                    stdinErrors.push(message);
                    return;
                }
                rejectSafe(error);
            });

            child.on("error", (error) => {
                if (error.code === "ENOENT") {
                    start();
                    return;
                }
                rejectSafe(error);
            });

            child.on("close", (code) => {
                if (code !== 0 || stdinErrors.length > 0) {
                    const stderr = Buffer.concat(errors).toString("utf8");
                    const message = stderr.trim() || (stdinErrors.length > 0 ? stdinErrors.join("; ") : "");
                    const error = new Error(message || `SQL analysis process exited with code ${code}`);
                    error.code = code;
                    rejectSafe(error);
                    return;
                }
                const stdout = Buffer.concat(chunks).toString("utf8");
                resolveSafe(stdout);
            });

            try {
                if (sqlText && sqlText.length > 0) {
                    child.stdin.write(sqlText, (error) => {
                        if (error) {
                            const code = error.code || "";
                            if (code === "EPIPE" || code === "EOF" || code === "ECONNRESET") {
                                const message = `stdin error: ${error.message || code}`;
                                errors.push(Buffer.from(`${message}\n`));
                                stdinErrors.push(message);
                                return;
                            }
                            rejectSafe(error);
                        }
                    });
                }
                child.stdin.end();
            } catch (error) {
                rejectSafe(error);
            }
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
    if (!parsed || typeof parsed.result !== "string") {
        throw new Error("SQL analysis result is missing the expected result field");
    }
    return parsed;
}

export function buildSqlReportPayload({ analysis, content }) {
    const resultText = typeof analysis?.result === "string" ? analysis.result : "";
    const reportText = resultText || "";
    const generatedAt = new Date().toISOString();
    return {
        report: reportText,
        conversationId: "",
        chunks: [
            {
                index: 1,
                total: 1,
                answer: reportText,
                raw: analysis?.result ?? reportText,
            },
        ],
        segments: [content ?? ""],
        generatedAt,
        analysis,
        source: "sql-static-analyzer",
    };
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
