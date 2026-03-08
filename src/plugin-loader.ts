import { readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { NestAPI, NestPlugin } from "./types.js";
import * as logger from "./logger.js";

const __srcDir = dirname(fileURLToPath(import.meta.url));
const __projectDir = resolve(__srcDir, "..");

/** Build jiti aliases so plugins can `import "nest"` from anywhere. */
function buildAliases(): Record<string, string> {
    return {
        "nest": resolve(__srcDir, "types.ts"),
        "nest/chunking": resolve(__srcDir, "chunking.ts"),
        "nest/logger": resolve(__srcDir, "logger.ts"),
    };
}

/**
 * Scan a directory for plugins and load them.
 *
 * A plugin is a subdirectory containing a `nest.ts` file that exports
 * a default function. The function receives a NestAPI instance.
 *
 * Uses jiti to resolve `import "nest"` to the actual source files,
 * so plugins work regardless of where they live on disk.
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

    const jiti = createJiti(import.meta.url, {
        moduleCache: !bustCache,
        alias: buildAliases(),
    });

    for (const entry of entries.sort()) {
        const fullPath = join(dir, entry);
        const st = await stat(fullPath);

        let modulePath: string | null = null;

        if (st.isDirectory()) {
            // Convention: subdirectory with nest.ts
            const nestPath = join(fullPath, "nest.ts");
            try {
                const nestStat = await stat(nestPath);
                if (nestStat.isFile()) {
                    modulePath = nestPath;
                }
            } catch {
                // No nest.ts — may be a pi-only plugin (e.g. core/)
            }
        } else if (st.isFile() && entry.endsWith(".ts") && entry !== "package.json") {
            // Legacy: flat .ts file
            modulePath = fullPath;
        }

        if (!modulePath) continue;

        try {
            const mod = await jiti.import(modulePath, { default: true }) as any;
            const pluginFn: NestPlugin = mod.default ?? mod;

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
