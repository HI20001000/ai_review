<script setup>
import { computed } from "vue";

defineOptions({ name: "ReportTreeNode" });

const props = defineProps({
    node: { type: Object, required: true },
    project: { type: Object, required: true },
    projectId: { type: String, required: true },
    isExpanded: { type: Function, required: true },
    toggle: { type: Function, required: true },
    getState: { type: Function, required: true },
    onGenerate: { type: Function, required: true },
    onSelect: { type: Function, required: true },
    getStatusLabel: { type: Function, required: true },
    activeTarget: { type: Object, default: null }
});

const isDirectory = computed(() => props.node.type === "dir");
const isFile = computed(() => props.node.type === "file");

const fileState = computed(() => {
    if (!isFile.value) return null;
    return props.getState(props.projectId, props.node.path);
});

const statusLabel = computed(() => {
    if (!fileState.value) return "";
    return props.getStatusLabel(fileState.value.status);
});

const issueTooltip = computed(() => {
    if (!isFile.value) return "";
    const summary = fileState.value?.issueSummary;
    if (!summary || !summary.raw) return "";

    const lines = [];
    const total = summary.totalIssues;
    if (Number.isFinite(total)) {
        lines.push(`總問題：${total}`);
    }

    const raw = summary.raw || {};
    const issues = Array.isArray(raw.issues) ? raw.issues : [];
    const ruleCounts = new Map();
    const severityCounts = new Map();

    if (issues.length) {
        for (const issue of issues) {
            const severityKey = typeof issue?.severity === "string"
                ? issue.severity.trim().toUpperCase()
                : "未標示";
            const severity = severityKey || "未標示";
            severityCounts.set(severity, (severityCounts.get(severity) || 0) + 1);

            const rule =
                (typeof issue?.rule_id === "string" && issue.rule_id.trim()) ||
                (typeof issue?.ruleId === "string" && issue.ruleId.trim()) ||
                (typeof issue?.rule === "string" && issue.rule.trim()) ||
                "未分類";
            ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1);
        }
    } else if (raw?.summary && typeof raw.summary === "object") {
        const byRule = raw.summary.by_rule || raw.summary.byRule;
        if (byRule && typeof byRule === "object") {
            for (const [rule, value] of Object.entries(byRule)) {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) continue;
                const ruleName = rule && typeof rule === "string" ? rule : "未分類";
                ruleCounts.set(ruleName, numeric);
            }
        }
    }

    if (severityCounts.size) {
        const severityParts = Array.from(severityCounts.entries()).map(
            ([key, count]) => `${key} ${count}`
        );
        if (severityParts.length) {
            lines.push(`嚴重度：${severityParts.join("，")}`);
        }
    }

    if (ruleCounts.size) {
        const ruleParts = Array.from(ruleCounts.entries()).map(
            ([rule, count]) => `${rule} (${count})`
        );
        if (ruleParts.length) {
            lines.push(`規則：${ruleParts.join("，")}`);
        }
    }

    return lines.join("\n");
});

const hasChildren = computed(
    () => Array.isArray(props.node.children) && props.node.children.length > 0
);

const isNodeExpanded = computed(() => {
    if (!isDirectory.value) return false;
    return props.isExpanded(props.projectId, props.node.path);
});

const icon = computed(() => {
    if (isDirectory.value) {
        return isNodeExpanded.value ? "📂" : "📁";
    }
    return "📄";
});

const isActive = computed(() => {
    if (!props.activeTarget || !isFile.value) return false;
    return (
        props.activeTarget.projectId === props.projectId &&
        props.activeTarget.path === props.node.path
    );
});

const statusClass = computed(() => {
    if (!fileState.value) return "";
    return `statusBadge--${fileState.value.status}`;
});

const isProcessing = computed(() => fileState.value?.status === "processing");
const isReady = computed(() => fileState.value?.status === "ready");
const isError = computed(() => fileState.value?.status === "error");
const isViewable = computed(() => isReady.value || isError.value);

function handleToggle() {
    if (!isDirectory.value) return;
    props.toggle(props.projectId, props.node.path);
}

function handleRowClick() {
    if (isDirectory.value) {
        handleToggle();
        return;
    }
    if (isViewable.value) {
        props.onSelect(props.projectId, props.node.path);
    }
}

function handleGenerate(event) {
    event?.stopPropagation?.();
    props.onGenerate(props.project, props.node);
}

function handleSelect(event) {
    event?.stopPropagation?.();
    props.onSelect(props.projectId, props.node.path);
}
</script>

<template>
    <li :class="['reportTreeNode', `reportTreeNode--${node.type}`]">
        <div
            class="reportTreeRow"
            :class="{ 'reportTreeRow--active': isActive }"
            @click="handleRowClick"
        >
            <button
                v-if="isDirectory"
                type="button"
                class="reportTreeCaret"
                @click.stop="handleToggle"
                :aria-label="isNodeExpanded ? '收合資料夾' : '展開資料夾'"
                :aria-expanded="isNodeExpanded"
            >
                <span v-if="isNodeExpanded">▾</span>
                <span v-else>▸</span>
            </button>
            <span v-else class="reportTreeCaret reportTreeCaret--placeholder"></span>
            <span class="reportTreeIcon">{{ icon }}</span>
            <span class="reportTreeLabel" :title="node.path">{{ node.name }}</span>
            <template v-if="isFile && fileState">
                <span
                    class="statusBadge"
                    :class="statusClass"
                    :title="issueTooltip || null"
                >
                    {{ statusLabel }}
                </span>
                <button
                    type="button"
                    class="reportActionBtn"
                    :disabled="isProcessing"
                    @click="handleGenerate"
                >
                    <span v-if="isProcessing">處理中...</span>
                    <span v-else-if="isReady">重新生成</span>
                    <span v-else>生成報告</span>
                </button>
                <button
                    v-if="isViewable"
                    type="button"
                    class="reportViewBtn"
                    @click="handleSelect"
                >
                    {{ isError ? "檢視錯誤" : "查看" }}
                </button>
            </template>
        </div>
        <p
            v-if="isFile && fileState?.status === 'error' && fileState?.error"
            class="reportErrorMessage"
        >
            {{ fileState.error }}
        </p>
        <p v-if="isFile && fileState?.status === 'ready' && fileState?.updatedAtDisplay" class="reportTimestamp">
            最後更新：{{ fileState.updatedAtDisplay }}
        </p>
        <ul v-if="isDirectory && hasChildren && isNodeExpanded" class="reportFileTreeChildren">
            <ReportTreeNode
                v-for="child in node.children"
                :key="child.path"
                :node="child"
                :project="project"
                :project-id="projectId"
                :is-expanded="isExpanded"
                :toggle="toggle"
                :get-state="getState"
                :on-generate="onGenerate"
                :on-select="onSelect"
                :get-status-label="getStatusLabel"
                :active-target="activeTarget"
            />
        </ul>
    </li>
</template>

<style scoped>
.reportTreeNode {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTreeRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    border-radius: 6px;
    transition: background 0.2s ease;
}

.reportTreeRow:hover {
    background: rgba(148, 163, 184, 0.08);
}

.reportTreeRow--active {
    background: rgba(59, 130, 246, 0.18);
}

.reportTreeCaret {
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 13px;
    user-select: none;
}

.reportTreeCaret--placeholder {
    cursor: default;
}

.reportTreeIcon {
    width: 20px;
    text-align: center;
    font-size: 16px;
}

.reportTreeLabel {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.statusBadge {
    flex: 0 0 auto;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.statusBadge--idle {
    background: rgba(148, 163, 184, 0.18);
    color: #cbd5f5;
}

.statusBadge--processing {
    background: rgba(251, 191, 36, 0.2);
    color: #facc15;
}

.statusBadge--ready {
    background: rgba(34, 197, 94, 0.2);
    color: #4ade80;
}

.statusBadge--error {
    background: rgba(248, 113, 113, 0.2);
    color: #f87171;
}

.reportActionBtn {
    flex: 0 0 auto;
    padding: 6px 12px;
    border-radius: 0;
    border: 1px solid #2563eb;
    background: linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(14, 165, 233, 0.18));
    color: #bfdbfe;
    font-size: 12px;
    cursor: pointer;
    transition: transform 0.2s ease, background 0.2s ease;
}

.reportActionBtn:hover {
    transform: translateY(-1px);
    background: linear-gradient(135deg, rgba(37, 99, 235, 0.28), rgba(14, 165, 233, 0.28));
}

.reportActionBtn:disabled {
    cursor: progress;
    opacity: 0.7;
    transform: none;
    background: rgba(148, 163, 184, 0.12);
    border-color: rgba(148, 163, 184, 0.3);
    color: #cbd5f5;
}

.reportViewBtn {
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s ease;
}

.reportViewBtn:hover {
    background: rgba(148, 163, 184, 0.2);
}

.reportErrorMessage {
    margin: 0;
    font-size: 12px;
    color: #f87171;
    padding-left: 54px;
}

.reportTimestamp {
    margin: 0;
    font-size: 11px;
    color: #94a3b8;
    padding-left: 54px;
}

.reportFileTreeChildren {
    list-style: none;
    margin: 4px 0 0 22px;
    padding: 0 0 0 16px;
    border-left: 1px dashed rgba(148, 163, 184, 0.25);
    display: flex;
    flex-direction: column;
    gap: 6px;
}
</style>
