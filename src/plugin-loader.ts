import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NestAPI, NestPlugin } from "./types.js";
import * as logger from "./logger.js";

/**
 * Scan a directory for plugins and load them.
 *
 * A plugin is a subdirectory containing a `nest.ts` file that exports
 * a default function. The function receives a NestAPI instance.
 *
 * Also supports legacy flat `.ts` files for backwards compatibility.
 */
export async function loadPlugins(pluginsDir: string, api: NestAPI, bustCache = false): Promise<string[]> {
    const dir = resolve(pluginsDir);
    const loaded: string[] = [];

    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err: any) {
        if (err.code === "ENOENT") {
            logger.info("Plugins directory not found, skipping", { dir });
            return loaded;
        }
        throw err;
    }

    for (const entry of entries.sort()) {
        const fullPath = join(dir, entry);
        const st = await stat(fullPath);

        let modulePath: string | null = null;

        if (st.isDirectory()) {
            // New convention: subdirectory with nest.ts
            const nestPath = join(fullPath, "nest.ts");
            try {
                const nestStat = await stat(nestPath);
                if (nestStat.isFile()) {
                    modulePath = nestPath;
                }
            } catch {
                // No nest.ts — skip (may be a pi-only plugin like core/)
            }
        } else if (st.isFile() && entry.endsWith(".ts") && entry !== "package.json") {
            // Legacy: flat .ts file
            modulePath = fullPath;
        }

        if (!modulePath) continue;

        try {
            // Append a query string to bust Node's ESM module cache on reload
            const importPath = bustCache ? `${modulePath}?t=${Date.now()}` : modulePath;
            const mod = await import(importPath);
            const pluginFn: NestPlugin = mod.default;

            if (typeof pluginFn !== "function") {
                logger.warn("Plugin has no default export function, skipping", { path: modulePath });
                continue;
            }

            await pluginFn(api);
            const name = st.isDirectory() ? entry : entry.replace(/\.ts$/, "");
            loaded.push(name);
            logger.info("Plugin loaded", { name, path: modulePath });
        } catch (err) {
            logger.error("Failed to load plugin", { path: modulePath, error: String(err) });
        }
    }

    return loaded;
}

/**
 * Discover pi extensions (pi.ts files) in plugin subdirectories.
 * Returns absolute paths to all pi.ts files found.
 */
export async function discoverExtensions(pluginsDir: string): Promise<string[]> {
    const dir = resolve(pluginsDir);
    const extensions: string[] = [];

    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return extensions;
    }

    for (const entry of entries.sort()) {
        const fullPath = join(dir, entry);
        try {
            const st = await stat(fullPath);
            if (!st.isDirectory()) continue;
            const piPath = join(fullPath, "pi.ts");
            const piStat = await stat(piPath);
            if (piStat.isFile()) {
                extensions.push(piPath);
            }
        } catch {
            // No pi.ts, skip
        }
    }

    return extensions;
}
