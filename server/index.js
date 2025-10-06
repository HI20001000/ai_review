if (typeof process.loadEnvFile === "function") {
    try {
        process.loadEnvFile();
    } catch (error) {
        if (error?.code !== "ENOENT") {
            console.warn("Failed to load .env file", error?.message || error);
        }
    }
}

import express from "express";
import pool from "./lib/db.js";
import { ensureSchema } from "./lib/ensureSchema.js";

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

app.delete("/api/projects/:projectId/nodes", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await pool.query("DELETE FROM nodes WHERE project_id = ?", [projectId]);
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.use((err, req, res, _next) => {
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
