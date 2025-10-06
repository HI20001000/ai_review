import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

function splitStatements(sql) {
    return sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length && !statement.startsWith("--"));
}

export async function ensureSchema() {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(currentDir, "../sql/schema.sql");
    const sql = await readFile(schemaPath, "utf8");
    const statements = splitStatements(sql);

    for (const statement of statements) {
        await pool.query(statement);
    }
}
