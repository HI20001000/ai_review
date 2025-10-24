<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import JSZip from "jszip";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";
import { generateReportViaDify, fetchProjectReports } from "../scripts/services/reportService.js";
import PanelRail from "../components/workspace/PanelRail.vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";

const preview = usePreview();

const projectsStore = useProjectsStore({
    preview,
    fileSystem: fileSystemService
});

const treeStore = useTreeStore({
    getProjectRootHandleById: projectsStore.getProjectRootHandleById,
    getFileHandleByPath: fileSystemService.getFileHandleByPath,
    previewing: preview.previewing,
    isTextLike: preview.isTextLike,
    MAX_TEXT_BYTES: preview.MAX_TEXT_BYTES,
    selectedProjectId: projectsStore.selectedProjectId
});

projectsStore.setTreeStore(treeStore);

const aiAssistant = useAiAssistant({ treeStore, projectsStore, fileSystem: fileSystemService, preview });

const {
    showUploadModal,
    projects,
    selectedProjectId,
    supportsFS,
    loadProjectsFromDB,
    cleanupLegacyHandles,
    openProject,
    collapseProject,
    deleteProject,
    handleDrop,
    handleDragOver,
    handleFolderInput,
    pickFolderAndImport,
    updateCapabilityFlags,
    getProjectRootHandleById,
    safeAlertFail
} = projectsStore;

const {
    tree,
    activeTreePath,
    activeTreeRevision,
    isLoadingTree,
    openNode,
    selectTreeNode
} = treeStore;

const {
    open: openAssistantSession,
    close: closeAssistantSession,
    contextItems,
    messages,
    addActiveNode,
    addSnippetContext,
    removeContext,
    clearContext,
    sendUserMessage,
    isProcessing,
    isInteractionLocked: isChatLocked,
    connection,
    retryHandshake
} = aiAssistant;

const { previewing } = preview;

const previewLineItems = computed(() => {
    if (previewing.value.kind !== "text") return [];
    const text = previewing.value.text ?? "";
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length === 0) {
        return [{ number: 1, content: "\u00A0" }];
    }
    return lines.map((line, index) => ({
        number: index + 1,
        content: line === "" ? "\u00A0" : line,
        raw: line
    }));
});

const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const codeScrollRef = ref(null);
const codeSelection = ref(null);
let pointerDownInCode = false;
let shouldClearAfterPointerClick = false;
let lastPointerDownWasOutsideCode = false;
const showCodeLineNumbers = ref(true);
const isChatWindowOpen = ref(false);
const activeRailTool = ref("projects");
const chatWindowState = reactive({ x: 0, y: 80, width: 420, height: 520 });
const chatDragState = reactive({ active: false, offsetX: 0, offsetY: 0 });
const chatResizeState = reactive({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,
    edges: {
        left: false,
        right: false,
        top: false,
        bottom: false
    }
});
const hasInitializedChatWindow = ref(false);
const isTreeCollapsed = ref(false);
const reportStates = reactive({});
const reportTreeCache = reactive({});
const reportBatchStates = reactive({});
const activeReportTarget = ref(null);
const isProjectToolActive = computed(() => activeRailTool.value === "projects");
const isReportToolActive = computed(() => activeRailTool.value === "reports");
const shouldPrepareReportTrees = computed(
    () => isProjectToolActive.value || isReportToolActive.value
);
const panelMode = computed(() => (isReportToolActive.value ? "reports" : "projects"));
const reportProjectEntries = computed(() => {
    const list = Array.isArray(projects.value) ? projects.value : [];
    return list.map((project) => {
        const projectKey = normaliseProjectId(project.id);
        return {
            project,
            cache: reportTreeCache[projectKey] || {
                nodes: [],
                loading: false,
                error: "",
                expandedPaths: [],
                hydratedReports: false,
                hydratingReports: false,
                reportHydrationError: ""
            }
        };
    });
});

const activePreviewTarget = computed(() => {
    const projectId = normaliseProjectId(selectedProjectId.value);
    const path = activeTreePath.value || "";
    if (!projectId || !path) return null;
    return { projectId, path };
});

const reportPanelConfig = computed(() => {
    const viewMode = isReportToolActive.value ? "reports" : "projects";
    const showProjectActions = isReportToolActive.value;
    const showIssueBadge = isReportToolActive.value;
    const showFileActions = isReportToolActive.value;
    const allowSelectWithoutReport = !isReportToolActive.value;
    const projectIssueGetter = showIssueBadge ? getProjectIssueCount : null;

    return {
        panelTitle: viewMode === "reports" ? "代碼審查" : "Project Files",
        showProjectActions,
        showIssueBadge,
        showFileActions,
        allowSelectWithoutReport,
        entries: reportProjectEntries.value,
        normaliseProjectId,
        isNodeExpanded: isReportNodeExpanded,
        toggleNode: toggleReportNode,
        getReportState: getReportStateForFile,
        onGenerate: generateReportForFile,
        onSelect: viewMode === "reports" ? selectReport : openProjectFileFromReportTree,
        getStatusLabel,
        onReloadProject: loadReportTreeForProject,
        onGenerateProject: generateProjectReports,
        getProjectBatchState,
        getProjectIssueCount: projectIssueGetter,
        activeTarget: isReportToolActive.value
            ? activeReportTarget.value
            : activePreviewTarget.value
    };
});
const readyReports = computed(() => {
    const list = [];
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const projectMap = new Map(projectList.map((project) => [String(project.id), project]));

    Object.entries(reportStates).forEach(([key, state]) => {
        if (state.status !== "ready") return;
        const parsed = parseReportKey(key);
        const project = projectMap.get(parsed.projectId);
        if (!project || !parsed.path) return;
        list.push({
            key,
            project,
            path: parsed.path,
            state
        });
    });

    list.sort((a, b) => {
        if (a.project.name === b.project.name) return a.path.localeCompare(b.path);
        return a.project.name.localeCompare(b.project.name);
    });

    return list;
});

const projectIssueTotals = computed(() => {
    const totals = new Map();
    Object.entries(reportStates).forEach(([key, state]) => {
        const summary = state?.issueSummary;
        if (!summary || !Number.isFinite(summary.totalIssues)) return;
        const parsed = parseReportKey(key);
        if (!parsed.projectId) return;
        const previous = totals.get(parsed.projectId);
        const base = typeof previous === "number" && Number.isFinite(previous) ? previous : 0;
        totals.set(parsed.projectId, base + summary.totalIssues);
    });
    return totals;
});
const hasReadyReports = computed(() => readyReports.value.length > 0);
const activeReport = computed(() => {
    const target = activeReportTarget.value;
    if (!target) return null;
    const key = toReportKey(target.projectId, target.path);
    if (!key) return null;
    const state = reportStates[key];
    if (!state || (state.status !== "ready" && state.status !== "error")) return null;
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => String(item.id) === target.projectId);
    if (!project) return null;
    return {
        project,
        state,
        path: target.path
    };
});

const viewerHasContent = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    return report.state.status === "ready" || report.state.status === "error";
});

const hasChunkDetails = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    const chunks = report.state.chunks;
    return Array.isArray(chunks) && chunks.length > 1;
});

const activeReportDetails = computed(() => {
    const report = activeReport.value;
    if (!report || report.state.status !== "ready") return null;
    const parsed = report.state.parsedReport;
    if (!parsed || typeof parsed !== "object") return null;

    const reports = parsed.reports && typeof parsed.reports === "object" ? parsed.reports : null;
    const staticReport = reports?.static_analyzer || reports?.staticAnalyzer || null;
    const dmlReport = reports?.dml_prompt || reports?.dmlPrompt || null;

    const issues = Array.isArray(staticReport?.issues)
        ? staticReport.issues
        : Array.isArray(parsed.issues)
        ? parsed.issues
        : [];
    const rawStaticSummary =
        staticReport && typeof staticReport === "object" && staticReport.summary !== undefined
            ? staticReport.summary
            : null;
    const summary = (rawStaticSummary ?? parsed.summary) ?? null;

    let total = report.state.issueSummary?.totalIssues;
    if (!Number.isFinite(total)) {
        const summaryObject = summary && typeof summary === "object" ? summary : null;
        if (summaryObject) {
            const candidate = Number(summaryObject.total_issues ?? summaryObject.totalIssues);
            if (Number.isFinite(candidate)) {
                total = candidate;
            }
        }
        if (!Number.isFinite(total)) {
            let computedTotal = 0;
            for (const issue of issues) {
                if (Array.isArray(issue?.issues) && issue.issues.length) {
                    const filtered = issue.issues.filter((entry) => typeof entry === "string" && entry.trim());
                    computedTotal += filtered.length || issue.issues.length;
                } else if (typeof issue?.message === "string" && issue.message.trim()) {
                    computedTotal += 1;
                }
            }
            total = computedTotal;
        }
    }

    const summaryText = typeof summary === "string" ? summary.trim() : "";
    const summaryObject = summary && typeof summary === "object" ? summary : null;
    const staticSummaryObject =
        rawStaticSummary && typeof rawStaticSummary === "object" ? rawStaticSummary : summaryObject;
    const staticSummaryDetails = buildSummaryDetailList(staticSummaryObject, {
        omitKeys: ["by_rule", "byRule", "sources"]
    });
    const staticMetadata =
        staticReport && typeof staticReport.metadata === "object" && !Array.isArray(staticReport.metadata)
            ? staticReport.metadata
            : null;
    const staticMetadataDetails = buildSummaryDetailList(staticMetadata);

    const severityCounts = new Map();
    const ruleCounts = new Map();

    const toStringList = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => {
                if (item == null) return "";
                return typeof item === "string" ? item : String(item);
            });
        }
        if (value == null) return [];
        return [typeof value === "string" ? value : String(value)];
    };

    const toNumberList = (value) => {
        if (Array.isArray(value)) {
            return value
                .map((item) => {
                    const numeric = Number(item);
                    return Number.isFinite(numeric) ? numeric : null;
                })
                .filter((item) => item !== null);
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) ? [numeric] : [];
    };

    const normalisedIssues = issues.map((issue, index) => {
        const ruleList = toStringList(issue?.rule_ids);
        if (!ruleList.length) {
            ruleList.push(...toStringList(issue?.ruleId));
            ruleList.push(...toStringList(issue?.rule_id));
            ruleList.push(...toStringList(issue?.rule));
        }

        const severityList = toStringList(issue?.severity_levels);
        if (!severityList.length) {
            severityList.push(...toStringList(issue?.severity));
            severityList.push(...toStringList(issue?.level));
        }

        const messageList = toStringList(issue?.issues);
        if (!messageList.length) {
            messageList.push(...toStringList(issue?.message));
            messageList.push(...toStringList(issue?.description));
        }

        const recommendationList = toStringList(issue?.recommendation);
        if (!recommendationList.length) {
            recommendationList.push(...toStringList(issue?.修改建議));
            recommendationList.push(...toStringList(issue?.modificationAdvice));
        }

        const evidenceList = toStringList(issue?.evidence_list);
        if (!evidenceList.length) {
            evidenceList.push(...toStringList(issue?.evidence));
        }

        const columnList = toNumberList(issue?.column);
        if (!columnList.length) {
            columnList.push(...toNumberList(issue?.columns));
        }

        const detailCount = Math.max(
            messageList.length,
            ruleList.length,
            severityList.length,
            recommendationList.length,
            columnList.length,
            evidenceList.length
        );

        const details = [];
        for (let detailIndex = 0; detailIndex < detailCount; detailIndex += 1) {
            const ruleCandidate = ruleList[detailIndex] ?? ruleList[0] ?? "";
            const messageCandidate = messageList[detailIndex] ?? messageList[0] ?? "";
            const severityCandidate = severityList[detailIndex] ?? severityList[0] ?? "";
            const recommendationCandidate = recommendationList[detailIndex] ?? recommendationList[0] ?? "";
            const evidenceCandidate = evidenceList[detailIndex] ?? evidenceList[0] ?? "";
            const columnCandidate = columnList[detailIndex] ?? columnList[0] ?? null;

            const ruleId = typeof ruleCandidate === "string" ? ruleCandidate.trim() : String(ruleCandidate ?? "").trim();
            const message = typeof messageCandidate === "string" ? messageCandidate.trim() : String(messageCandidate ?? "").trim();
            const severityRaw =
                typeof severityCandidate === "string" ? severityCandidate.trim() : String(severityCandidate ?? "").trim();
            const severityKey = severityRaw ? severityRaw.toUpperCase() : "未標示";
            let severityClass = "info";
            if (!severityRaw || severityKey === "未標示") {
                severityClass = "muted";
            } else if (severityKey.includes("CRIT") || severityKey.includes("ERR")) {
                severityClass = "error";
            } else if (severityKey.includes("WARN")) {
                severityClass = "warn";
            }
            const columnNumber = Number(columnCandidate);
            const column = Number.isFinite(columnNumber) ? columnNumber : null;
            const suggestion =
                typeof recommendationCandidate === "string"
                    ? recommendationCandidate.trim()
                    : String(recommendationCandidate ?? "").trim();
            const evidence = typeof evidenceCandidate === "string" ? evidenceCandidate : String(evidenceCandidate ?? "");

            details.push({
                key: `${index}-detail-${detailIndex}`,
                index: details.length + 1,
                ruleId,
                severity: severityRaw,
                severityLabel: severityKey,
                severityClass,
                message,
                column,
                suggestion,
                evidence
            });
        }

        if (!details.length) {
            details.push({
                key: `${index}-detail-0`,
                index: 1,
                ruleId: "",
                severity: "",
                severityLabel: "未標示",
                severityClass: "muted",
                message: "",
                column: null,
                suggestion: "",
                evidence: typeof issue?.evidence === "string" ? issue.evidence : ""
            });
        }

        details.forEach((detail) => {
            const severityLabel = detail.severityLabel || "未標示";
            severityCounts.set(severityLabel, (severityCounts.get(severityLabel) || 0) + 1);
            if (detail.ruleId) {
                ruleCounts.set(detail.ruleId, (ruleCounts.get(detail.ruleId) || 0) + 1);
            }
        });

        const objectName =
            (typeof issue?.object === "string" && issue.object.trim()) ||
            (typeof issue?.object_name === "string" && issue.object_name.trim()) ||
            "";

        let line = Number(issue?.line);
        if (!Number.isFinite(line)) line = null;

        const snippet = typeof issue?.snippet === "string" ? issue.snippet : "";
        const snippetLines = snippet ? snippet.replace(/\r\n?/g, "\n").split("\n") : [];

        const codeLines = snippetLines.map((lineText, idx) => {
            const rawText = lineText.replace(/\r$/, "");
            const number = line !== null ? line + idx : null;
            const displayNumber = number !== null ? String(number) : "";
            const safeHtml = escapeHtml(rawText);
            return {
                key: `${index}-line-${idx}`,
                number,
                displayNumber,
                raw: rawText,
                html: safeHtml.length ? safeHtml : "&nbsp;",
                highlight: false
            };
        });

        if (codeLines.length) {
            let highlightApplied = false;
            if (line !== null) {
                codeLines.forEach((codeLine) => {
                    if (codeLine.number === line) {
                        codeLine.highlight = true;
                        highlightApplied = true;
                    }
                });
            }

            if (!highlightApplied) {
                const fallbackIndex = codeLines.findIndex((item) => item.raw.trim().length > 0);
                const indexToHighlight = fallbackIndex >= 0 ? fallbackIndex : 0;
                if (codeLines[indexToHighlight]) {
                    codeLines[indexToHighlight].highlight = true;
                }
            }
        }

        const suggestionList = details
            .map((detail) => (typeof detail.suggestion === "string" ? detail.suggestion.trim() : ""))
            .filter((value) => value);

        const fixedCode =
            (typeof issue?.fixed_code === "string" && issue.fixed_code.trim()) ||
            (typeof issue?.fixedCode === "string" && issue.fixedCode.trim()) ||
            "";

        const primaryDetail = details[0];
        const primaryRuleId = details.find((detail) => detail.ruleId)?.ruleId || "";
        const primaryMessage = primaryDetail?.message || "";
        const primarySeverity = primaryDetail?.severity || "";
        const primarySeverityLabel = primaryDetail?.severityLabel || "未標示";
        const primarySeverityClass = primaryDetail?.severityClass || "info";
        const primaryEvidence =
            (typeof issue?.evidence === "string" && issue.evidence) || primaryDetail?.evidence || "";

        const columns = columnList;
        const columnPrimary = columns.length ? columns[0] : null;

        return {
            key: `${primaryRuleId || "issue"}-${index}`,
            index: index + 1,
            ruleId: primaryRuleId,
            ruleIds: ruleList.map((value) => (typeof value === "string" ? value.trim() : String(value ?? "").trim())).filter(Boolean),
            severity: primarySeverity,
            severityLabel: primarySeverityLabel,
            severityClass: primarySeverityClass,
            message: primaryMessage,
            objectName,
            line,
            column: columns,
            columnPrimary,
            snippet,
            evidence: primaryEvidence,
            suggestion: suggestionList[0] || "",
            suggestionList,
            fixedCode,
            codeLines,
            details
        };
    });

    if (summaryObject?.by_rule && typeof summaryObject.by_rule === "object") {
        for (const [rule, count] of Object.entries(summaryObject.by_rule)) {
            const key = typeof rule === "string" && rule.trim() ? rule.trim() : "";
            const numeric = Number(count);
            if (!Number.isFinite(numeric)) continue;
            const previous = ruleCounts.get(key) || 0;
            ruleCounts.set(key || "未分類", Math.max(previous, numeric));
        }
    }

    const severityBreakdown = Array.from(severityCounts.entries()).map(([label, count]) => ({
        label,
        count
    }));

    severityBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const ruleBreakdown = Array.from(ruleCounts.entries())
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .map(([label, count]) => ({
            label: label || "未分類",
            count
        }));

    ruleBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const globalSummary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null;
    const combinedSummaryDetails = buildSummaryDetailList(globalSummary, {
        omitKeys: ["sources", "by_rule", "byRule"]
    });
    const sourceSummaries = [];
    if (globalSummary?.sources && typeof globalSummary.sources === "object") {
        for (const [key, value] of Object.entries(globalSummary.sources)) {
            if (!value || typeof value !== "object") continue;
            const keyLower = key.toLowerCase();
            let label = key;
            if (keyLower === "static_analyzer" || keyLower === "staticanalyzer") {
                label = "靜態分析器";
            } else if (keyLower === "dml_prompt" || keyLower === "dmlprompt") {
                label = "DML 提示詞分析";
            }
            const metrics = [];
            if (value.total_issues !== undefined || value.totalIssues !== undefined) {
                const totalValue = Number(value.total_issues ?? value.totalIssues ?? 0);
                metrics.push({ label: "問題數", value: Number.isFinite(totalValue) ? totalValue : 0 });
            }
            if (value.by_rule || value.byRule) {
                const byRuleEntries = Object.entries(value.by_rule || value.byRule || {});
                metrics.push({ label: "規則數", value: byRuleEntries.length });
            }
            if (value.total_segments !== undefined || value.totalSegments !== undefined) {
                const totalSegments = Number(value.total_segments ?? value.totalSegments ?? 0);
                metrics.push({ label: "拆分語句", value: Number.isFinite(totalSegments) ? totalSegments : 0 });
            }
            if (value.analyzed_segments !== undefined || value.analyzedSegments !== undefined) {
                const analysedSegments = Number(value.analyzed_segments ?? value.analyzedSegments ?? 0);
                metrics.push({ label: "已分析段數", value: Number.isFinite(analysedSegments) ? analysedSegments : 0 });
            }
            const status = typeof value.status === "string" ? value.status : "";
            const errorMessage =
                typeof value.error_message === "string"
                    ? value.error_message
                    : typeof value.errorMessage === "string"
                    ? value.errorMessage
                    : "";
            const generatedAt = value.generated_at || value.generatedAt || null;
            sourceSummaries.push({ key, label, metrics, status, errorMessage, generatedAt });
        }
    }

    let dmlDetails = null;
    if (dmlReport && typeof dmlReport === "object") {
        const dmlSummary =
            dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
        const dmlChunks = Array.isArray(dmlReport.chunks) ? dmlReport.chunks : [];
        const dmlSegments = Array.isArray(dmlReport.segments)
            ? dmlReport.segments.map((segment, index) => {
                  const chunk = dmlChunks[index] || null;
                  const sql = typeof segment?.text === "string" ? segment.text : String(segment?.sql || "");
                  const analysisText = typeof chunk?.answer === "string" ? chunk.answer : "";
                  return {
                      key: `${index}-segment`,
                      index: Number.isFinite(Number(segment?.index)) ? Number(segment.index) : index + 1,
                      sql,
                      startLine: Number.isFinite(Number(segment?.startLine)) ? Number(segment.startLine) : null,
                      endLine: Number.isFinite(Number(segment?.endLine)) ? Number(segment.endLine) : null,
                      startColumn: Number.isFinite(Number(segment?.startColumn)) ? Number(segment.startColumn) : null,
                      endColumn: Number.isFinite(Number(segment?.endColumn)) ? Number(segment.endColumn) : null,
                      analysis: analysisText,
                      raw: chunk?.raw || null
                  };
              })
            : [];
        const aggregatedText = typeof dmlReport.report === "string" ? dmlReport.report.trim() : "";
        const errorMessage =
            typeof dmlReport.error === "string"
                ? dmlReport.error
                : typeof dmlSummary?.error_message === "string"
                ? dmlSummary.error_message
                : typeof dmlSummary?.errorMessage === "string"
                ? dmlSummary.errorMessage
                : "";
        const status = typeof dmlSummary?.status === "string" ? dmlSummary.status : "";
        const generatedAt = dmlReport.generatedAt || dmlSummary?.generated_at || dmlSummary?.generatedAt || null;
        const conversationId =
            typeof dmlReport.conversationId === "string" ? dmlReport.conversationId : "";
        dmlDetails = {
            summary: dmlSummary,
            segments: dmlSegments,
            reportText: aggregatedText,
            error: errorMessage,
            status,
            generatedAt,
            conversationId
        };
    }

    return {
        totalIssues: Number.isFinite(total) ? Number(total) : null,
        summary,
        summaryObject,
        summaryText,
        staticSummary: staticSummaryObject,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues: normalisedIssues,
        severityBreakdown,
        ruleBreakdown,
        raw: parsed,
        sourceSummaries,
        combinedSummary: parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null,
        combinedSummaryDetails,
        staticReport,
        dmlReport: dmlDetails
    };
});


const hasStructuredReport = computed(() => Boolean(activeReportDetails.value));
const activeReportSourceText = computed(() => {
    const report = activeReport.value;
    if (!report) return "";
    const text = report.state?.sourceText;
    return typeof text === "string" ? text : "";
});

const activeReportSourceLines = computed(() => {
    const text = activeReportSourceText.value;
    if (!text) {
        return [];
    }
    const normalised = text.replace(/\r\n?/g, "\n").split("\n");
    if (!normalised.length) {
        return [];
    }
    return normalised.map((raw, index) => ({
        number: index + 1,
        raw,
        html: escapeHtml(raw) || "&nbsp;"
    }));
});

const reportIssueLines = computed(() => {
    const details = activeReportDetails.value;
    const sourceLines = activeReportSourceLines.value;
    const issues = Array.isArray(details?.issues) ? details.issues : [];

    let maxLine = sourceLines.length;
    const issuesByLine = new Map();
    const orphanIssues = [];

    for (const issue of issues) {
        const lineNumber = Number(issue?.line);
        if (Number.isFinite(lineNumber) && lineNumber > 0) {
            const key = Math.max(1, Math.floor(lineNumber));
            const bucket = issuesByLine.get(key) || [];
            bucket.push(issue);
            issuesByLine.set(key, bucket);
            if (key > maxLine) {
                maxLine = key;
            }
        } else {
            orphanIssues.push(issue);
        }
    }

    const result = [];

    const ensureLineEntry = (lineNumber) => {
        const index = lineNumber - 1;
        if (index < sourceLines.length) {
            return sourceLines[index];
        }
        return { number: lineNumber, raw: "", html: "&nbsp;" };
    };

    for (let lineNumber = 1; lineNumber <= Math.max(1, maxLine); lineNumber += 1) {
        const baseLine = ensureLineEntry(lineNumber);
        const lineIssues = issuesByLine.get(lineNumber) || [];
        const hasIssue = lineIssues.length > 0;

        result.push({
            key: `code-${lineNumber}`,
            type: "code",
            number: lineNumber,
            displayNumber: String(lineNumber),
            html: baseLine.html,
            hasIssue,
            issues: lineIssues
        });

        if (hasIssue) {
            result.push(buildIssueMetaLine("issues", lineNumber, lineIssues));
            result.push(buildIssueMetaLine("fix", lineNumber, lineIssues));
        }
    }

    if (orphanIssues.length) {
        result.push(buildIssueMetaLine("issues", "orphan", orphanIssues, true));
        result.push(buildIssueMetaLine("fix", "orphan", orphanIssues, true));
    }

    return result;
});

const hasReportIssueLines = computed(() => reportIssueLines.value.length > 0);

const reportIssuesViewMode = ref("code");
const structuredReportViewMode = ref("combined");

const canShowStructuredSummary = computed(() => Boolean(activeReportDetails.value));

const canShowStructuredStatic = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return false;

    if (details.staticReport && typeof details.staticReport === "object") {
        if (Object.keys(details.staticReport).length > 0) {
            return true;
        }
    }

    if (Array.isArray(details.staticSummaryDetails) && details.staticSummaryDetails.length) {
        return true;
    }

    if (Array.isArray(details.staticMetadataDetails) && details.staticMetadataDetails.length) {
        return true;
    }

    if (details.staticSummary) {
        if (typeof details.staticSummary === "string") {
            if (details.staticSummary.trim().length) return true;
        } else if (typeof details.staticSummary === "object") {
            if (Object.keys(details.staticSummary).length) return true;
        }
    }

    if (details.staticMetadata && typeof details.staticMetadata === "object") {
        if (Object.keys(details.staticMetadata).length) {
            return true;
        }
    }

    return false;
});

const canShowStructuredDml = computed(() => {
    const report = activeReportDetails.value?.dmlReport;
    if (!report) return false;

    if (Array.isArray(report.segments) && report.segments.length) {
        return true;
    }

    if (typeof report.reportText === "string" && report.reportText.trim().length) {
        return true;
    }

    if (typeof report.error === "string" && report.error.trim().length) {
        return true;
    }

    if (typeof report.status === "string" && report.status.trim().length) {
        return true;
    }

    if (report.generatedAt) {
        return true;
    }

    return false;
});

const hasStructuredReportToggle = computed(
    () => canShowStructuredSummary.value || canShowStructuredStatic.value || canShowStructuredDml.value
);

const activeReportStaticRawSourceText = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const direct = report.state?.rawReport;
    if (typeof direct === "string" && direct.trim()) {
        return direct;
    }

    const analysisRaw = report.state?.analysis?.rawReport;
    if (typeof analysisRaw === "string" && analysisRaw.trim()) {
        return analysisRaw;
    }

    const analysisOriginal = report.state?.analysis?.originalResult;
    if (typeof analysisOriginal === "string" && analysisOriginal.trim()) {
        return analysisOriginal;
    }

    const staticReportObject = report.state?.analysis?.staticReport;
    if (staticReportObject && typeof staticReportObject === "object") {
        try {
            return JSON.stringify(staticReportObject);
        } catch (error) {
            console.warn("[reports] Failed to stringify static report", error);
        }
    }

    const parsedReport = report.state?.parsedReport;
    if (parsedReport && typeof parsedReport === "object") {
        const reports =
            parsedReport.reports && typeof parsedReport.reports === "object" ? parsedReport.reports : null;
        if (reports) {
            const staticReport = reports.static_analyzer || reports.staticAnalyzer;
            if (staticReport && typeof staticReport === "object") {
                try {
                    return JSON.stringify(staticReport);
                } catch (error) {
                    console.warn("[reports] Failed to stringify parsed static report", error);
                }
            }
        }
    }

    return "";
});

const activeReportDifyRawSourceText = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const difyReport = report.state?.dify?.report;
    if (typeof difyReport === "string" && difyReport.trim()) {
        return difyReport;
    }

    const difyOriginal = report.state?.dify?.originalReport;
    if (typeof difyOriginal === "string" && difyOriginal.trim()) {
        return difyOriginal;
    }

    const difyChunks = report.state?.dify?.chunks;
    if (Array.isArray(difyChunks) && difyChunks.length) {
        try {
            return JSON.stringify(difyChunks);
        } catch (error) {
            console.warn("[reports] Failed to stringify dify chunks", error);
        }
    }

    const analysisDify = report.state?.analysis?.difyReport;
    if (analysisDify && typeof analysisDify === "object") {
        try {
            return JSON.stringify(analysisDify);
        } catch (error) {
            console.warn("[reports] Failed to stringify analysis dify report", error);
        }
    }

    return "";
});

function formatReportRawText(rawText) {
    if (typeof rawText !== "string") return "";
    let candidate = rawText.trim();
    if (!candidate) return "";

    let depth = 0;
    while (depth < 2) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "string") {
                candidate = parsed.trim();
                depth += 1;
                continue;
            }
            return JSON.stringify(parsed, null, 2);
        } catch (error) {
            break;
        }
    }

    return candidate;
}

const activeReportStaticRawText = computed(() => formatReportRawText(activeReportStaticRawSourceText.value));
const activeReportStaticRawValue = computed(() => parseReportRawValue(activeReportStaticRawSourceText.value));
const canExportActiveReportStaticRaw = computed(() => activeReportStaticRawValue.value.success);

const activeReportDifyRawText = computed(() => formatReportRawText(activeReportDifyRawSourceText.value));
const activeReportDifyRawValue = computed(() => parseReportRawValue(activeReportDifyRawSourceText.value));
const canExportActiveReportDifyRaw = computed(() => activeReportDifyRawValue.value.success);

const isExportingReportJsonExcel = ref(false);

const canShowCodeIssues = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    if (report.state?.sourceLoading || report.state?.sourceError) {
        return true;
    }
    return hasReportIssueLines.value;
});

const canShowStaticReportJson = computed(() => activeReportStaticRawText.value.trim().length > 0);
const canShowDifyReportJson = computed(() => activeReportDifyRawText.value.trim().length > 0);

const activeReportDifyErrorMessage = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const direct = typeof report.state?.difyErrorMessage === "string" ? report.state.difyErrorMessage : "";
    if (direct && direct.trim()) {
        return direct.trim();
    }

    const nested = typeof report.state?.analysis?.difyErrorMessage === "string"
        ? report.state.analysis.difyErrorMessage
        : "";
    if (nested && nested.trim()) {
        return nested.trim();
    }

    return "";
});

const shouldShowDifyUnavailableNotice = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    if (!canShowStaticReportJson.value) return false;
    if (canShowDifyReportJson.value) return false;
    return true;
});

const reportDifyUnavailableNotice = computed(() => {
    if (!shouldShowDifyUnavailableNotice.value) return "";
    const detail = activeReportDifyErrorMessage.value;
    if (detail) {
        return `無法連接 Dify 分析：${detail}。目前僅顯示靜態分析器報告。`;
    }
    return "無法連接 Dify 分析，僅顯示靜態分析器報告。";
});

const shouldShowReportIssuesSection = computed(
    () =>
        Boolean(activeReportDetails.value) ||
        canShowStaticReportJson.value ||
        canShowDifyReportJson.value
);

const activeReportIssueCount = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return null;
    if (Number.isFinite(details.totalIssues)) return Number(details.totalIssues);
    const list = Array.isArray(details.issues) ? details.issues : [];
    return list.length;
});

function setReportIssuesViewMode(mode) {
    if (!mode) return;
    if (mode !== "code" && mode !== "static" && mode !== "dify") return;
    if (mode === reportIssuesViewMode.value) return;
    if (mode === "code" && !canShowCodeIssues.value) return;
    if (mode === "static" && !canShowStaticReportJson.value) return;
    if (mode === "dify" && !canShowDifyReportJson.value) return;
    reportIssuesViewMode.value = mode;
}

function setStructuredReportViewMode(mode) {
    if (!mode) return;
    if (mode !== "combined" && mode !== "static" && mode !== "dml") return;
    if (mode === structuredReportViewMode.value) return;
    if (mode === "combined" && !canShowStructuredSummary.value) return;
    if (mode === "static" && !canShowStructuredStatic.value) return;
    if (mode === "dml" && !canShowStructuredDml.value) return;
    structuredReportViewMode.value = mode;
}

function ensureReportIssuesViewMode(preferred) {
    const order = [];
    if (preferred) {
        order.push(preferred);
    }
    order.push("code", "static", "dify");

    for (const mode of order) {
        if (mode === "code" && canShowCodeIssues.value) {
            if (reportIssuesViewMode.value !== "code") {
                reportIssuesViewMode.value = "code";
            }
            return;
        }
        if (mode === "static" && canShowStaticReportJson.value) {
            if (reportIssuesViewMode.value !== "static") {
                reportIssuesViewMode.value = "static";
            }
            return;
        }
        if (mode === "dify" && canShowDifyReportJson.value) {
            if (reportIssuesViewMode.value !== "dify") {
                reportIssuesViewMode.value = "dify";
            }
            return;
        }
    }

    if (reportIssuesViewMode.value !== "code") {
        reportIssuesViewMode.value = "code";
    }
}

function ensureStructuredReportViewMode(preferred) {
    const order = [];
    if (preferred) {
        order.push(preferred);
    }
    order.push("combined", "static", "dml");

    for (const mode of order) {
        if (mode === "combined" && canShowStructuredSummary.value) {
            if (structuredReportViewMode.value !== "combined") {
                structuredReportViewMode.value = "combined";
            }
            return;
        }
        if (mode === "static" && canShowStructuredStatic.value) {
            if (structuredReportViewMode.value !== "static") {
                structuredReportViewMode.value = "static";
            }
            return;
        }
        if (mode === "dml" && canShowStructuredDml.value) {
            if (structuredReportViewMode.value !== "dml") {
                structuredReportViewMode.value = "dml";
            }
            return;
        }
    }

    if (structuredReportViewMode.value !== "combined") {
        structuredReportViewMode.value = "combined";
    }
}

watch(activeReport, (report) => {
    if (!report) {
        reportIssuesViewMode.value = "code";
        structuredReportViewMode.value = "combined";
        return;
    }
    ensureReportIssuesViewMode("code");
    ensureStructuredReportViewMode("combined");
});

watch(
    [canShowCodeIssues, canShowStaticReportJson, canShowDifyReportJson],
    () => {
        ensureReportIssuesViewMode(reportIssuesViewMode.value);
    },
    { immediate: true }
);

watch(
    [canShowStructuredSummary, canShowStructuredStatic, canShowStructuredDml],
    () => {
        ensureStructuredReportViewMode(structuredReportViewMode.value);
    },
    { immediate: true }
);

function getReportJsonValueForMode(mode) {
    if (mode === "dify") {
        return activeReportDifyRawValue.value;
    }
    return activeReportStaticRawValue.value;
}

function getReportJsonLabel(mode) {
    if (mode === "dify") {
        return "Dify JSON";
    }
    return "靜態分析器 JSON";
}

async function exportActiveReportJsonToExcel(mode) {
    if (isExportingReportJsonExcel.value) return;
    const raw = getReportJsonValueForMode(mode);
    if (!raw.success) {
        const label = getReportJsonLabel(mode);
        alert(`${label} 不是有效的 JSON 格式，無法匯出 Excel。`);
        return;
    }

    try {
        isExportingReportJsonExcel.value = true;
        const worksheet = buildWorksheetFromValue(raw.value);
        const blob = await createExcelBlobFromWorksheet(worksheet);
        const fileName = buildActiveReportExcelFileName(mode);
        triggerBlobDownload(blob, fileName);
    } catch (error) {
        console.error("[reports] Failed to export report JSON to Excel", error);
        const message = error?.message || String(error);
        alert(`匯出 Excel 失敗：${message}`);
    } finally {
        isExportingReportJsonExcel.value = false;
    }
}

function parseReportRawValue(rawText) {
    if (typeof rawText !== "string") {
        return { success: false, value: null };
    }
    let candidate = rawText.trim();
    if (!candidate) {
        return { success: false, value: null };
    }

    const maxDepth = 3;
    for (let depth = 0; depth < maxDepth; depth += 1) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "string") {
                const trimmed = parsed.trim();
                if (trimmed && trimmed !== candidate && /^[\[{]/.test(trimmed)) {
                    candidate = trimmed;
                    continue;
                }
                return { success: true, value: parsed };
            }
            return { success: true, value: parsed };
        } catch (error) {
            break;
        }
    }

    return { success: false, value: null };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildWorksheetFromValue(value) {
    const hierarchical = buildHierarchicalWorksheet(value);
    if (hierarchical) {
        return hierarchical;
    }

    const categorized = buildCategorizedWorksheet(value);
    if (categorized) {
        return categorized;
    }

    const rows = buildGenericWorksheetRows(value);
    return { rows, merges: [] };
}

function buildSummaryDetailList(source, options = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        return [];
    }

    const omit = new Set(options.omitKeys || []);
    const details = [];

    for (const [key, rawValue] of Object.entries(source)) {
        if (omit.has(key)) continue;
        if (rawValue === null || rawValue === undefined) continue;
        if (typeof rawValue === "object") continue;

        let value;
        if (typeof rawValue === "boolean") {
            value = rawValue ? "是" : "否";
        } else {
            value = String(rawValue);
        }

        const label = typeof key === "string" && key.trim() ? key : "-";
        details.push({ label, value });
    }

    return details;
}

function buildHierarchicalWorksheet(value) {
    if (!isPlainObject(value) && !Array.isArray(value)) {
        return null;
    }

    const rootChildren = createTreeChildren(value);
    if (rootChildren.length === 0) {
        return null;
    }

    const root = { label: null, value: undefined, children: rootChildren };
    assignTreeDepth(root, -1);
    computeTreeRowSpan(root);
    assignTreeStartRow(root, 1);

    const leafRecords = [];
    collectTreeLeafRows(root, [], leafRecords);
    if (leafRecords.length === 0) {
        return null;
    }

    const maxLabelCount = leafRecords.reduce(
        (max, record) => Math.max(max, record.labels.length),
        0
    );
    const totalColumns = maxLabelCount + 1;

    const rows = leafRecords.map((record) => {
        const cells = new Array(totalColumns);
        for (let index = 0; index < totalColumns; index += 1) {
            cells[index] = createSheetCell(null);
        }

        record.labels.forEach((label, index) => {
            cells[index] = createSheetCell(label, { forceString: true });
        });

        const valueColumnIndex = record.labels.length;
        cells[valueColumnIndex] = createSheetCell(record.value);

        return cells;
    });

    const merges = [];
    collectTreeMerges(root, merges);

    return { rows, merges };
}

function createTreeChildren(value) {
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) {
            return [];
        }
        return entries.map(([key, childValue]) => createTreeNode(key, childValue));
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [];
        }
        return value.map((item, index) => createTreeNode(deduceArrayItemLabel(item, index), item));
    }

    return [];
}

function createTreeNode(label, value) {
    if (isPlainObject(value)) {
        const children = createTreeChildren(value);
        if (children.length === 0) {
            return { label, value: "", children: [] };
        }
        return { label, value: undefined, children };
    }

    if (Array.isArray(value)) {
        const children = createTreeChildren(value);
        if (children.length === 0) {
            return { label, value: "", children: [] };
        }
        return { label, value: undefined, children };
    }

    return { label, value, children: [] };
}

function deduceArrayItemLabel(item, index) {
    if (isPlainObject(item)) {
        const candidateKeys = ["name", "label", "key", "id", "title"];
        for (const key of candidateKeys) {
            const value = item[key];
            if (typeof value === "string" && value.trim()) {
                return value;
            }
            if (typeof value === "number" && Number.isFinite(value)) {
                return String(value);
            }
        }
    }

    return `[${index}]`;
}

function assignTreeDepth(node, depth) {
    node.depth = depth;
    if (!node.children || node.children.length === 0) {
        return;
    }

    const nextDepth = depth + 1;
    node.children.forEach((child) => assignTreeDepth(child, nextDepth));
}

function computeTreeRowSpan(node) {
    if (!node.children || node.children.length === 0) {
        node.rowSpan = 1;
        return 1;
    }

    let total = 0;
    node.children.forEach((child) => {
        total += computeTreeRowSpan(child);
    });

    node.rowSpan = Math.max(total, 1);
    return node.rowSpan;
}

function assignTreeStartRow(node, startRow) {
    node.startRow = startRow;
    if (!node.children || node.children.length === 0) {
        return;
    }

    let cursor = startRow;
    node.children.forEach((child) => {
        assignTreeStartRow(child, cursor);
        cursor += child.rowSpan;
    });
}

function collectTreeLeafRows(node, path, rows) {
    const nextPath = node.label !== null && node.label !== undefined ? [...path, node] : path;

    if (!node.children || node.children.length === 0) {
        const labels = nextPath
            .filter((entry) => entry.label !== null && entry.label !== undefined)
            .map((entry) => entry.label);
        rows.push({ labels, value: node.value });
        return;
    }

    node.children.forEach((child) => {
        collectTreeLeafRows(child, nextPath, rows);
    });
}

function collectTreeMerges(node, merges) {
    if (node.label !== null && node.label !== undefined && node.rowSpan > 1 && node.depth >= 0) {
        merges.push({
            startRow: node.startRow,
            endRow: node.startRow + node.rowSpan - 1,
            startColumn: node.depth,
            endColumn: node.depth
        });
    }

    if (!node.children || node.children.length === 0) {
        return;
    }

    node.children.forEach((child) => collectTreeMerges(child, merges));
}

function buildCategorizedWorksheet(value) {
    const fromMap = buildCategorizedWorksheetFromMap(value);
    if (fromMap) {
        return fromMap;
    }

    const fromArray = buildCategorizedWorksheetFromArray(value);
    if (fromArray) {
        return fromArray;
    }

    return null;
}

function buildCategorizedWorksheetFromMap(value) {
    if (!isPlainObject(value)) {
        return null;
    }

    const categoryEntries = Object.entries(value);
    if (categoryEntries.length === 0) {
        return null;
    }

    const normalized = categoryEntries.map(([categoryName, entries]) => ({
        categoryName,
        entries: Array.isArray(entries) ? entries.filter((item) => isPlainObject(item)) : []
    }));

    if (normalized.every(({ entries }) => entries.length === 0)) {
        return null;
    }

    const columnKeys = [];
    const seen = new Set();
    for (const { entries } of normalized) {
        for (const item of entries) {
            for (const key of Object.keys(item)) {
                if (!seen.has(key)) {
                    seen.add(key);
                    columnKeys.push(key);
                }
            }
        }
    }

    if (columnKeys.length === 0) {
        return null;
    }

    const rows = [
        [createSheetCell("分類", { forceString: true }), ...columnKeys.map((key) => createSheetCell(key, { forceString: true }))]
    ];
    const merges = [];
    let rowCursor = 2;

    for (const { categoryName, entries } of normalized) {
        const safeEntries = entries.length > 0 ? entries : [{}];
        const rowCount = safeEntries.length;

        safeEntries.forEach((item, index) => {
            const firstCell = index === 0 ? createSheetCell(categoryName, { forceString: true }) : createSheetCell(null);
            const rowCells = [firstCell];
            for (const key of columnKeys) {
                rowCells.push(createSheetCell(item[key]));
            }
            rows.push(rowCells);
        });

        if (rowCount > 1) {
            merges.push({ startRow: rowCursor, endRow: rowCursor + rowCount - 1, startColumn: 0, endColumn: 0 });
        }
        rowCursor += rowCount;
    }

    return { rows, merges };
}

function buildCategorizedWorksheetFromArray(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }

    const items = value.filter((item) => isPlainObject(item));
    if (items.length === 0) {
        return null;
    }

    const categoryKey = findCategoryKey(items);
    if (!categoryKey) {
        return null;
    }

    const columnKeys = [];
    const seen = new Set();
    for (const item of items) {
        for (const key of Object.keys(item)) {
            if (key === categoryKey) continue;
            if (!seen.has(key)) {
                seen.add(key);
                columnKeys.push(key);
            }
        }
    }

    if (columnKeys.length === 0) {
        return null;
    }

    const groups = [];
    const groupMap = new Map();
    for (const item of items) {
        const label = formatCategoryLabel(item[categoryKey]);
        if (!groupMap.has(label)) {
            const container = { label, rows: [] };
            groupMap.set(label, container);
            groups.push(container);
        }
        groupMap.get(label).rows.push(item);
    }

    const rows = [
        [createSheetCell("分類", { forceString: true }), ...columnKeys.map((key) => createSheetCell(key, { forceString: true }))]
    ];
    const merges = [];
    let rowCursor = 2;

    for (const { label, rows: groupRows } of groups) {
        const rowCount = groupRows.length;
        groupRows.forEach((item, index) => {
            const firstCell = index === 0 ? createSheetCell(label, { forceString: true }) : createSheetCell(null);
            const rowCells = [firstCell];
            for (const key of columnKeys) {
                rowCells.push(createSheetCell(item[key]));
            }
            rows.push(rowCells);
        });

        if (rowCount > 1) {
            merges.push({ startRow: rowCursor, endRow: rowCursor + rowCount - 1, startColumn: 0, endColumn: 0 });
        }
        rowCursor += rowCount;
    }

    return { rows, merges };
}

function findCategoryKey(items) {
    const keyInfo = new Map();
    const priorityPattern = /(category|分類|分類別|類別|類型|类型|group|分組|分组|module|模組|模块|section|type)/iu;

    for (const item of items) {
        for (const key of Object.keys(item)) {
            const value = item[key];
            if (value === undefined) {
                continue;
            }
            let info = keyInfo.get(key);
            if (!info) {
                info = {
                    values: new Set(),
                    total: 0,
                    stringLike: 0,
                    priority: priorityPattern.test(key) ? 1 : 0
                };
                keyInfo.set(key, info);
            }
            info.total += 1;
            if (typeof value === "string" || typeof value === "number") {
                info.stringLike += 1;
                info.values.add(String(value));
            } else if (value === null) {
                info.stringLike += 1;
                info.values.add("");
            } else {
                info.priority = -Infinity;
            }
        }
    }

    const candidates = [];
    keyInfo.forEach((info, key) => {
        if (info.priority === -Infinity) return;
        if (info.stringLike === 0) return;
        if (info.values.size === info.total) return;
        candidates.push({ key, priority: info.priority, diversity: info.values.size });
    });

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }
        return a.diversity - b.diversity;
    });

    return candidates[0].key;
}

function formatCategoryLabel(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function buildGenericWorksheetRows(value) {
    if (Array.isArray(value)) {
        const rows = [];
        const allPlainObjects = value.every((item) => isPlainObject(item));
        if (allPlainObjects && value.length > 0) {
            const keySet = new Set();
            for (const item of value) {
                for (const key of Object.keys(item)) {
                    keySet.add(key);
                }
            }
            const headers = keySet.size > 0 ? Array.from(keySet) : [];
            if (headers.length > 0) {
                rows.push(headers.map((key) => createSheetCell(key, { forceString: true })));
                for (const item of value) {
                    rows.push(headers.map((key) => createSheetCell(item[key])));
                }
                return rows;
            }
        }

        const header = [createSheetCell("index", { forceString: true }), createSheetCell("value", { forceString: true })];
        rows.push(header);
        if (value.length > 0) {
            value.forEach((item, index) => {
                rows.push([createSheetCell(index), createSheetCell(item)]);
            });
        }
        return rows;
    }

    if (isPlainObject(value)) {
        const rows = [
            [createSheetCell("key", { forceString: true }), createSheetCell("value", { forceString: true })]
        ];
        const entries = Object.entries(value);
        if (entries.length > 0) {
            for (const [key, entryValue] of entries) {
                rows.push([createSheetCell(key, { forceString: true }), createSheetCell(entryValue)]);
            }
        }
        return rows;
    }

    return [
        [createSheetCell("value", { forceString: true })],
        [createSheetCell(value)]
    ];
}

function createSheetCell(value, { forceString = false } = {}) {
    if (forceString) {
        return { type: "string", text: value === null || value === undefined ? "" : String(value) };
    }
    if (value === null || value === undefined) {
        return { type: "empty", text: "" };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return { type: "number", text: String(value) };
    }
    if (typeof value === "boolean") {
        return { type: "boolean", text: value ? "1" : "0" };
    }
    if (value instanceof Date) {
        return { type: "string", text: value.toISOString() };
    }
    if (typeof value === "string") {
        return { type: "string", text: value };
    }
    try {
        return { type: "string", text: JSON.stringify(value) };
    } catch (error) {
        return { type: "string", text: String(value) };
    }
}

async function createExcelBlobFromWorksheet(worksheet) {
    const sheetXml = buildSheetXml(worksheet.rows, worksheet.merges);

    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
    zip.folder("_rels").file(".rels", ROOT_RELS_XML);
    const xlFolder = zip.folder("xl");
    xlFolder.file("workbook.xml", WORKBOOK_XML);
    xlFolder.file("styles.xml", STYLES_XML);
    xlFolder.folder("_rels").file("workbook.xml.rels", WORKBOOK_RELS_XML);
    xlFolder.folder("worksheets").file("sheet1.xml", sheetXml);

    return zip.generateAsync({ type: "blob" });
}

const MIN_COLUMN_WIDTH = 6;
const MAX_COLUMN_WIDTH = 80;
const COLUMN_WIDTH_PADDING = 2;

function buildSheetXml(rows, merges = []) {
    const rowXml = [];
    let maxColumnCount = 0;
    const columnWidths = [];

    rows.forEach((cells, rowIndex) => {
        if (!Array.isArray(cells) || cells.length === 0) {
            return;
        }
        const cellXml = cells
            .map((cell, cellIndex) => {
                if (!cell) return "";
                const column = columnLetter(cellIndex);
                const cellRef = `${column}${rowIndex + 1}`;
                const cellWidth = deduceCellWidth(cell);
                if (cellWidth > (columnWidths[cellIndex] ?? 0)) {
                    columnWidths[cellIndex] = cellWidth;
                }
                switch (cell.type) {
                    case "number":
                        return `<c r="${cellRef}"><v>${cell.text}</v></c>`;
                    case "boolean":
                        return `<c r="${cellRef}" t="b"><v>${cell.text}</v></c>`;
                    case "string": {
                        const needsPreserve = /(^\s)|([\s]$)|([\r\n])/u.test(cell.text);
                        const preserveAttr = needsPreserve ? ' xml:space="preserve"' : "";
                        return `<c r="${cellRef}" t="inlineStr"><is><t${preserveAttr}>${escapeXml(
                            cell.text
                        )}</t></is></c>`;
                    }
                    default:
                        return `<c r="${cellRef}"/>`;
                }
            })
            .join("");

        rowXml.push(`<row r="${rowIndex + 1}">${cellXml}</row>`);
        if (cells.length > maxColumnCount) {
            maxColumnCount = cells.length;
        }
    });

    if (maxColumnCount > 0) {
        for (let index = 0; index < maxColumnCount; index += 1) {
            if (columnWidths[index] === undefined) {
                columnWidths[index] = 0;
            }
        }
    }

    const colsXml =
        columnWidths.length > 0
            ? `<cols>${columnWidths
                  .map((width, index) => {
                      const adjusted = Math.min(
                          MAX_COLUMN_WIDTH,
                          Math.max(MIN_COLUMN_WIDTH, Math.ceil(width + COLUMN_WIDTH_PADDING))
                      );
                      return `<col min="${index + 1}" max="${index + 1}" width="${adjusted}" customWidth="1"/>`;
                  })
                  .join("")}</cols>`
            : "";

    const dimension =
        rows.length > 0 && maxColumnCount > 0
            ? `<dimension ref="A1:${columnLetter(maxColumnCount - 1)}${rows.length}"/>`
            : "";

    const mergeXml =
        Array.isArray(merges) && merges.length > 0
            ? `<mergeCells count="${merges.length}">${merges
                  .map(({ startRow, endRow, startColumn, endColumn }) => {
                      const startCell = `${columnLetter(startColumn)}${startRow}`;
                      const endCell = `${columnLetter(endColumn ?? startColumn)}${endRow ?? startRow}`;
                      return `<mergeCell ref="${startCell}:${endCell}"/>`;
                  })
                  .join("")}</mergeCells>`
            : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}${colsXml}<sheetData>${rowXml.join(
        ""
    )}</sheetData>${mergeXml}</worksheet>`;
}

function columnLetter(index) {
    let result = "";
    let current = index;
    while (current >= 0) {
        result = String.fromCharCode((current % 26) + 65) + result;
        current = Math.floor(current / 26) - 1;
    }
    return result || "A";
}

function deduceCellWidth(cell) {
    if (!cell || typeof cell.text !== "string") {
        if (cell?.type === "number" || cell?.type === "boolean") {
            return String(cell.text ?? "").length;
        }
        return 0;
    }
    if (!cell.text) {
        return 0;
    }
    return cell.text
        .split(/\r?\n/)
        .reduce((max, line) => Math.max(max, line.length), 0);
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function triggerBlobDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function buildActiveReportExcelFileName(mode = "raw") {
    const report = activeReport.value;
    const parts = [];
    if (report?.project?.name) {
        parts.push(report.project.name);
    }
    if (report?.path) {
        const segments = report.path.split(/[/\\]+/);
        const last = segments[segments.length - 1];
        if (last) {
            parts.push(last);
        }
    }
    const base = parts.join("_") || "report";
    const safe = base.replace(/[\\/:*?"<>|]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    const finalName = safe || "report";

    let suffix = "raw";
    if (mode === "static") {
        suffix = "static";
    } else if (mode === "dify") {
        suffix = "dify";
    }

    return `${finalName}_${suffix}.xlsx`;
}

const CONTENT_TYPES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";

const ROOT_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

const WORKBOOK_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>' +
    "</workbook>";

const WORKBOOK_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";

const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font/></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/>' +
    '<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>' +
    "</styleSheet>";

const middlePaneStyle = computed(() => {
    const hasActiveTool = isProjectToolActive.value || isReportToolActive.value;
    const width = hasActiveTool ? middlePaneWidth.value : 0;
    return {
        flex: `0 0 ${width}px`,
        width: `${width}px`
    };
});

const chatWindowStyle = computed(() => ({
    width: `${chatWindowState.width}px`,
    height: `${chatWindowState.height}px`,
    left: `${chatWindowState.x}px`,
    top: `${chatWindowState.y}px`
}));

const isChatToggleDisabled = computed(() => isChatLocked.value && !isChatWindowOpen.value);

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildIssueMetaLine(type, keySource, issues, isOrphan = false) {
    const label = type === "fix" ? "Fix" : "Issues";
    const keySuffix = typeof keySource === "number" ? keySource : String(keySource || type);
    const html = type === "fix"
        ? buildIssueFixHtml(issues)
        : buildIssueDetailsHtml(issues, isOrphan);
    return {
        key: `${type}-${keySuffix}`,
        type,
        number: typeof keySource === "number" ? keySource : null,
        displayNumber: "",
        iconLabel: label,
        html: html || "&nbsp;",
        hasIssue: true,
        issues,
        isMeta: true,
        isOrphan: Boolean(isOrphan)
    };
}

function buildIssueDetailsHtml(issues, isOrphan = false) {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    const rows = [];

    issues.forEach((issue) => {
        const details = Array.isArray(issue?.details) && issue.details.length ? issue.details : [issue];
        details.forEach((detail, detailIndex) => {
            const lineIndex = Number(detail?.index ?? detailIndex + 1);
            const badges = [];
            if (Number.isFinite(lineIndex)) {
                badges.push(`<span class="reportIssueInlineIndex">#${lineIndex}</span>`);
            }
            if (detail?.ruleId) {
                badges.push(`<span class="reportIssueInlineRule">${escapeHtml(detail.ruleId)}</span>`);
            }
            if (detail?.severityLabel) {
                const severityClass = detail.severityClass || "info";
                badges.push(
                    `<span class="reportIssueInlineSeverity reportIssueInlineSeverity--${severityClass}">${escapeHtml(
                        detail.severityLabel
                    )}</span>`
                );
            }
            if (isOrphan && Number.isFinite(issue?.line)) {
                badges.push(`<span class="reportIssueInlineLine">Line ${escapeHtml(String(issue.line))}</span>`);
            }

            const badgeBlock = badges.length
                ? `<span class="reportIssueInlineBadges">${badges.join(" ")}</span>`
                : "";

            const messageText =
                typeof detail?.message === "string" && detail.message.trim()
                    ? detail.message.trim()
                    : typeof issue?.message === "string" && issue.message.trim()
                      ? issue.message.trim()
                      : "未提供說明";
            const message = `<span class="reportIssueInlineMessage">${escapeHtml(messageText)}</span>`;

            const metaParts = [];
            if (issue?.objectName) {
                metaParts.push(`<span class="reportIssueInlineObject">${escapeHtml(issue.objectName)}</span>`);
            }
            if (Number.isFinite(detail?.column)) {
                metaParts.push(`<span class="reportIssueInlineColumn">列 ${escapeHtml(String(detail.column))}</span>`);
            }
            const meta = metaParts.length
                ? `<span class="reportIssueInlineMeta">${metaParts.join(" · ")}</span>`
                : "";

            rows.push(`<div class="reportIssueInlineRow">${badgeBlock}${message}${meta}</div>`);
        });
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    return rows.join("");
}

function buildIssueFixHtml(issues) {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    const rows = [];
    const suggestionSet = new Set();
    const suggestionQueue = [];
    const fixedCodeSet = new Set();
    const fixedCodeQueue = [];

    const pushSuggestion = (value) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed || suggestionSet.has(trimmed)) return;
        suggestionSet.add(trimmed);
        suggestionQueue.push(trimmed);
    };

    issues.forEach((issue) => {
        const details = Array.isArray(issue?.details) && issue.details.length ? issue.details : [];
        details.forEach((detail) => {
            if (typeof detail?.suggestion === "string") {
                pushSuggestion(detail.suggestion);
            }
        });

        const suggestionList = Array.isArray(issue?.suggestionList) ? issue.suggestionList : [];
        suggestionList.forEach((item) => {
            if (typeof item === "string") {
                pushSuggestion(item);
            }
        });

        if (typeof issue?.suggestion === "string") {
            pushSuggestion(issue.suggestion);
        }

        const fixedCode = typeof issue?.fixedCode === "string" ? issue.fixedCode.trim() : "";
        if (fixedCode && !fixedCodeSet.has(fixedCode)) {
            fixedCodeSet.add(fixedCode);
            fixedCodeQueue.push(fixedCode);
        }
    });

    suggestionQueue.forEach((text) => {
        rows.push(`<div class="reportIssueInlineRow">${escapeHtml(text)}</div>`);
    });

    fixedCodeQueue.forEach((code) => {
        rows.push(
            `<pre class="reportIssueInlineRow reportIssueInlineCode"><code>${escapeHtml(code)}</code></pre>`
        );
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    return rows.join("");
}

function renderLineContent(line) {
    const rawText = typeof line?.raw === "string" ? line.raw : (line?.content || "").replace(/ /g, " ");
    const selection = codeSelection.value;
    const safe = escapeHtml(rawText);

    if (!selection || !selection.startLine || !selection.endLine || !Number.isFinite(line?.number)) {
        return safe.length ? safe : "&nbsp;";
    }

    const lineNumber = line.number;
    if (lineNumber < selection.startLine || lineNumber > selection.endLine) {
        return safe.length ? safe : "&nbsp;";
    }

    const plain = rawText;
    const lineLength = plain.length;
    const startIndex = lineNumber === selection.startLine ? Math.max(0, (selection.startColumn ?? 1) - 1) : 0;
    const endIndex = lineNumber === selection.endLine
        ? Math.min(lineLength, selection.endColumn ?? lineLength)
        : lineLength;

    const safeBefore = escapeHtml(plain.slice(0, startIndex));
    const highlightEnd = Math.max(startIndex, endIndex);
    const middleRaw = plain.slice(startIndex, highlightEnd);
    const safeMiddle = escapeHtml(middleRaw);
    const safeAfter = escapeHtml(plain.slice(highlightEnd));

    const highlighted = `<span class="codeSelectionHighlight">${safeMiddle.length ? safeMiddle : "&nbsp;"}</span>`;
    const combined = `${safeBefore}${highlighted}${safeAfter}`;
    return combined.length ? combined : "&nbsp;";
}

function clearCodeSelection() {
    if (codeSelection.value) {
        codeSelection.value = null;
    }
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function isWithinCodeLine(target) {
    const root = codeScrollRef.value;
    if (!root || !target) return false;

    let current = target;
    while (current && current !== root) {
        if (current.classList && (current.classList.contains("codeLine") || current.classList.contains("codeLineContent") || current.classList.contains("codeLineNo"))) {
            return true;
        }
        current = current.parentNode;
    }

    return false;
}

function resolveLineInfo(node) {
    if (!node) return null;
    let current = node.nodeType === 3 ? node.parentElement : node;
    while (current && current !== codeScrollRef.value) {
        if (current.classList && current.classList.contains("codeLine")) {
            const lineNumber = Number.parseInt(current.dataset?.line || "", 10);
            const contentEl = current.querySelector(".codeLineContent");
            return {
                lineEl: current,
                contentEl,
                lineNumber: Number.isFinite(lineNumber) ? lineNumber : null
            };
        }
        current = current.parentElement;
    }
    return null;
}

function normaliseSelectionRangeText(range) {
    return range
        .toString()
        .replace(/\u00A0/g, " ")
        .replace(/\r\n|\r/g, "\n");
}

function measureColumn(lineInfo, container, offset, mode) {
    if (!lineInfo?.contentEl || typeof document === "undefined") return null;
    const targetContainer = container?.nodeType === 3 ? container : container;
    if (!lineInfo.contentEl.contains(targetContainer)) {
        if (mode === "end") {
            const fullRange = document.createRange();
            fullRange.selectNodeContents(lineInfo.contentEl);
            return normaliseSelectionRangeText(fullRange).length || null;
        }
        return 1;
    }
    const range = document.createRange();
    range.selectNodeContents(lineInfo.contentEl);
    try {
        range.setEnd(container, offset);
    } catch (error) {
        return null;
    }
    const length = normaliseSelectionRangeText(range).length;
    if (mode === "start") {
        return Math.max(1, length + 1);
    }
    return Math.max(1, length);
}

function buildSelectedSnippet() {
    if (typeof window === "undefined") return null;
    const root = codeScrollRef.value;
    if (!root) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return null;
    }

    const rawText = normaliseSelectionRangeText(range);
    if (!rawText.trim()) return null;

    const startInfo = resolveLineInfo(range.startContainer);
    const endInfo = resolveLineInfo(range.endContainer);
    if (!startInfo || !endInfo) return null;

    const startLine = startInfo.lineNumber;
    const endLine = endInfo.lineNumber;
    const startColumn = measureColumn(startInfo, range.startContainer, range.startOffset, "start");
    const endColumn = measureColumn(endInfo, range.endContainer, range.endOffset, "end");
    const lineCount = startLine !== null && endLine !== null ? endLine - startLine + 1 : null;

    const path = previewing.value.path || treeStore.activeTreePath.value || "";
    const name = previewing.value.name || path || "選取片段";

    const snippet = {
        path,
        name,
        label: name,
        startLine,
        endLine,
        startColumn,
        endColumn,
        lineCount,
        text: rawText
    };

    codeSelection.value = snippet;
    shouldClearAfterPointerClick = false;
    return snippet;
}

function handleDocumentSelectionChange() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (previewing.value.kind !== "text") return;
    const root = codeScrollRef.value;
    if (!root) return;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    if (selection.isCollapsed) {
        return;
    }

    const snippet = buildSelectedSnippet();
    if (!snippet) {
        clearCodeSelection();
    }
}

function handleDocumentPointerUp(event) {
    const root = codeScrollRef.value;
    if (!root) {
        pointerDownInCode = false;
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
        return;
    }

    const target = event?.target || null;
    const pointerUpInside = target ? root.contains(target) : false;

    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    const selectionInCode =
        !!selection &&
        selection.rangeCount > 0 &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode);
    const hasActiveSelection = !!selectionInCode && selection && !selection.isCollapsed;

    if (hasActiveSelection) {
        // Ensure the most recent drag selection is captured even if the
        // browser collapses the native selection highlight after mouseup.
        const snippet = buildSelectedSnippet();
        if (!snippet && codeSelection.value) {
            // Re-emit the existing selection so the custom highlight remains
            // visible when the document selection collapses immediately.
            codeSelection.value = { ...codeSelection.value };
        }
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
    } else if (pointerDownInCode && pointerUpInside && shouldClearAfterPointerClick) {
        clearCodeSelection();
    } else if (lastPointerDownWasOutsideCode && !pointerUpInside) {
        // Preserve the current highlight when the interaction happens completely outside the editor
        // by re-emitting the stored selection so Vue keeps the custom highlight rendered.
        if (codeSelection.value) {
            codeSelection.value = { ...codeSelection.value };
        }
    }

    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function handleCodeScrollPointerDown(event) {
    if (event.button !== 0) return;
    if (previewing.value.kind !== "text") return;
    const target = event?.target || null;
    const withinLine = isWithinCodeLine(target);
    pointerDownInCode = withinLine;
    shouldClearAfterPointerClick = withinLine && !!codeSelection.value;
    lastPointerDownWasOutsideCode = !withinLine;
}

function handleDocumentPointerDown(event) {
    const root = codeScrollRef.value;
    if (!root) return;
    const target = event?.target || null;
    const pointerDownInside = target ? root.contains(target) : false;
    if (pointerDownInside) {
        lastPointerDownWasOutsideCode = false;
        return;
    }

    lastPointerDownWasOutsideCode = true;
    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;

    if (codeSelection.value) {
        // Touching other panes should not discard the stored snippet, so keep the
        // highlight alive by nudging Vue's reactivity system.
        codeSelection.value = { ...codeSelection.value };
    }
}

let wrapMeasureFrame = null;
let codeScrollResizeObserver = null;

function runLineWrapMeasurement() {
    if (!showCodeLineNumbers.value) {
        showCodeLineNumbers.value = true;
    }
}

function scheduleLineWrapMeasurement() {
    if (typeof window === "undefined") return;
    if (wrapMeasureFrame !== null) {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    wrapMeasureFrame = window.requestAnimationFrame(() => {
        wrapMeasureFrame = null;
        runLineWrapMeasurement();
    });
}

watch(isChatWindowOpen, (visible) => {
    if (visible) {
        openAssistantSession();
        const shouldForce = connection.value.status === "error";
        retryHandshake({ force: shouldForce });
        if (!hasInitializedChatWindow.value) {
            chatWindowState.width = 420;
            chatWindowState.height = 520;
            chatWindowState.x = Math.max(20, window.innerWidth - chatWindowState.width - 40);
            chatWindowState.y = 80;
            hasInitializedChatWindow.value = true;
        } else {
            ensureChatWindowInView();
        }
        nextTick(() => {
            ensureChatWindowInView();
        });
    } else {
        closeAssistantSession();
    }
});

watch(
    () => previewing.value.kind,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => previewing.value.text,
    () => {
        scheduleLineWrapMeasurement();
    },
    { flush: "post" }
);

watch(
    () => previewLineItems.value.length,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => codeScrollRef.value,
    (next, prev) => {
        if (codeScrollResizeObserver && prev) {
            codeScrollResizeObserver.unobserve(prev);
        }
        if (codeScrollResizeObserver && next) {
            codeScrollResizeObserver.observe(next);
        }
        scheduleLineWrapMeasurement();
    }
);

onMounted(() => {
    if (typeof window !== "undefined" && "ResizeObserver" in window) {
        codeScrollResizeObserver = new window.ResizeObserver(() => {
            scheduleLineWrapMeasurement();
        });
        if (codeScrollRef.value) {
            codeScrollResizeObserver.observe(codeScrollRef.value);
        }
    }
    scheduleLineWrapMeasurement();
});

onBeforeUnmount(() => {
    if (wrapMeasureFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    if (codeScrollResizeObserver) {
        if (codeScrollRef.value) {
            codeScrollResizeObserver.unobserve(codeScrollRef.value);
        }
        if (typeof codeScrollResizeObserver.disconnect === "function") {
            codeScrollResizeObserver.disconnect();
        }
        codeScrollResizeObserver = null;
    }
});

watch(
    () => previewing.value.kind,
    (kind) => {
        if (kind !== "text") {
            clearCodeSelection();
        }
    }
);

watch(
    () => previewing.value.path,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreePath.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreeRevision.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => previewing.value.text,
    () => {
        if (previewing.value.kind === "text") {
            clearCodeSelection();
        }
    }
);

async function ensureActiveProject() {
    const list = Array.isArray(projects.value) ? projects.value : [];
    if (!list.length) return;

    const selectedIdValue = selectedProjectId.value;
    if (!selectedIdValue) {
        return;
    }

    const current = list.find((project) => project.id === selectedIdValue);
    if (!current) {
        selectedProjectId.value = null;
        return;
    }

    if (!tree.value.length && !isLoadingTree.value) {
        isTreeCollapsed.value = false;
        await openProject(current);
    }
}

watch(
    [projects, selectedProjectId],
    async () => {
        await ensureActiveProject();
    },
    { immediate: true }
);

watch(selectedProjectId, (projectId) => {
    if (projectId === null || projectId === undefined) {
        isTreeCollapsed.value = false;
    }
});

function handleSelectProject(project) {
    if (!project) return;
    const currentId = selectedProjectId.value;
    const treeHasNodes = Array.isArray(tree.value) && tree.value.length > 0;
    if (currentId === project.id) {
        if (isTreeCollapsed.value) {
            isTreeCollapsed.value = false;
            if (!treeHasNodes && !isLoadingTree.value) {
                openProject(project);
            }
        } else {
            if (!isLoadingTree.value && !treeHasNodes) {
                openProject(project);
            } else {
                isTreeCollapsed.value = true;
            }
        }
        return;
    }
    isTreeCollapsed.value = false;
    openProject(project);
}

function toggleProjectTool() {
    if (isProjectToolActive.value) return;
    activeRailTool.value = "projects";
}

function toggleReportTool() {
    if (isReportToolActive.value) return;
    activeRailTool.value = "reports";
}

function normaliseProjectId(projectId) {
    if (projectId === null || projectId === undefined) return "";
    return String(projectId);
}

function toReportKey(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return "";
    return `${projectKey}::${path}`;
}

function parseReportKey(key) {
    if (!key) return { projectId: "", path: "" };
    const index = key.indexOf("::");
    if (index === -1) {
        return { projectId: key, path: "" };
    }
    return {
        projectId: key.slice(0, index),
        path: key.slice(index + 2)
    };
}

function createDefaultReportState() {
    return {
        status: "idle",
        report: "",
        updatedAt: null,
        updatedAtDisplay: null,
        error: "",
        chunks: [],
        segments: [],
        conversationId: "",
        analysis: null,
        issueSummary: null,
        parsedReport: null,
        rawReport: "",
        dify: null,
        dml: null,
        difyErrorMessage: "",
        dmlErrorMessage: "",
        sourceText: "",
        sourceLoaded: false,
        sourceLoading: false,
        sourceError: ""
    };
}

function parseReportJson(reportText) {
    if (typeof reportText !== "string") return null;
    const trimmed = reportText.trim();
    if (!trimmed) return null;
    if (!/^\s*[\[{]/.test(trimmed)) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return { issues: parsed };
        }
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
        return null;
    } catch (_error) {
        return null;
    }
}

function computeIssueSummary(reportText, parsedOverride = null) {
    const parsed = parsedOverride || parseReportJson(reportText);
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const summary = parsed?.summary;
    let total = null;
    if (summary && typeof summary === "object") {
        const candidate = summary.total_issues ?? summary.totalIssues;
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
            total = numeric;
        }
        if (!Number.isFinite(total) && summary.sources && typeof summary.sources === "object") {
            const staticSource = summary.sources.static_analyzer || summary.sources.staticAnalyzer;
            if (staticSource && typeof staticSource === "object") {
                const staticTotal = staticSource.total_issues ?? staticSource.totalIssues;
                const staticNumeric = Number(staticTotal);
                if (Number.isFinite(staticNumeric)) {
                    total = staticNumeric;
                }
            }
        }
    }
    if (total === null && Array.isArray(parsed?.issues)) {
        total = parsed.issues.length;
    }
    if (total === null && typeof summary === "string") {
        const normalised = summary.trim();
        if (normalised === "代码正常" || normalised === "代碼正常" || normalised === "OK") {
            total = 0;
        }
    }
    return {
        totalIssues: Number.isFinite(total) ? total : null,
        summary,
        raw: parsed
    };
}

function normaliseReportAnalysisState(state) {
    if (!state) return;

    const rawReport = typeof state.rawReport === "string" ? state.rawReport : "";
    const baseAnalysis =
        state.analysis && typeof state.analysis === "object" && !Array.isArray(state.analysis)
            ? { ...state.analysis }
            : {};

    if (rawReport) {
        if (typeof baseAnalysis.rawReport !== "string") {
            baseAnalysis.rawReport = rawReport;
        }
        if (typeof baseAnalysis.originalResult !== "string") {
            baseAnalysis.originalResult = rawReport;
        }
        if (typeof baseAnalysis.result !== "string") {
            baseAnalysis.result = rawReport;
        }
    }

    const parsedReport = state.parsedReport && typeof state.parsedReport === "object" ? state.parsedReport : null;
    if (parsedReport) {
        const reports =
            parsedReport.reports && typeof parsedReport.reports === "object" ? parsedReport.reports : null;
        if (reports) {
            const staticReport = reports.static_analyzer || reports.staticAnalyzer;
            if (staticReport && typeof staticReport === "object") {
                if (!baseAnalysis.staticReport) {
                    baseAnalysis.staticReport = staticReport;
                }
            }

            const dmlReport = reports.dml_prompt || reports.dmlPrompt;
            if (dmlReport && typeof dmlReport === "object") {
                state.dml = dmlReport;
                const summary =
                    dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
                if (!state.dmlErrorMessage) {
                    const dmlError =
                        typeof summary?.error_message === "string"
                            ? summary.error_message
                            : typeof summary?.errorMessage === "string"
                            ? summary.errorMessage
                            : "";
                    state.dmlErrorMessage = dmlError || "";
                }
            }
        }
    }

    state.analysis = Object.keys(baseAnalysis).length ? baseAnalysis : null;
}

function ensureReportTreeEntry(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportTreeCache, key)) {
        reportTreeCache[key] = {
            nodes: [],
            loading: false,
            error: "",
            expandedPaths: [],
            hydratedReports: false,
            hydratingReports: false,
            reportHydrationError: ""
        };
    }
    return reportTreeCache[key];
}

function ensureProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportBatchStates, key)) {
        reportBatchStates[key] = {
            running: false,
            processed: 0,
            total: 0
        };
    }
    return reportBatchStates[key];
}

function getProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    return reportBatchStates[key] || null;
}

function getProjectIssueCount(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    const totals = projectIssueTotals.value;
    if (!totals.has(key)) return null;
    return totals.get(key);
}

function ensureFileReportState(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportStates, key)) {
        reportStates[key] = createDefaultReportState();
    }
    return reportStates[key];
}

function getReportStateForFile(projectId, path) {
    return ensureFileReportState(projectId, path) || createDefaultReportState();
}

function getStatusLabel(status) {
    switch (status) {
        case "processing":
            return "處理中";
        case "ready":
            return "已完成";
        case "error":
            return "失敗";
        default:
            return "待生成";
    }
}

function isReportNodeExpanded(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return false;
    if (!path) return true;
    return entry.expandedPaths.includes(path);
}

function toggleReportNode(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || !path) return;
    const set = new Set(entry.expandedPaths);
    if (set.has(path)) {
        set.delete(path);
    } else {
        set.add(path);
    }
    entry.expandedPaths = Array.from(set);
}

function collectFileNodes(nodes, bucket = []) {
    for (const node of nodes || []) {
        if (node.type === "file") {
            bucket.push(node);
        } else if (node.children && node.children.length) {
            collectFileNodes(node.children, bucket);
        }
    }
    return bucket;
}

function findTreeNodeByPath(nodes, targetPath) {
    if (!targetPath) return null;
    for (const node of nodes || []) {
        if (!node) continue;
        if (node.path === targetPath) {
            return node;
        }
        if (node.children && node.children.length) {
            const found = findTreeNodeByPath(node.children, targetPath);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function ensureStatesForProject(projectId, nodes) {
    const fileNodes = collectFileNodes(nodes);
    const validPaths = new Set();
    for (const node of fileNodes) {
        if (!node?.path) continue;
        ensureFileReportState(projectId, node.path);
        validPaths.add(node.path);
    }

    Object.keys(reportStates).forEach((key) => {
        const parsed = parseReportKey(key);
        if (parsed.projectId !== normaliseProjectId(projectId)) return;
        if (parsed.path && !validPaths.has(parsed.path)) {
            if (activeReportTarget.value &&
                activeReportTarget.value.projectId === parsed.projectId &&
                activeReportTarget.value.path === parsed.path) {
                activeReportTarget.value = null;
            }
            delete reportStates[key];
        }
    });
}

function parseHydratedTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed);
        }
    }
    return null;
}

async function hydrateReportsForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return;
    if (entry.hydratedReports || entry.hydratingReports) return;
    entry.hydratingReports = true;
    entry.reportHydrationError = "";
    try {
        const records = await fetchProjectReports(projectId);
        for (const record of records) {
            if (!record || !record.path) continue;
            const state = ensureFileReportState(projectId, record.path);
            if (!state) continue;
            state.status = record.report ? "ready" : "idle";
            state.report = record.report || "";
            state.error = "";
            state.chunks = Array.isArray(record.chunks) ? record.chunks : [];
            state.segments = Array.isArray(record.segments) ? record.segments : [];
            state.conversationId = record.conversationId || "";
            state.analysis = record.analysis || null;
            state.rawReport = typeof record.analysis?.result === "string" ? record.analysis.result : "";
            state.dify = null;
            state.dml = null;
            state.difyErrorMessage = "";
            state.dmlErrorMessage = "";
            state.parsedReport = parseReportJson(state.report);
            state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
            normaliseReportAnalysisState(state);
            const timestamp = parseHydratedTimestamp(record.generatedAt || record.updatedAt || record.createdAt);
            state.updatedAt = timestamp;
            state.updatedAtDisplay = timestamp ? timestamp.toLocaleString() : null;
            if (typeof state.sourceText !== "string") {
                state.sourceText = "";
            }
            state.sourceLoaded = Boolean(state.sourceText);
            state.sourceLoading = false;
            state.sourceError = "";
        }
        entry.hydratedReports = true;
    } catch (error) {
        console.error("[Report] Failed to hydrate saved reports", { projectId, error });
        entry.reportHydrationError = error?.message ? String(error.message) : String(error);
    } finally {
        entry.hydratingReports = false;
    }
}

async function loadReportTreeForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || entry.loading) return;
    entry.loading = true;
    entry.error = "";
    try {
        const nodes = await treeStore.loadTreeFromDB(projectId);
        entry.nodes = nodes;
        ensureStatesForProject(projectId, nodes);
        await hydrateReportsForProject(projectId);
        const nextExpanded = new Set(entry.expandedPaths);
        for (const node of nodes) {
            if (node.type === "dir") {
                nextExpanded.add(node.path);
            }
        }
        entry.expandedPaths = Array.from(nextExpanded);
    } catch (error) {
        console.error("[Report] Failed to load tree for project", projectId, error);
        entry.error = error?.message ? String(error.message) : String(error);
    } finally {
        entry.loading = false;
    }
}

function selectReport(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return;
    const state = reportStates[key];
    if (!state || state.status !== "ready") return;
    activeReportTarget.value = {
        projectId: normaliseProjectId(projectId),
        path
    };
}

async function openProjectFileFromReportTree(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return;

    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find(
        (item) => normaliseProjectId(item.id) === projectKey
    );
    if (!project) return;

    if (isTreeCollapsed.value) {
        isTreeCollapsed.value = false;
    }

    if (selectedProjectId.value !== project.id) {
        await openProject(project);
    } else if (!Array.isArray(tree.value) || tree.value.length === 0) {
        await openProject(project);
    }

    const entry = ensureReportTreeEntry(project.id);
    if (entry && !entry.nodes.length && !entry.loading) {
        loadReportTreeForProject(project.id);
    }

    const searchNodes = (entry && entry.nodes && entry.nodes.length)
        ? entry.nodes
        : tree.value;
    let targetNode = findTreeNodeByPath(searchNodes, path);
    if (!targetNode) {
        const name = path.split("/").pop() || path;
        targetNode = { type: "file", path, name, mime: "" };
    }

    treeStore.selectTreeNode(path);
    try {
        await treeStore.openNode(targetNode);
    } catch (error) {
        console.error("[Workspace] Failed to preview file from report tree", {
            projectId: project.id,
            path,
            error
        });
    }
}

async function generateReportForFile(project, node, options = {}) {
    const { autoSelect = true, silent = false } = options;
    if (!project || !node || node.type !== "file") {
        return { status: "skipped" };
    }
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, node.path);
    if (!state || state.status === "processing") {
        return { status: "processing" };
    }

    state.status = "processing";
    state.error = "";
    state.report = "";
    state.chunks = [];
    state.segments = [];
    state.conversationId = "";
    state.analysis = null;
    state.issueSummary = null;
    state.parsedReport = null;
    state.rawReport = "";
    state.dify = null;
    state.dml = null;
    state.difyErrorMessage = "";
    state.dmlErrorMessage = "";
    state.sourceText = "";
    state.sourceLoaded = false;
    state.sourceLoading = false;
    state.sourceError = "";

    try {
        const root = await getProjectRootHandleById(project.id);
        const fileHandle = await fileSystemService.getFileHandleByPath(root, node.path);
        const file = await fileHandle.getFile();
        const mime = node.mime || file.type || "";
        if (!preview.isTextLike(node.name, mime)) {
            throw new Error("目前僅支援純文字或程式碼檔案的審查");
        }
        const text = await file.text();
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }

        state.sourceText = text;
        state.sourceLoaded = true;
        state.sourceLoading = false;
        state.sourceError = "";

        const payload = await generateReportViaDify({
            projectId,
            projectName: project.name,
            path: node.path,
            content: text
        });

        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        state.status = "ready";
        state.updatedAt = completedAt;
        state.updatedAtDisplay = completedAt.toLocaleString();
        state.report = payload?.report || "";
        state.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        state.segments = Array.isArray(payload?.segments) ? payload.segments : [];
        state.conversationId = payload?.conversationId || "";
        state.rawReport = typeof payload?.rawReport === "string" ? payload.rawReport : "";
        state.dify = payload?.dify || null;
        state.dml = payload?.dml || null;
        state.difyErrorMessage = typeof payload?.difyErrorMessage === "string" ? payload.difyErrorMessage : "";
        state.dmlErrorMessage = typeof payload?.dmlErrorMessage === "string" ? payload.dmlErrorMessage : "";
        state.analysis = payload?.analysis || null;
        state.parsedReport = parseReportJson(state.report);
        state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
        normaliseReportAnalysisState(state);
        state.error = "";

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        return { status: "ready" };
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        state.status = "error";
        state.error = message;
        state.report = "";
        state.chunks = [];
        state.segments = [];
        state.conversationId = "";
        state.analysis = null;
        state.issueSummary = null;
        state.parsedReport = null;
        state.rawReport = "";
        state.dify = null;
        state.dml = null;
        state.difyErrorMessage = "";
        state.dmlErrorMessage = "";
        state.sourceLoading = false;
        if (!state.sourceText) {
            state.sourceLoaded = false;
        }
        const now = new Date();
        state.updatedAt = now;
        state.updatedAtDisplay = now.toLocaleString();

        console.error("[Report] Failed to generate report", {
            projectId,
            path: node?.path,
            error
        });

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        if (!silent) {
            if (error?.name === "SecurityError" || error?.name === "NotAllowedError" || error?.name === "TypeError") {
                await safeAlertFail("生成報告失敗", error);
            } else {
                alert(`生成報告失敗：${message}`);
            }
        }

        return { status: "error", error };
    }
}

async function generateProjectReports(project) {
    if (!project) return;
    const projectId = normaliseProjectId(project.id);
    const batchState = ensureProjectBatchState(projectId);
    if (!batchState || batchState.running) return;

    const entry = ensureReportTreeEntry(project.id);
    if (!entry.nodes.length) {
        await loadReportTreeForProject(project.id);
    }

    if (entry.loading) {
        await new Promise((resolve) => {
            const stop = watch(
                () => entry.loading,
                (loading) => {
                    if (!loading) {
                        stop();
                        resolve();
                    }
                }
            );
        });
    }

    if (entry.error) {
        console.warn("[Report] Cannot start batch generation due to tree error", entry.error);
        alert(`無法生成報告：${entry.error}`);
        return;
    }

    const nodes = collectFileNodes(entry.nodes);
    if (!nodes.length) {
        alert("此專案尚未索引可供審查的檔案");
        return;
    }

    batchState.running = true;
    batchState.processed = 0;
    batchState.total = nodes.length;

    try {
        for (const node of nodes) {
            await generateReportForFile(project, node, { autoSelect: false, silent: true });
            batchState.processed += 1;
        }
    } finally {
        batchState.running = false;
        if (nodes.length) {
            activeReportTarget.value = {
                projectId,
                path: nodes[nodes.length - 1].path
            };
        }
    }
}

watch(
    projects,
    (list) => {
        const projectList = Array.isArray(list) ? list : [];
        const currentIds = new Set(projectList.map((project) => normaliseProjectId(project.id)));

        projectList.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (shouldPrepareReportTrees.value && entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (
                shouldPrepareReportTrees.value &&
                entry &&
                !entry.hydratedReports &&
                !entry.hydratingReports
            ) {
                hydrateReportsForProject(project.id);
            }
        });

        Object.keys(reportTreeCache).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportTreeCache[projectId];
            }
        });

        Object.keys(reportBatchStates).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportBatchStates[projectId];
            }
        });

        Object.keys(reportStates).forEach((key) => {
            const parsed = parseReportKey(key);
            if (!currentIds.has(parsed.projectId)) {
                if (activeReportTarget.value &&
                    activeReportTarget.value.projectId === parsed.projectId &&
                    activeReportTarget.value.path === parsed.path) {
                    activeReportTarget.value = null;
                }
                delete reportStates[key];
            }
        });
    },
    { immediate: true, deep: true }
);

watch(
    shouldPrepareReportTrees,
    (active) => {
        if (!active) return;
        const list = Array.isArray(projects.value) ? projects.value : [];
        list.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (entry && !entry.hydratedReports && !entry.hydratingReports) {
                hydrateReportsForProject(project.id);
            }
        });
    }
);

watch(
    readyReports,
    (list) => {
        if (!list.length) {
            activeReportTarget.value = null;
            return;
        }
        const target = activeReportTarget.value;
        const hasActive = target
            ? list.some((entry) => normaliseProjectId(entry.project.id) === target.projectId && entry.path === target.path)
            : false;
        if (!hasActive) {
            const next = list[0];
            activeReportTarget.value = {
                projectId: normaliseProjectId(next.project.id),
                path: next.path
            };
        }
    },
    { immediate: true }
);

watch(
    activeReport,
    async (report) => {
        if (!report) return;
        const state = report.state;
        if (state.sourceLoaded || state.sourceLoading) {
            return;
        }
        state.sourceLoading = true;
        state.sourceError = "";
        try {
            const root = await getProjectRootHandleById(report.project.id);
            if (!root) {
                throw new Error("找不到專案根目錄，無法載入檔案內容");
            }
            const fileHandle = await fileSystemService.getFileHandleByPath(root, report.path);
            if (!fileHandle) {
                throw new Error("找不到對應的檔案");
            }
            const file = await fileHandle.getFile();
            const text = await file.text();
            state.sourceText = typeof text === "string" ? text : "";
            state.sourceLoaded = state.sourceText.length > 0;
            state.sourceError = "";
        } catch (error) {
            state.sourceText = "";
            state.sourceLoaded = false;
            state.sourceError = error?.message ? String(error.message) : "無法載入檔案內容";
            console.error("[Report] Failed to load source text", {
                projectId: report.project.id,
                path: report.path,
                error
            });
        } finally {
            state.sourceLoading = false;
        }
    },
    { immediate: true }
);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function shouldIgnoreMouseEvent(event) {
    return (
        event?.type === "mousedown" &&
        typeof window !== "undefined" &&
        "PointerEvent" in window
    );
}

function startPreviewResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = middlePaneWidth.value;
    const containerEl = mainContentRef.value;
    const workspaceEl = containerEl?.querySelector(".workSpace");
    if (!workspaceEl) return;

    const minWidth = 260;
    const workspaceMinWidth = 320;
    const workspaceRect = workspaceEl.getBoundingClientRect();
    const maxAdditional = Math.max(0, workspaceRect.width - workspaceMinWidth);
    const maxWidth = Math.max(minWidth, startWidth + maxAdditional);

    const handleMove = (pointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        middlePaneWidth.value = clamp(startWidth + delta, minWidth, maxWidth);
    };

    const stop = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
}

function clampReportSidebarWidth() {
    const containerEl = mainContentRef.value;
    if (!containerEl) return;

    const navEl = containerEl.querySelector(".toolColumn");
    const availableWidth = containerEl.clientWidth - (navEl?.clientWidth ?? 0);
    if (availableWidth <= 0) return;

    const workspaceMinWidth = 320;
    const minRailWidthDefault = 260;
    const maxRailWidth = Math.max(0, availableWidth - workspaceMinWidth);

    if (maxRailWidth === 0) {
        middlePaneWidth.value = 0;
        return;
    }

    const minRailWidth = Math.min(minRailWidthDefault, maxRailWidth);
    middlePaneWidth.value = clamp(middlePaneWidth.value, minRailWidth, maxRailWidth);
}

async function handleAddActiveContext() {
    const added = await addActiveNode();
    if (added) {
        openChatWindow();
    }
}

function handleAddSelectionContext() {
    let snippet = buildSelectedSnippet();
    if (!snippet) {
        snippet = codeSelection.value ? { ...codeSelection.value } : null;
    }
    if (!snippet) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("請先在程式碼預覽中選取想加入的內容。");
        }
        return;
    }
    const added = addSnippetContext({ ...snippet });
    if (added) {
        openChatWindow();
        clearCodeSelection();
        if (typeof window !== "undefined") {
            const selection = window.getSelection?.();
            if (selection?.removeAllRanges) {
                selection.removeAllRanges();
            }
        }
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    openChatWindow();
    console.log("[ChatAI] Sending message:", text);
    await sendUserMessage(text);
}

function openChatWindow() {
    if (!isChatWindowOpen.value) {
        isChatWindowOpen.value = true;
    }
}

function closeChatWindow() {
    if (isChatWindowOpen.value) {
        isChatWindowOpen.value = false;
        stopChatDrag();
        stopChatResize();
    }
}

function toggleChatWindow() {
    if (isChatWindowOpen.value) return;
    if (!isChatToggleDisabled.value) {
        openChatWindow();
    }
}

function ensureChatWindowInView() {
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(chatWindowState.x, 0, maxX);
    chatWindowState.y = clamp(chatWindowState.y, 0, maxY);
}

function startChatDrag(event) {
    if (shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    chatDragState.active = true;
    chatDragState.offsetX = event.clientX - chatWindowState.x;
    chatDragState.offsetY = event.clientY - chatWindowState.y;
    window.addEventListener("pointermove", handleChatDrag);
    window.addEventListener("pointerup", stopChatDrag);
    window.addEventListener("pointercancel", stopChatDrag);
}

function handleChatDrag(event) {
    if (!chatDragState.active) return;
    event.preventDefault();
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(event.clientX - chatDragState.offsetX, 0, maxX);
    chatWindowState.y = clamp(event.clientY - chatDragState.offsetY, 0, maxY);
}

function stopChatDrag() {
    chatDragState.active = false;
    window.removeEventListener("pointermove", handleChatDrag);
    window.removeEventListener("pointerup", stopChatDrag);
    window.removeEventListener("pointercancel", stopChatDrag);
}

function startChatResize(payload) {
    const event = payload?.originalEvent ?? payload;
    const edges = payload?.edges ?? { right: true, bottom: true };
    if (!event || shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    if (!edges.left && !edges.right && !edges.top && !edges.bottom) return;

    event.preventDefault();
    chatResizeState.active = true;
    chatResizeState.startX = event.clientX;
    chatResizeState.startY = event.clientY;
    chatResizeState.startWidth = chatWindowState.width;
    chatResizeState.startHeight = chatWindowState.height;
    chatResizeState.startLeft = chatWindowState.x;
    chatResizeState.startTop = chatWindowState.y;
    chatResizeState.edges.left = !!edges.left;
    chatResizeState.edges.right = !!edges.right;
    chatResizeState.edges.top = !!edges.top;
    chatResizeState.edges.bottom = !!edges.bottom;

    window.addEventListener("pointermove", handleChatResize);
    window.addEventListener("pointerup", stopChatResize);
    window.addEventListener("pointercancel", stopChatResize);
}

function handleChatResize(event) {
    if (!chatResizeState.active) return;
    event.preventDefault();
    const deltaX = event.clientX - chatResizeState.startX;
    const deltaY = event.clientY - chatResizeState.startY;
    const minWidth = 320;
    const minHeight = 320;

    if (chatResizeState.edges.left) {
        const proposedLeft = chatResizeState.startLeft + deltaX;
        const maxLeft = chatResizeState.startLeft + chatResizeState.startWidth - minWidth;
        const clampedLeft = clamp(proposedLeft, 0, Math.max(0, maxLeft));
        const widthFromLeft = chatResizeState.startWidth + (chatResizeState.startLeft - clampedLeft);
        const maxWidthFromViewport = Math.max(minWidth, window.innerWidth - clampedLeft);
        chatWindowState.x = clampedLeft;
        chatWindowState.width = clamp(widthFromLeft, minWidth, maxWidthFromViewport);
    }

    if (chatResizeState.edges.top) {
        const proposedTop = chatResizeState.startTop + deltaY;
        const maxTop = chatResizeState.startTop + chatResizeState.startHeight - minHeight;
        const clampedTop = clamp(proposedTop, 0, Math.max(0, maxTop));
        const heightFromTop = chatResizeState.startHeight + (chatResizeState.startTop - clampedTop);
        const maxHeightFromViewport = Math.max(minHeight, window.innerHeight - clampedTop);
        chatWindowState.y = clampedTop;
        chatWindowState.height = clamp(heightFromTop, minHeight, maxHeightFromViewport);
    }

    if (chatResizeState.edges.right) {
        const maxWidth = Math.max(minWidth, window.innerWidth - chatWindowState.x);
        chatWindowState.width = clamp(chatResizeState.startWidth + deltaX, minWidth, maxWidth);
    }

    if (chatResizeState.edges.bottom) {
        const maxHeight = Math.max(minHeight, window.innerHeight - chatWindowState.y);
        chatWindowState.height = clamp(chatResizeState.startHeight + deltaY, minHeight, maxHeight);
    }
}

function stopChatResize() {
    chatResizeState.active = false;
    chatResizeState.edges.left = false;
    chatResizeState.edges.right = false;
    chatResizeState.edges.top = false;
    chatResizeState.edges.bottom = false;
    window.removeEventListener("pointermove", handleChatResize);
    window.removeEventListener("pointerup", stopChatResize);
    window.removeEventListener("pointercancel", stopChatResize);
}

onMounted(async () => {
    await cleanupLegacyHandles();
    updateCapabilityFlags();
    await loadProjectsFromDB();
    clampReportSidebarWidth();
    window.addEventListener("resize", ensureChatWindowInView);
    window.addEventListener("resize", clampReportSidebarWidth);
    if (typeof document !== "undefined") {
        document.addEventListener("pointerdown", handleDocumentPointerDown, true);
        document.addEventListener("selectionchange", handleDocumentSelectionChange);
        document.addEventListener("mouseup", handleDocumentPointerUp);
    }
});

onBeforeUnmount(() => {
    window.removeEventListener("resize", ensureChatWindowInView);
    window.removeEventListener("resize", clampReportSidebarWidth);
    stopChatDrag();
    stopChatResize();
    if (typeof document !== "undefined") {
        document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
        document.removeEventListener("selectionchange", handleDocumentSelectionChange);
        document.removeEventListener("mouseup", handleDocumentPointerUp);
    }
});
</script>



<template>
    <div class="page">
        <div class="topBar">
            <div class="topBar_left">
                <h1 class="topBar_title">Workspace</h1>
            </div>
            <div class="topBar_spacer"></div>
            <div class="topBar_right">
                <div class="topBar_addProject" @click="showUploadModal = true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                        <path d="M256,0C114.6,0,0,114.6,0,256s114.6,256,256,256s256-114.6,256-256S397.4,0,256,0z M405.3,277.3c0,11.8-9.5,21.3-21.3,21.3h-85.3V384c0,11.8-9.5,21.3-21.3,21.3h-42.7c-11.8,0-21.3-9.6-21.3-21.3v-85.3H128c-11.8,0-21.3-9.6-21.3-21.3v-42.7c0-11.8,9.5-21.3,21.3-21.3h85.3V128c0-11.8,9.5-21.3,21.3-21.3h42.7c11.8,0,21.3,9.6,21.3,21.3v85.3H384c11.8,0,21.3,9.6,21.3,21.3V277.3z" />
                    </svg>
                    <p>Add Project</p>
                </div>
            </div>
        </div>

        <div class="mainContent themed-scrollbar" ref="mainContentRef">
            <nav class="toolColumn">
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isProjectToolActive }"
                    @click="toggleProjectTool"
                    :aria-pressed="isProjectToolActive"
                    title="Projects"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" opacity="0.18" />
                        <path
                            d="M5 7h5l1.5 2H19v8H5V7Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isReportToolActive }"
                    @click="toggleReportTool"
                    :aria-pressed="isReportToolActive"
                    title="報告審查"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="9" fill="currentColor" opacity="0.18" />
                        <path
                            d="M14.8 13.4a4.5 4.5 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5Zm-3.8.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn toolColumn_btn--chat"
                    :class="{ active: isChatWindowOpen }"
                    :disabled="isChatToggleDisabled"
                    @click="toggleChatWindow"
                    :aria-pressed="isChatWindowOpen"
                    title="Chat AI"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" opacity="0.12" />
                        <path
                            d="M8.5 8h7c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5h-.94l-1.8 1.88c-.31.33-.76.12-.76-.32V14.5h-3.5c-.83 0-1.5-.67-1.5-1.5v-3C7 8.67 7.67 8 8.5 8Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
            </nav>
            <PanelRail
                :style-width="middlePaneStyle"
                :mode="panelMode"
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject"
                :is-tree-collapsed="isTreeCollapsed"
                :show-content="isProjectToolActive || isReportToolActive"
                :tree="tree"
                :active-tree-path="activeTreePath"
                :is-loading-tree="isLoadingTree"
                :open-node="openNode"
                :select-tree-node="selectTreeNode"
                :report-config="reportPanelConfig"
                @resize-start="startPreviewResize"
            />

            <section class="workSpace" :class="{ 'workSpace--reports': isReportToolActive }">
                <template v-if="isReportToolActive">
                    <div class="panelHeader">報告檢視</div>
                    <template v-if="hasReadyReports || viewerHasContent">
                        <div v-if="readyReports.length" class="reportTabs">
                            <button
                                v-for="entry in readyReports"
                                :key="entry.key"
                                type="button"
                                class="reportTab"
                                :class="{
                                    active:
                                        activeReport &&
                                        normaliseProjectId(entry.project.id) === normaliseProjectId(activeReport.project.id) &&
                                        entry.path === activeReport.path
                                }"
                                @click="selectReport(entry.project.id, entry.path)"
                            >
                                {{ entry.project.name }} / {{ entry.path }}
                            </button>
                        </div>
                        <div class="reportViewerContent">
                            <template v-if="activeReport">
                                <div class="reportViewerHeader">
                                    <h3 class="reportTitle">{{ activeReport.project.name }} / {{ activeReport.path }}</h3>
                                    <p class="reportViewerTimestamp">更新於 {{ activeReport.state.updatedAtDisplay || '-' }}</p>
                                </div>
                                <div v-if="activeReport.state.status === 'error'" class="reportErrorPanel">
                                    <p class="reportErrorText">生成失敗：{{ activeReport.state.error || '未知原因' }}</p>
                                    <p class="reportErrorHint">請檢查檔案權限、Dify 設定或稍後再試。</p>
                                </div>
                                <template v-else>
                                    <div v-if="hasStructuredReport" class="reportStructured">
                                        <div
                                            v-if="hasStructuredReportToggle"
                                            class="reportStructuredToggle"
                                            role="group"
                                            aria-label="報告來源"
                                        >
                                            <button
                                                type="button"
                                                class="reportStructuredToggleButton"
                                                :class="{ active: structuredReportViewMode === 'combined' }"
                                                :disabled="!canShowStructuredSummary"
                                                @click="setStructuredReportViewMode('combined')"
                                            >
                                                總報告
                                            </button>
                                            <button
                                                type="button"
                                                class="reportStructuredToggleButton"
                                                :class="{ active: structuredReportViewMode === 'static' }"
                                                :disabled="!canShowStructuredStatic"
                                                @click="setStructuredReportViewMode('static')"
                                            >
                                                靜態分析器
                                            </button>
                                            <button
                                                type="button"
                                                class="reportStructuredToggleButton"
                                                :class="{ active: structuredReportViewMode === 'dml' }"
                                                :disabled="!canShowStructuredDml"
                                                @click="setStructuredReportViewMode('dml')"
                                            >
                                                DML 語句分析
                                            </button>
                                        </div>
                                        <section
                                            v-if="structuredReportViewMode === 'combined' && canShowStructuredSummary"
                                            class="reportSummaryGrid"
                                        >
                                            <div
                                                v-if="activeReportDetails?.sourceSummaries?.length"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">來源摘要</span>
                                                <ul class="reportSummarySources">
                                                    <li
                                                        v-for="item in activeReportDetails.sourceSummaries"
                                                        :key="item.key"
                                                        class="reportSummarySource"
                                                    >
                                                        <div class="reportSummarySourceHeading">
                                                            <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                            <span
                                                                v-if="item.status"
                                                                class="reportSummarySourceStatus"
                                                            >
                                                                {{ item.status }}
                                                            </span>
                                                        </div>
                                                        <ul
                                                            v-if="item.metrics?.length"
                                                            class="reportSummarySourceMetrics"
                                                        >
                                                            <li
                                                                v-for="metric in item.metrics"
                                                                :key="`${item.key}-${metric.label}`"
                                                            >
                                                                <span class="reportSummaryItemLabel">{{ metric.label }}</span>
                                                                <span class="reportSummaryItemValue">{{ metric.value }}</span>
                                                            </li>
                                                        </ul>
                                                        <p
                                                            v-if="item.errorMessage"
                                                            class="reportSummarySourceError"
                                                        >
                                                            {{ item.errorMessage }}
                                                        </p>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div
                                                v-if="activeReportDetails?.combinedSummaryDetails?.length"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">整合摘要</span>
                                                <ul class="reportSummaryList">
                                                    <li
                                                        v-for="item in activeReportDetails.combinedSummaryDetails"
                                                        :key="`combined-${item.label}-${item.value}`"
                                                    >
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div class="reportSummaryCard reportSummaryCard--total">
                                                <span class="reportSummaryLabel">問題</span>
                                                <span class="reportSummaryValue">
                                                    {{
                                                        activeReportDetails?.totalIssues === null
                                                            ? "—"
                                                            : activeReportDetails.totalIssues
                                                    }}
                                                </span>
                                            </div>
                                            <div
                                                v-if="activeReportDetails?.summaryText"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">{{ activeReportDetails.summaryText }}</p>
                                            </div>
                                            <div
                                                v-else-if="activeReportDetails && activeReportDetails.totalIssues === 0"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">未檢測到問題。</p>
                                            </div>
                                            <div
                                                v-if="activeReportDetails?.ruleBreakdown?.length"
                                                class="reportSummaryCard"
                                            >
                                                <span class="reportSummaryLabel">規則分佈</span>
                                                <ul class="reportSummaryList">
                                                    <li
                                                        v-for="item in activeReportDetails.ruleBreakdown"
                                                        :key="`${item.label}-${item.count}`"
                                                    >
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div
                                                v-if="activeReportDetails?.severityBreakdown?.length"
                                                class="reportSummaryCard"
                                            >
                                                <span class="reportSummaryLabel">嚴重度</span>
                                                <ul class="reportSummaryList">
                                                    <li
                                                        v-for="item in activeReportDetails.severityBreakdown"
                                                        :key="`${item.label}-${item.count}`"
                                                    >
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                        </section>

                                            <section
                                                v-if="
                                                    structuredReportViewMode === 'static' &&
                                                    (
                                                        activeReportDetails?.staticSummaryDetails?.length ||
                                                        activeReportDetails?.staticMetadataDetails?.length
                                                    )
                                                "
                                                class="reportStaticSection"
                                            >
                                                <div class="reportStaticHeader">
                                                    <h4>靜態分析器</h4>
                                                    <span
                                                        v-if="activeReportDetails?.staticMetadata?.engine"
                                                        class="reportStaticEngine"
                                                    >
                                                        引擎：{{ activeReportDetails.staticMetadata.engine }}
                                                    </span>
                                                    <span
                                                        v-else-if="activeReportDetails?.staticSummary?.analysis_source"
                                                        class="reportStaticEngine"
                                                    >
                                                        來源：{{ activeReportDetails.staticSummary.analysis_source }}
                                                    </span>
                                                </div>
                                                <div
                                                    v-if="activeReportDetails?.staticSummaryDetails?.length"
                                                    class="reportStaticBlock"
                                                >
                                                    <h5>摘要資訊</h5>
                                                    <ul class="reportStaticList">
                                                        <li
                                                            v-for="item in activeReportDetails.staticSummaryDetails"
                                                            :key="`static-summary-${item.label}-${item.value}`"
                                                        >
                                                            <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                            <span class="reportStaticItemValue">{{ item.value }}</span>
                                                        </li>
                                                    </ul>
                                                </div>
                                                <div
                                                    v-if="activeReportDetails?.staticMetadataDetails?.length"
                                                    class="reportStaticBlock"
                                                >
                                                    <h5>中繼資料</h5>
                                                    <ul class="reportStaticList">
                                                        <li
                                                            v-for="item in activeReportDetails.staticMetadataDetails"
                                                            :key="`static-metadata-${item.label}-${item.value}`"
                                                        >
                                                            <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                            <span class="reportStaticItemValue">{{ item.value }}</span>
                                                        </li>
                                                    </ul>
                                                </div>
                                            </section>

                                            <section
                                                v-if="
                                                    structuredReportViewMode === 'dml' &&
                                                    activeReportDetails?.dmlReport
                                                "
                                                class="reportDmlSection"
                                            >
                                                <div class="reportDmlHeader">
                                                    <h4>DML 提示詞分析</h4>
                                                    <span
                                                        v-if="activeReportDetails.dmlReport.status"
                                                        class="reportDmlStatus"
                                                    >
                                                        {{ activeReportDetails.dmlReport.status }}
                                                    </span>
                                                    <span
                                                        v-if="activeReportDetails.dmlReport.generatedAt"
                                                        class="reportDmlTimestamp"
                                                    >
                                                        產生於 {{ activeReportDetails.dmlReport.generatedAt }}
                                                    </span>
                                                </div>
                                                <p
                                                    v-if="activeReportDetails.dmlReport.error"
                                                    class="reportDmlError"
                                                >
                                                    {{ activeReportDetails.dmlReport.error }}
                                                </p>
                                                <div
                                                    v-if="activeReportDetails.dmlReport.segments?.length"
                                                    class="reportDmlSegments"
                                                >
                                                    <details
                                                        v-for="segment in activeReportDetails.dmlReport.segments"
                                                        :key="segment.key"
                                                        class="reportDmlSegment"
                                                    >
                                                        <summary>
                                                            第 {{ segment.index }} 段
                                                            <span v-if="segment.startLine">
                                                                （第 {{ segment.startLine }} 行起
                                                                <span v-if="segment.endLine">，至第 {{ segment.endLine }} 行止</span>
                                                                ）
                                                            </span>
                                                        </summary>
                                                        <pre class="reportDmlSql codeScroll themed-scrollbar">
                                                            {{ segment.sql }}
                                                        </pre>
                                                        <pre
                                                            v-if="segment.analysis"
                                                            class="reportDmlAnalysis codeScroll themed-scrollbar"
                                                        >
                                                            {{ segment.analysis }}
                                                        </pre>
                                                    </details>
                                                </div>
                                                <p v-else class="reportDmlEmpty">尚未取得 DML 拆分結果。</p>
                                                <pre
                                                    v-if="activeReportDetails.dmlReport.reportText"
                                                    class="reportDmlSummary codeScroll themed-scrollbar"
                                                >
                                                    {{ activeReportDetails.dmlReport.reportText }}
                                                </pre>
                                            </section>
                                            <section v-if="shouldShowReportIssuesSection" class="reportIssuesSection">
                                                <div class="reportIssuesHeader">
                                                    <div class="reportIssuesHeaderInfo">
                                                        <h4>問題清單</h4>
                                                        <span class="reportIssuesTotal">
                                                            <template v-if="activeReportIssueCount !== null">
                                                                共 {{ activeReportIssueCount }} 項
                                                            </template>
                                                            <template v-else>—</template>
                                                        </span>
                                                    </div>
                                                    <div class="reportIssuesToggle" role="group" aria-label="檢視模式">
                                                        <button
                                                            type="button"
                                                            class="reportIssuesToggleButton"
                                                            :class="{ active: reportIssuesViewMode === 'code' }"
                                                            :disabled="!canShowCodeIssues"
                                                            @click="setReportIssuesViewMode('code')"
                                                        >
                                                            報告預覽
                                                        </button>
                                                        <button
                                                            type="button"
                                                            class="reportIssuesToggleButton"
                                                            :class="{ active: reportIssuesViewMode === 'static' }"
                                                            :disabled="!canShowStaticReportJson"
                                                            @click="setReportIssuesViewMode('static')"
                                                        >
                                                            靜態分析器 JSON
                                                        </button>
                                                        <button
                                                            type="button"
                                                            class="reportIssuesToggleButton"
                                                            :class="{ active: reportIssuesViewMode === 'dify' }"
                                                            :disabled="!canShowDifyReportJson"
                                                            @click="setReportIssuesViewMode('dify')"
                                                        >
                                                            Dify JSON
                                                        </button>
                                                    </div>
                                                </div>
                                                <div class="reportIssuesContent">
                                                    <div v-if="reportIssuesViewMode === 'code'">
                                                        <div v-if="activeReportDetails">
                                                            <div
                                                                v-if="activeReport.state.sourceLoading"
                                                                class="reportIssuesNotice"
                                                            >
                                                                正在載入原始碼…
                                                            </div>
                                                            <div
                                                                v-else-if="activeReport.state.sourceError"
                                                                class="reportIssuesNotice reportIssuesNotice--error"
                                                            >
                                                                無法載入檔案內容：{{ activeReport.state.sourceError }}
                                                            </div>
                                                            <div v-else>
                                                                <div
                                                                    v-if="shouldShowDifyUnavailableNotice"
                                                                    class="reportIssuesNotice reportIssuesNotice--warning"
                                                                >
                                                                    {{ reportDifyUnavailableNotice }}
                                                                </div>
                                                                <div
                                                                    v-if="hasReportIssueLines"
                                                                    class="reportRow reportIssuesRow"
                                                                >
                                                                    <div class="reportRowContent codeScroll themed-scrollbar">
                                                                        <div class="codeEditor">
                                                                            <div
                                                                                v-for="line in reportIssueLines"
                                                                                :key="line.key"
                                                                                class="codeLine"
                                                                                :class="{
                                                                                    'codeLine--issue': line.type === 'code' && line.hasIssue,
                                                                                    'codeLine--meta': line.type !== 'code',
                                                                                    'codeLine--issuesMeta': line.type === 'issues',
                                                                                    'codeLine--fixMeta': line.type === 'fix'
                                                                                }"
                                                                            >
                                                                                <span
                                                                                    class="codeLineNo"
                                                                                    :class="{
                                                                                        'codeLineNo--issue': line.type === 'code' && line.hasIssue,
                                                                                        'codeLineNo--meta': line.type !== 'code',
                                                                                        'codeLineNo--issues': line.type === 'issues',
                                                                                        'codeLineNo--fix': line.type === 'fix'
                                                                                    }"
                                                                                    :data-line="line.displayNumber"
                                                                                    :aria-label="line.type !== 'code' ? line.iconLabel : null"
                                                                                    :aria-hidden="line.type === 'code'"
                                                                                >
                                                                                    <svg
                                                                                        v-if="line.type === 'issues'"
                                                                                        class="codeLineNoIcon codeLineNoIcon--warning"
                                                                                        viewBox="0 0 20 20"
                                                                                        focusable="false"
                                                                                        aria-hidden="true"
                                                                                    >
                                                                                        <path
                                                                                            d="M10.447 2.105a1 1 0 00-1.894 0l-7 14A1 1 0 002.447 18h15.106a1 1 0 00.894-1.447l-7-14zM10 6a1 1 0 01.993.883L11 7v4a1 1 0 01-1.993.117L9 11V7a1 1 0 011-1zm0 8a1 1 0 110 2 1 1 0 010-2z"
                                                                                        />
                                                                                    </svg>
                                                                                    <svg
                                                                                        v-else-if="line.type === 'fix'"
                                                                                        class="codeLineNoIcon codeLineNoIcon--fix"
                                                                                        viewBox="0 0 20 20"
                                                                                        focusable="false"
                                                                                        aria-hidden="true"
                                                                                    >
                                                                                        <path
                                                                                            d="M17.898 2.102a1 1 0 00-1.517.127l-2.156 2.873-1.21-.403a1 1 0 00-1.043.24l-4.95 4.95a1 1 0 000 1.414l1.775 1.775-5.189 5.189a1 1 0 001.414 1.414l5.189-5.189 1.775 1.775a1 1 0 001.414 0l4.95-4.95a1 1 0 00.24-1.043l-.403-1.21 2.873-2.156a1 1 0 00.127-1.517l-.489-.489z"
                                                                                        />
                                                                                    </svg>
                                                                                </span>
                                                                                <span
                                                                                    class="codeLineContent"
                                                                                    :class="{
                                                                                        'codeLineContent--issueHighlight':
                                                                                            line.type === 'code' && line.hasIssue,
                                                                                        'codeLineContent--issues': line.type === 'issues',
                                                                                        'codeLineContent--fix': line.type === 'fix'
                                                                                    }"
                                                                                    v-html="line.html"
                                                                                ></span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                                            </div>
                                                        </div>
                                                        <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                                    </div>
                                                    <div v-else-if="reportIssuesViewMode === 'static'">
                                                        <div v-if="activeReportStaticRawText.trim().length" class="reportRow">
                                                            <div v-if="canExportActiveReportStaticRaw" class="reportRowActions">
                                                                <button
                                                                    type="button"
                                                                    class="reportRowActionButton"
                                                                    :disabled="isExportingReportJsonExcel"
                                                                    @click="exportActiveReportJsonToExcel('static')"
                                                                >
                                                                    <span v-if="isExportingReportJsonExcel">匯出中…</span>
                                                                    <span v-else>匯出 Excel</span>
                                                                </button>
                                                            </div>
                                                            <pre class="reportRowContent codeScroll themed-scrollbar">
                                                                {{ activeReportStaticRawText }}
                                                            </pre>
                                                            <p v-if="!canExportActiveReportStaticRaw" class="reportRowNotice">
                                                                靜態分析器 JSON 不是有效的 JSON 格式，因此無法匯出 Excel。
                                                            </p>
                                                        </div>
                                                        <p v-else class="reportIssuesEmpty">尚未取得靜態分析器報告內容。</p>
                                                    </div>
                                                    <div v-else-if="reportIssuesViewMode === 'dify'">
                                                        <div v-if="activeReportDifyRawText.trim().length" class="reportRow">
                                                            <div v-if="canExportActiveReportDifyRaw" class="reportRowActions">
                                                                <button
                                                                    type="button"
                                                                    class="reportRowActionButton"
                                                                    :disabled="isExportingReportJsonExcel"
                                                                    @click="exportActiveReportJsonToExcel('dify')"
                                                                >
                                                                    <span v-if="isExportingReportJsonExcel">匯出中…</span>
                                                                    <span v-else>匯出 Excel</span>
                                                                </button>
                                                            </div>
                                                            <pre class="reportRowContent codeScroll themed-scrollbar">
                                                                {{ activeReportDifyRawText }}
                                                            </pre>
                                                            <p v-if="!canExportActiveReportDifyRaw" class="reportRowNotice">
                                                                Dify JSON 不是有效的 JSON 格式，因此無法匯出 Excel。
                                                            </p>
                                                        </div>
                                                        <p v-else class="reportIssuesEmpty">尚未取得 Dify 報告內容。</p>
                                                    </div>
                                                    <p v-else class="reportIssuesEmpty">此報告不支援結構化檢視。</p>
                                                </div>
                                            </section>
                                            <p v-else class="reportIssuesEmpty">未檢測到任何問題。</p>

                                    </div>
                                    <pre v-else class="reportBody codeScroll themed-scrollbar">{{ activeReport.state.report }}</pre>
                                    <details v-if="hasChunkDetails" class="reportChunks">
                                        <summary>分段輸出（{{ activeReport.state.chunks.length }}）</summary>
                                        <ol class="reportChunkList">
                                            <li
                                                v-for="chunk in activeReport.state.chunks"
                                                :key="`${chunk.index}-${chunk.total}`"
                                            >
                                                <h4 class="reportChunkTitle">第 {{ chunk.index }} 段</h4>
                                                <pre class="reportChunkBody codeScroll themed-scrollbar">{{ chunk.answer }}</pre>
                                            </li>
                                        </ol>
                                    </details>
                                </template>
                            </template>
                            <template v-else>
                                <div class="reportViewerPlaceholder">請從左側選擇檔案報告。</div>
                            </template>
                        </div>
                    </template>
                    <p v-else class="reportViewerPlaceholder">尚未生成任何報告，請先於左側檔案中啟動生成。</p>
                </template>
                <template v-else-if="previewing.kind && previewing.kind !== 'error'">
                    <div class="pvHeader">
                        <div class="pvName">{{ previewing.name }}</div>
                        <div class="pvMeta">{{ previewing.mime || '-' }} | {{ (previewing.size / 1024).toFixed(1) }} KB</div>
                    </div>

                    <template v-if="previewing.kind === 'text'">
                        <div class="pvBox codeBox">
                            <div
                                class="codeScroll themed-scrollbar"
                                :class="{ 'codeScroll--wrapped': !showCodeLineNumbers }"
                                ref="codeScrollRef"
                                @pointerdown="handleCodeScrollPointerDown"
                            >
                                <div class="codeEditor">
                                    <div
                                        v-for="line in previewLineItems"
                                        :key="line.number"
                                        class="codeLine"
                                        :data-line="line.number"
                                    >
                                        <span
                                            class="codeLineNo"
                                            :data-line="line.number"
                                            aria-hidden="true"
                                        ></span>
                                        <span class="codeLineContent" v-html="renderLineContent(line)"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </template>

                    <div v-else-if="previewing.kind === 'image'" class="pvBox imgBox">
                        <img :src="previewing.url" :alt="previewing.name" />
                    </div>

                    <div v-else-if="previewing.kind === 'pdf'" class="pvBox pdfBox">
                        <iframe :src="previewing.url" title="PDF Preview" style="width:100%;height:100%;border:none;"></iframe>
                    </div>

                    <div v-else class="pvBox">
                        <a class="btn" :href="previewing.url" download>Download file</a>
                        <a class="btn outline" :href="previewing.url" target="_blank">Open in new window</a>
                    </div>
                </template>

                <template v-else-if="previewing.kind === 'error'">
                    <div class="pvError">
                        Cannot preview: {{ previewing.error }}
                    </div>
                </template>

                <template v-else>
                    <div class="pvPlaceholder">Select a file to see its preview here.</div>
                </template>
            </section>
        </div>

        <Teleport to="body">
            <ChatAiWindow
                :visible="isChatWindowOpen"
                :floating-style="chatWindowStyle"
                :context-items="contextItems"
                :messages="messages"
                :loading="isProcessing"
                :disabled="isChatLocked"
                :connection="connection"
                @add-active="handleAddActiveContext"
                @add-selection="handleAddSelectionContext"
                @clear-context="clearContext"
                @remove-context="removeContext"
                @send-message="handleSendMessage"
                @close="closeChatWindow"
                @drag-start="startChatDrag"
                @resize-start="startChatResize"
            />
        </Teleport>

        <div v-if="showUploadModal" class="modalBackdrop" @click.self="showUploadModal = false">
            <div class="modalCard">
                <h3>Import Project Folder</h3>
                <p>Drag a folder here or use the buttons below to import a project. External directories and OPFS are supported.</p>

                <div class="dropZone" @drop="handleDrop" @dragover="handleDragOver">Drop a folder here to import</div>

                <div class="modalBtns">
                    <button class="btn" v-if="supportsFS" @click="pickFolderAndImport">Select folder</button>
                    <label class="btn outline" v-else>Fallback import<input type="file" webkitdirectory directory multiple style="display:none" @change="handleFolderInput"></label>
                    <button class="btn ghost" @click="showUploadModal = false">Cancel</button>
                </div>
                <p class="hint" v-if="!supportsFS">Your browser does not support showDirectoryPicker. Use the fallback input instead.</p>
            </div>
        </div>
    </div>
</template>
<style>
/* 讓 100% 有依據 */
html,
body,
#app {
    height: 100%;
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e5e7eb;
}

.page {
    min-height: 100vh;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background-color: #1e1e1e;
}

/* 頂欄 */
.topBar {
    box-sizing: border-box;
    height: 60px;
    padding: 0 16px;
    background: linear-gradient(90deg, #2c2c2c, #252526);
    border-bottom: 1px solid #3d3d3d;
    display: flex;
    align-items: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}

.topBar_spacer {
    flex: 1 1 auto;
}

.topBar_right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_iconBtn {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid #3d3d3d;
    background: #2b2b2b;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.topBar_iconBtn svg {
    width: 20px;
    height: 20px;
}

.topBar_iconBtn:hover:not(:disabled) {
    background: #343434;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.topBar_iconBtn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(14, 165, 233, 0.3));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.topBar_addProject {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-radius: 6px;
    background-color: #007acc;
    transition: all 0.25s ease;
}

.topBar_addProject p {
    margin: 0;
    color: white;
    font-weight: 600;
    font-size: 15px;
}

.topBar_addProject svg {
    height: 20px;
    fill: white;
    transition: transform 0.25s ease, fill 0.25s ease;
}

.topBar_addProject:hover {
    background-color: #0288d1;
    transform: translateY(-2px) scale(1.03);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.topBar_addProject:active {
    transform: scale(0.96);
}


.mainContent {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 0;
    height: calc(100vh - 60px);
    max-height: calc(100vh - 60px);
    overflow: hidden;
}

.workSpace {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    height: 100%;
    max-height: 100%;
    min-width: 0;
    overflow: hidden;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
}

.workSpace--reports {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
}

.toolColumn {
    flex: 0 0 64px;
    width: 64px;
    background: #252526;
    border-right: 1px solid #323232;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px 10px;
    box-sizing: border-box;
}

.toolColumn_btn {
    width: 44px;
    height: 44px;
    border: 1px solid #3d3d3d;
    background: #262626;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
    padding: 0;
}

.toolColumn_btn svg {
    width: 33px;
    height: 33px;
}

.toolColumn_btn--chat {
    margin-top: auto;
}

.toolColumn_btn:hover {
    background: #2f2f2f;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.toolColumn_btn:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.mainContent > * {
    min-height: 0;
}

@media (max-width: 900px) {
    .mainContent {
        flex-direction: column;
    }
    .toolColumn {
        flex-direction: row;
        width: 100%;
        flex: 0 0 auto;
        border-right: none;
        border-bottom: 1px solid #323232;
        justify-content: flex-start;
    }
    .toolColumn_btn {
        transform: none;
    }
    .toolColumn_btn--chat {
        margin-top: 0;
        margin-left: auto;
    }
    .workSpace {
        width: 100%;
        flex: 1 1 auto;
    }
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportViewerContent {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    min-width: 0;
}

.reportViewerHeader {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reportTab {
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 0;
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportTab.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(59, 130, 246, 0.5);
}


.reportTitle {
    margin: 0;
    font-size: 18px;
    color: #f9fafb;
}

.reportViewerTimestamp {
    margin: 0;
    font-size: 12px;
    color: #a5b4fc;
}

.reportBody {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
    max-height: 100%;
}

.reportStructured {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1 1 auto;
    min-height: 0;
}

.reportStructuredToggle {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.reportStructuredToggleButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportStructuredToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.28), rgba(14, 165, 233, 0.28));
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportStructuredToggleButton:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.reportSummaryGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    width: 100%;
}

.reportSummaryCard {
    border: 1px solid #2f2f2f;
    background: #1f1f1f;
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    word-break: break-word;
}

.reportSummaryCard--total {
    background: #1f1f1f;
    border-color: #2f2f2f;
}

.reportSummaryCard--span {
    grid-column: 1 / -1;
}

@media (max-width: 720px) {
    .reportSummaryCard--span {
        grid-column: span 1;
    }
}

.reportSummaryLabel {
    font-size: 12px;
    font-weight: 600;
    color: #cbd5f5;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.reportSummaryValue {
    font-size: 28px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1;
}

.reportSummaryText {
    margin: 0;
    font-size: 13px;
    color: #e2e8f0;
    line-height: 1.5;
}

.reportSummaryList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportSummaryItemLabel {
    font-weight: 600;
    margin-right: 6px;
}

.reportSummaryItemValue {
    color: #cbd5f5;
}

.reportSummarySources {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportSummarySource {
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(30, 41, 59, 0.32);
}

.reportSummarySourceHeading {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.reportSummarySourceStatus {
    font-size: 12px;
    font-weight: 600;
    color: #38bdf8;
    text-transform: uppercase;
}

.reportSummarySourceMetrics {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
    font-size: 13px;
    color: #e2e8f0;
    word-break: break-word;
}

.reportSummarySourceMetrics li {
    display: flex;
    gap: 6px;
}

.reportSummarySourceError {
    margin: 0;
    font-size: 12px;
    color: #f87171;
}

.reportStaticSection {
    margin-top: 24px;
    padding: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(30, 41, 59, 0.32);
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportStaticHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}

.reportStaticHeader h4 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #f8fafc;
}

.reportStaticEngine {
    font-size: 12px;
    color: #94a3b8;
}

.reportStaticBlock {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.reportStaticBlock h5 {
    margin: 0;
    font-size: 13px;
    color: #cbd5f5;
    text-transform: none;
    letter-spacing: 0.02em;
}

.reportStaticList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportStaticItemLabel {
    font-weight: 600;
    margin-right: 6px;
}

.reportStaticItemValue {
    color: #cbd5f5;
}

.reportDmlSection {
    margin-top: 24px;
    padding: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.4);
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportDmlHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}

.reportDmlHeader h4 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #f8fafc;
}

.reportDmlStatus {
    font-size: 12px;
    font-weight: 600;
    color: #22d3ee;
    text-transform: uppercase;
}

.reportDmlTimestamp {
    font-size: 12px;
    color: #94a3b8;
}

.reportDmlError {
    margin: 0;
    color: #f87171;
    font-size: 13px;
}

.reportDmlSegments {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportDmlSegment {
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.35);
}

.reportDmlSegment summary {
    cursor: pointer;
    padding: 8px 12px;
    font-weight: 600;
    color: #e2e8f0;
}

.reportDmlSegment pre {
    margin: 0;
    padding: 12px;
    font-size: 13px;
}

.reportDmlSql {
    background: rgba(15, 23, 42, 0.55);
    color: #e0f2fe;
}

.reportDmlAnalysis {
    background: rgba(8, 47, 73, 0.55);
    color: #fef9c3;
}

.reportDmlSummary {
    margin: 0;
    font-size: 13px;
    background: rgba(15, 23, 42, 0.65);
    color: #cbd5f5;
    border-radius: 6px;
    padding: 12px;
}

.reportDmlEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}


.reportIssuesSection {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 0 0 auto;
    min-height: 0;
    align-self: stretch;
}


.reportIssuesHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.reportIssuesHeaderInfo {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.reportIssuesToggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.reportIssuesToggleButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportIssuesToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.28), rgba(14, 165, 233, 0.28));
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportIssuesToggleButton:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.reportIssuesContent {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportIssuesHeader h4 {
    margin: 0;
    font-size: 16px;
    color: #f8fafc;
}

.reportIssuesTotal {
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesNotice {
    padding: 10px 14px;
    border-radius: 6px;
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 13px;
}

.reportIssuesNotice--error {
    background: rgba(248, 113, 113, 0.12);
    color: #fda4af;
}

.reportIssuesNotice--warning {
    background: rgba(250, 204, 21, 0.12);
    color: #facc15;
}

.reportRow {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    background: #1b1b1b;
    display: flex;
    flex-direction: column;
}

.reportRowActions {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px 0;
    gap: 8px;
}

.reportRowActionButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportRowActionButton:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportRowActionButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.reportRowContent {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #e2e8f0;
    background: transparent;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 800px;
}

.reportRowContent.codeScroll {
    overflow: visible;
    max-height: none;
}

.reportRowNotice {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesRow .reportRowContent {
    padding: 0;
}

.reportIssuesRow .reportRowContent.codeScroll {
    display: flex;
    flex-direction: column;
}

.reportIssuesRow .codeEditor {
    padding: 4px 0;
}

.reportIssuesRow .codeLine {
    border-left: 3px solid transparent;
    padding: 2px 0;
}

.reportIssuesRow .codeLine--issue {
    background: rgba(248, 113, 113, 0.12);
    border-left-color: rgba(248, 113, 113, 0.65);
}

.codeLineNo--issue {
    color: #fca5a5;
}

.codeLineContent--issueHighlight {
    color: #fee2e2;
    background: rgba(248, 113, 113, 0.08);
}

.reportIssuesRow .codeLine--meta {
    background: rgba(15, 23, 42, 0.92);
    border-left-color: rgba(148, 163, 184, 0.4);
}

.reportIssuesRow .codeLine--issuesMeta {
    background: rgba(251, 146, 60, 0.18);
    border-left-color: rgba(251, 146, 60, 0.55);
}

.reportIssuesRow .codeLine--fixMeta {
    background: rgba(56, 189, 248, 0.14);
    border-left-color: rgba(56, 189, 248, 0.5);
}

.codeLineNo--meta {
    color: #cbd5f5;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-right: 0;
}

.codeLineNo--meta::before {
    content: "";
}

.codeLineNo--issues {
    color: #f97316;
}

.codeLineNo--fix {
    color: #38bdf8;
}

.codeLineNoIcon {
    width: 16px;
    height: 16px;
    fill: currentColor;
    display: block;
}

.codeLineNoIcon--warning {
    color: inherit;
}

.codeLineContent--issues,
.codeLineContent--fix {
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
}

.codeLineContent--issues {
    color: #fed7aa;
}

.codeLineContent--fix {
    color: #bae6fd;
}

.reportIssueInlineRow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
    margin: 0 0 6px;
    color: #f8fafc;
}

.reportIssueInlineRow:last-child {
    margin-bottom: 0;
}

.reportIssueInlineRow--empty {
    color: #cbd5f5;
    font-style: italic;
}

.reportIssueInlineCode {
    width: 100%;
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--code-font, "JetBrains Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    color: #e2e8f0;
    background-clip: padding-box;
}

.reportIssueInlineCode code {
    font-family: inherit;
}

.reportIssueInlineBadges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #cbd5f5;
}

.reportIssueInlineIndex {
    color: #bfdbfe;
}

.reportIssueInlineRule {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.2);
    color: #bfdbfe;
    font-weight: 600;
}

.reportIssueInlineSeverity {
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
    border: 1px solid transparent;
}

.reportIssueInlineSeverity--error {
    background: rgba(248, 113, 113, 0.18);
    color: #fca5a5;
    border-color: rgba(248, 113, 113, 0.35);
}

.reportIssueInlineSeverity--warn {
    background: rgba(234, 179, 8, 0.2);
    color: #facc15;
    border-color: rgba(234, 179, 8, 0.35);
}

.reportIssueInlineSeverity--info {
    background: rgba(59, 130, 246, 0.2);
    color: #bfdbfe;
    border-color: rgba(59, 130, 246, 0.35);
}

.reportIssueInlineSeverity--muted {
    background: rgba(148, 163, 184, 0.2);
    color: #cbd5f5;
    border-color: rgba(148, 163, 184, 0.35);
}

.reportIssueInlineLine {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.25);
    color: #cbd5f5;
    font-weight: 600;
}

.reportIssueInlineMessage {
    flex: 1 1 220px;
    min-width: 200px;
    font-weight: 600;
}

.reportIssueInlineMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: #cbd5f5;
}

.reportIssueInlineObject {
    font-weight: 600;
}

.reportIssueInlineColumn {
    color: #e2e8f0;
}

.reportIssuesEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}

.reportRaw {
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    background: #111827;
    padding: 10px 14px;
}

.reportRaw > summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    color: #cbd5f5;
}

.reportRaw > summary::marker {
    color: #94a3b8;
}

.reportErrorPanel {
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    border: 1px solid rgba(248, 113, 113, 0.3);
    background: rgba(248, 113, 113, 0.08);
    color: #fda4af;
}

.reportErrorText {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.reportErrorHint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #fecaca;
}

.reportChunks {
    margin-top: 16px;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    background: #111827;
    padding: 12px 16px;
    color: #e2e8f0;
}

.reportChunks > summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
}

.reportChunkList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportChunkTitle {
    margin: 0 0 6px;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkBody {
    margin: 0;
    padding: 12px;
    border-radius: 4px;
    border: 1px solid #2f2f2f;
    background: #1b1b1b;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
}

.reportViewerPlaceholder {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.pvHeader {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.2;
}

.pvName {
    font-size: 16px;
    font-weight: 600;
    color: #f3f4f6;
    word-break: break-all;
}

.pvMeta {
    font-size: 12px;
    color: #94a3b8;
}

.pvBox {
    flex: 1 1 auto;
    background: #1b1b1b;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    padding: 12px;
    overflow: hidden;
    display: flex;
}

.pvBox:not(.codeBox) {
    overflow: auto;
}

.pvBox.codeBox {
    padding: 12px;
    overflow: hidden;
}

.pvBox.codeBox.reportIssuesBox,
.pvBox.codeBox.reportIssuesBox .codeScroll {
    overflow: visible;
    max-height: none;
}

.codeScroll {
    flex: 1 1 auto;
    overflow: auto;
    max-height: 100%;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #d1d5db;
    background: #1b1b1b;
    cursor: text;
}

.reportBody.codeScroll,
.reportChunkBody.codeScroll {
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeEditor {
    display: block;
    width: 100%;
    min-width: 0;
    outline: none;
    caret-color: transparent;
}

.codeEditor:focus {
    outline: none;
}

.codeLine {
    display: flex;
    align-items: flex-start;
    width: 100%;
}

.codeLineNo {
    position: relative;
    flex: 0 0 auto;
    width: 3.5ch;
    padding: 0 12px 0 0;
    text-align: right;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
    user-select: none;
}

.codeLineNo::before {
    content: attr(data-line);
    display: block;
}

.codeLineContent {
    flex: 1 1 auto;
    display: block;
    width: 100%;
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    min-width: 0;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeSelectionHighlight {
    background: rgba(59, 130, 246, 0.35);
    color: #f8fafc;
    border-radius: 2px;
}

.reportBody::selection,
.reportBody *::selection,
.reportChunkBody::selection,
.reportChunkBody *::selection,
.codeScroll::selection,
.codeScroll *::selection,
.codeLineContent::selection,
.codeLineContent *::selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}

.reportBody::-moz-selection,
.reportBody *::-moz-selection,
.reportChunkBody::-moz-selection,
.reportChunkBody *::-moz-selection,
.codeScroll::-moz-selection,
.codeScroll *::-moz-selection,
.codeLineContent::-moz-selection,
.codeLineContent *::-moz-selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}


.modalBackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}

.modalCard {
    width: 520px;
    max-width: 90vw;
    background: #252526;
    color: #e5e7eb;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .6);
}

.modalCard h3 {
    margin: 0 0 6px;
}

.modalCard p {
    margin: 6px 0 12px;
    opacity: .9;
}

.dropZone {
    border: 2px dashed #3d3d3d;
    border-radius: 10px;
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    user-select: none;
}

.dropZone:hover {
    background: #2a2a2a;
}

.modalBtns {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3d3d3d;
    background: #007acc;
    color: #fff;
    cursor: pointer;
}

.btn:hover {
    filter: brightness(1.1);
}

.btn.ghost {
    background: transparent;
    color: #e5e7eb;
}

.btn.outline {
    background: transparent;
    color: #e5e7eb;
    border-color: #4b5563;
}
</style>






































































