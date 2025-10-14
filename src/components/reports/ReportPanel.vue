<script setup>
import { computed, ref, watch } from "vue";
import ReportTreeNode from "./ReportTreeNode.vue";

const props = defineProps({
    styleWidth: {
        type: Object,
        required: true
    },
    enableResizeEdge: {
        type: Boolean,
        default: true
    },
    entries: {
        type: Array,
        default: () => []
    },
    normaliseProjectId: {
        type: Function,
        required: true
    },
    isNodeExpanded: {
        type: Function,
        required: true
    },
    toggleNode: {
        type: Function,
        required: true
    },
    getReportState: {
        type: Function,
        required: true
    },
    onGenerate: {
        type: Function,
        required: true
    },
    onSelect: {
        type: Function,
        required: true
    },
    getStatusLabel: {
        type: Function,
        required: true
    },
    onReloadProject: {
        type: Function,
        required: true
    },
    onGenerateProject: {
        type: Function,
        required: true
    },
    getProjectBatchState: {
        type: Function,
        required: true
    },
    getProjectIssueCount: {
        type: Function,
        default: null
    },
    activeTarget: {
        type: Object,
        default: null
    },
    isResizing: {
        type: Boolean,
        default: false
    }
});

const emit = defineEmits(["resizeStart"]);

const hasEntries = computed(() => (props.entries || []).length > 0);

const isHoveringResizeEdge = ref(false);
const showHoverEdge = computed(() => props.enableResizeEdge && isHoveringResizeEdge.value);

const EDGE_THRESHOLD = 8;

const collapsedProjects = ref({});

watch(
    () => (props.entries || []).map((entry) => props.normaliseProjectId(entry?.project?.id)).filter(Boolean),
    (ids) => {
        const next = {};
        ids.forEach((id) => {
            if (!id) return;
            const current = collapsedProjects.value[id];
            next[id] = typeof current === "boolean" ? current : true;
        });
        collapsedProjects.value = next;
    },
    { immediate: true }
);

function isProjectCollapsed(projectId) {
    const key = props.normaliseProjectId(projectId);
    if (!key) return false;
    const map = collapsedProjects.value;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
        return Boolean(map[key]);
    }
    return true;
}

function setProjectCollapsed(projectId, collapsed) {
    const key = props.normaliseProjectId(projectId);
    if (!key) return;
    collapsedProjects.value = {
        ...collapsedProjects.value,
        [key]: Boolean(collapsed)
    };
}

function toggleProjectCollapsed(projectId) {
    setProjectCollapsed(projectId, !isProjectCollapsed(projectId));
}

function projectIssueCount(projectId) {
    if (typeof props.getProjectIssueCount !== "function") {
        return null;
    }
    const value = props.getProjectIssueCount(projectId);
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return null;
}

function updateResizeHoverState(event) {
    const panel = event.currentTarget;
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const hovering = rect.width - offsetX <= EDGE_THRESHOLD;
    if (isHoveringResizeEdge.value !== hovering) {
        isHoveringResizeEdge.value = hovering;
    }
    return hovering;
}

function handlePointerMove(event) {
    if (!props.enableResizeEdge) return;
    updateResizeHoverState(event);
}

function handlePointerLeave() {
    isHoveringResizeEdge.value = false;
}

function handlePointerDown(event) {
    if (!props.enableResizeEdge) return;
    const hovering = updateResizeHoverState(event);
    if (!hovering) return;
    emit("resizeStart", event);
}

function handleGenerateProject(event, project) {
    event?.stopPropagation?.();
    props.onGenerateProject(project);
}

function isBatchRunning(projectId) {
    const state = props.getProjectBatchState(projectId);
    return Boolean(state?.running);
}

function batchProgress(projectId) {
    const state = props.getProjectBatchState(projectId);
    if (!state?.running) return "";
    return `${state.processed}/${state.total}`;
}

watch(
    () => props.enableResizeEdge,
    (enabled) => {
        if (!enabled) {
            isHoveringResizeEdge.value = false;
        }
    }
);
</script>

<template>
    <aside
        class="reportProjects"
        :class="{
            'reportProjects--hoverEdge': showHoverEdge,
            'reportProjects--resizing': isResizing
        }"
        :style="styleWidth"
        @pointermove="handlePointerMove"
        @pointerleave="handlePointerLeave"
        @pointerdown="handlePointerDown"
    >
        <div class="panelHeader">代碼審查</div>
        <template v-if="hasEntries">
            <ul class="reportProjectList">
                <li
                    v-for="entry in entries"
                    :key="entry.project.id"
                    :class="[
                        'reportProjectItem',
                        { 'reportProjectItem--collapsed': isProjectCollapsed(entry.project.id) }
                    ]"
                >
                    <div class="projectHeader">
                        <button
                            type="button"
                            class="projectToggle"
                            :aria-expanded="!isProjectCollapsed(entry.project.id)"
                            :title="isProjectCollapsed(entry.project.id) ? '展開專案' : '收合專案'"
                            @click.stop="toggleProjectCollapsed(entry.project.id)"
                        >
                            <span class="projectToggleIcon" :class="{ 'projectToggleIcon--collapsed': isProjectCollapsed(entry.project.id) }"></span>
                        </button>
                        <span class="projName" :title="entry.project.name">{{ entry.project.name }}</span>
                        <span
                            v-if="projectIssueCount(entry.project.id) !== null"
                            class="projectIssueBadge"
                        >
                            問題 {{ projectIssueCount(entry.project.id) }}
                        </span>
                        <button
                            type="button"
                            class="reportBatchBtn"
                            :disabled="entry.cache.loading || isBatchRunning(entry.project.id)"
                            @click="handleGenerateProject($event, entry.project)"
                        >
                            <span v-if="isBatchRunning(entry.project.id)">
                                批次生成中 {{ batchProgress(entry.project.id) }}
                            </span>
                            <span v-else>一鍵生成</span>
                        </button>
                        <button
                            v-if="entry.cache.error"
                            type="button"
                            class="reportRetryBtn"
                            @click.stop="onReloadProject(entry.project.id)"
                        >
                            重新載入
                        </button>
                        <span v-else-if="entry.cache.loading" class="reportMeta">載入中…</span>
                    </div>
                    <div v-if="!isProjectCollapsed(entry.project.id)" class="reportProjectBody">
                        <p v-if="entry.cache.error" class="reportError">無法載入：{{ entry.cache.error }}</p>
                        <div v-else-if="entry.cache.loading" class="reportLoading">正在載入檔案清單…</div>
                        <p v-else-if="!entry.cache.nodes.length" class="reportEmpty">此專案尚未索引任何檔案。</p>
                        <div v-else class="reportTreeWrapper">
                            <ul class="reportFileTree">
                                <ReportTreeNode
                                    v-for="node in entry.cache.nodes"
                                    :key="node.path"
                                    :node="node"
                                    :project="entry.project"
                                    :project-id="normaliseProjectId(entry.project.id)"
                                    :is-expanded="isNodeExpanded"
                                    :toggle="toggleNode"
                                    :get-state="getReportState"
                                    :on-generate="onGenerate"
                                    :on-select="onSelect"
                                    :get-status-label="getStatusLabel"
                                    :active-target="activeTarget"
                                />
                            </ul>
                        </div>
                    </div>
                </li>
            </ul>
        </template>
        <p v-else class="emptyProjects">尚未匯入任何專案。</p>
    </aside>
</template>

<style scoped>
.reportProjects {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #191919;
    padding: 16px;
    overflow-y: auto;
    border-radius: 0;
    box-sizing: border-box;
    min-width: 260px;
    position: relative;
}

.reportProjects--hoverEdge,
.reportProjects--resizing {
    cursor: col-resize;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportProjectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportProjectItem {
    border: 1px solid #2f2f2f;
    border-radius: 0;
    background: #202020;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.projectHeader {
    display: flex;
    align-items: center;
    gap: 12px;
}

.projectToggle {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    padding: 0;
    transition: color 0.2s ease;
}

.projectToggle:hover {
    color: #cbd5f5;
}

.projectToggleIcon {
    display: inline-block;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 8px solid currentColor;
    transition: transform 0.2s ease;
}

.projectToggleIcon--collapsed {
    transform: rotate(-90deg);
}

.projName {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    color: #f3f4f6;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
}

.reportBatchBtn {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid #334155;
    background: #1f2937;
    color: #cbd5f5;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.projectIssueBadge {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 9999px;
    border: 1px solid #4b5563;
    background: #111827;
    color: #fbbf24;
    white-space: nowrap;
}

.reportProjectItem--collapsed {
    gap: 4px;
}

.reportProjectBody {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportBatchBtn:hover {
    background: #2563eb;
    border-color: #1d4ed8;
    color: #fff;
}

.reportBatchBtn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    background: #1e293b;
    color: #94a3b8;
    border-color: #1e293b;
}

.reportMeta {
    margin-left: auto;
    font-size: 12px;
    color: #94a3b8;
}

.reportRetryBtn {
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 0;
    border: 1px solid rgba(239, 68, 68, 0.5);
    background: rgba(239, 68, 68, 0.1);
    color: #fca5a5;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportRetryBtn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(248, 113, 113, 0.7);
}

.reportLoading,
.reportEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}

.reportError {
    margin: 0;
    font-size: 13px;
    color: #f87171;
}

.reportTreeWrapper {
    border-top: 1px solid #2f2f2f;
    padding-top: 8px;
}

.reportFileTree {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.emptyProjects {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}
</style>
