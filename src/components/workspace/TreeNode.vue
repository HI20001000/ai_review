<script setup>
import { computed, ref, watch } from "vue";

defineOptions({
    name: "TreeNode"
});

const props = defineProps({
    node: {
        type: Object,
        required: true
    },
    activePath: {
        type: String,
        default: ""
    }
});

const emit = defineEmits(["open", "select"]);

const isDirectory = computed(() => props.node?.type === "dir");
const isActive = computed(() => props.activePath === (props.node?.path || ""));
const children = computed(() => (props.node?.children || []));

const isOpen = ref(false);

watch(
    () => props.node,
    (node) => {
        if (!node) {
            isOpen.value = false;
            return;
        }
        isOpen.value = node.type === "dir";
    },
    { immediate: true }
);

const icon = computed(() => {
    if (!props.node) return "";
    if (isDirectory.value) {
        return isOpen.value ? "📂" : "📁";
    }
    return "📄";
});

const bigFileLabel = computed(() => {
    if (!props.node || props.node.type !== "file" || !props.node.isBig) {
        return "";
    }
    const size = props.node.size || 0;
    const mb = size / 1024 / 1024;
    return `${mb.toFixed(1)} MB`;
});

const fileTitle = computed(() => {
    const node = props.node;
    if (!node) return "";
    if (node.type !== "file") return node.name || "";
    const size = node.size ?? 0;
    const mime = node.mime || "-";
    const timestamp = node.lastModified ? new Date(node.lastModified).toLocaleString() : "-";
    return `Size: ${size} bytes\nType: ${mime}\nUpdated: ${timestamp}`;
});

function handleClick() {
    const node = props.node;
    if (!node) return;
    emit("select", node.path);
    if (node.type === "dir") {
        isOpen.value = !isOpen.value;
        return;
    }
    emit("open", node);
}

function forwardOpen(childNode) {
    emit("open", childNode);
}

function forwardSelect(path) {
    emit("select", path);
}
</script>

<template>
    <li>
        <div class="treeRow" :class="{ active: isActive }" @click="handleClick" :title="fileTitle">
            <span class="icon">{{ icon }}</span>
            <span class="name">
                {{ props.node?.name }}
                <small v-if="bigFileLabel" class="sizeHint">({{ bigFileLabel }})</small>
            </span>
        </div>
        <ul v-if="isDirectory && isOpen" class="treeChildren">
            <TreeNode
                v-for="child in children"
                :key="child.path"
                :node="child"
                :active-path="activePath"
                @open="forwardOpen"
                @select="forwardSelect"
            />
        </ul>
    </li>
</template>

<style scoped>
.treeRow {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 0;
    cursor: pointer;
    user-select: none;
}

.treeRow.active {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 6px;
}

.icon {
    width: 20px;
    text-align: center;
}

.name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.sizeHint {
    font-size: 11px;
    opacity: 0.65;
}

.treeChildren {
    list-style: none;
    margin: 0;
    padding-left: 16px;
}
</style>
