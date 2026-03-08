/**
 * TUI client for `nest attach` — renders chat using pi-tui components.
 *
 * Layout:
 *   ┌─────────────────────────────┐
 *   │  scrollable message history  │
 *   │  ...                         │
 *   │  wren: response text         │
 *   ├─────────────────────────────┤
 *   │  > input                     │
 *   └─────────────────────────────┘
 */

import {
    ProcessTerminal, TUI, Container, Text, Spacer, Markdown,
    Editor, matchesKey, Key,
} from "@mariozechner/pi-tui";
import type { MarkdownTheme, EditorTheme } from "@mariozechner/pi-tui";
import WebSocket from "ws";

// ─── Theme ──────────────────────────────────────────────────

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const UL = "\x1b[4m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";
const WHITE = "\x1b[37m";
const BG_GRAY = "\x1b[48;5;236m";

const mdTheme: MarkdownTheme = {
    heading: (s) => `${BOLD}${CYAN}${s}${R}`,
    link: (s) => `${UL}${CYAN}${s}${R}`,
    linkUrl: (s) => `${DIM}${s}${R}`,
    code: (s) => `${BG_GRAY}${WHITE}${s}${R}`,
    codeBlock: (s) => s,
    codeBlockBorder: (s) => `${GRAY}${s}${R}`,
    quote: (s) => `${DIM}${s}${R}`,
    quoteBorder: (s) => `${GRAY}${s}${R}`,
    hr: (s) => `${GRAY}${s}${R}`,
    listBullet: (s) => `${CYAN}${s}${R}`,
    bold: (s) => `${BOLD}${s}${R}`,
    italic: (s) => `${ITALIC}${s}${R}`,
    strikethrough: (s) => `${STRIKE}${s}${R}`,
    underline: (s) => `${UL}${s}${R}`,
};

const editorTheme: EditorTheme = {
    borderColor: (s) => `${CYAN}${s}${R}`,
    selectList: {
        selectedPrefix: (s) => `${GREEN}${s}${R}`,
        selectedText: (s) => `${GREEN}${s}${R}`,
        description: (s) => `${DIM}${s}${R}`,
        scrollInfo: (s) => `${DIM}${s}${R}`,
        noMatch: (s) => `${YELLOW}${s}${R}`,
    },
};

// ─── Message Types ──────────────────────────────────────────

interface ChatMessage {
    type: "user" | "response" | "tool" | "system" | "error" | "file";
    text: string;
}

// ─── TUI ────────────────────────────────────────────────────

export function startTui(ws: WebSocket, workspaceName: string): void {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);
    const messages: ChatMessage[] = [];

    // Message area
    const messageArea = new Container();
    tui.addChild(messageArea);

    // Editor at bottom
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    editor.onSubmit = (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        // Client-side commands
        if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
            tui.stop();
            ws.close();
            process.exit(0);
        }

        messages.push({ type: "user", text: trimmed });
        lastResponseIdx = -1; // next text event starts a new response
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "message", text: trimmed }));
        }
        rebuildMessages();
        tui.requestRender();
    };
    tui.addChild(editor);
    tui.setFocus(editor);

    // Track streaming text — the kernel sends intermediate text chunks and a final response
    let lastResponseIdx = -1;

    function addMessage(msg: ChatMessage): void {
        // Non-response messages break the streaming sequence
        if (msg.type !== "response") {
            lastResponseIdx = -1;
        }
        messages.push(msg);
        rebuildMessages();
        tui.requestRender();
    }

    function handleText(text: string): void {
        if (!text.trim()) return;

        // The kernel broadcasts text chunks then a final response.
        // Each subsequent text for a response replaces the previous one
        // (the kernel sends the full accumulated text each time).
        if (lastResponseIdx >= 0 && lastResponseIdx < messages.length) {
            messages[lastResponseIdx].text = text;
        } else {
            messages.push({ type: "response", text });
            lastResponseIdx = messages.length - 1;
        }
        rebuildMessages();
        tui.requestRender();
    }

    function rebuildMessages(): void {
        messageArea.clear();

        if (messages.length === 0) {
            messageArea.addChild(new Text(`${DIM}Connected to ${workspaceName}. Type a message.${R}`, 1, 1));
            return;
        }

        // Show recent messages that fit on screen
        const maxLines = Math.max(terminal.rows - 6, 5);
        let lineCount = 0;
        let startIdx = messages.length - 1;

        for (let i = messages.length - 1; i >= 0 && lineCount < maxLines; i--) {
            lineCount += estimateLines(messages[i], terminal.columns) + 1;
            startIdx = i;
        }

        for (let i = startIdx; i < messages.length; i++) {
            const msg = messages[i];
            switch (msg.type) {
                case "user":
                    messageArea.addChild(new Text(`${GREEN}${BOLD}you${R}${DIM}:${R} ${msg.text}`, 1, 0));
                    break;
                case "response":
                    messageArea.addChild(new Text(`${CYAN}${BOLD}wren${R}`, 1, 0));
                    messageArea.addChild(new Markdown(msg.text, 2, 0, mdTheme));
                    break;
                case "tool":
                    messageArea.addChild(new Text(`${YELLOW}⚙ ${msg.text}${R}`, 2, 0));
                    break;
                case "system":
                    messageArea.addChild(new Text(`${DIM}${msg.text}${R}`, 1, 0));
                    break;
                case "error":
                    messageArea.addChild(new Text(`${RED}✗ ${msg.text}${R}`, 1, 0));
                    break;
                case "file":
                    messageArea.addChild(new Text(`${MAGENTA}📎 ${msg.text}${R}`, 2, 0));
                    break;
            }
            if (i < messages.length - 1) {
                messageArea.addChild(new Spacer(1));
            }
        }
    }

    function estimateLines(msg: ChatMessage, width: number): number {
        const w = Math.max(width - 4, 20);
        return Math.max(1, Math.ceil(msg.text.length / w));
    }

    // Handle WebSocket messages
    ws.on("message", (rawData) => {
        let msg: any;
        try { msg = JSON.parse(rawData.toString()); } catch { return; }

        switch (msg.type) {
            case "stream":
                handleText(msg.text ?? "");
                break;
            case "text":
                // Final response — finalize any streaming
                lastResponseIdx = -1;
                handleText(msg.text ?? "");
                break;
            case "tool_start":
                // Tool breaks the streaming sequence — finalize current response
                lastResponseIdx = -1;
                addMessage({ type: "tool", text: msg.text ?? "tool" });
                break;
            case "files":
                lastResponseIdx = -1;
                for (const f of msg.files ?? []) {
                    addMessage({ type: "file", text: `${f.filename} (${f.size} bytes)` });
                }
                break;
            case "system":
                addMessage({ type: "system", text: msg.text ?? "" });
                break;
            case "error":
                addMessage({ type: "error", text: msg.text ?? "" });
                break;
        }
    });

    ws.on("close", () => {
        tui.stop();
        console.log("Disconnected from nest.");
        process.exit(0);
    });

    ws.on("error", () => {
        tui.stop();
        process.exit(1);
    });

    // Intercept ctrl+c before TUI gets it
    tui.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
            tui.stop();
            ws.close();
            process.exit(0);
        }
        return undefined; // don't consume — let TUI/editor handle it
    });

    // Start
    terminal.setTitle(`nest: ${workspaceName}`);
    rebuildMessages();
    tui.start();
}
