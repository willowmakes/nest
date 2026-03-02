import { useState, useEffect, useRef, useCallback } from "react";

// ─── Block-based message model ────────────────────────────────

type ToolResultContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

interface ToolResult {
    content: ToolResultContent[];
    isError?: boolean;
}

type ChatBlock =
    | { type: "text"; content: string; streaming?: boolean }
    | {
        type: "tool_call";
        toolCallId: string;
        toolName: string;
        args?: Record<string, unknown>;
        result?: ToolResult;
        status: "running" | "complete" | "error";
    }
    | { type: "thinking"; content: string };

interface ChatMessage {
    id: string;
    role: "user" | "agent";
    blocks: ChatBlock[];
}

// ─── Helpers ──────────────────────────────────────────────────

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderInlineMarkdown(text: string): string {
    const escaped = escapeHtml(text);
    return escaped
        .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/\n/g, "<br/>");
}

/** Compact JSON summary for tool args — truncate long values */
function summarizeArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    const parts = entries.map(([k, v]) => {
        let val = typeof v === "string" ? v : JSON.stringify(v);
        if (val && val.length > 80) val = val.slice(0, 77) + "…";
        return `${escapeHtml(k)}: ${escapeHtml(val)}`;
    });
    return parts.join(", ");
}

/** Whitelist of safe MIME types for inline image rendering */
const SAFE_IMAGE_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
]);

// ─── Tool Call Block Component ────────────────────────────────

const TEXT_TRUNCATE_LENGTH = 500;

function ToolCallBlock({ block }: { block: Extract<ChatBlock, { type: "tool_call" }> }) {
    const [expanded, setExpanded] = useState(block.status === "running");
    const [showFullResult, setShowFullResult] = useState(false);

    // Auto-collapse when tool completes
    const prevStatus = useRef(block.status);
    useEffect(() => {
        if (prevStatus.current === "running" && block.status !== "running") {
            setExpanded(false);
        }
        prevStatus.current = block.status;
    }, [block.status]);

    const statusClass =
        block.status === "running" ? "tool-call--running" :
        block.status === "error" ? "tool-call--error" : "tool-call--complete";

    const statusIcon =
        block.status === "running" ? "⏳" :
        block.status === "error" ? "❌" : "✓";

    const argsSummary = block.args ? summarizeArgs(block.args) : "";

    return (
        <div className={`tool-call ${statusClass}`}>
            <div
                className="tool-call-header"
                onClick={() => setExpanded(!expanded)}
            >
                <span className="tool-call-icon">🔧</span>
                <span className="tool-call-name">{block.toolName}</span>
                <span className="tool-call-status-icon">{statusIcon}</span>
                <span className="tool-call-chevron">{expanded ? "▼" : "▶"}</span>
            </div>
            {expanded && (
                <div className="tool-call-body">
                    {argsSummary && (
                        <div className="tool-call-args">
                            <span className="tool-call-args-label">args: </span>
                            <span>{argsSummary}</span>
                        </div>
                    )}
                    {block.result && (
                        <div className={`tool-call-result ${block.result.isError ? "tool-call-result--error" : ""}`}>
                            {block.result.content.map((item, i) => {
                                if (item.type === "image") {
                                    const mimeType = SAFE_IMAGE_TYPES.has(item.mimeType)
                                        ? item.mimeType
                                        : "application/octet-stream";
                                    return (
                                        <img
                                            key={i}
                                            className="tool-call-image"
                                            src={`data:${mimeType};base64,${item.data}`}
                                            alt={`Tool result image ${i + 1}`}
                                        />
                                    );
                                }
                                // Text content
                                const text = item.text;
                                const isLong = text.length > TEXT_TRUNCATE_LENGTH;
                                const displayText = (!showFullResult && isLong)
                                    ? text.slice(0, TEXT_TRUNCATE_LENGTH) + "…"
                                    : text;
                                return (
                                    <div key={i} className="tool-call-text">
                                        <span dangerouslySetInnerHTML={{
                                            __html: renderInlineMarkdown(displayText),
                                        }} />
                                        {isLong && (
                                            <button
                                                className="tool-call-show-more"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setShowFullResult(!showFullResult);
                                                }}
                                            >
                                                {showFullResult ? "Show less" : "Show more"}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {block.status === "running" && !block.result && (
                        <div className="tool-call-running-indicator">Running…</div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Message Block Renderer ───────────────────────────────────

function MessageBlocks({ blocks }: { blocks: ChatBlock[] }) {
    return (
        <>
            {blocks.map((block, i) => {
                if (block.type === "text") {
                    return (
                        <div
                            key={i}
                            className="chat-block-text"
                            dangerouslySetInnerHTML={{
                                __html: renderInlineMarkdown(block.content),
                            }}
                        />
                    );
                }
                if (block.type === "tool_call") {
                    return <ToolCallBlock key={block.toolCallId} block={block} />;
                }
                if (block.type === "thinking") {
                    return (
                        <div key={i} className="chat-block-thinking">
                            <span className="thinking-label">💭 Thinking</span>
                            <span dangerouslySetInnerHTML={{
                                __html: renderInlineMarkdown(block.content),
                            }} />
                        </div>
                    );
                }
                return null;
            })}
        </>
    );
}

// ─── Main Chat Component ─────────────────────────────────────

export default function Chat() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const idCounter = useRef(0);
    const mountedRef = useRef(true);

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, scrollToBottom]);

    const connect = useCallback(() => {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${window.location.host}/attach`);
        wsRef.current = ws;

        ws.onopen = () => {
            // Cookie sent on upgrade — wait for server auth_ok confirmation
        };

        ws.onclose = () => {
            if (!mountedRef.current) return;
            setConnected(false);
            wsRef.current = null;
            reconnectTimer.current = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };

        ws.onmessage = (event) => {
            if (!mountedRef.current) return;
            try {
                const data = JSON.parse(event.data);
                handleWsMessage(data);
            } catch {
                // ignore malformed messages
            }
        };
    }, []);

    useEffect(() => {
        connect();
        return () => {
            mountedRef.current = false;
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);

    const handleWsMessage = (data: any) => {
        if (!mountedRef.current) return;

        if (data.type === "auth_ok") {
            setConnected(true);
            return;
        }

        // Only show events from websocket-initiated messages
        if (data.source && data.source !== "websocket") return;

        if (data.type === "agent_start") {
            return;
        }

        if (data.type === "message_update") {
            const delta = data.assistantMessageEvent;
            if (!delta) return;

            if (delta.type === "text_delta" && delta.delta) {
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last.role === "agent") {
                        const lastBlock = last.blocks[last.blocks.length - 1];
                        if (lastBlock && lastBlock.type === "text" && lastBlock.streaming) {
                            // Append to existing streaming text block
                            const updatedBlock = { ...lastBlock, content: lastBlock.content + delta.delta };
                            const updatedMsg = {
                                ...last,
                                blocks: [...last.blocks.slice(0, -1), updatedBlock],
                            };
                            return [...prev.slice(0, -1), updatedMsg];
                        }
                        // Agent message exists but last block isn't streaming text — add new text block
                        const newBlock: ChatBlock = { type: "text", content: delta.delta, streaming: true };
                        const updatedMsg = {
                            ...last,
                            blocks: [...last.blocks, newBlock],
                        };
                        return [...prev.slice(0, -1), updatedMsg];
                    }
                    // No agent message yet — create one with a streaming text block
                    return [
                        ...prev,
                        {
                            id: `agent-${idCounter.current++}`,
                            role: "agent" as const,
                            blocks: [{ type: "text" as const, content: delta.delta, streaming: true }],
                        },
                    ];
                });
            }
            return;
        }

        if (data.type === "tool_execution_start") {
            const toolCallId = data.toolCallId ?? `tc-${idCounter.current++}`;
            const toolName = data.toolName ?? "unknown";
            const args = data.args;

            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "agent") {
                    // Finalize any streaming text block before inserting tool call
                    const blocks = last.blocks.map((b) =>
                        b.type === "text" && b.streaming ? { ...b, streaming: false } : b
                    );
                    const toolBlock: ChatBlock = {
                        type: "tool_call",
                        toolCallId,
                        toolName,
                        args,
                        status: "running",
                    };
                    return [
                        ...prev.slice(0, -1),
                        { ...last, blocks: [...blocks, toolBlock] },
                    ];
                }
                // No agent message yet — create one with just the tool call
                const toolBlock: ChatBlock = {
                    type: "tool_call",
                    toolCallId,
                    toolName,
                    args,
                    status: "running",
                };
                return [
                    ...prev,
                    {
                        id: `agent-${idCounter.current++}`,
                        role: "agent" as const,
                        blocks: [toolBlock],
                    },
                ];
            });
            return;
        }

        if (data.type === "tool_execution_end") {
            const toolCallId = data.toolCallId;
            const isError = data.isError ?? false;

            // Parse result content into our ToolResult format
            let result: ToolResult | undefined;
            if (data.result != null) {
                // result might be a string, an array of content blocks, or an object with content
                if (typeof data.result === "string") {
                    result = { content: [{ type: "text", text: data.result }], isError };
                } else if (Array.isArray(data.result)) {
                    result = { content: data.result, isError };
                } else if (data.result.content && Array.isArray(data.result.content)) {
                    result = { content: data.result.content, isError };
                } else {
                    // Fallback: stringify the whole thing
                    result = { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }], isError };
                }
            }

            setMessages((prev) => {
                // Find the agent message containing this tool call
                for (let i = prev.length - 1; i >= 0; i--) {
                    const msg = prev[i];
                    if (msg.role !== "agent") continue;
                    const blockIdx = msg.blocks.findIndex(
                        (b) => b.type === "tool_call" && b.toolCallId === toolCallId
                    );
                    if (blockIdx === -1) continue;

                    const block = msg.blocks[blockIdx] as Extract<ChatBlock, { type: "tool_call" }>;
                    const updatedBlock: ChatBlock = {
                        ...block,
                        result,
                        status: isError ? "error" : "complete",
                    };
                    const updatedBlocks = [...msg.blocks];
                    updatedBlocks[blockIdx] = updatedBlock;
                    const updated = [...prev];
                    updated[i] = { ...msg, blocks: updatedBlocks };
                    return updated;
                }
                return prev;
            });
            return;
        }

        if (data.type === "agent_end") {
            // Finalize all streaming blocks
            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "agent") {
                    const blocks = last.blocks.map((b) => {
                        if (b.type === "text" && b.streaming) {
                            return { ...b, streaming: false };
                        }
                        if (b.type === "tool_call" && b.status === "running") {
                            return { ...b, status: "complete" as const };
                        }
                        return b;
                    });
                    return [...prev.slice(0, -1), { ...last, blocks }];
                }
                return prev;
            });
            return;
        }

        if (data.type === "response" && data.id) {
            return;
        }
    };

    const sendMessage = () => {
        const text = input.trim();
        if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const id = `msg-${idCounter.current++}`;

        setMessages((prev) => [
            ...prev,
            {
                id,
                role: "user",
                blocks: [{ type: "text", content: text }],
            },
        ]);

        wsRef.current.send(JSON.stringify({
            id,
            type: "prompt",
            message: text,
        }));

        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    return (
        <>
            <div className="chat-header">
                <span>Chat</span>
                <div className="chat-status">
                    <span className={`status-dot ${connected ? "ok" : ""}`} />
                    <span>{connected ? "Connected" : "Disconnected"}</span>
                </div>
            </div>
            <div className="chat-messages">
                {messages.length === 0 && (
                    <div className="empty-state">Send a message to start chatting</div>
                )}
                {messages.map((msg) => (
                    <div key={msg.id} className={`chat-msg ${msg.role}`}>
                        <MessageBlocks blocks={msg.blocks} />
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <div className="chat-input-area">
                <textarea
                    className="chat-input"
                    placeholder={connected ? "Type a message…" : "Connecting…"}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!connected}
                    rows={1}
                />
                <button
                    className="chat-send-btn"
                    onClick={sendMessage}
                    disabled={!connected || !input.trim()}
                >
                    Send
                </button>
            </div>
        </>
    );
}
