import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pool, { getPoolConfigSummary } from "./db.js";

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

async function hasColumn(table, column) {
    const statement = pool.format("SHOW COLUMNS FROM ?? LIKE ?", [table, column]);
    const [rows] = await pool.query(statement);
    return Array.isArray(rows) && rows.length > 0;
}

async function ensureColumn({ info, error }, table, columnName, columnDefinition) {
    if (await hasColumn(table, columnName)) {
        info(`[schema] Column ${table}.${columnName} already exists, skipping.`);
        return;
    }

    const statement = pool.format(
        `ALTER TABLE ?? ADD COLUMN ?? ${columnDefinition}`,
        [table, columnName]
    );
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

    const summary = getPoolConfigSummary();
    info(
        `[schema] Using connection host=${summary.host} port=${summary.port} user=${summary.user} ` +
            `database=${summary.database} password=${summary.hasPassword ? "set" : "empty"}`
    );

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

    const reportColumnDefinitions = [
        { name: "combined_report_json", definition: "LONGTEXT NULL" },
        { name: "static_report_json", definition: "LONGTEXT NULL" },
        { name: "ai_report_json", definition: "LONGTEXT NULL" }
    ];

    for (const { name, definition } of reportColumnDefinitions) {
        await ensureColumn({ info, error }, "reports", name, definition);
    }
}
