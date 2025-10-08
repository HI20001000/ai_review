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

const baseUrl = DIFY_API_BASE_URL.replace(/\/$/, "");

if (!baseUrl) {
    console.warn("[dify] DIFY_API_BASE_URL is not configured; report generation will fail until it is set.");
}

const endpointPath = DIFY_CHAT_ENDPOINT.startsWith("/") ? DIFY_CHAT_ENDPOINT : `/${DIFY_CHAT_ENDPOINT}`;
const requestUrl = `${baseUrl}${endpointPath}`;

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

function buildPrompt({ segment, projectName, filePath, chunkIndex, chunkTotal }) {
    const headerLines = [
        "你是一位資深的程式碼審查專家，請針對以下程式碼段落提供深入的審查報告。",
        "請重點標記潛在缺陷、最佳化建議、安全性問題、可維護性與測試建議。",
        "輸出請使用繁體中文，並保持清晰的 Markdown 結構。",
        "",
        `專案：${projectName || "(未命名專案)"}`,
        `檔案：${filePath}`,
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

export async function requestDifyReport({ projectName, filePath, content, userId, segments: presetSegments, files }) {
    assertConfig();
    const segments = Array.isArray(presetSegments) && presetSegments.length
        ? presetSegments
        : partitionContent(content || "");
    const results = [];
    let conversationId = "";
    const fetchImpl = await resolveFetch();
    const fileAttachments = Array.isArray(files) ? files : [];
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const chunkIndex = index + 1;
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
                chunkTotal: segments.length
            }),
            response_mode: responseMode,
            conversation_id: conversationId,
            user: userId || DIFY_USER_ID,
            files: fileAttachments
        };
        let response;
        try {
            response = await fetchImpl(requestUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${DIFY_API_KEY}`,
                    "Content-Type": "application/json"
                },
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
        generatedAt: new Date().toISOString()
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
