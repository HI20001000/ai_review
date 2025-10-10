import { loadEnv } from "./env.js";

const env = loadEnv() ?? process.env;

const {
    DIFY_API_BASE_URL = "",
    DIFY_API_KEY = "",
    DIFY_CHAT_ENDPOINT = "/chat-messages",
    DIFY_RESPONSE_MODE = "blocking",
    DIFY_TOKEN_LIMIT = "32000",
    DIFY_APPROX_CHARS_PER_TOKEN = "4",
    DIFY_SAFETY_MARGIN = "0.8",
    DIFY_USER_ID = "code-reviewer"
} = env;

const baseUrl = typeof DIFY_API_BASE_URL === "string"
    ? DIFY_API_BASE_URL.trim().replace(/\/$/, "")
    : "";

if (!baseUrl) {
    console.warn("[dify] DIFY_API_BASE_URL is not configured; report generation will fail until it is set.");
}

const endpointPath = (typeof DIFY_CHAT_ENDPOINT === "string" && DIFY_CHAT_ENDPOINT.trim())
    ? (DIFY_CHAT_ENDPOINT.trim().startsWith("/") ? DIFY_CHAT_ENDPOINT.trim() : `/${DIFY_CHAT_ENDPOINT.trim()}`)
    : "/chat-messages";
const requestUrl = baseUrl ? `${baseUrl}${endpointPath}` : endpointPath;

const responseMode = (() => {
    const mode = typeof DIFY_RESPONSE_MODE === "string" && DIFY_RESPONSE_MODE.trim()
        ? DIFY_RESPONSE_MODE.trim().toLowerCase()
        : "blocking";
    return mode === "streaming" ? "streaming" : "blocking";
})();

let cachedFetch = null;

async function resolveFetch() {
    if (typeof fetch === "function") {
        return fetch.bind(globalThis);
    }
    if (cachedFetch) {
        return cachedFetch;
    }
    try {
        const undici = await import("node:undici");
        cachedFetch = undici.fetch;
        return cachedFetch;
    } catch (error) {
        const reason = error?.message ? ` (original error: ${error.message})` : "";
        throw new Error(
            `Fetch API is not available in this Node.js runtime. Please upgrade to Node 18+ or ensure node:undici can be imported${reason}.`
        );
    }
}

const tokenLimit = Math.max(1000, Number(DIFY_TOKEN_LIMIT) || 32000);
const approxCharsPerToken = Math.max(1, Number(DIFY_APPROX_CHARS_PER_TOKEN) || 4);
const safetyMargin = Math.min(1, Math.max(0.1, Number(DIFY_SAFETY_MARGIN) || 0.8));
const maxSegmentChars = Math.max(
    500,
    Math.floor(tokenLimit * approxCharsPerToken * safetyMargin)
);

const hasApiKey = Boolean(DIFY_API_KEY && DIFY_API_KEY.length);

console.log(
    `[dify] Resolved config baseUrl=${baseUrl || "(unset)"} endpoint=${endpointPath} responseMode=${responseMode} tokenLimit=${tokenLimit} ` +
        `approxCharsPerToken=${approxCharsPerToken} safetyMargin=${safetyMargin} maxSegmentChars=${maxSegmentChars} apiKey=${hasApiKey ? "set" : "missing"}`
);

function sliceByNewline(content, start, size) {
    const tentativeEnd = Math.min(content.length, start + size);
    if (tentativeEnd >= content.length) {
        return tentativeEnd;
    }
    const newlineIndex = content.lastIndexOf("\n", tentativeEnd);
    if (newlineIndex <= start + Math.floor(size * 0.3)) {
        return tentativeEnd;
    }
    return newlineIndex + 1;
}

export function partitionContent(content) {
    if (typeof content !== "string" || !content.length) {
        return [""];
    }
    if (content.length <= maxSegmentChars) {
        return [content];
    }
    const segments = [];
    let offset = 0;
    while (offset < content.length) {
        const nextEnd = sliceByNewline(content, offset, maxSegmentChars);
        segments.push(content.slice(offset, nextEnd));
        offset = nextEnd;
    }
    return segments;
}

function normaliseSelectionMeta(selection) {
    if (!selection || typeof selection !== "object") {
        return null;
    }
    const normalised = {};
    const start = Number(selection.startLine);
    const end = Number(selection.endLine);
    const startColumnRaw = Number(selection.startColumn);
    const endColumnRaw = Number(selection.endColumn);
    const providedLineCount = Number(selection.lineCount);
    if (Number.isFinite(start)) {
        normalised.startLine = Math.max(1, Math.floor(start));
    }
    if (Number.isFinite(end)) {
        normalised.endLine = Math.max(1, Math.floor(end));
    }
    if (Number.isFinite(startColumnRaw) && startColumnRaw > 0) {
        normalised.startColumn = Math.max(1, Math.floor(startColumnRaw));
    }
    if (Number.isFinite(endColumnRaw) && endColumnRaw > 0) {
        normalised.endColumn = Math.max(1, Math.floor(endColumnRaw));
    }
    if (
        normalised.startLine !== undefined &&
        normalised.endLine !== undefined &&
        normalised.endLine < normalised.startLine
    ) {
        const temp = normalised.startLine;
        normalised.startLine = normalised.endLine;
        normalised.endLine = temp;
        if (normalised.startColumn !== undefined || normalised.endColumn !== undefined) {
            const columnTemp = normalised.startColumn;
            normalised.startColumn = normalised.endColumn;
            normalised.endColumn = columnTemp;
        }
    }
    if (normalised.startLine !== undefined && normalised.endLine === undefined) {
        normalised.endLine = normalised.startLine;
    }
    if (normalised.endLine !== undefined && normalised.startLine === undefined) {
        normalised.startLine = normalised.endLine;
    }
    if (
        normalised.startLine !== undefined &&
        normalised.endLine !== undefined &&
        normalised.startLine === normalised.endLine &&
        normalised.startColumn !== undefined &&
        normalised.endColumn !== undefined &&
        normalised.endColumn < normalised.startColumn
    ) {
        const columnTemp = normalised.startColumn;
        normalised.startColumn = normalised.endColumn;
        normalised.endColumn = columnTemp;
    }
    if (typeof selection.label === "string" && selection.label.trim()) {
        normalised.label = selection.label.trim();
    }
    if (Number.isFinite(providedLineCount) && providedLineCount > 0) {
        normalised.lineCount = Math.max(1, Math.floor(providedLineCount));
    } else if (normalised.startLine !== undefined && normalised.endLine !== undefined) {
        normalised.lineCount = normalised.endLine - normalised.startLine + 1;
    }
    return Object.keys(normalised).length ? normalised : null;
}

function describeSelection(selection) {
    if (!selection) return "";
    const hasStart = typeof selection.startLine === "number" && Number.isFinite(selection.startLine);
    const hasEnd = typeof selection.endLine === "number" && Number.isFinite(selection.endLine);
    const hasStartColumn = typeof selection.startColumn === "number" && Number.isFinite(selection.startColumn);
    const hasEndColumn = typeof selection.endColumn === "number" && Number.isFinite(selection.endColumn);
    const isSingleLine = hasStart && hasEnd && selection.startLine === selection.endLine;
    let rangeText = "";
    if (hasStart && hasEnd) {
        rangeText = selection.startLine === selection.endLine
            ? `第 ${selection.startLine} 行`
            : `第 ${selection.startLine}-${selection.endLine} 行`;
    } else if (hasStart) {
        rangeText = `第 ${selection.startLine} 行`;
    } else if (hasEnd) {
        rangeText = `第 ${selection.endLine} 行`;
    }
    let columnText = "";
    if (isSingleLine) {
        if (hasStartColumn && hasEndColumn) {
            columnText = selection.startColumn === selection.endColumn
                ? `字元 ${selection.startColumn}`
                : `字元 ${selection.startColumn}-${selection.endColumn}`;
        } else if (hasStartColumn) {
            columnText = `字元 ${selection.startColumn} 起`;
        } else if (hasEndColumn) {
            columnText = `字元 ${selection.endColumn} 止`;
        }
    } else {
        if (hasStartColumn) {
            columnText = `起始字元 ${selection.startColumn}`;
        }
        if (hasEndColumn) {
            columnText = columnText ? `${columnText}，結束字元 ${selection.endColumn}` : `結束字元 ${selection.endColumn}`;
        }
    }
    const segments = [];
    if (rangeText) segments.push(rangeText);
    if (columnText) segments.push(columnText);
    const descriptor = segments.join("，");
    const label = typeof selection.label === "string" && selection.label.trim() ? selection.label.trim() : "";
    if (label && descriptor) {
        return `選取範圍：${descriptor}（${label}）`;
    }
    if (descriptor) {
        return `選取範圍：${descriptor}`;
    }
    if (label) {
        return `選取標籤：${label}`;
    }
    return "";
}

function buildPrompt({ segment, projectName, filePath, chunkIndex, chunkTotal, selection }) {
    const headerLines = [
        "你是一位資深的程式碼審查專家，請針對以下程式碼段落提供深入的審查報告。",
        "請重點標記潛在缺陷、最佳化建議、安全性問題、可維護性與測試建議。",
        "輸出請使用繁體中文，並保持清晰的 Markdown 結構。",
        "",
        `專案：${projectName || "(未命名專案)"}`,
        `檔案：${filePath}`,
        describeSelection(selection),
        chunkTotal > 1 ? `分段：${chunkIndex}/${chunkTotal}` : "",
        "",
        "以下是本段程式碼：",
        "```",
        segment.trimEnd(),
        "```"
    ].filter(Boolean);
    return headerLines.join("\n");
}

function assertConfig() {
    if (!baseUrl) {
        throw new Error("Dify API base URL (DIFY_API_BASE_URL) is not configured");
    }
    if (!DIFY_API_KEY) {
        throw new Error("Dify API key (DIFY_API_KEY) is not configured");
    }
}

export async function requestDifyReport({
    projectName,
    filePath,
    content,
    userId,
    segments: presetSegments,
    files,
    selection
}) {
    assertConfig();
    const segments = Array.isArray(presetSegments) && presetSegments.length
        ? presetSegments
        : partitionContent(content || "");
    const results = [];
    let conversationId = "";
    const fetchImpl = await resolveFetch();
    const fileAttachments = Array.isArray(files) ? files : [];
    const selectionMeta = normaliseSelectionMeta(selection);
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const chunkIndex = index + 1;
        const resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : DIFY_USER_ID;
        if (!resolvedUserId) {
            throw new Error("Dify user identifier is required; set DIFY_USER_ID or pass userId");
        }
        const body = {
            inputs: {
                project_name: projectName || "",
                file_path: filePath,
                chunk_index: chunkIndex,
                chunk_total: segments.length
            },
            query: buildPrompt({
                segment,
                projectName,
                filePath,
                chunkIndex,
                chunkTotal: segments.length,
                selection: selectionMeta
            }),
            response_mode: responseMode,
            conversation_id: conversationId,
            user: resolvedUserId,
            files: fileAttachments
        };
        if (selectionMeta) {
            if (typeof selectionMeta.startLine === "number") {
                body.inputs.selection_start_line = selectionMeta.startLine;
            }
            if (typeof selectionMeta.endLine === "number") {
                body.inputs.selection_end_line = selectionMeta.endLine;
            }
            if (typeof selectionMeta.startColumn === "number") {
                body.inputs.selection_start_column = selectionMeta.startColumn;
            }
            if (typeof selectionMeta.endColumn === "number") {
                body.inputs.selection_end_column = selectionMeta.endColumn;
            }
            if (typeof selectionMeta.lineCount === "number") {
                body.inputs.selection_line_count = selectionMeta.lineCount;
            }
            if (selectionMeta.label) {
                body.inputs.selection_label = selectionMeta.label;
            }
        }
        let response;
        try {
            const headers = new Headers();
            headers.set("Authorization", `Bearer ${DIFY_API_KEY}`);
            headers.set("Content-Type", "application/json");
            response = await fetchImpl(requestUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(body)
            });
        } catch (error) {
            const cause = error?.cause;
            const addressHint = cause?.address ? ` ${cause.address}` : "";
            const networkHint = cause?.code ? ` (code: ${cause.code}${addressHint})` : "";
            const reason = error?.message || "Unknown error";
            throw new Error(`Failed to reach Dify endpoint ${requestUrl}${networkHint}: ${reason}`);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(
                `Dify request failed for chunk ${chunkIndex}/${segments.length}: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
            );
        }
        const payload = await response.json();
        conversationId = payload?.conversation_id || conversationId;
        const answer = payload?.answer || "";
        results.push({
            index: chunkIndex,
            total: segments.length,
            answer,
            raw: payload
        });
    }
    const combinedReport = results.map((item) => {
        if (segments.length === 1) {
            return item.answer;
        }
        return [`### 第 ${item.index} 段審查`, item.answer].join("\n\n");
    }).join("\n\n").trim();
    return {
        report: combinedReport,
        conversationId,
        chunks: results,
        segments,
        generatedAt: new Date().toISOString(),
        selection: selectionMeta || undefined
    };
}

export function getDifyConfigSummary() {
    return {
        baseUrl,
        endpointPath,
        tokenLimit,
        approxCharsPerToken,
        safetyMargin,
        maxSegmentChars,
        responseMode,
        hasApiKey
    };
}
