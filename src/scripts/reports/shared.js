/**
 * Shared helpers for report pipelines.
 * These utilities normalise source keys, clone issues, remap issue sources and remove duplicates.
 * They are intentionally colocated to prevent module level duplication across the different report pipelines.
 */

/**
 * Normalise a report source key by stripping non alpha-numeric characters and lower-casing the result.
 *
 * @param {unknown} value - Raw source key candidate.
 * @returns {string} A normalised identifier (empty when input is not a string).
 */
export function normaliseReportSourceKey(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Attempt to locate a report entry whose key matches the supplied source key (after normalisation).
 *
 * @template T
 * @param {Record<string, T> | null | undefined} container - Object containing report entries keyed by source name.
 * @param {string} sourceKey - Desired source key.
 * @returns {T | null} The matching entry or null when not present.
 */
export function findEntryBySourceKey(container, sourceKey) {
    if (!container || typeof container !== "object") {
        return null;
    }
    const target = normaliseReportSourceKey(sourceKey);
    if (!target) return null;
    for (const [key, value] of Object.entries(container)) {
        if (normaliseReportSourceKey(key) === target) {
            return value && typeof value === "object" ? value : null;
        }
    }
    return null;
}

/**
 * Clone an issue object and attach/override its `source` value when necessary.
 *
 * @template T extends Record<string, any>
 * @param {T} issue - The issue record to clone.
 * @param {string} sourceKey - Source identifier that should be recorded on the issue.
 * @param {{ force?: boolean }} [options]
 * @returns {T} A cloned issue with the desired source applied (original object returned when no changes required).
 */
export function cloneIssueWithSource(issue, sourceKey, options = {}) {
    let result = issue;

    if (issue && typeof issue === "object" && !Array.isArray(issue)) {
        const target = normaliseReportSourceKey(sourceKey);

        if (target) {
            const existingKeys = [
                normaliseReportSourceKey(issue.source),
                normaliseReportSourceKey(issue.analysis_source),
                normaliseReportSourceKey(issue.analysisSource)
            ].filter(Boolean);

            if (options.force) {
                const base = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
                const { analysis_source: _analysisSource, analysisSource: _analysisSourceCamel, ...rest } = base;
                result = { ...rest, source: sourceKey };
            } else if (existingKeys.includes(target)) {
                result = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
            } else if (existingKeys.length === 0) {
                result = { ...issue, source: sourceKey };
            }
        }
    }

    return result;
}

/**
 * Remap all issues in a collection to the specified source key.
 *
 * @template T extends Record<string, any>
 * @param {T[] | null | undefined} issues - Array of issue records.
 * @param {string} sourceKey - Source identifier to apply.
 * @param {{ force?: boolean }} [options]
 * @returns {T[]} List of cloned issues mapped to the supplied source.
 */
export function remapIssuesToSource(issues, sourceKey, options = {}) {
    if (!Array.isArray(issues)) {
        return [];
    }
    return issues.map((issue) => cloneIssueWithSource(issue, sourceKey, options));
}

function sortObjectKeys(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sortObjectKeys(item));
    }
    const sorted = {};
    Object.keys(value)
        .sort()
        .forEach((key) => {
            sorted[key] = sortObjectKeys(value[key]);
        });
    return sorted;
}

function createIssueKey(issue) {
    if (issue && typeof issue === "object") {
        try {
            return JSON.stringify(sortObjectKeys(issue));
        } catch (error) {
            console.warn("[reports] Failed to stringify issue for dedupe", error, issue);
        }
    }
    if (typeof issue === "string") {
        return issue;
    }
    return String(issue);
}

/**
 * Remove duplicate issues using a stable JSON representation for comparison.
 *
 * @template T
 * @param {T[] | null | undefined} list - Candidate issue collection.
 * @returns {T[]} Deduplicated issues preserving the original iteration order.
 */
export function dedupeIssues(list) {
    const seen = new Set();
    const result = [];
    for (const issue of list || []) {
        const key = createIssueKey(issue);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(issue);
    }
    return result;
}

export default {
    normaliseReportSourceKey,
    findEntryBySourceKey,
    cloneIssueWithSource,
    remapIssuesToSource,
    dedupeIssues
};
