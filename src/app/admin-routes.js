import { Config } from "../config/defaults.js";
import { GLOBALS } from "../proxy/diagnostics/runtime-state.js";
import { Auth } from "../admin/auth.js";
import { CFAnalytics } from "../integrations/cf-analytics.js";
import { CFDns } from "../integrations/cf-dns.js";
import { readLazyVersionStatus } from "../integrations/version-check.js";
import { getPlaybackOptimizationStats } from "../proxy/diagnostics/playback-optimization.js";
import { readRuntimeConfig, writeRuntimeConfig } from "../storage/config-repository.js";
import {
    deleteAdminNodesPayload,
    invalidateStoredNodeCache,
    listAdminNodesPayload,
    saveAdminNodesPayload
} from "../storage/import-export.js";
import { probeStoredNodeLines } from "../storage/node-repository.js";
import { UI } from "../admin/ui/page.js";

function jsonResponse(value, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(value), {
        ...init,
        headers
    });
}

export async function readAdminApiPayload(request) {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > Config.Defaults.AdminApiMaxBodyBytes) {
        return {
            errorResponse: jsonResponse({ error: "请求体过大" }, { status: 413 })
        };
    }

    let data;
    try {
        data = await request.json();
    } catch (_) {
        return {
            errorResponse: jsonResponse({ error: "请求体必须为 JSON" }, { status: 400 })
        };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.action !== "string") {
        return {
            errorResponse: jsonResponse({ error: "无效请求参数" }, { status: 400 })
        };
    }

    return { data };
}

export async function handleAdminApiAction(data, { request, env }) {
    const kv = Auth.getKV(env);
    if (!kv) {
        return jsonResponse({ error: "KV未绑定! 请检查变量名是否为 ENI_KV 或 KV" }, { status: 500 });
    }

    switch (data.action) {
        case "loadConfig":
            return jsonResponse(await readRuntimeConfig(env));

        case "saveConfig":
            if (data.config) {
                await writeRuntimeConfig(env, data.config);
            }
            return jsonResponse({ success: true });

        case "versionStatus":
            return jsonResponse(await readLazyVersionStatus(env, { now: new Date() }));

        case "tcping": {
            if (typeof data.name === "string" && data.name.trim()) {
                const runtimeConfig = await readRuntimeConfig(env);
                const result = await probeStoredNodeLines(data.name, env, {
                    lineId: data.lineId,
                    timeoutMs: data.timeout ?? runtimeConfig.pingTimeout,
                    cacheMinutes: runtimeConfig.pingCacheMinutes,
                    forceRefresh: data.forceRefresh === true || data.force === true,
                    silent: data.silent === true,
                    invalidate: invalidateStoredNodeCache
                });
                return jsonResponse(result.body, { status: result.status });
            }
            const { handleTcpProbe } = await import("../probes/tcp-probe.js");
            return handleTcpProbe(data.target, env, request, { force: data.force === true });
        }

        case "cfMetrics":
            return CFAnalytics.handleMetrics(data.rangeKey, env, data.mode, request);

        case "playbackOptimizationStats":
            return jsonResponse(getPlaybackOptimizationStats(GLOBALS));

        case "cfDnsGetPreferredRecords":
            return CFDns.handleGetPreferredRecords(data, request, env);

        case "cfDnsApplyPreferredRecords":
            return CFDns.handleApplyPreferredRecords(data, request, env);

        case "cfDnsGetCurrentCname":
            return CFDns.handleGetCurrentCname(data, request, env);

        case "cfDnsUpsertCurrentCname":
            return CFDns.handleUpsertCurrentCname(data, request, env);

        case "save":
        case "import": {
            const result = await saveAdminNodesPayload(data, env);
            return jsonResponse(result.success ? { success: true } : { error: result.error }, { status: result.status });
        }

        case "delete":
        case "batchDelete": {
            const result = await deleteAdminNodesPayload(data, env);
            return jsonResponse({ success: result.success }, { status: result.status });
        }

        case "list": {
            try {
                const result = await listAdminNodesPayload(env);
                return jsonResponse({
                    nodes: result.nodes,
                    generatedAt: result.generatedAt || "",
                    nodeActivityAvailable: result.nodeActivityAvailable === true,
                    nodeActivity: result.nodeActivity || {}
                }, { status: result.status });
            } catch (error) {
                return jsonResponse({ error: error.message || "读取节点列表失败" }, { status: 500 });
            }
        }

        case "logout":
            return jsonResponse({ success: true }, {
                headers: {
                    "Set-Cookie": "auth_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
                }
            });

        default:
            return new Response("Invalid Action", { status: 400 });
    }
}

export async function handleAdminApiRequest(request, env) {
    const { data, errorResponse } = await readAdminApiPayload(request);
    if (errorResponse) return errorResponse;
    return handleAdminApiAction(data, { request, env });
}

export async function handleAdminRouteRequest(request, env) {
    const contentType = request.headers.get("content-type") || "";

    if (request.method === "POST" && contentType.includes("form")) {
        return Auth.handleLogin(request, env);
    }

    if (!(await Auth.verifyRequest(request, env))) {
        if (request.method === "POST") return new Response("Unauthorized", { status: 401 });
        return UI.renderLoginPage();
    }

    if (request.method === "POST") {
        if (!Auth.verifyAdminPostOrigin(request)) {
            return jsonResponse({ error: "Forbidden Origin" }, { status: 403 });
        }
        return handleAdminApiRequest(request, env);
    }

    return UI.renderAdminUI();
}
