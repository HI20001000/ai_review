import { ref, computed, h, defineComponent } from "vue";

const TreeNode = defineComponent({
    name: "TreeNode",
    props: {
        node: { type: Object, required: true },
        activePath: { type: String, default: "" }
    },
    emits: ["open", "select"],
    setup(props, { emit }) {
        const open = ref(true);
        const isDir = () => props.node?.type === "dir";
        const isActive = computed(() => props.activePath === props.node?.path);

        const handleClick = () => {
            const node = props.node;
            if (!node) return;
            emit("select", node.path);
            if (isDir()) {
                open.value = !open.value;
            } else {
                emit("open", node);
            }
        };

        const buildFileTitle = (node) => {
            if (!node || node.type !== "file") return "";
            const size = node.size ?? 0;
            const mime = node.mime || "-";
            const timestamp = node.lastModified ? new Date(node.lastModified).toLocaleString() : "-";
            return `Size: ${size} bytes\nType: ${mime}\nUpdated: ${timestamp}`;
        };

        return () => {
            const node = props.node;
            if (!node) return null;

            const icon = isDir() ? (open.value ? "📂" : "📁") : "📄";

            return h("li", null, [
                h(
                    "div",
                    {
                        class: ["treeRow", { active: isActive.value }],
                        onClick: handleClick,
                        title: buildFileTitle(node)
                    },
                    [
                        h("span", { class: "icon" }, icon),
                        h("span", { class: "name" }, [
                            node.name,
                            node.type === "file" && node.isBig
                                ? h("small", { style: "opacity:.7;" }, `(${((node.size || 0) / 1024 / 1024).toFixed(1)} MB)`)
                                : null
                        ])
                    ]
                ),
                isDir() && open.value
                    ? h(
                        "ul",
                        { class: "treeChildren" },
                        (node.children || []).map((child) =>
                            h(TreeNode, {
                                node: child,
                                key: child.path,
                                activePath: props.activePath,
                                onOpen: (childNode) => emit("open", childNode),
                                onSelect: (path) => emit("select", path)
                            })
                        )
                    )
                    : null
            ]);
        };
    }
});

export default TreeNode;


