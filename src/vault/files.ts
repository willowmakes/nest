import { resolve, relative, sep } from "node:path";
import {
    readFile as fsReadFile,
    writeFile as fsWriteFile,
    unlink,
    mkdir,
    readdir,
    lstat,
    realpath,
    rename,
    copyFile,
} from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { FileEntry } from "../types.js";

const MIME_TYPES: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "text/typescript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".excalidraw": "application/json",
};

const TEXT_EXTENSIONS = new Set([
    ".md", ".txt", ".json", ".yaml", ".yml",
    ".html", ".css", ".js", ".ts", ".svg",
    ".excalidraw",
]);

export class WorkspaceFiles {
    private roots: Map<string, string>;

    constructor(roots: Record<string, string>) {
        this.roots = new Map(
            Object.entries(roots).map(([name, path]) => [name, resolve(path)])
        );
    }

    /** Get the list of configured root names */
    getRootNames(): string[] {
        return Array.from(this.roots.keys());
    }

    /** Resolve a root name to its absolute path, or throw */
    private resolveRoot(rootName: string): string {
        const root = this.roots.get(rootName);
        if (!root) {
            throw new FilePathError(`Unknown root: ${rootName}`);
        }
        return root;
    }

    /** Resolve a user-provided path and verify it's inside the given root */
    private async resolveSafe(root: string, userPath: string): Promise<string> {
        // Reject paths with .. components before resolution
        const normalized = relative(".", userPath);
        if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
            throw new FilePathError(`Path traversal rejected: ${userPath}`);
        }

        const resolved = resolve(root, userPath);

        // Must be within root
        if (!resolved.startsWith(root + sep) && resolved !== root) {
            throw new FilePathError(`Path outside root: ${userPath}`);
        }

        // Check that the real path (following symlinks) stays inside the root.
        await this.verifyRealPath(resolved, root, userPath);

        return resolved;
    }

    /** Verify that the real filesystem path stays inside the root */
    private async verifyRealPath(targetPath: string, root: string, userPath: string): Promise<void> {
        try {
            const real = await realpath(targetPath);
            if (!real.startsWith(root + sep) && real !== root) {
                throw new FilePathError(`Symlink resolves outside root: ${userPath}`);
            }
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                throw err;
            }
        }

        // File doesn't exist — check the nearest existing parent
        let parent = dirname(targetPath);
        while (parent !== root && parent.startsWith(root)) {
            try {
                const real = await realpath(parent);
                if (!real.startsWith(root + sep) && real !== root) {
                    throw new FilePathError(`Symlink resolves outside root: ${userPath}`);
                }
                return;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw err;
                }
            }
            parent = dirname(parent);
        }
    }

    async readFile(rootName: string, relativePath: string): Promise<{ content: string; mimeType: string; encoding?: string }> {
        const root = this.resolveRoot(rootName);
        const fullPath = await this.resolveSafe(root, relativePath);

        try {
            const stat = await lstat(fullPath);
            if (stat.isDirectory()) {
                throw new FilePathError(`Path is a directory, not a file: ${relativePath}`);
            }

            const ext = extname(fullPath).toLowerCase();
            const mimeType = MIME_TYPES[ext] ?? "text/plain";
            const isText = TEXT_EXTENSIONS.has(ext) || !MIME_TYPES[ext];

            if (isText) {
                const content = await fsReadFile(fullPath, "utf-8");
                return { content, mimeType };
            } else {
                const buffer = await fsReadFile(fullPath);
                return { content: buffer.toString("base64"), mimeType, encoding: "base64" };
            }
        } catch (err) {
            if (err instanceof FilePathError) throw err;
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FileNotFoundError(`File not found: ${relativePath}`);
            }
            throw err;
        }
    }

    async readFileRaw(rootName: string, relativePath: string): Promise<{ buffer: Buffer; mimeType: string }> {
        const root = this.resolveRoot(rootName);
        const fullPath = await this.resolveSafe(root, relativePath);

        try {
            const stat = await lstat(fullPath);
            if (stat.isDirectory()) {
                throw new FilePathError(`Path is a directory, not a file: ${relativePath}`);
            }

            const ext = extname(fullPath).toLowerCase();
            const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
            const buffer = await fsReadFile(fullPath);
            return { buffer, mimeType };
        } catch (err) {
            if (err instanceof FilePathError) throw err;
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FileNotFoundError(`File not found: ${relativePath}`);
            }
            throw err;
        }
    }

    async moveFile(rootName: string, fromPath: string, toPath: string): Promise<void> {
        const root = this.resolveRoot(rootName);
        const fullFrom = await this.resolveSafe(root, fromPath);
        const fullTo = await this.resolveSafe(root, toPath);

        try {
            const stat = await lstat(fullFrom);
            if (stat.isDirectory()) {
                throw new FilePathError(`Cannot move a directory: ${fromPath}`);
            }
        } catch (err) {
            if (err instanceof FilePathError) throw err;
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FileNotFoundError(`File not found: ${fromPath}`);
            }
            throw err;
        }

        try {
            await lstat(fullTo);
            throw new FilePathError(`Destination already exists: ${toPath}`);
        } catch (err) {
            if (err instanceof FilePathError) throw err;
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }

        await mkdir(dirname(fullTo), { recursive: true });

        try {
            await rename(fullFrom, fullTo);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EXDEV") {
                try {
                    await copyFile(fullFrom, fullTo);
                } catch (copyErr) {
                    throw new FilePathError(`Failed to copy file: ${(copyErr as Error).message}`);
                }
                try {
                    await unlink(fullFrom);
                } catch (unlinkErr) {
                    await unlink(fullTo).catch(() => {});
                    throw new FilePathError(`Move failed (could not delete source): ${(unlinkErr as Error).message}`);
                }
            } else {
                throw err;
            }
        }
    }

    async writeFile(rootName: string, relativePath: string, content: string): Promise<void> {
        const root = this.resolveRoot(rootName);
        const fullPath = await this.resolveSafe(root, relativePath);

        await mkdir(dirname(fullPath), { recursive: true });
        await fsWriteFile(fullPath, content, "utf-8");
    }

    async deleteFile(rootName: string, relativePath: string): Promise<void> {
        const root = this.resolveRoot(rootName);
        const fullPath = await this.resolveSafe(root, relativePath);

        try {
            await unlink(fullPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FileNotFoundError(`File not found: ${relativePath}`);
            }
            throw err;
        }
    }

    async listFiles(rootName: string, dir?: string, search?: string): Promise<FileEntry[]> {
        const root = this.resolveRoot(rootName);
        const targetDir = dir
            ? await this.resolveSafe(root, dir)
            : root;

        const entries = await this.buildTree(targetDir, root);

        if (search) {
            return this.filterTree(entries, search.toLowerCase());
        }

        return entries;
    }

    private async buildTree(dirPath: string, rootPath: string): Promise<FileEntry[]> {
        let items: import("node:fs").Dirent[];
        try {
            items = await readdir(dirPath, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FileNotFoundError(`Directory not found: ${relative(rootPath, dirPath)}`);
            }
            throw err;
        }

        // Sort: directories first, then alphabetically
        items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        const result: FileEntry[] = [];

        for (const item of items) {
            if (item.name.startsWith(".")) continue;

            const fullPath = resolve(dirPath, item.name);
            const relPath = relative(rootPath, fullPath);

            if (item.isDirectory()) {
                const children = await this.buildTree(fullPath, rootPath);
                result.push({
                    name: item.name,
                    path: relPath,
                    type: "dir",
                    children,
                });
            } else if (item.isFile()) {
                result.push({
                    name: item.name,
                    path: relPath,
                    type: "file",
                });
            }
        }

        return result;
    }

    private filterTree(entries: FileEntry[], search: string): FileEntry[] {
        const result: FileEntry[] = [];

        for (const entry of entries) {
            if (entry.type === "dir" && entry.children) {
                const filteredChildren = this.filterTree(entry.children, search);
                if (filteredChildren.length > 0) {
                    result.push({ ...entry, children: filteredChildren });
                }
            } else if (entry.type === "file") {
                if (entry.name.toLowerCase().includes(search)) {
                    result.push(entry);
                }
            }
        }

        return result;
    }
}

export class FilePathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FilePathError";
    }
}

export class FileNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FileNotFoundError";
    }
}
