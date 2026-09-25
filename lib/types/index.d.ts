/**
 * Register a {@link NewApiAdapter} for the `newapi-images` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin reads its own volatile config references (the profile
 * patch and the web settings page write them through the settings service)
 * and resolves the API key through the optional credential seam
 * (`ctx.credentials`), so a changed base URL, catalog, or key reaches the
 * very next request without re-applying the plugin, while an in-flight stream
 * keeps the facts it started with. The one registration-captured fact — the
 * retry policy — re-registers the route in place when it changes. The plugin
 * also serves model discovery for the `llm-newapi-vision` settings namespace by
 * interrogating `GET {baseURL}/models`.
 * @module dsh-llm-newapi-vision
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import type { NewApiCatalogModel, NewApiConnectionOptions, ToolImageMode } from './adapter.js';
import type { ProviderHints } from './types.js';
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODEL_EXCLUDE_PATTERNS, DEFAULT_PROVIDER_HINTS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, matchModelsDev, modelNameFromId, NewApiAdapter, normalizeBaseUrl, PKG, } from './adapter.js';
export { imageTaskTool, serializeRequest, serializeRequestWithImages } from './serialize.js';
export type { NewApiAdapterOptions, NewApiCatalogModel, NewApiConnectionOptions } from './adapter.js';
export type * from './types.js';
export declare const name = "llm-newapi-vision";
export declare const inject: string[];
/** Placeholder gateway base used when neither config nor environment names one. */
export declare const DEFAULT_BASE_URL = "https://newapi.example.com/v1";
/**
 * Plugin config values, validated by the same-named schemastery schema and
 * doubling as the `llm-newapi-vision` settings-section shape. Every field is
 * optional in yml: `baseURL` falls back to $NEWAPI_IMAGES_BASE_URL from a trusted
 * environment layer, then the placeholder {@link DEFAULT_BASE_URL} — a
 * request against the placeholder fails as TRANSPORT at first use, naming the
 * endpoint to fix. The API key is not a config value at all: it lives in the
 * credentials store under the fixed reference `newapi_images` (the web settings
 * page writes it), and a request without any stored key fails with
 * `MISSING_CREDENTIAL`, not at plugin load.
 *
 * This is the plain-value shape a composition entry or programmatic caller
 * writes; the running plugin reads the schema-derived {@link Config} whose
 * volatile fields are references (see {@link snapshotConfig}).
 */
export interface NewApiConfig {
    /** Gateway base including the `/v1` prefix; defaults to $NEWAPI_IMAGES_BASE_URL from a trusted layer, then the placeholder `https://newapi.example.com/v1`. */
    baseURL?: string;
    /** Advisory models shown by discovery consumers; defaults to none — a gateway's model set is deployment-specific. */
    models?: NewApiCatalogModel[];
    /**
     * Optional request-only projection of tool-produced images: with
     * `user-followup`, an image a tool returned is repeated to the model as a
     * transient user-role attachment after its tool result, so a vision route
     * can inspect tool output. Disabled by default; the durable log is untouched.
     */
    toolImageMode?: ToolImageMode;
    /**
     * Case-insensitive id substrings excluding discovered models that cannot
     * serve chat completions (embedding, rerank, ranker families). Replaces the
     * default {@link DEFAULT_MODEL_EXCLUDE_PATTERNS} list; an empty array
     * disables filtering. The hand-curated {@link models} catalog is unaffected.
     */
    modelExcludePatterns?: string[];
    /** Positive context capacity used when the selected model has no exact value (default 128,000). */
    defaultContextWindow?: number;
    /** Default per-request output cap; omission sends no cap and lets each upstream default apply. */
    maxTokens?: number;
    /** Maximum gateway idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Forward proxy for the models.dev catalog download performed by the「更新模型信息」action. */
    proxy?: ProxyConfig;
    /**
     * Match-shaping hints for the models.dev params lookup: family prefixes
     * and exact ids name which catalog provider counts as official (leading
     * match, flagged). Built-in families (glm→zai, gpt→openai, claude→
     * anthropic, …) apply first; these entries override and extend them.
     */
    providerHints?: ProviderHints;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
/** Forward-proxy settings for the models.dev catalog download. */
export interface ProxyConfig {
    /** Whether the proxy is used; defaults to false. */
    enabled?: boolean;
    /** Proxy URL; presets default to `http://127.0.0.1:7890`. */
    url?: string;
}
/** Default forward proxy: the conventional Clash port on loopback. */
export declare const DEFAULT_PROXY_URL = "http://127.0.0.1:7890";
declare const configSchema: z<Schemastery.ObjectS<NoInfer<{
    baseURL: z<string, string, "volatile">;
    models: z<NoInfer<NewApiCatalogModel[]>, NoInfer<NewApiCatalogModel[]>, "volatile">;
    toolImageMode: z<"off" | "user-followup", "off" | "user-followup", "volatile-defined">;
    modelExcludePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxTokens: z<number, number, "volatile">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    proxy: z<NoInfer<{
        enabled?: boolean | null;
        url?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict>, NoInfer<ProxyConfig>, "volatile">;
    providerHints: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, "volatile">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseURL: z<string, string, "volatile">;
    models: z<NoInfer<NewApiCatalogModel[]>, NoInfer<NewApiCatalogModel[]>, "volatile">;
    toolImageMode: z<"off" | "user-followup", "off" | "user-followup", "volatile-defined">;
    modelExcludePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxTokens: z<number, number, "volatile">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    proxy: z<NoInfer<{
        enabled?: boolean | null;
        url?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict>, NoInfer<ProxyConfig>, "volatile">;
    providerHints: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, "volatile">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * The plugin config schema. Every field is volatile: the settings form edits
 * them through the active profile patch, and the Loader commits a
 * volatile-only edit into the running config references without re-applying
 * the plugin, so the next resolution sees it. Field-level checks live here —
 * not only in the resolver — because the settings write point validates this
 * exact schema before persisting, and the resolver re-judges every bound for
 * programmatic construction.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    baseURL: z<string, string, "volatile">;
    models: z<NoInfer<NewApiCatalogModel[]>, NoInfer<NewApiCatalogModel[]>, "volatile">;
    toolImageMode: z<"off" | "user-followup", "off" | "user-followup", "volatile-defined">;
    modelExcludePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxTokens: z<number, number, "volatile">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    proxy: z<NoInfer<{
        enabled?: boolean | null;
        url?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict>, NoInfer<ProxyConfig>, "volatile">;
    providerHints: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, "volatile">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseURL: z<string, string, "volatile">;
    models: z<NoInfer<NewApiCatalogModel[]>, NoInfer<NewApiCatalogModel[]>, "volatile">;
    toolImageMode: z<"off" | "user-followup", "off" | "user-followup", "volatile-defined">;
    modelExcludePatterns: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxTokens: z<number, number, "volatile">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    proxy: z<NoInfer<{
        enabled?: boolean | null;
        url?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict>, NoInfer<ProxyConfig>, "volatile">;
    providerHints: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        defaults: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
        models: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>, "plain">;
    }>>>, "volatile">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * The config a running plugin instance holds: schemastery replaced every
 * volatile field with a stable reference, updated in place by the Loader.
 * Read plain values through {@link snapshotConfig}; the exported
 * {@link NewApiConfig} is the plain-value shape callers write.
 */
export type Config = ReturnType<typeof configSchema>;
/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedNewApiOptions = NewApiConnectionOptions;
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - plain plugin config values (a composition entry, or a
 * {@link snapshotConfig} of the running volatile references).
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. A trusted layer may supply the gateway endpoint.
 * @returns validated connection facts plus the credential reference.
 */
export declare function resolveAdapterOptions(config: NewApiConfig, environment?: ReturnType<typeof launchEnvironmentOf>): ResolvedNewApiOptions;
export declare function apply(ctx: Context, config: Config): void;
