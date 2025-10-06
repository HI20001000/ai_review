import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

function stripComments(sql) {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
}

function splitStatements(sql) {
    return stripComments(sql)
        .split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length);
}

function createLogger(logger) {
    const target = logger && typeof logger === "object" ? logger : console;
    const info = typeof target.info === "function" ? target.info.bind(target) : console.log.bind(console);
    const error = typeof target.error === "function" ? target.error.bind(target) : console.error.bind(console);
    return { info, error };
}

function formatStatement(statement) {
    const singleLine = statement.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 120) {
        return singleLine;
    }
    return `${singleLine.slice(0, 117)}...`;
}

export async function ensureSchema({ logger } = {}) {
    const { info, error } = createLogger(logger);
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(currentDir, "../sql/schema.sql");
    const sql = await readFile(schemaPath, "utf8");
    const statements = splitStatements(sql);

    for (const statement of statements) {
        const preview = formatStatement(statement);
        info(`[schema] Executing: ${preview}`);
        try {
            await pool.query(statement);
            info(`[schema] Success: ${preview}`);
        } catch (err) {
            error(`[schema] Failed: ${preview}`, err);
            throw err;
        }
    }
}
