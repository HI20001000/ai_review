<script setup>
import { computed, ref } from "vue";
import ReportTreeNode from "./ReportTreeNode.vue";

const props = defineProps({
    styleWidth: {
        type: Object,
        required: true
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

const EDGE_THRESHOLD = 8;

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
    updateResizeHoverState(event);
}

function handlePointerLeave() {
    isHoveringResizeEdge.value = false;
}

function handlePointerDown(event) {
    const hovering = updateResizeHoverState(event);
    if (!hovering) return;
    emit("resizeStart", event);
}
</script>

<template>
    <aside
        class="reportProjects"
        :class="{
            'reportProjects--hoverEdge': isHoveringResizeEdge,
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
                    class="reportProjectItem"
                >
                    <div class="projectHeader">
                        <span class="projName" :title="entry.project.name">{{ entry.project.name }}</span>
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
    border: 1px solid #323232;
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

.projName {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    color: #f3f4f6;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
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
