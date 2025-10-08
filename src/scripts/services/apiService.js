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

const request = async (path, { method = "GET", body, headers = {} } = {}) => {
    const url = `${apiBase}${path}`;
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
        opts.body = typeof body === "string" ? body : JSON.stringify(body);
        if (!opts.headers["Content-Type"]) {
            opts.headers["Content-Type"] = "application/json";
        }
    }
    const response = await fetch(url, opts);
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }
    return await response.text();
};

const fetchProjects = async () => {
    return await request("/projects");
};

const createOrUpdateProject = async (project) => {
    return await request("/projects", { method: "POST", body: project });
};

const deleteProjectById = async (projectId) => {
    await request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
};

const fetchNodesByProject = async (projectId) => {
    return await request(`/projects/${encodeURIComponent(projectId)}/nodes`);
};

const replaceProjectNodes = async (projectId, nodes) => {
    await request(`/projects/${encodeURIComponent(projectId)}/nodes`, { method: "POST", body: { nodes } });
};

const deleteProjectNodes = async (projectId) => {
    await request(`/projects/${encodeURIComponent(projectId)}/nodes`, { method: "DELETE" });
};

const generateReportViaDify = async (payload) => {
    return await request("/reports/dify", { method: "POST", body: payload });
};

export {
    fetchProjects,
    createOrUpdateProject,
    deleteProjectById,
    fetchNodesByProject,
    replaceProjectNodes,
    deleteProjectNodes,
    generateReportViaDify,
};

const apiService = {
    fetchProjects,
    createOrUpdateProject,
    deleteProjectById,
    fetchNodesByProject,
    replaceProjectNodes,
    deleteProjectNodes,
    generateReportViaDify,
};

export default apiService;
