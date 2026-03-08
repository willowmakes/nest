import type { Listener, IncomingMessage, MessageOrigin, OutgoingFile } from "../src/types.js";

export class MockListener implements Listener {
    readonly name: string;
    readonly streaming: boolean;
    private handler?: (msg: IncomingMessage) => void;
    sent: Array<{ origin: MessageOrigin; text: string; files?: OutgoingFile[] }> = [];
    typingSent: MessageOrigin[] = [];
    connected = false;

    constructor(name = "test", streaming = false) {
        this.name = name;
        this.streaming = streaming;
    }

    async connect(): Promise<void> { this.connected = true; }
    async disconnect(): Promise<void> { this.connected = false; }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.handler = handler;
    }

    async send(origin: MessageOrigin, text: string, files?: OutgoingFile[]): Promise<void> {
        this.sent.push({ origin, text, files });
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        this.typingSent.push(origin);
    }

    // Test helper: simulate an incoming message
    simulateMessage(msg: IncomingMessage): void {
        this.handler?.(msg);
    }
}

export function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
        platform: "test",
        channel: "test-channel",
        sender: "testuser",
        text: "hello",
        ...overrides,
    };
}
