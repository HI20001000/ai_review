const DEFAULT_BASE = "/api";

const apiBase = (() => {
    if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE_URL) {
        return import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");
    }
    if (typeof process !== "undefined" && process.env?.VITE_API_BASE_URL) {
        return process.env.VITE_API_BASE_URL.replace(/\/$/, "");
    }
    return DEFAULT_BASE;
})();

async function postJson(path, payload) {
    const url = `${apiBase}${path}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }

    return await response.text();
}

export async function generateReportViaDify(payload) {
    return await postJson("/reports/dify", payload);
}

export default {
    generateReportViaDify
};
