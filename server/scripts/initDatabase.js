if (typeof process.loadEnvFile === "function") {
    try {
        process.loadEnvFile();
    } catch (error) {
        if (error?.code !== "ENOENT") {
            console.warn("Failed to load .env file", error?.message || error);
        }
    }
}

import pool from "../lib/db.js";
import { ensureSchema } from "../lib/ensureSchema.js";

try {
    await ensureSchema();
    console.log("MySQL schema ensured successfully.");
} catch (error) {
    console.error("Failed to initialise database schema", error);
    process.exitCode = 1;
} finally {
    await pool.end().catch((err) => console.error("Failed to close MySQL pool", err));
}
