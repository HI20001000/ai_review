<script setup>
import { computed, ref, useSlots } from "vue";
import TreeNode from "./TreeNode.vue";

const props = defineProps({
    styleWidth: {
        type: Object,
        required: true
    },
    mode: {
        type: String,
        default: "projects"
    },
    projects: {
        type: Array,
        default: () => []
    },
    selectedProjectId: {
        type: [String, Number],
        default: null
    },
    onSelectProject: {
        type: Function,
        required: true
    },
    onDeleteProject: {
        type: Function,
        required: true
    },
    tree: {
        type: Array,
        default: () => []
    },
    activeTreePath: {
        type: String,
        default: ""
    },
    isLoadingTree: {
        type: Boolean,
        default: false
    },
    openNode: {
        type: Function,
        required: true
    },
    selectTreeNode: {
        type: Function,
        required: true
    },
    isTreeCollapsed: {
        type: Boolean,
        default: false
    },
    showContent: {
        type: Boolean,
        default: true
    }
});

const emit = defineEmits(["resizeStart"]);

const slots = useSlots();

const isProjectsMode = computed(() => props.mode === "projects");
const hasCustomContent = computed(() => !!slots.default);

const hasProjects = computed(() => (props.projects || []).length > 0);
const hasSelectedProject = computed(
    () => props.selectedProjectId !== null && props.selectedProjectId !== undefined
);
const hasTreeNodes = computed(() => Array.isArray(props.tree) && props.tree.length > 0);
const shouldShowTreeList = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        hasTreeNodes.value &&
        !props.isLoadingTree
);
const shouldShowTreeLoading = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        props.isLoadingTree
);
const shouldShowEmptyTree = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        !props.isLoadingTree &&
        !hasTreeNodes.value
);

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
    <section
        class="panelRail"
        :class="{ 'panelRail--resizeEdge': isHoveringResizeEdge }"
        :style="styleWidth"
        @pointermove="handlePointerMove"
        @pointerleave="handlePointerLeave"
        @pointerdown="handlePointerDown"
    >
        <template v-if="showContent">
            <template v-if="!isProjectsMode && hasCustomContent">
                <slot />
            </template>
            <template v-else>
                <div class="projectPanel">
                    <div class="panelHeader">Projects</div>
                    <template v-if="hasProjects">
                        <ul class="projectList">
                            <li
                                v-for="p in projects"
                                :key="p.id"
                                :class="['projectItem', { active: p.id === selectedProjectId }]"
                            >
                                <div class="projectHeader" @click="onSelectProject(p)">
                                    <span class="projName">{{ p.name }}</span>
                                    <span class="rightSide">
                                        <span class="badge" :title="p.mode">{{ p.mode }}</span>
                                        <button
                                            class="delBtn"
                                            title="Delete project (DB only)"
                                            @click.stop="onDeleteProject($event, p)"
                                        >
                                            ❌
                                        </button>
                                    </span>
                                </div>
                            </li>
                        </ul>
                    </template>
                    <p v-else class="emptyProjects">尚未匯入任何專案。</p>
                </div>

                <div
                    v-if="hasSelectedProject"
                    class="treeArea"
                    :class="{ collapsed: isTreeCollapsed }"
                >
                    <div class="panelHeader">Project Files</div>
                    <div v-if="isTreeCollapsed" class="collapsedNotice">檔案樹已折疊，點擊專案可再次展開。</div>
                    <div v-else-if="shouldShowTreeLoading" class="loading">Loading...</div>
                    <ul v-else-if="shouldShowTreeList" class="treeRoot">
                        <TreeNode
                            v-for="n in tree"
                            :key="n.path"
                            :node="n"
                            :active-path="activeTreePath"
                            @open="openNode"
                            @select="selectTreeNode"
                        />
                    </ul>
                    <p v-else-if="shouldShowEmptyTree" class="emptyTree">尚未載入任何檔案。</p>
                </div>

                <div v-else class="treePlaceholder">
                    <div class="panelHeader">Project Files</div>
                    <p class="emptyTree">請先選擇左側的專案以載入檔案。</p>
                </div>
            </template>
        </template>

        <div v-else class="panelEmpty">
            <div class="panelHeader">工具列</div>
            <p class="emptyTree">選擇左側的工具以顯示內容。</p>
        </div>
    </section>
</template>

<style scoped>
.panelRail {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    height: 100%;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 0;
    box-sizing: border-box;
    overflow: hidden;
    position: relative;
}

.panelRail--resizeEdge {
    cursor: col-resize;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    margin-bottom: 12px;
}

.projectPanel {
    flex: 0 0 auto;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.projectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 220px;
    overflow: auto;
}

.projectItem {
    background: #202020;
    border: 1px solid #303134;
    border-radius: 0;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    transition: border-color 0.2s ease, background-color 0.2s ease;
}

.projectItem.active {
    border-color: #2b4b63;
    background: #1f2d3c;
}

.projectHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    color: #e5e7eb;
    cursor: pointer;
}

.projName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rightSide {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.badge {
    font-size: 12px;
    opacity: 0.6;
}

.delBtn {
    background: transparent;
    border: none;
    color: #fca5a5;
    font-size: 14px;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 0;
    cursor: pointer;
}

.delBtn:hover {
    background: #3a2a2a;
    color: #fecaca;
}

.emptyProjects {
    margin: 0;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
}

.treeArea,
.treePlaceholder {
    flex: 1 1 auto;
    min-width: 0;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.panelEmpty {
    flex: 1 1 auto;
    min-width: 0;
    background: #252526;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 8px;
    text-align: center;
}

.treeArea.collapsed {
    justify-content: flex-start;
}

.treeArea .panelHeader,
.treePlaceholder .panelHeader {
    margin-bottom: 12px;
}

.treeArea .loading {
    padding: 10px;
    opacity: 0.8;
}

.emptyTree {
    margin: 0;
    color: rgba(255, 255, 255, 0.7);
}

.collapsedNotice {
    margin: 0;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.4;
}

.treeArea .treeRoot {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
    overflow: auto;
}

:deep(.treeChildren) {
    list-style: none;
    margin: 0;
    padding-left: 16px;
}

:deep(.treeRow) {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 0;
    cursor: pointer;
}

:deep(.treeRow.active) {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 0;
}

:deep(.treeRow .icon) {
    width: 20px;
    text-align: center;
}

@media (max-width: 900px) {
    .panelRail {
        width: 100% !important;
        flex: 1 1 auto !important;
    }
}
</style>
