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
    getStatusLabel: { type: Function, required: true }
});

const fileState = computed(() => {
    if (props.node.type !== "file") return null;
    return props.getState(props.projectId, props.node.path);
});

const statusLabel = computed(() => {
    if (!fileState.value) return "";
    return props.getStatusLabel(fileState.value.status);
});

const hasChildren = computed(
    () => Array.isArray(props.node.children) && props.node.children.length > 0
);

const isNodeExpanded = computed(() => {
    if (props.node.type !== "dir") return false;
    return props.isExpanded(props.projectId, props.node.path);
});
</script>

<template>
    <li :class="['reportTreeNode', `reportTreeNode--${node.type}`]">
        <div class="reportTreeRow">
            <button
                v-if="node.type === 'dir'"
                type="button"
                class="reportTreeToggle"
                @click.stop="toggle(projectId, node.path)"
            >
                <span v-if="isNodeExpanded">▾</span>
                <span v-else>▸</span>
            </button>
            <span v-else class="reportTreeSpacer"></span>
            <span class="reportTreeLabel" :title="node.path">{{ node.name }}</span>
            <template v-if="node.type === 'file' && fileState">
                <span class="statusBadge" :class="`statusBadge--${fileState.status}`">{{ statusLabel }}</span>
                <button
                    type="button"
                    class="reportActionBtn"
                    :disabled="fileState.status === 'processing'"
                    @click.stop="onGenerate(project, node)"
                >
                    <span v-if="fileState.status === 'processing'">處理中...</span>
                    <span v-else-if="fileState.status === 'ready'">重新生成</span>
                    <span v-else>生成報告</span>
                </button>
                <button
                    v-if="fileState.status === 'ready'"
                    type="button"
                    class="reportViewBtn"
                    @click.stop="onSelect(projectId, node.path)"
                >
                    查看
                </button>
            </template>
        </div>
        <p
            v-if="node.type === 'file' && fileState?.status === 'ready' && fileState?.updatedAtDisplay"
            class="reportTimestamp"
        >
            最後更新：{{ fileState.updatedAtDisplay }}
        </p>
        <ul v-if="node.type === 'dir' && hasChildren && isNodeExpanded" class="reportFileTreeChildren">
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
            />
        </ul>
    </li>
</template>
