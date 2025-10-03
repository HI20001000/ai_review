import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from "vue";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;
const EDGE_PADDING = 16;

export function useChatWindow(props, emit) {
    const draft = ref("");
    const windowRef = ref(null);
    const messagesRef = ref(null);

    const hasWindow = typeof window !== "undefined";
    const defaultWidth = 420;
    const defaultHeight = 520;
    const initialLeft = hasWindow ? Math.max(EDGE_PADDING, window.innerWidth - defaultWidth - EDGE_PADDING) : 80;
    const initialTop = hasWindow ? Math.max(EDGE_PADDING, window.innerHeight * 0.15) : 80;

    const position = reactive({
        top: initialTop,
        left: initialLeft,
        width: defaultWidth,
        height: defaultHeight
    });

    let dragCleanup = null;
    let resizeCleanup = null;

    const styleObject = computed(() => ({
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        height: `${position.height}px`
    }));

    const resizeHandler = () => ensureBounds();

    if (hasWindow) {
        window.addEventListener("resize", resizeHandler);
        ensureBounds();
    }

    function clamp(value, min, max) {
        if (Number.isNaN(value)) return min;
        if (max < min) return min;
        return Math.min(Math.max(value, min), max);
    }

    function ensureBounds() {
        if (!hasWindow) return;
        const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - EDGE_PADDING * 2);
        const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - EDGE_PADDING * 2);
        position.width = clamp(position.width, MIN_WIDTH, maxWidth);
        position.height = clamp(position.height, MIN_HEIGHT, maxHeight);
        const maxLeft = window.innerWidth - EDGE_PADDING - position.width;
        const maxTop = window.innerHeight - EDGE_PADDING - position.height;
        position.left = clamp(position.left, EDGE_PADDING, Math.max(EDGE_PADDING, maxLeft));
        position.top = clamp(position.top, EDGE_PADDING, Math.max(EDGE_PADDING, maxTop));
    }

    function clearDrag() {
        if (typeof dragCleanup === "function") {
            dragCleanup();
            dragCleanup = null;
        }
    }

    function clearResize() {
        if (typeof resizeCleanup === "function") {
            resizeCleanup();
            resizeCleanup = null;
        }
    }

    function startDrag(event) {
        if (typeof event.button === "number" && event.button !== 0 && event.button !== -1) {
            return;
        }
        event.preventDefault();
        clearDrag();
        ensureBounds();

        const startX = event.clientX;
        const startY = event.clientY;
        const initialLeft = position.left;
        const initialTop = position.top;

        const move = (pointerEvent) => {
            if (!hasWindow) return;
            const deltaX = pointerEvent.clientX - startX;
            const deltaY = pointerEvent.clientY - startY;
            const maxLeft = window.innerWidth - EDGE_PADDING - position.width;
            const maxTop = window.innerHeight - EDGE_PADDING - position.height;
            position.left = clamp(initialLeft + deltaX, EDGE_PADDING, Math.max(EDGE_PADDING, maxLeft));
            position.top = clamp(initialTop + deltaY, EDGE_PADDING, Math.max(EDGE_PADDING, maxTop));
        };

        const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            event.target?.releasePointerCapture?.(event.pointerId);
            dragCleanup = null;
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        event.target?.setPointerCapture?.(event.pointerId);
        dragCleanup = stop;
    }

    function startResize(event, dirX, dirY) {
        if (typeof event.button === "number" && event.button !== 0 && event.button !== -1) {
            return;
        }
        event.preventDefault();
        clearResize();
        ensureBounds();

        const startX = event.clientX;
        const startY = event.clientY;
        const initial = {
            top: position.top,
            left: position.left,
            width: position.width,
            height: position.height
        };

        const move = (pointerEvent) => {
            let nextLeft = initial.left;
            let nextTop = initial.top;
            let nextWidth = initial.width;
            let nextHeight = initial.height;

            const deltaX = pointerEvent.clientX - startX;
            const deltaY = pointerEvent.clientY - startY;

            if (dirX === "right") {
                nextWidth = initial.width + deltaX;
            } else if (dirX === "left") {
                nextWidth = initial.width - deltaX;
                nextLeft = initial.left + deltaX;
            }

            if (dirY === "bottom") {
                nextHeight = initial.height + deltaY;
            } else if (dirY === "top") {
                nextHeight = initial.height - deltaY;
                nextTop = initial.top + deltaY;
            }

            if (hasWindow) {
                const maxLeft = window.innerWidth - EDGE_PADDING - MIN_WIDTH;
                const maxTop = window.innerHeight - EDGE_PADDING - MIN_HEIGHT;
                nextLeft = clamp(nextLeft, EDGE_PADDING, Math.max(EDGE_PADDING, maxLeft));
                nextTop = clamp(nextTop, EDGE_PADDING, Math.max(EDGE_PADDING, maxTop));
                const maxWidth = window.innerWidth - EDGE_PADDING - nextLeft;
                const maxHeight = window.innerHeight - EDGE_PADDING - nextTop;
                nextWidth = clamp(nextWidth, MIN_WIDTH, Math.max(MIN_WIDTH, maxWidth));
                nextHeight = clamp(nextHeight, MIN_HEIGHT, Math.max(MIN_HEIGHT, maxHeight));
            } else {
                nextWidth = Math.max(MIN_WIDTH, nextWidth);
                nextHeight = Math.max(MIN_HEIGHT, nextHeight);
            }

            position.left = nextLeft;
            position.top = nextTop;
            position.width = nextWidth;
            position.height = nextHeight;
        };

        const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            event.target?.releasePointerCapture?.(event.pointerId);
            resizeCleanup = null;
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        event.target?.setPointerCapture?.(event.pointerId);
        resizeCleanup = stop;
    }

    function scrollToBottom() {
        nextTick(() => {
            const el = messagesRef.value;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }

    function focusDraft() {
        nextTick(() => {
            const root = windowRef.value;
            if (!root) return;
            const textarea = root.querySelector("textarea");
            textarea?.focus();
        });
    }

    function send() {
        if (props.loading || props.disabled) return;
        const value = draft.value.trim();
        if (!value) return;
        emit("send-message", value);
        draft.value = "";
        scrollToBottom();
    }

    function formatTime(value) {
        if (!value) return "";
        const date = value instanceof Date ? value : new Date(value);
        return date.toLocaleTimeString();
    }

    watch(
        () => props.messages,
        () => {
            scrollToBottom();
        },
        { deep: true, flush: "post" }
    );

    watch(
        () => props.visible,
        (visible) => {
            if (visible) {
                ensureBounds();
                scrollToBottom();
                focusDraft();
            } else {
                clearDrag();
                clearResize();
            }
        }
    );

    onBeforeUnmount(() => {
        clearDrag();
        clearResize();
        if (hasWindow) {
            window.removeEventListener("resize", resizeHandler);
        }
    });

    return {
        draft,
        windowRef,
        messagesRef,
        styleObject,
        startDrag,
        startResize,
        send,
        formatTime
    };
}

