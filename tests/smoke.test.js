import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeConfig } from "../src/config/normalize.js";
import {
  Config,
  DEFAULT_REDIRECT_RULE_TERMS,
  DEFAULT_TCPING_CONFIG,
  MANUAL_REDIRECT_DOMAINS
} from "../src/config/defaults.js";
import { DEFAULT_REDIRECT_RULE_TERMS as DEFAULT_REDIRECT_RULE_TERM_PRESET } from "../src/config/default-redirect-rule-terms.js";
import { createRuntimeGlobals, GLOBALS } from "../src/proxy/diagnostics/runtime-state.js";
import {
  createStoredNodeRecord,
  prepareNodesForStorage,
  normalizeNodeRecord,
  normalizeTargetList
} from "../src/storage/node-model.js";
import { handleAdminApiRequest } from "../src/app/admin-routes.js";
import { CONFIG_STORAGE_KEY, readRuntimeConfig } from "../src/storage/config-repository.js";
import { Proxy } from "../src/proxy/pipeline/handle.js";
import {
  applyBaseProxySecurityHeaders,
  applyProxyCorsHeaders,
  applyStaticStreamingCacheHeaders
} from "../src/proxy/media/response-header-policy.js";
import {
  buildCloudflareFetchOptions,
  shouldUseIndependentImagePath,
  shouldUseIndependentMetadataPath
} from "../src/proxy/media/static-cache.js";
import {
  concatUint8Arrays,
  isOpenEndedByteRange,
  parseResponseByteRange,
  parseSingleByteRangeHeader
} from "../src/proxy/media/range-windows.js";
import {
  buildExternalRedirectCacheKey,
  EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS
} from "../src/proxy/routing/url-utils.js";
import {
  clearExternalRedirectUrl,
  rememberExternalRedirectUrl,
  resolveCachedExternalRedirectUrl
} from "../src/proxy/routing/redirect-cache.js";
import {
  cacheLearnedBasePath,
  clearCachedLearnedBasePath,
  detectBasePathChannel,
  getCachedLearnedBasePath
} from "../src/proxy/routing/basepath-state.js";
import { CFAnalytics } from "../src/integrations/cf-analytics.js";
import { Auth } from "../src/admin/auth.js";
import { UI } from "../src/admin/ui/page.js";
import { NODE_PATH_PHRASE_MAP } from "../src/admin/ui/node-path-phrase-map.js";
import {
  buildConfigFromSettingsDraft,
  cloneTcpingConfig,
  createSettingsDraftFromConfig,
  MAX_SHARED_REDIRECT_RULES
} from "../src/admin/ui/settings-model.js";
import {
  buildProxyResponseBody,
  PlaybackTelemetry,
  wrapPlaybackTelemetryBody
} from "../src/proxy/diagnostics/playback-telemetry.js";
import {
  mergeNodeActivityWithRecentUsage,
  readRecentNodeUsageMap,
  rememberRecentNodeUsage
} from "../src/proxy/diagnostics/recent-node-usage.js";
import {
  maybeCleanupRuntimeCaches
} from "../src/proxy/diagnostics/runtime-cache-cleanup.js";
import { createPlaybackOptimizationBudgetState } from "../src/proxy/diagnostics/playback-optimization.js";
import { createDiagnostics, finalizeDiagnostics } from "../src/proxy/diagnostics/diagnostics.js";
import {
  LOGIN_COMPAT_AUTH,
  PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
  PLAYBACK_OPTIMIZATION_MAX_BOUNDED_RANGE_BYTES
} from "../src/proxy/shared/constants.js";
import { isManualRedirectHost } from "../src/proxy/routing/redirect-policy.js";
import {
  buildExternalRedirectHeaders,
  buildRedirectErrorResponse,
  followRedirectChain
} from "../src/proxy/routing/redirect-chain.js";
import { normalizeIncomingPath } from "../src/proxy/routing/incoming-path.js";
import { prepareNodeContext } from "../src/proxy/pipeline/node-context.js";
import {
  normalizeIncomingRequest,
  normalizeIndependentImageRequest,
  shouldUseContinuationMediaFastPath,
  shouldUseStartupMediaFastPath
} from "../src/proxy/pipeline/request-state.js";
import {
  buildMetadataPrewarmTargets,
  maybePrewarmMetadataResponse,
  normalizePrewarmDepth
} from "../src/proxy/media/metadata-prewarm.js";
import { buildPlaybackWindowSessionKey } from "../src/proxy/media/playback-windows.js";
import {
  buildWorkerMetadataCacheKey,
  isWhitelistedMetadataManifestUrl,
  matchWorkerMetadataCache,
  normalizeWorkerMetadataCacheUrl,
  shouldWorkerCacheMetadataUrl,
  storeWorkerMetadataCache
} from "../src/proxy/media/metadata-cache.js";
import { rewriteProxyResponse } from "../src/proxy/pipeline/response-orchestrator.js";
import {
  dispatchIndependentImageUpstream,
  dispatchContinuationMediaUpstream,
  dispatchStartupMediaUpstream,
  dispatchUpstream
} from "../src/proxy/upstream/dispatch-upstream.js";
import { createFetchWithRedirectsHandlers } from "../src/proxy/upstream/upstream-attempt.js";
import { buildUpstreamHeaders } from "../src/proxy/upstream/upstream-headers.js";
import { shouldAllowTargetFailover } from "../src/proxy/upstream/failover-utils.js";

function createCacheFacade() {
  const store = new Map();
  return {
    async match(url) {
      return store.get(String(url)) || null;
    },
    async put(url, response) {
      store.set(String(url), response);
    },
    async delete(url) {
      store.delete(String(url));
      return true;
    }
  };
}

function resetGlobals() {
  GLOBALS.NodeCache.clear();
  GLOBALS.NodeContextCache.clear();
  GLOBALS.StreamBasePathCache.clear();
  GLOBALS.GeoCache.clear();
  GLOBALS.TcpingResultCache.clear();
  GLOBALS.TcpingInflight.clear();
  GLOBALS.CfMetricsSummaryCache.clear();
  GLOBALS.CfMetricsTopPathsCache.clear();
  GLOBALS.CfMetricsActivityCache.clear();
  GLOBALS.CfMetricsSummaryInflight.clear();
  GLOBALS.CfMetricsTopPathsInflight.clear();
  GLOBALS.CfMetricsActivityInflight.clear();
  GLOBALS.RecentNodeUsageCache.clear();
  GLOBALS.PlaybackTelemetryHosts.clear();
  GLOBALS.ExternalRedirectCache.clear();
  GLOBALS.ExternalRedirectInflight.clear();
  GLOBALS.PlaybackHeadWindowCache.clear();
  GLOBALS.PlaybackJumpWindowCache.clear();
  GLOBALS.PlaybackSessionHints.clear();
  GLOBALS.PlaybackSessionStopGuard.clear();
  GLOBALS.PlaybackContinuationLanes?.clear?.();
  GLOBALS.PlaybackContinuationStalls?.clear?.();
  GLOBALS.PlaybackWindowBytesTotal = 0;
  GLOBALS.RateLimitCache.clear();
  GLOBALS.resetRuntimeCacheCleanupState();
  GLOBALS.resetPlaybackOptimizationStats();
  GLOBALS.ConfigCache = null;
  globalThis.caches.default = createCacheFacade();
}

async function settleExecutionContext(executionContext) {
  await Promise.allSettled(executionContext?.tasks || []);
}

globalThis.caches = {
  default: createCacheFacade()
};

test("normalizeConfig keeps defaults and sanitizes redirect whitelist", () => {
  const config = normalizeConfig({
    redirectWhitelistDomains: [" https://Example.com/path ", "foo.bar", "example.com"],
    cfMetrics: { autoRefreshSeconds: 5 },
    tcping: { count: 99, timeoutMs: 50 }
  });

  assert.deepEqual(config.thirdPartyProxies, []);
  assert.deepEqual(config.redirectWhitelistDomains, ["example.com", "foo.bar"]);
  assert.equal(config.cfMetrics.autoRefreshSeconds, 30);
  assert.equal(config.tcping.tcp.count, 10);
  assert.equal(config.tcping.tcp.timeoutMs, 200);
});

test("normalize config source no longer keeps historical default constant names", async () => {
  const source = await fs.promises.readFile(new URL("../src/config/normalize.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DEFAULT_MS06_/);
});

test("wrangler config explicitly disables Smart Placement for the single-worker frontend", async () => {
  const raw = await fs.promises.readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw);
  assert.equal(config?.placement?.mode, "off");
  assert.equal(config?.triggers, undefined);
});

test("version module stays aligned with package metadata and exposes repository defaults", async () => {
  const packageJson = JSON.parse(
    await fs.promises.readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  const wranglerConfig = JSON.parse(
    await fs.promises.readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  );
  const versionManifest = JSON.parse(
    await fs.promises.readFile(new URL("../version.json", import.meta.url), "utf8")
  );
  const versionModule = await import(`../src/app/version.js?t=${Date.now()}`);

  assert.equal(versionModule.WORKER_VERSION, packageJson.version);
  assert.equal(versionManifest.version, packageJson.version);
  assert.equal(versionModule.GITHUB_REPOSITORY_URL, "https://github.com/irm123gard/Emby-Mate");
  assert.equal(versionModule.GITHUB_REPOSITORY_BRANCH, "main");
  assert.equal(versionModule.GITHUB_REPOSITORY_VERSION_PATH, "version.json");
  assert.equal(versionModule.VERSION_STATUS_LAZY_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(versionModule.VERSION_STATUS_ERROR_RETRY_MS, 60 * 60 * 1000);
  assert.equal(wranglerConfig?.triggers, undefined);
  assert.equal(
    versionModule.buildGitHubRepositoryRawUrl(versionModule.GITHUB_REPOSITORY_VERSION_PATH),
    "https://raw.githubusercontent.com/irm123gard/Emby-Mate/main/version.json"
  );
  assert.deepEqual(versionModule.normalizeVersionStatusRecord({
    currentVersion: "2.4.10",
    remoteVersion: "2.5.0",
    status: "update-available",
    checkedAt: "2026-03-24T06:00:00.000Z"
  }), {
    currentVersion: "2.4.10",
    remoteVersion: "2.5.0",
    status: "update-available",
    checkedAt: "2026-03-24T06:00:00.000Z",
    error: ""
  });
});

test("normalizeConfig accepts aligned playback fields and legacy aliases", () => {
  const config = normalizeConfig({
    enableH2: true,
    enableH3: false,
    peakDowngrade: false,
    protocolFallback: false,
    enablePrewarm: false,
    prewarmDepth: "poster",
    prewarmCacheTtl: 99999,
    directStaticAssets: true,
    directHlsDash: true,
    sourceSameOriginProxy: false,
    forceExternalProxy: false,
    debugProxyHeaders: true,
    wangpandirect: " 115.com , aliyundrive ",
    corsOrigins: " https://app.example.test , https://tv.example.test ",
    geoAllowlist: " us, jp ",
    geoBlocklist: " cn, hk ",
    ipBlacklist: " 203.0.113.9 , 198.51.100.5 ",
    rateLimitRpm: 120,
    directSourceNodes: [" alpha ", "beta", "alpha", ""],
    pingTimeout: 999999,
    pingCacheMinutes: -10,
    upstreamTimeoutMs: 30000,
    upstreamRetryAttempts: 99,
    cacheTtlImages: 999
  });

  assert.equal(config.enableH2, true);
  assert.equal(config.enableH3, false);
  assert.equal(config.peakDowngrade, false);
  assert.equal(config.protocolFallback, false);
  assert.equal(config.enablePrewarm, false);
  assert.equal(config.prewarmDepth, "poster");
  assert.equal(config.prewarmCacheTtl, 3600);
  assert.equal(config.directStaticAssets, true);
  assert.equal(config.directHlsDash, true);
  assert.equal(config.sourceSameOriginProxy, false);
  assert.equal(config.forceExternalProxy, false);
  assert.equal(config.debugProxyHeaders, true);
  assert.equal(config.wangpandirect, "115.com , aliyundrive");
  assert.equal(config.corsOrigins, "https://app.example.test , https://tv.example.test");
  assert.equal(config.geoAllowlist, "us, jp");
  assert.equal(config.geoBlocklist, "cn, hk");
  assert.equal(config.ipBlacklist, "203.0.113.9 , 198.51.100.5");
  assert.equal(config.rateLimitRpm, 120);
  assert.deepEqual(config.sourceDirectNodes, ["alpha", "beta"]);
  assert.equal(config.pingTimeout, 180000);
  assert.equal(config.pingCacheMinutes, 0);
  assert.equal(config.upstreamTimeoutMs, 30000);
  assert.equal(config.upstreamRetryAttempts, 3);
  assert.equal(config.cacheTtlImages, 365);
});
test("normalizeTargetList keeps order and removes invalid or duplicate targets", () => {
  assert.deepEqual(
    normalizeTargetList([
      " https://a.example.test/ ",
      "http://b.example.test",
      "https://a.example.test",
      "ftp://invalid.example.test"
    ]),
    ["https://a.example.test", "http://b.example.test"]
  );
});

test("normalizeNodeRecord supports path-based nodes and sanitized headers", () => {
  const node = normalizeNodeRecord({
    name: "东影",
    path: "dongying",
    lines: [
      { name: "主线", target: "https://a.example.test/" },
      { name: "备用", target: "http://b.example.test" },
      { name: "无效", target: "ftp://invalid.example.test" }
    ],
    activeLineId: "missing",
    headers: {
      "X-Test": 1,
      Host: "should-drop"
    },
    secret: "abc",
    tag: "tag",
    remark: "remark"
  });

  assert.equal(node.name, "东影");
  assert.equal(node.path, "dongying");
  assert.equal(node.target, "https://a.example.test");
  assert.deepEqual(node.targets, ["https://a.example.test", "http://b.example.test"]);
  assert.equal(node.activeLineId, "line-1");
  assert.equal(node.direct, false);
  assert.equal(node.sourceDirect, false);
  assert.equal(node.directSource, false);
  assert.equal(node.direct2xx, false);
  assert.equal(node.realClientIpMode, "forward");
  assert.deepEqual(node.lines, [
    {
      id: "line-1",
      name: "主线",
      target: "https://a.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    },
    {
      id: "line-2",
      name: "备用",
      target: "http://b.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    }
  ]);
  assert.deepEqual(node.headers, { "X-Test": "1" });
  assert.equal("secret" in node, false);

  const stored = createStoredNodeRecord(node);
  assert.equal(stored.name, "东影");
  assert.equal(stored.path, "dongying");
  assert.equal(stored.target, "https://a.example.test");
  assert.deepEqual(stored.targets, ["https://a.example.test", "http://b.example.test"]);
  assert.equal(stored.activeLineId, "line-1");
  assert.deepEqual(stored.lines, node.lines);
  assert.deepEqual(stored.headers, { "X-Test": "1" });
  assert.equal(stored.realClientIpMode, "forward");
  assert.equal("secret" in stored, false);
});

test("normalizeNodeRecord defaults real client IP mode to forward and accepts explicit strip mode", () => {
  const defaultForward = normalizeNodeRecord({
    name: "默认站点",
    path: "default-node",
    target: "https://default.example.test"
  });
  const explicitStrip = normalizeNodeRecord({
    name: "新站点",
    path: "modern",
    target: "https://modern.example.test",
    realClientIpMode: "strip"
  });

  assert.equal(defaultForward.realClientIpMode, "forward");
  assert.equal(explicitStrip.realClientIpMode, "strip");
});

test("normalizeNodeRecord falls back to legacy secret when path is missing", () => {
  const node = normalizeNodeRecord({
    name: "东影",
    secret: "dongying",
    target: "https://a.example.test/"
  });

  assert.equal(node.name, "东影");
  assert.equal(node.path, "dongying");
  assert.equal(node.target, "https://a.example.test");
  assert.deepEqual(node.targets, ["https://a.example.test"]);
  assert.equal("secret" in node, false);
});

test("prepareNodesForStorage validates and normalizes node save payloads", () => {
  const prepared = prepareNodesForStorage([
    {
      name: " alpha ",
      path: " dongying ",
      lines: [
        { name: "主线", target: "https://alpha-a.example.test/" },
        { name: "备用", target: "https://alpha-b.example.test/" }
      ],
      headers: {
        "X-Test": 1,
        Host: "drop-me"
      }
    }
  ]);

  assert.deepEqual(prepared.error, null);
  assert.deepEqual(prepared.nodes, [
    {
      name: "alpha",
      path: "dongying",
      target: "https://alpha-a.example.test",
      targets: ["https://alpha-a.example.test", "https://alpha-b.example.test"],
      lines: [
        {
          id: "line-1",
          name: "主线",
          target: "https://alpha-a.example.test",
          latencyMs: null,
          latencyUpdatedAt: ""
        },
        {
          id: "line-2",
          name: "备用",
          target: "https://alpha-b.example.test",
          latencyMs: null,
          latencyUpdatedAt: ""
        }
      ],
      activeLineId: "line-1",
      headers: { "X-Test": "1" },
      remark: "",
      tag: "",
      redirectWhitelistEnabled: false,
      realClientIpMode: "forward",
      direct: false,
      sourceDirect: false,
      directSource: false,
      direct2xx: false
    }
  ]);

  assert.deepEqual(prepareNodesForStorage([{ lines: [{ target: "https://only.example.test" }] }]), {
    nodes: [],
    error: "节点名称不能为空"
  });
  assert.deepEqual(prepareNodesForStorage([{ name: "旧站", target: "https://only.example.test" }]), {
    nodes: [
      {
        name: "旧站",
        path: "旧站",
        target: "https://only.example.test",
        targets: ["https://only.example.test"],
        lines: [
          {
            id: "line-1",
            name: "线路1",
            target: "https://only.example.test",
            latencyMs: null,
            latencyUpdatedAt: ""
          }
        ],
        activeLineId: "line-1",
        headers: {},
        remark: "",
        tag: "",
        redirectWhitelistEnabled: false,
        realClientIpMode: "forward",
        direct: false,
        sourceDirect: false,
        directSource: false,
        direct2xx: false
      }
    ],
    error: null
  });
  assert.deepEqual(prepareNodesForStorage([{ name: "broken", target: "ftp://bad.example.test" }]), {
    nodes: [],
    error: "请至少填写 1 个目标地址"
  });
  assert.deepEqual(prepareNodesForStorage([{ name: "broken", targets: ["https://ok.example.test", "ftp://bad.example.test"] }]), {
    nodes: [],
    error: "目标地址格式错误，必须以 http:// 或 https:// 开头"
  });
  assert.deepEqual(prepareNodesForStorage([
    { name: "站点一", path: "same", target: "https://one.example.test" },
    { name: "站点二", path: "same", target: "https://two.example.test" }
  ]), {
    nodes: [],
    error: "站点路径不能重复"
  });
});

test("createRuntimeGlobals creates isolated runtime state snapshots", () => {
  const a = createRuntimeGlobals();
  const b = createRuntimeGlobals();

  a.NodeCache.set("alpha", { ok: true });
  a.PlaybackOptimizationStats.redirect.followed = 7;
  a.ConfigCache = { mode: "a" };

  assert.equal(b.NodeCache.size, 0);
  assert.equal(b.PlaybackOptimizationStats.redirect.followed, 0);
  assert.equal(b.ConfigCache, null);
  assert.equal("PlaybackTargetAffinityCache" in a, false);
  assert.equal("PlaybackTargetAffinityCache" in b, false);
  assert.equal("MetadataJsonInflight" in a, false);
  assert.equal("MetadataJsonInflight" in b, false);
  assert.equal(a.PlaybackWindowBytesTotal, 0);
  assert.equal(b.PlaybackWindowBytesTotal, 0);
  assert.notEqual(a.PlaybackOptimizationStats, b.PlaybackOptimizationStats);
  assert.notEqual(a.RuntimeCacheCleanupState, b.RuntimeCacheCleanupState);
});

test("playback window source tracks byte totals without sort-based eviction", async () => {
  const source = await fs.promises.readFile(new URL("../src/proxy/media/playback-windows.js", import.meta.url), "utf8");

  assert.match(source, /PlaybackWindowBytesTotal/);
  assert.doesNotMatch(source, /collectPlaybackWindowEntries/);
  assert.doesNotMatch(source, /\.sort\(\(left,\s*right\)\s*=>/);
});

test("runtime cache cleanup iterates through rate-limit and redirect caches in small chunks", () => {
  const globals = createRuntimeGlobals();
  const now = Date.now();

  globals.RateLimitCache.set("expired-rate-1", { count: 1, resetAt: now - 1 });
  globals.RateLimitCache.set("expired-rate-2", { count: 1, resetAt: now - 1 });
  globals.RateLimitCache.set("live-rate", { count: 1, resetAt: now + 10_000 });

  globals.ExternalRedirectCache.set("expired-redirect", {
    url: "https://cdn.example.test/old.mkv",
    exp: now - 1
  });
  globals.ExternalRedirectCache.set("live-redirect", {
    url: "https://cdn.example.test/live.mkv",
    exp: now + 10_000
  });

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 1 });
  assert.equal(globals.RateLimitCache.has("expired-rate-1"), false);
  assert.equal(globals.RateLimitCache.has("expired-rate-2"), true);
  assert.equal(globals.ExternalRedirectCache.has("expired-redirect"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 1);
  assert.ok(globals.RuntimeCacheCleanupState.iterators.rate);

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 1 });
  assert.equal(globals.ExternalRedirectCache.has("expired-redirect"), false);
  assert.equal(globals.ExternalRedirectCache.has("live-redirect"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 2);

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 1 });
  assert.equal(globals.RuntimeCacheCleanupState.phase, 3);

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 1 });
  assert.equal(globals.RuntimeCacheCleanupState.phase, 0);

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 1 });
  assert.equal(globals.RateLimitCache.has("expired-rate-2"), false);
  assert.equal(globals.RateLimitCache.has("live-rate"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 1);
});

test("runtime cache cleanup trims oversize rate-limit and redirect caches by oldest entries", () => {
  const globals = createRuntimeGlobals();
  const now = Date.now();

  globals.RateLimitCache.set("rate-old", { count: 1, resetAt: now + 60_000 });
  globals.RateLimitCache.set("rate-mid", { count: 2, resetAt: now + 60_000 });
  globals.RateLimitCache.set("rate-new", { count: 3, resetAt: now + 60_000 });

  globals.ExternalRedirectCache.set("redirect-old", {
    url: "https://cdn.example.test/old.mkv",
    exp: now + 60_000
  });
  globals.ExternalRedirectCache.set("redirect-new", {
    url: "https://cdn.example.test/new.mkv",
    exp: now + 60_000
  });

  maybeCleanupRuntimeCaches(globals, {
    now,
    budgetMs: 10,
    chunkSize: 8,
    rateLimitMaxEntries: 2,
    redirectMaxEntries: 1
  });
  assert.equal(globals.RateLimitCache.has("rate-old"), false);
  assert.equal(globals.RateLimitCache.has("rate-mid"), true);
  assert.equal(globals.RateLimitCache.has("rate-new"), true);
  assert.equal(globals.ExternalRedirectCache.has("redirect-old"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 1);

  maybeCleanupRuntimeCaches(globals, {
    now,
    budgetMs: 10,
    chunkSize: 8,
    rateLimitMaxEntries: 2,
    redirectMaxEntries: 1
  });
  assert.equal(globals.ExternalRedirectCache.has("redirect-old"), false);
  assert.equal(globals.ExternalRedirectCache.has("redirect-new"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 2);

  maybeCleanupRuntimeCaches(globals, {
    now,
    budgetMs: 10,
    chunkSize: 8,
    rateLimitMaxEntries: 2,
    redirectMaxEntries: 1
  });
  maybeCleanupRuntimeCaches(globals, {
    now,
    budgetMs: 10,
    chunkSize: 8,
    rateLimitMaxEntries: 2,
    redirectMaxEntries: 1
  });
  assert.equal(globals.RuntimeCacheCleanupState.phase, 0);
});

test("runtime cache cleanup clears stale inflight redirect and metadata prewarm state", () => {
  const globals = createRuntimeGlobals();
  const now = Date.now();

  globals.ExternalRedirectInflight.set("redirect-stale", {
    promise: Promise.resolve(""),
    resolve() {},
    startedAt: now - 61_000
  });
  globals.ExternalRedirectInflight.set("redirect-live", {
    promise: Promise.resolve(""),
    resolve() {},
    startedAt: now - 5_000
  });

  globals.MetadataPrewarmInflight.set("prewarm-stale", now - 61_000);
  globals.MetadataPrewarmInflight.set("prewarm-live", now - 5_000);

  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 8 });
  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 8 });
  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 8 });
  maybeCleanupRuntimeCaches(globals, { now, budgetMs: 10, chunkSize: 8 });

  assert.equal(globals.ExternalRedirectInflight.has("redirect-stale"), false);
  assert.equal(globals.ExternalRedirectInflight.has("redirect-live"), true);
  assert.equal(globals.MetadataPrewarmInflight.has("prewarm-stale"), false);
  assert.equal(globals.MetadataPrewarmInflight.has("prewarm-live"), true);
  assert.equal(globals.RuntimeCacheCleanupState.phase, 0);
});

test("runtime-state compatibility exports preserve shared globals and isolated factories", async () => {
  const runtimeState = await import("../src/proxy/diagnostics/runtime-state.js");
  const snapshot = runtimeState.createRuntimeGlobals();

  assert.equal(runtimeState.GLOBALS, GLOBALS);
  assert.equal(snapshot.ConfigCache, null);
  assert.notEqual(snapshot, runtimeState.GLOBALS);

  runtimeState.GLOBALS.NodeCache.set("runtime-state-test", { ok: true });
  assert.equal(GLOBALS.NodeCache.get("runtime-state-test")?.ok, true);
  GLOBALS.NodeCache.delete("runtime-state-test");
});

test("probe-shared normalizes probe config into safe bounds", async () => {
  const { normalizeProbeConfig } = await import("../src/probes/probe-shared.js");
  const defaults = {
    count: 3,
    timeoutMs: 2500,
    latencyWarnLow: 80,
    latencyWarnHigh: 200
  };

  assert.deepEqual(normalizeProbeConfig({ count: 99, timeoutMs: 50 }, defaults), {
    count: 10,
    timeoutMs: 200,
    latencyWarnLow: 80,
    latencyWarnHigh: 200
  });
});

test("config compatibility exports preserve normalizeConfig behavior", async () => {
  const { normalizeConfig: normalizeConfigCompat } = await import("../src/config/normalize.js");
  const sample = {
    enablePrewarm: false,
    directSourceNodes: [" alpha ", "beta", "alpha"]
  };

  assert.deepEqual(normalizeConfigCompat(sample), normalizeConfig(sample));
});

test("config normalize module exposes config normalization and kv loading", async () => {
  const {
    normalizeConfig: normalizeConfigCompat,
    readNormalizedConfigFromKv: readNormalizedConfigFromKvCompat
  } = await import("../src/config/normalize.js");
  const sample = {
    enablePrewarm: false,
    directSourceNodes: [" alpha ", "beta", "alpha"],
    pingTimeout: 999999
  };
  const kv = {
    async get(key, options) {
      assert.equal(key, "sys:theme");
      assert.deepEqual(options, { type: "json" });
      return sample;
    }
  };

  assert.deepEqual(normalizeConfigCompat(sample), normalizeConfig(sample));
  assert.deepEqual(await readNormalizedConfigFromKvCompat(kv), normalizeConfig(sample));
});

test("storage compatibility exports preserve node model behavior", async () => {
  const { normalizeNodeRecord: normalizeNodeRecordCompat } = await import("../src/storage/node-model.js");
  const sample = {
    lines: [
      { name: "主线", target: "https://a.example.test/" },
      { name: "备用", target: "http://b.example.test" }
    ],
    headers: {
      "X-Test": "1",
      Host: "drop-me"
    }
  };

  assert.deepEqual(normalizeNodeRecordCompat(sample), normalizeNodeRecord(sample));
});

test("storage node model exposes full helpers while core path stays compatible", async () => {
  const storageNodeModel = await import("../src/storage/node-model.js");
  const sample = {
    name: " alpha ",
    lines: [
      { name: "主线", target: "https://a.example.test/" },
      { name: "备用", target: "http://b.example.test" }
    ]
  };

  assert.deepEqual(
    storageNodeModel.prepareNodesForStorage([sample]),
    prepareNodesForStorage([sample])
  );
  assert.deepEqual(
    storageNodeModel.normalizeTargetList([" https://a.example.test/ ", "http://b.example.test"]),
    normalizeTargetList([" https://a.example.test/ ", "http://b.example.test"])
  );
});

test("admin auth module preserves legacy core auth helpers", async () => {
  const { Auth: AdminAuth } = await import("../src/admin/auth.js");
  const sameOriginRequest = new Request("https://example.com/admin", {
    method: "POST",
    headers: {
      Origin: "https://example.com"
    }
  });
  const crossOriginRequest = new Request("https://example.com/admin", {
    method: "POST",
    headers: {
      Origin: "https://evil.example"
    }
  });

  assert.equal(typeof AdminAuth.getKV, "function");
  assert.equal(AdminAuth.getKV({ ENI_KV: 1, KV: 2 }), 1);
  assert.equal(AdminAuth.verifyAdminPostOrigin(sameOriginRequest), Auth.verifyAdminPostOrigin(sameOriginRequest));
  assert.equal(AdminAuth.verifyAdminPostOrigin(crossOriginRequest), Auth.verifyAdminPostOrigin(crossOriginRequest));
});

test("admin ui page module preserves legacy ui exports", async () => {
  const { UI: AdminUI } = await import("../src/admin/ui/page.js");
  const { ADMIN_ICONS: AdminIcons } = await import("../src/admin/ui/icons.js");
  const legacyLoginPage = UI.renderLoginPage("错误");
  const migratedLoginPage = AdminUI.renderLoginPage("错误");

  assert.equal(migratedLoginPage.status, legacyLoginPage.status);
  assert.equal(migratedLoginPage.headers.get("Content-Type"), legacyLoginPage.headers.get("Content-Type"));
  assert.equal(AdminUI.getHead("标题"), UI.getHead("标题"));
  assert.equal(AdminIcons.plus.length > 0, true);
});

test("proxy diagnostics playback telemetry module preserves legacy telemetry helpers", async () => {
  const diagnosticsTelemetryModule = await import("../src/proxy/diagnostics/playback-telemetry.js");
  const { PlaybackTelemetry: DiagnosticsPlaybackTelemetry } = diagnosticsTelemetryModule;

  assert.deepEqual(
    DiagnosticsPlaybackTelemetry.createUnavailableSummary(),
    PlaybackTelemetry.createUnavailableSummary()
  );
  assert.equal(
    DiagnosticsPlaybackTelemetry.normalizeHost("Demo.EXAMPLE.com:8096"),
    PlaybackTelemetry.normalizeHost("Demo.EXAMPLE.com:8096")
  );
  assert.equal(typeof diagnosticsTelemetryModule.buildProxyResponseBody, "function");
  assert.equal(typeof diagnosticsTelemetryModule.wrapPlaybackTelemetryBody, "function");
  assert.equal(typeof diagnosticsTelemetryModule.isBenignStreamTermination, "function");
});

test("current baseline removes playback payload rewrite runtime modules", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const removedFiles = [
    "src/proxy/compat/payload-rewrite.js",
    "src/proxy/compat/playback-url-compat.js",
    "src/proxy/media/prewarm.js"
  ];

  for (const relativePath of removedFiles) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), false, `${relativePath} should be removed`);
  }
});

test("config defaults exports only static config helpers", async () => {
  const defaultsCompat = await import("../src/config/defaults.js");

  assert.equal(defaultsCompat.Config.Defaults.AdminApiMaxBodyBytes, Config.Defaults.AdminApiMaxBodyBytes);
  assert.deepEqual(defaultsCompat.DEFAULT_TCPING_CONFIG, DEFAULT_TCPING_CONFIG);
  assert.equal("GLOBALS" in defaultsCompat, false);
  assert.equal("createRuntimeGlobals" in defaultsCompat, false);
});

test("storage config repository compatibility exports preserve config normalization", async () => {
  const { normalizeStoredConfig } = await import("../src/storage/config-repository.js");
  const sample = {
    enablePrewarm: false,
    directSourceNodes: [" alpha ", "beta", "alpha"],
    pingTimeout: 999999
  };

  assert.deepEqual(normalizeStoredConfig(sample), normalizeConfig(sample));
});

test("storage config repository writes normalized config and seeds runtime cache", async () => {
  resetGlobals();
  const { readRuntimeConfig, writeRuntimeConfig } = await import("../src/storage/config-repository.js");
  let writtenKey = "";
  let writtenValue = null;
  const env = {
    ENI_KV: {
      async get() {
        throw new Error("readRuntimeConfig should use the seeded cache");
      },
      async put(key, value) {
        writtenKey = key;
        writtenValue = JSON.parse(value);
      }
    }
  };

  const stored = await writeRuntimeConfig(env, {
    enablePrewarm: false,
    directSourceNodes: [" alpha ", "beta", "alpha"],
    pingTimeout: 999999
  });

  assert.equal(writtenKey, CONFIG_STORAGE_KEY);
  assert.deepEqual(writtenValue, stored);
  assert.equal(stored.enablePrewarm, false);
  assert.deepEqual(stored.sourceDirectNodes, ["alpha", "beta"]);
  assert.equal(stored.pingTimeout, 180000);

  const cached = await readRuntimeConfig(env);
  assert.deepEqual(cached, stored);
});

test("app admin routes compatibility export preserves admin API handling", async () => {
  const { handleAdminApiRequest } = await import("../src/app/admin-routes.js");
  GLOBALS.PlaybackOptimizationStats.redirect.followed = 5;
  GLOBALS.PlaybackOptimizationStats.updatedAt = "2026-03-15T00:00:00.000Z";
  const env = {
    ENI_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [] }; }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "playbackOptimizationStats"
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.redirect.followed, 5);
  assert.equal(payload.updatedAt, "2026-03-15T00:00:00.000Z");
});

test("app admin routes action dispatcher preserves config save and load flow", async () => {
  resetGlobals();
  const { handleAdminApiAction } = await import("../src/app/admin-routes.js");
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list() {
        return { keys: [] };
      }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });

  const saved = await handleAdminApiAction({
    action: "saveConfig",
    config: {
      enablePrewarm: false,
      directSourceNodes: [" alpha ", "beta", "alpha"],
      thirdPartyProxies: [
        { id: "proxy-1", name: "桌面反代", url: "https://desktop-relay.example.test" },
        { id: "proxy-2", name: "移动反代", url: "https://mobile-relay.example.test" }
      ],
      cfMetrics: {
        accountId: "account-1",
        apiToken: "token-1",
        workerUrl: "https://dash.cloudflare.com/example",
        showCard: true,
        autoRefreshSeconds: 120
      }
    }
  }, { request, env });
  const savedPayload = await saved.json();
  const storedConfig = JSON.parse(store.get(CONFIG_STORAGE_KEY));

  assert.equal(saved.status, 200);
  assert.equal(savedPayload.success, true);
  assert.equal(storedConfig.enablePrewarm, false);
  assert.deepEqual(storedConfig.sourceDirectNodes, ["alpha", "beta"]);
  assert.deepEqual(storedConfig.thirdPartyProxies, [
    { id: "proxy-1", name: "桌面反代", url: "https://desktop-relay.example.test" },
    { id: "proxy-2", name: "移动反代", url: "https://mobile-relay.example.test" }
  ]);
  assert.deepEqual(storedConfig.cfMetrics, {
    accountId: "account-1",
    apiToken: "token-1",
    workerUrl: "https://dash.cloudflare.com/example",
    showCard: true,
    autoRefreshSeconds: 120
  });

  const loaded = await handleAdminApiAction({
    action: "loadConfig"
  }, { request, env });
  const loadedPayload = await loaded.json();

  assert.equal(loaded.status, 200);
  assert.equal(loadedPayload.enablePrewarm, false);
  assert.deepEqual(loadedPayload.sourceDirectNodes, ["alpha", "beta"]);
  assert.deepEqual(loadedPayload.thirdPartyProxies, [
    { id: "proxy-1", name: "桌面反代", url: "https://desktop-relay.example.test" },
    { id: "proxy-2", name: "移动反代", url: "https://mobile-relay.example.test" }
  ]);
  assert.deepEqual(loadedPayload.cfMetrics, {
    accountId: "account-1",
    apiToken: "token-1",
    workerUrl: "https://dash.cloudflare.com/example",
    showCard: true,
    autoRefreshSeconds: 120
  });
});

test("app admin routes expose stored version status with local defaults", async () => {
  resetGlobals();
  const { handleAdminApiAction } = await import(`../src/app/admin-routes.js?t=${Date.now()}`);
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key !== "sys:version-status") return null;
        const payload = {
          currentVersion: "2.4.10",
          remoteVersion: "2.5.0",
          status: "update-available",
          checkedAt: "2999-01-01T06:00:00.000Z"
        };
        return options.type === "json" ? payload : JSON.stringify(payload);
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [] };
      }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });

  const response = await handleAdminApiAction({
    action: "versionStatus"
  }, { request, env });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.currentVersion, "2.4.10");
  assert.equal(payload.remoteVersion, "2.5.0");
  assert.equal(payload.status, "update-available");
  assert.equal(payload.checkedAt, "2999-01-01T06:00:00.000Z");
  assert.equal(payload.error, "");
  assert.deepEqual(Object.keys(payload).sort(), ["checkedAt", "currentVersion", "error", "remoteVersion", "status"]);
});

test("app admin routes lazily refresh stale version status records", async () => {
  resetGlobals();
  const { handleAdminApiAction } = await import(`../src/app/admin-routes.js?t=${Date.now()}`);
  const puts = [];
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key !== "sys:version-status") return null;
        const payload = {
          currentVersion: "2.4.10",
          remoteVersion: "2.4.10",
          status: "equal",
          checkedAt: "2000-01-01T00:00:00.000Z"
        };
        return options.type === "json" ? payload : JSON.stringify(payload);
      },
      async put(key, value) {
        puts.push([key, JSON.parse(String(value))]);
      },
      async delete() {},
      async list() {
        return { keys: [] };
      }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://raw.githubusercontent.com/irm123gard/Emby-Mate/main/version.json") {
      return new Response(JSON.stringify({
        version: "2.5.0",
        workerPath: "dist/worker.js"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  try {
    const response = await handleAdminApiAction({
      action: "versionStatus"
    }, { request, env });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.currentVersion, "2.4.10");
    assert.equal(payload.remoteVersion, "2.5.0");
    assert.equal(payload.status, "update-available");
    assert.equal(payload.error, "");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], "sys:version-status");
  assert.equal(puts[0][1].remoteVersion, "2.5.0");
  assert.equal(puts[0][1].status, "update-available");
});

test("app admin routes handle admin route delegates form login submissions", async () => {
  resetGlobals();
  const { handleAdminRouteRequest } = await import("../src/app/admin-routes.js");
  const env = {
    ADMIN_PASS: "secret-pass",
    JWT_SECRET: "secret-pass",
    ENI_KV: {
      async get() { return null; },
      async put() {},
      async delete() {}
    }
  };
  const body = new URLSearchParams({ password: "secret-pass" });
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const response = await handleAdminRouteRequest(request, env);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/admin");
  assert.match(response.headers.get("Set-Cookie") || "", /auth_token=/);
});

test("app admin routes handle admin route renders login page for unauthorized get", async () => {
  resetGlobals();
  const { handleAdminRouteRequest } = await import("../src/app/admin-routes.js");
  const env = {
    ADMIN_PASS: "secret-pass",
    JWT_SECRET: "secret-pass",
    ENI_KV: {
      async get() { return null; }
    }
  };
  const request = new Request("https://proxy.example.test/admin");

  const response = await handleAdminRouteRequest(request, env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /登录|密码/);
});

test("app admin routes handle admin route rejects unauthorized json post", async () => {
  resetGlobals();
  const { handleAdminRouteRequest } = await import("../src/app/admin-routes.js");
  const env = {
    ADMIN_PASS: "secret-pass",
    JWT_SECRET: "secret-pass",
    ENI_KV: {
      async get() { return null; }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "list" })
  });

  const response = await handleAdminRouteRequest(request, env);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("app admin routes handle admin route renders admin ui for authorized get", async () => {
  resetGlobals();
  const { handleAdminRouteRequest } = await import("../src/app/admin-routes.js");
  const secret = "secret-pass";
  const token = await Auth.generateJwt(secret, 3600);
  const env = {
    ADMIN_PASS: secret,
    JWT_SECRET: secret,
    ENI_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [] }; }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    headers: {
      Cookie: `auth_token=${token}`
    }
  });

  const response = await handleAdminRouteRequest(request, env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /__client_rtt__|站点/);
});

test("app admin routes handle admin route rejects cross-origin authorized post", async () => {
  resetGlobals();
  const { handleAdminRouteRequest } = await import("../src/app/admin-routes.js");
  const secret = "secret-pass";
  const token = await Auth.generateJwt(secret, 3600);
  const env = {
    ADMIN_PASS: secret,
    JWT_SECRET: secret,
    ENI_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [] }; }
    }
  };
  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      Cookie: `auth_token=${token}`,
      "Content-Type": "application/json",
      Origin: "https://evil.example.test"
    },
    body: JSON.stringify({ action: "list" })
  });

  const response = await handleAdminRouteRequest(request, env);
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.error, "Forbidden Origin");
});

test("storage node repository compatibility export preserves node loading", async () => {
  const { getStoredNode } = await import("../src/storage/node-repository.js");
  const store = new Map([
    ["node:delta", JSON.stringify({
      lines: [
        { name: "主线", target: "https://delta-a.example.test/" },
        { name: "备用", target: "https://delta-b.example.test/" }
      ],
      activeLineId: "line-2",
      headers: {
        "X-Test": "delta"
      }
    })]
  ]);
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      }
    }
  };
  const ctx = {
    waitUntil() {}
  };

  const node = await getStoredNode("delta", env, ctx);

  assert.equal(node.target, "https://delta-a.example.test");
  assert.equal(node.activeLineId, "line-2");
  assert.deepEqual(node.targets, ["https://delta-a.example.test", "https://delta-b.example.test"]);
  assert.deepEqual(node.headers, { "X-Test": "delta" });
});

test("storage node repository returns normalized nodes without an execution context", async () => {
  resetGlobals();
  const { getStoredNode } = await import("../src/storage/node-repository.js");
  const env = {
    ENI_KV: {
      async get(key) {
        if (key === "node:epsilon") {
          return {
            lines: [
              { id: "line-1", name: "主线", target: "https://epsilon-a.example.test/" },
              { id: "line-2", name: "备用", target: "https://epsilon-b.example.test" }
            ],
            activeLineId: "line-2",
            headers: {
              "X-Test": "epsilon",
              Host: "drop-me"
            }
          };
        }
        return null;
      }
    }
  };

  const node = await getStoredNode("epsilon", env, null);

  assert.equal(node.target, "https://epsilon-a.example.test");
  assert.equal(node.activeLineId, "line-2");
  assert.deepEqual(node.targets, ["https://epsilon-a.example.test", "https://epsilon-b.example.test"]);
  assert.deepEqual(node.headers, { "X-Test": "epsilon" });
});

test("storage node repository lists normalized mixed legacy and line-based nodes", async () => {
  resetGlobals();
  const { listStoredNodes, NODE_INDEX_STORAGE_KEY } = await import("../src/storage/node-repository.js");
  const store = new Map([
    ["node:legacy", JSON.stringify({
      target: "https://legacy.example.test/"
    })],
    ["node:zeta", JSON.stringify({
      lines: [
        { name: "主线", target: "https://zeta-a.example.test/" },
        { name: "备用", target: "https://zeta-b.example.test/" }
      ],
      activeLineId: "line-2"
    })]
  ]);
  const env = {
    ENI_KV: {
      async list() {
        return {
          keys: [
            { name: "node:legacy" },
            { name: "node:zeta" }
          ]
        };
      },
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      }
    }
  };

  const nodes = await listStoredNodes(env);
  const names = nodes.map(node => node.name).sort();
  const legacy = nodes.find(node => node.name === "legacy");
  const zeta = nodes.find(node => node.name === "zeta");

  assert.deepEqual(names, ["legacy", "zeta"]);
  assert.equal(legacy.target, "https://legacy.example.test");
  assert.deepEqual(legacy.targets, ["https://legacy.example.test"]);
  assert.equal(zeta.activeLineId, "line-2");
  assert.deepEqual(zeta.targets, ["https://zeta-a.example.test", "https://zeta-b.example.test"]);
  assert.equal(Array.isArray(JSON.parse(store.get(NODE_INDEX_STORAGE_KEY))), true);
});

test("storage node repository prefers stored node index for path listing", async () => {
  resetGlobals();
  const { listStoredNodePaths, NODE_INDEX_STORAGE_KEY } = await import("../src/storage/node-repository.js");
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key !== NODE_INDEX_STORAGE_KEY) return null;
        const value = [
          { name: "Alpha", path: "alpha", target: "https://alpha.example.test/" },
          { name: "Beta", path: "beta", target: "https://beta.example.test/" }
        ];
        return options.type === "json" ? value : JSON.stringify(value);
      },
      async list() {
        throw new Error("node key fan-out should not run when index is present");
      }
    }
  };

  const paths = await listStoredNodePaths(env);

  assert.deepEqual(paths, ["alpha", "beta"]);
});

test("storage node repository checks node path availability for create and rename", async () => {
  const { isStoredNodePathAvailable } = await import("../src/storage/node-repository.js");
  const env = {
    ENI_KV: {
      async get(key) {
        if (key === "node:occupied") return "{}";
        return null;
      }
    }
  };

  assert.equal(await isStoredNodePathAvailable(env, "occupied"), false);
  assert.equal(await isStoredNodePathAvailable(env, "fresh"), true);
  assert.equal(await isStoredNodePathAvailable(env, "occupied", "occupied"), true);
});

test("storage node repository writes nodes and invalidates touched names", async () => {
  resetGlobals();
  const { writeStoredNodes, NODE_INDEX_STORAGE_KEY } = await import("../src/storage/node-repository.js");
  const puts = new Map();
  const deletes = [];
  const invalidated = [];
  const input = {
    name: "theta",
    path: "theta-path",
    lines: [
      { name: "主线", target: "https://theta-a.example.test/" },
      { name: "备用", target: "https://theta-b.example.test/" }
    ],
    activeLineId: "line-2",
    headers: {
      "X-Test": "theta",
      Host: "drop-me"
    }
  };
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key !== NODE_INDEX_STORAGE_KEY || !puts.has(key)) return null;
        const value = puts.get(key);
        return options.type === "json" ? value : JSON.stringify(value);
      },
      async list() {
        return { keys: [] };
      },
      async put(key, value) {
        puts.set(key, JSON.parse(value));
      },
      async delete(key) {
        deletes.push(key);
      }
    }
  };

  await writeStoredNodes(env, [input], {
    previousPath: "theta-old",
    async invalidate(path) {
      invalidated.push(path);
    }
  });

  assert.deepEqual(puts.get("node:theta-path"), createStoredNodeRecord(input));
  assert.deepEqual(puts.get(NODE_INDEX_STORAGE_KEY), [createStoredNodeRecord(input)]);
  assert.deepEqual(deletes, ["node:theta-old"]);
  assert.deepEqual(invalidated, ["theta-path", "theta-old"]);
});

test("storage node repository batch deletes nodes and invalidates each name", async () => {
  resetGlobals();
  const { deleteStoredNodes, NODE_INDEX_STORAGE_KEY } = await import("../src/storage/node-repository.js");
  const deletes = [];
  const puts = new Map();
  const invalidated = [];
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key !== NODE_INDEX_STORAGE_KEY) return null;
        const value = [
          { name: "alpha", path: "alpha", target: "https://alpha.example.test/" },
          { name: "beta", path: "beta", target: "https://beta.example.test/" },
          { name: "gamma", path: "gamma", target: "https://gamma.example.test/" }
        ];
        return options.type === "json" ? value : JSON.stringify(value);
      },
      async put(key, value) {
        puts.set(key, JSON.parse(value));
      },
      async delete(key) {
        deletes.push(key);
      }
    }
  };

  await deleteStoredNodes(env, ["alpha", "", "beta", "alpha"], async (name) => {
    invalidated.push(name);
  });

  assert.deepEqual(deletes, ["node:alpha", "node:beta"]);
  assert.deepEqual(invalidated, ["alpha", "beta"]);
  assert.deepEqual(puts.get(NODE_INDEX_STORAGE_KEY), [
    createStoredNodeRecord({ name: "gamma", path: "gamma", target: "https://gamma.example.test/" })
  ]);
});

test("storage import-export saves admin import payloads and runtime config", async () => {
  resetGlobals();
  const { saveAdminNodesPayload } = await import("../src/storage/import-export.js");
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  const result = await saveAdminNodesPayload({
    action: "import",
    nodes: [
      {
        name: "beta",
        path: "beta",
        lines: [
          { name: "主线", target: "https://beta-a.example.test/" },
          { name: "备用", target: "https://beta-b.example.test/" }
        ],
        headers: {
          "X-Test": "2"
        }
      }
    ],
    config: {
      enablePrewarm: false,
      directSourceNodes: [" beta "]
    }
  }, env);

  assert.deepEqual(result, { success: true, status: 200 });
  assert.equal(JSON.parse(store.get("node:beta")).target, "https://beta-a.example.test");
  assert.equal(JSON.parse(store.get("node:beta")).name, "beta");
  assert.equal(JSON.parse(store.get("node:beta")).path, "beta");
  assert.deepEqual(JSON.parse(store.get("sys:theme")).sourceDirectNodes, ["beta"]);
});

test("storage import-export rejects duplicate save paths for admin payloads", async () => {
  resetGlobals();
  const { saveAdminNodesPayload } = await import("../src/storage/import-export.js");
  const env = {
    ENI_KV: {
      async get(key) {
        if (key === "node:occupied") return "{}";
        return null;
      },
      async put() {
        throw new Error("should not write duplicate node");
      },
      async delete() {}
    }
  };

  const result = await saveAdminNodesPayload({
    action: "save",
    name: "任意名称",
    path: "occupied",
    target: "https://occupied.example.test"
  }, env);

  assert.deepEqual(result, {
    success: false,
    status: 409,
    error: "站点路径已存在"
  });
});

test("app proxy routes compatibility export preserves proxy forwarding", async () => {
  const { forwardProxyRequest } = await import("../src/app/proxy-routes.js");
  const env = {
    ENI_KV: {
      async get() { return null; }
    }
  };
  const request = new Request("https://proxy.example.test/dongying/emby/System/Ping", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Method": "GET"
    }
  });
  const nodeData = { target: "https://media.example.test/emby" };
  const expectedConfig = await readRuntimeConfig(env);

  const wrapped = await forwardProxyRequest({
    request,
    nodeData,
    remaining: "/emby/System/Ping",
    nodePath: "dongying",
    ctx: null,
    env
  });
  const direct = await Proxy.handle(
    request,
    nodeData,
    "/emby/System/Ping",
    "dongying",
    expectedConfig,
    null,
    env
  );

  assert.equal(wrapped.status, direct.status);
  assert.equal(wrapped.headers.get("Access-Control-Allow-Origin"), direct.headers.get("Access-Control-Allow-Origin"));
  assert.equal(wrapped.headers.get("Access-Control-Allow-Private-Network"), direct.headers.get("Access-Control-Allow-Private-Network"));
});

test("app proxy routes handle node request redirects root GET to web index", async () => {
  resetGlobals();
  const { handleProxyNodeRequest } = await import("../src/app/proxy-routes.js");
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key === "node:dongying") {
          return options.type === "json"
            ? { name: "东影", path: "dongying", target: "https://media.example.test/emby" }
            : JSON.stringify({ name: "东影", path: "dongying", target: "https://media.example.test/emby" });
        }
        return null;
      }
    }
  };

  const response = await handleProxyNodeRequest({
    request: new Request("https://proxy.example.test/dongying"),
    nodePath: "dongying",
    segments: ["dongying"],
    env,
    ctx: { waitUntil() {} }
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dongying/web/index.html");
});

test("app proxy routes handle node request issues backup cookie redirect for restricted web access", async () => {
  resetGlobals();
  const { handleProxyNodeRequest } = await import("../src/app/proxy-routes.js");
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key === "node:alpha-web") {
          return options.type === "json"
            ? { target: "https://media.example.test/emby" }
            : JSON.stringify({ target: "https://media.example.test/emby" });
        }
        return null;
      }
    }
  };

  const response = await handleProxyNodeRequest({
    request: new Request("https://proxy.example.test/alpha-web/web/index.html?backup=1"),
    nodeName: "alpha-web",
    segments: ["alpha-web", "web", "index.html"],
    env,
    ctx: { waitUntil() {} }
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://proxy.example.test/alpha-web/web/index.html");
  assert.match(response.headers.get("Set-Cookie") || "", /emby_web_bypass=1/);
});

test("app worker routes serve client rtt probe path", async () => {
  const { handleWorkerRequest } = await import("../src/app/worker-routes.js");
  const response = await handleWorkerRequest(
    new Request("https://proxy.example.test/__client_rtt__"),
    {},
    null
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, max-age=0");
});

test("app worker routes delegate admin requests to admin route handler", async () => {
  resetGlobals();
  const { handleWorkerRequest } = await import("../src/app/worker-routes.js");
  const env = {
    ADMIN_PASS: "secret-pass",
    JWT_SECRET: "secret-pass",
    ENI_KV: {
      async get() { return null; }
    }
  };
  const response = await handleWorkerRequest(
    new Request("https://proxy.example.test/admin"),
    env,
    null
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /登录|密码/);
});

test("app worker routes decode node path segments before proxy routing", async () => {
  resetGlobals();
  const { handleWorkerRequest } = await import("../src/app/worker-routes.js");
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (key === "node:dongying") {
          return options.type === "json"
            ? { name: "中文站点", path: "dongying", target: "https://media.example.test/emby" }
            : JSON.stringify({ name: "中文站点", path: "dongying", target: "https://media.example.test/emby" });
        }
        return null;
      }
    }
  };

  const response = await handleWorkerRequest(
    new Request("https://proxy.example.test/dongying"),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/dongying/web/index.html");
});

test("app worker routes return not found for unknown paths", async () => {
  resetGlobals();
  const { handleWorkerRequest } = await import("../src/app/worker-routes.js");
  const env = {
    ENI_KV: {
      async get() { return null; }
    }
  };
  const response = await handleWorkerRequest(
    new Request("https://proxy.example.test/unknown/emby/System/Ping"),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not Found");
});

test("tcp/head probe thin exports preserve shared normalization", async () => {
  const { normalizeTcpProbeConfig } = await import("../src/probes/tcp-probe.js");
  const { normalizeHeadProbeConfig } = await import("../src/probes/head-probe.js");

  assert.deepEqual(normalizeTcpProbeConfig({ count: 99, timeoutMs: 50 }), {
    count: 10,
    timeoutMs: 200,
    latencyWarnLow: DEFAULT_TCPING_CONFIG.tcp.latencyWarnLow,
    latencyWarnHigh: DEFAULT_TCPING_CONFIG.tcp.latencyWarnHigh
  });
  assert.deepEqual(normalizeHeadProbeConfig({ count: 0, timeoutMs: 20001 }), {
    count: 1,
    timeoutMs: 10000,
    latencyWarnLow: DEFAULT_TCPING_CONFIG.head.latencyWarnLow,
    latencyWarnHigh: DEFAULT_TCPING_CONFIG.head.latencyWarnHigh
  });
});

test("rtt probe thin export returns no-store 204 response", async () => {
  const { handleClientRttProbe } = await import("../src/probes/rtt-probe.js");
  const response = handleClientRttProbe();

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Expires"), "0");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("admin inline script remains syntactically valid", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1]);
  });
});

test("admin UI renders node-level real client IP forwarding control", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();

  assert.match(html, /真实客户端 IP 透传/);
  assert.match(html, /id="in-real-client-ip-mode"/);
  assert.match(html, /默认透传/);
  assert.match(html, /仅X-Real-IP/);
  assert.match(html, /关闭透传/);
});

test("admin UI keeps real client IP mode tabs content-width instead of full-row", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();

  assert.match(
    html,
    /id="real-client-ip-mode-list" class="proxy-mode-tabs proxy-mode-tabs-fit"/
  );
  assert.match(
    html,
    /\.proxy-mode-tabs\.proxy-mode-tabs-fit\{display:inline-flex;width:fit-content;max-width:100%;align-self:flex-start\}/
  );
  assert.match(
    html,
    /\.proxy-mode-tabs\.proxy-mode-tabs-fit\{width:fit-content;max-width:100%\}/
  );
});

test("admin inline script initializes App without missing helper references", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected inline admin script");

  function createClassList() {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      toggle(value, force) {
        if (force === void 0) {
          if (values.has(value)) values.delete(value);
          else values.add(value);
          return;
        }
        if (force) values.add(value);
        else values.delete(value);
      },
      contains(value) { return values.has(value); }
    };
  }

  function createElement(id = "") {
    const values = new Set();
    let innerHTMLValue = "";
    const element = {
      id,
      style: {},
      classList: {
        add(value) { values.add(value); },
        remove(value) { values.delete(value); },
        toggle(value, force) {
          if (force === void 0) {
            if (values.has(value)) values.delete(value);
            else values.add(value);
            return;
          }
          if (force) values.add(value);
          else values.delete(value);
        },
        contains(value) { return values.has(value); }
      },
      innerText: "",
      textContent: "",
      value: "",
      title: "",
      disabled: false,
      scrollTop: 0,
      dataset: {},
      childNodes: [],
      parentElement: null,
      querySelector(selector) {
        if (selector === ".empty-hint" && innerHTMLValue.includes('class="empty-hint"')) return createElement("empty-hint");
        return createElement();
      },
      querySelectorAll(selector) {
        if (selector === ".card[data-card-path]") {
          return this.childNodes.filter(node => node.classList?.contains("card") && String(node.dataset?.cardPath || ""));
        }
        return [];
      },
      setAttribute(name, value) {
        if (name === "id") this.id = String(value || "");
      },
      getAttribute(name) {
        if (name === "id") return this.id || "";
        return "";
      },
      appendChild(node) { this.insertBefore(node, null); },
      insertBefore(node, referenceNode) {
        if (!node) return;
        const currentIndex = this.childNodes.indexOf(node);
        if (currentIndex >= 0) this.childNodes.splice(currentIndex, 1);
        node.parentElement = this;
        if (!referenceNode) this.childNodes.push(node);
        else {
          const referenceIndex = this.childNodes.indexOf(referenceNode);
          if (referenceIndex >= 0) this.childNodes.splice(referenceIndex, 0, node);
          else this.childNodes.push(node);
        }
        innerHTMLValue = this.childNodes.length ? this.childNodes.map(item => item.outerHTML || "").join("") : innerHTMLValue;
      },
      focus() {},
      closest() { return null; },
      replaceWith(node) {
        if (!this.parentElement) return;
        const siblings = this.parentElement.childNodes;
        const index = siblings.indexOf(this);
        if (index < 0) return;
        const replacement = node || createElement();
        const replacementIndex = siblings.indexOf(replacement);
        if (replacementIndex >= 0) siblings.splice(replacementIndex, 1);
        replacement.parentElement = this.parentElement;
        siblings[index] = replacement;
        this.parentElement.innerHTML = siblings.map(item => item.outerHTML || "").join("");
      },
      addEventListener() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return innerHTMLValue; },
      set(value) {
        innerHTMLValue = String(value || "");
        if (!/<div class="card\b/.test(innerHTMLValue)) element.childNodes = [];
      }
    });
    Object.defineProperty(element, "outerHTML", {
      get() { return innerHTMLValue; },
      set(value) { innerHTMLValue = String(value || ""); }
    });
    Object.defineProperty(element, "firstElementChild", {
      get() { return element.childNodes[0] || null; }
    });
    Object.defineProperty(element, "nextElementSibling", {
      get() {
        if (!element.parentElement) return null;
        const siblings = element.parentElement.childNodes;
        const index = siblings.indexOf(element);
        return index >= 0 ? siblings[index + 1] || null : null;
      }
    });
    return element;
  }

  const elements = new Map();
  const ensureElement = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  [
    "list-container",
    "node-count",
    "main-menu",
    "tag-list",
    "cf-range-list",
    "search-clear",
    "search-input",
    "pull-indicator",
    "pull-text",
    "client-rtt-pill",
    "client-rtt-value",
    "client-rtt-refresh",
    "client-rtt-label",
    "client-rtt-bar",
    "client-rtt-state",
    "cf-card-container"
  ].forEach(ensureElement);
  const toolbarSearch = createElement("toolbar-search");
  const documentStub = {
    body: createElement("body"),
    documentElement: createElement("html"),
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      for (const element of elements.values()) {
        const found = element.childNodes.find(node => node.id === id);
        if (found) return found;
      }
      return createElement(id);
    },
    querySelector(selector) {
      if (selector === ".toolbar-search") return toolbarSearch;
      return createElement(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tagName = "") {
      if (String(tagName).toLowerCase() === "template") {
        return {
          content: { firstElementChild: null },
          set innerHTML(value) {
            const markup = String(value || "");
            const matchId = markup.match(/\bid="([^"]+)"/);
            const matchClass = markup.match(/\bclass="([^"]+)"/);
            const node = createElement(matchId?.[1] || "");
            node.innerHTML = markup;
            String(matchClass?.[1] || "").split(/\s+/).filter(Boolean).forEach(name => node.classList.add(name));
            this.content.firstElementChild = node;
          },
          get innerHTML() { return this.content.firstElementChild?.outerHTML || ""; }
        };
      }
      return createElement();
    }
  };

  const localStorageMap = new Map();
  const localStorageStub = {
    getItem(key) { return localStorageMap.has(key) ? localStorageMap.get(key) : null; },
    setItem(key, value) { localStorageMap.set(key, String(value)); },
    removeItem(key) { localStorageMap.delete(key); }
  };

  const fetchStub = async (url, options = {}) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (String(url) === "/admin" && body?.action === "loadConfig") {
      return new Response(JSON.stringify({ theme: "auto", cfMetrics: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url) === "/admin" && body?.action === "list") {
      return new Response(JSON.stringify({
        nodes: [{
          name: "东影",
          path: "dongying",
          target: "https://a.example.com",
          targets: ["https://a.example.com"],
          remark: "说明",
          tag: "测试"
        }],
        nodeActivity: {
          dongying: { lastSeenAt: "2026-03-19T12:00:00.000Z", requests: 1 }
        },
        nodeActivityAvailable: true
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url).startsWith("/__client_rtt__")) {
      return new Response("", { status: 204 });
    }
    if (String(url) === "/admin" && body?.action === "cfMetrics") {
      return new Response(JSON.stringify({ nodeActivity: {}, nodeActivityAvailable: true, metrics: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  const context = {
    console,
    document: documentStub,
    window: null,
    location: {
      hostname: "auto.shangrenxi.top",
      origin: "https://auto.shangrenxi.top",
      pathname: "/admin",
      reload() {}
    },
    localStorage: localStorageStub,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: fetchStub,
    Response,
    Headers,
    Request,
    URL,
    performance: { now: () => 100 },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {}
      };
    },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    confirm() { return true; },
    alert() {}
  };
  context.window = context;

  assert.doesNotThrow(() => {
    vm.runInNewContext(scriptMatch[1], context, { timeout: 5000 });
  });
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(String(ensureElement("node-count").innerText), /1 个站点/);
  assert.match(String(ensureElement("list-container").innerHTML), /dongying/);
});

test("admin ui settings and cf saves submit latest DOM values instead of stale drafts", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected inline admin script");

  function createClassList() {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      toggle(value, force) {
        if (force === void 0) {
          if (values.has(value)) values.delete(value);
          else values.add(value);
          return;
        }
        if (force) values.add(value);
        else values.delete(value);
      },
      contains(value) { return values.has(value); }
    };
  }

  function createElement(id = "") {
    const values = new Set();
    let innerHTMLValue = "";
    const element = {
      id,
      style: {},
      classList: {
        add(value) { values.add(value); },
        remove(value) { values.delete(value); },
        toggle(value, force) {
          if (force === void 0) {
            if (values.has(value)) values.delete(value);
            else values.add(value);
            return;
          }
          if (force) values.add(value);
          else values.delete(value);
        },
        contains(value) { return values.has(value); }
      },
      innerText: "",
      textContent: "",
      value: "",
      title: "",
      disabled: false,
      scrollTop: 0,
      dataset: {},
      childNodes: [],
      parentElement: null,
      querySelector(selector) {
        if (selector === ".empty-hint" && innerHTMLValue.includes('class="empty-hint"')) return createElement("empty-hint");
        return createElement();
      },
      querySelectorAll(selector) {
        if (selector === ".card[data-card-path]") {
          return this.childNodes.filter(node => node.classList?.contains("card") && String(node.dataset?.cardPath || ""));
        }
        return [];
      },
      setAttribute(name, value) {
        if (name === "id") this.id = String(value || "");
      },
      getAttribute(name) {
        if (name === "id") return this.id || "";
        return "";
      },
      appendChild(node) { this.insertBefore(node, null); },
      insertBefore(node, referenceNode) {
        if (!node) return;
        const currentIndex = this.childNodes.indexOf(node);
        if (currentIndex >= 0) this.childNodes.splice(currentIndex, 1);
        node.parentElement = this;
        if (!referenceNode) this.childNodes.push(node);
        else {
          const referenceIndex = this.childNodes.indexOf(referenceNode);
          if (referenceIndex >= 0) this.childNodes.splice(referenceIndex, 0, node);
          else this.childNodes.push(node);
        }
        innerHTMLValue = this.childNodes.length ? this.childNodes.map(item => item.outerHTML || "").join("") : innerHTMLValue;
      },
      focus() {},
      closest() { return null; },
      replaceWith(node) {
        if (!this.parentElement) return;
        const siblings = this.parentElement.childNodes;
        const index = siblings.indexOf(this);
        if (index < 0) return;
        const replacement = node || createElement();
        const replacementIndex = siblings.indexOf(replacement);
        if (replacementIndex >= 0) siblings.splice(replacementIndex, 1);
        replacement.parentElement = this.parentElement;
        siblings[index] = replacement;
        this.parentElement.innerHTML = siblings.map(item => item.outerHTML || "").join("");
      },
      addEventListener() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return innerHTMLValue; },
      set(value) {
        innerHTMLValue = String(value || "");
        if (!/<div class="card\b/.test(innerHTMLValue)) element.childNodes = [];
      }
    });
    Object.defineProperty(element, "outerHTML", {
      get() { return innerHTMLValue; },
      set(value) { innerHTMLValue = String(value || ""); }
    });
    Object.defineProperty(element, "firstElementChild", {
      get() { return element.childNodes[0] || null; }
    });
    Object.defineProperty(element, "nextElementSibling", {
      get() {
        if (!element.parentElement) return null;
        const siblings = element.parentElement.childNodes;
        const index = siblings.indexOf(element);
        return index >= 0 ? siblings[index + 1] || null : null;
      }
    });
    return element;
  }

  const elements = new Map();
  const ensureElement = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  [
    "list-container",
    "node-count",
    "main-menu",
    "tag-list",
    "search-clear",
    "search-input",
    "pull-indicator",
    "pull-text",
    "client-rtt-pill",
    "client-rtt-value",
    "client-rtt-refresh",
    "client-rtt-label",
    "client-rtt-bar",
    "client-rtt-state",
    "cf-card-container",
    "settings-mask",
    "settings-modal",
    "cf-settings-mask",
    "cf-settings-modal",
    "toast",
    "tcping-tcp-count",
    "tcping-tcp-timeout",
    "tcping-tcp-latency-low",
    "tcping-tcp-latency-high",
    "tcping-head-count",
    "tcping-head-timeout",
    "tcping-head-latency-low",
    "tcping-head-latency-high",
    "settings-prewarm-cache-ttl",
    "settings-prewarm-depth",
    "settings-upstream-timeout-ms",
    "settings-upstream-retry-attempts",
    "settings-proxy-list",
    "settings-redirect-whitelist-list",
    "cf-account-id",
    "cf-api-token",
    "cf-worker-url",
    "cf-auto-refresh",
    "cf-show-card-show",
    "cf-show-card-hide",
    "cf-dns-capabilities",
    "cf-domain-history",
    "cf-ip-history",
    "cf-dns-status",
    "cf-preferred-mode-domain",
    "cf-preferred-mode-ip",
    "cf-preferred-domain-panel",
    "cf-preferred-ip-panel",
    "cf-preferred-domain",
    "cf-preferred-ip-list"
  ].forEach(ensureElement);

  const documentStub = {
    body: createElement("body"),
    documentElement: createElement("html"),
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      for (const element of elements.values()) {
        const found = element.childNodes.find(node => node.id === id);
        if (found) return found;
      }
      return createElement(id);
    },
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tagName = "") {
      if (String(tagName).toLowerCase() === "template") {
        return {
          content: { firstElementChild: null },
          set innerHTML(value) {
            const markup = String(value || "");
            const matchId = markup.match(/\bid="([^"]+)"/);
            const matchClass = markup.match(/\bclass="([^"]+)"/);
            const node = createElement(matchId?.[1] || "");
            node.innerHTML = markup;
            String(matchClass?.[1] || "").split(/\s+/).filter(Boolean).forEach(name => node.classList.add(name));
            this.content.firstElementChild = node;
          },
          get innerHTML() { return this.content.firstElementChild?.outerHTML || ""; }
        };
      }
      return createElement();
    }
  };

  const localStorageMap = new Map();
  const savedPayloads = [];
  const fetchStub = async (url, options = {}) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (String(url) === "/admin" && body?.action === "loadConfig") {
      return new Response(JSON.stringify({
        theme: "auto",
        cfMetrics: {
          accountId: "",
          apiToken: "",
          workerUrl: "",
          showCard: true,
          autoRefreshSeconds: 300
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url) === "/admin" && body?.action === "list") {
      return new Response(JSON.stringify({
        nodes: [],
        nodeActivity: {},
        nodeActivityAvailable: false
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url).startsWith("/__client_rtt__")) {
      return new Response("", { status: 204 });
    }
    if (String(url) === "/admin" && body?.action === "cfMetrics") {
      return new Response(JSON.stringify({
        nodeActivity: {},
        nodeActivityAvailable: false,
        metrics: {}
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url) === "/admin" && body?.action === "saveConfig") {
      savedPayloads.push(body);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  const context = {
    console,
    document: documentStub,
    window: null,
    location: {
      hostname: "auto.shangrenxi.top",
      origin: "https://auto.shangrenxi.top",
      pathname: "/admin",
      reload() {}
    },
    localStorage: {
      getItem(key) { return localStorageMap.has(key) ? localStorageMap.get(key) : null; },
      setItem(key, value) { localStorageMap.set(key, String(value)); },
      removeItem(key) { localStorageMap.delete(key); }
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: fetchStub,
    Response,
    Headers,
    Request,
    URL,
    performance: { now: () => 100 },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {}
      };
    },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    confirm() { return true; },
    alert() {}
  };
  context.window = context;

  vm.runInNewContext(`${scriptMatch[1]}\nthis.__APP__=App;`, context, { timeout: 5000 });
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));

  const App = context.__APP__;
  App.settingsDraft = createSettingsDraftFromConfig(normalizeConfig({
    thirdPartyProxies: [{ id: "draft-proxy", name: "旧值", url: "https://old-relay.example.test" }],
    redirectWhitelistEntries: [{ id: "redirect-1", name: "旧规则", domain: "old.example.test" }],
    prewarmCacheTtl: 180,
    upstreamTimeoutMs: 30000,
    upstreamRetryAttempts: 1
  }));
  App.config = normalizeConfig({
    cfMetrics: {
      accountId: "old-account",
      apiToken: "old-token",
      workerUrl: "https://old.example.test",
      showCard: true,
      autoRefreshSeconds: 300
    }
  });
  App.cfSettingsDraft = { ...App.config.cfMetrics };

  const proxyNameInput = createElement("proxy-name");
  proxyNameInput.value = "手机反代";
  const proxyUrlInput = createElement("proxy-url");
  proxyUrlInput.value = "https://phone-relay.example.test";
  const proxyRow = {
    getAttribute(name) {
      return name === "data-third-party-proxy-id" ? "proxy-phone" : "";
    },
    querySelector(selector) {
      if (selector === "[data-third-party-proxy-name]") return proxyNameInput;
      if (selector === "[data-third-party-proxy-url]") return proxyUrlInput;
      return null;
    }
  };
  ensureElement("settings-proxy-list").querySelectorAll = selector => selector === "[data-third-party-proxy-row]" ? [proxyRow] : [];

  const redirectNameInput = createElement("redirect-name");
  redirectNameInput.value = "网盘";
  const redirectDomainInput = createElement("redirect-domain");
  redirectDomainInput.value = "pan.quark.cn";
  const redirectRow = {
    getAttribute(name) {
      return name === "data-redirect-rule-id" ? "redirect-phone" : "";
    },
    querySelector(selector) {
      if (selector === "[data-redirect-rule-name]") return redirectNameInput;
      if (selector === "[data-redirect-rule-domain]") return redirectDomainInput;
      return null;
    }
  };
  ensureElement("settings-redirect-whitelist-list").querySelectorAll = selector => selector === "[data-redirect-rule-row]" ? [redirectRow] : [];

  ensureElement("tcping-tcp-count").value = "4";
  ensureElement("tcping-tcp-timeout").value = "2600";
  ensureElement("tcping-tcp-latency-low").value = "90";
  ensureElement("tcping-tcp-latency-high").value = "180";
  ensureElement("tcping-head-count").value = "5";
  ensureElement("tcping-head-timeout").value = "2800";
  ensureElement("tcping-head-latency-low").value = "320";
  ensureElement("tcping-head-latency-high").value = "760";
  ensureElement("settings-prewarm-cache-ttl").value = "240";
  ensureElement("settings-prewarm-depth").value = "poster";
  ensureElement("settings-upstream-timeout-ms").value = "12000";
  ensureElement("settings-upstream-retry-attempts").value = "2";

  await App.saveConfig();

  const settingsPayload = savedPayloads.at(0)?.config;
  assert.ok(settingsPayload);
  assert.deepEqual(settingsPayload.thirdPartyProxies, [
    { id: "proxy-phone", name: "手机反代", url: "https://phone-relay.example.test" }
  ]);
  assert.deepEqual(settingsPayload.redirectWhitelistEntries, [
    { id: "redirect-phone", name: "网盘", domain: "pan.quark.cn" }
  ]);
  assert.equal(settingsPayload.prewarmCacheTtl, 240);
  assert.equal(settingsPayload.prewarmDepth, "poster");
  assert.equal(settingsPayload.upstreamTimeoutMs, 12000);
  assert.equal(settingsPayload.upstreamRetryAttempts, 2);

  ensureElement("cf-account-id").value = "mobile-account";
  ensureElement("cf-api-token").value = "mobile-token";
  ensureElement("cf-worker-url").value = "https://dash.cloudflare.com/mobile";
  ensureElement("cf-auto-refresh").value = "600";
  ensureElement("cf-show-card-show").classList.add("active");
  ensureElement("cf-show-card-hide").classList.remove("active");

  await App.saveCfSettings();

  const cfPayload = savedPayloads.at(1)?.config?.cfMetrics;
  assert.deepEqual(cfPayload, {
    accountId: "mobile-account",
    apiToken: "mobile-token",
    workerUrl: "https://dash.cloudflare.com/mobile",
    showCard: true,
    autoRefreshSeconds: 600
  });
});

async function createAdminInlineAppHarness({ fetchImpl = async () => new Response(null, { status: 204 }) } = {}) {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected inline admin script");

  function createClassList() {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      toggle(value, force) {
        if (force === void 0) {
          if (values.has(value)) values.delete(value);
          else values.add(value);
          return;
        }
        if (force) values.add(value);
        else values.delete(value);
      },
      contains(value) { return values.has(value); }
    };
  }

  function createElement(id = "") {
    const classList = createClassList();
    const attributes = new Map();
    let innerHTMLValue = "";
    const element = {
      id,
      style: {},
      classList,
      innerText: "",
      textContent: "",
      value: "",
      title: "",
      disabled: false,
      scrollTop: 0,
      dataset: {},
      childNodes: [],
      parentElement: null,
      querySelector(selector) {
        if (selector === ".empty-hint" && innerHTMLValue.includes('class="empty-hint"')) return createElement("empty-hint");
        return null;
      },
      querySelectorAll(selector) {
        if (selector === ".card[data-card-path]") {
          return this.childNodes.filter(node => node.classList?.contains("card") && String(node.dataset?.cardPath || ""));
        }
        return [];
      },
      setAttribute(name, value) {
        attributes.set(String(name), String(value ?? ""));
        if (name === "id") this.id = String(value || "");
      },
      getAttribute(name) {
        if (name === "id") return this.id || "";
        return attributes.get(String(name)) || "";
      },
      appendChild(node) { this.insertBefore(node, null); },
      insertBefore(node, referenceNode) {
        if (!node) return;
        const currentIndex = this.childNodes.indexOf(node);
        if (currentIndex >= 0) this.childNodes.splice(currentIndex, 1);
        node.parentElement = this;
        if (!referenceNode) this.childNodes.push(node);
        else {
          const referenceIndex = this.childNodes.indexOf(referenceNode);
          if (referenceIndex >= 0) this.childNodes.splice(referenceIndex, 0, node);
          else this.childNodes.push(node);
        }
      },
      focus() {},
      closest() { return null; },
      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.childNodes;
        const index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
      },
      replaceWith(node) {
        if (!this.parentElement) return;
        const siblings = this.parentElement.childNodes;
        const index = siblings.indexOf(this);
        if (index < 0) return;
        const replacement = node || createElement();
        const replacementIndex = siblings.indexOf(replacement);
        if (replacementIndex >= 0) siblings.splice(replacementIndex, 1);
        replacement.parentElement = this.parentElement;
        siblings[index] = replacement;
      },
      addEventListener() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return innerHTMLValue; },
      set(value) {
        innerHTMLValue = String(value || "");
        if (!/<div class="card\b/.test(innerHTMLValue)) element.childNodes = [];
      }
    });
    Object.defineProperty(element, "outerHTML", {
      get() { return innerHTMLValue; },
      set(value) { innerHTMLValue = String(value || ""); }
    });
    Object.defineProperty(element, "firstElementChild", {
      get() { return element.childNodes[0] || null; }
    });
    Object.defineProperty(element, "nextElementSibling", {
      get() {
        if (!element.parentElement) return null;
        const siblings = element.parentElement.childNodes;
        const index = siblings.indexOf(element);
        return index >= 0 ? siblings[index + 1] || null : null;
      }
    });
    return element;
  }

  const elements = new Map();
  const ensureElement = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  [
    "in-name",
    "in-path",
    "in-remark",
    "in-tag",
    "in-node-headers-enabled",
    "in-redirect-whitelist-enabled",
    "in-forward-real-client-ip-enabled",
    "target-list",
    "list-container",
    "node-count",
    "toast",
    "modal",
    "modal-mask",
    "main-menu",
    "tag-list",
    "search-input",
    "search-clear",
    "pull-indicator",
    "pull-text",
    "client-rtt-pill",
    "client-rtt-value",
    "client-rtt-refresh",
    "cf-card-container"
  ].forEach(ensureElement);

  const documentStub = {
    body: createElement("body"),
    documentElement: createElement("html"),
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      return ensureElement(id);
    },
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tagName = "") {
      if (String(tagName).toLowerCase() === "template") {
        return {
          content: { firstElementChild: null },
          set innerHTML(value) {
            const markup = String(value || "");
            const matchId = markup.match(/\bid="([^"]+)"/);
            const matchClass = markup.match(/\bclass="([^"]+)"/);
            const node = createElement(matchId?.[1] || "");
            node.innerHTML = markup;
            String(matchClass?.[1] || "").split(/\s+/).filter(Boolean).forEach(name => node.classList.add(name));
            this.content.firstElementChild = node;
          },
          get innerHTML() { return this.content.firstElementChild?.outerHTML || ""; }
        };
      }
      return createElement();
    }
  };

  const context = {
    console,
    document: documentStub,
    window: null,
    location: {
      hostname: "auto.shangrenxi.top",
      origin: "https://auto.shangrenxi.top",
      pathname: "/admin",
      reload() {}
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: fetchImpl,
    Response,
    Headers,
    Request,
    URL,
    performance: { now: () => 100 },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {}
      };
    },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    confirm() { return true; },
    alert() {}
  };
  context.window = context;

  const scriptBody = scriptMatch[1].replace(/\nApp\.init\(\);\s*$/, "\n");
  vm.runInNewContext(`${scriptBody}\nthis.__APP__=App;`, context, { timeout: 5000 });
  return {
    App: context.__APP__,
    context,
    ensureElement,
    createElement
  };
}

test("admin ui saveNode promotes the first reordered target as the active line", async () => {
  const savedPayloads = [];
  const { App, ensureElement } = await createAdminInlineAppHarness({
    fetchImpl: async (url, options = {}) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      if (String(url) === "/admin" && body?.action === "save") {
        savedPayloads.push(body);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }
  });

  const toasts = [];
  App.renderList = () => {};
  App.closeModal = () => {};
  App.toast = (message, type = "success") => {
    toasts.push({ message, type });
  };
  App.nodes = [App.normalizeNode({
    name: "alpha",
    path: "alpha",
    lines: [
      { id: "line-1", name: "旧线路", target: "https://a.example.test" }
    ],
    activeLineId: "line-1"
  })];
  App.updateTags();
  App.editing = "alpha";
  App.editingActiveLineId = "line-1";
  ensureElement("in-name").value = "alpha";
  ensureElement("in-path").value = "alpha";
  ensureElement("in-remark").value = "";
  ensureElement("in-tag").value = "";
  ensureElement("in-node-headers-enabled").value = "0";
  ensureElement("in-redirect-whitelist-enabled").value = "0";
  ensureElement("in-real-client-ip-mode").value = "forward";
  App.getDraftTargetEntries = () => ([
    { id: "line-2", name: "新线路", target: "https://b.example.test" },
    { id: "line-1", name: "旧线路", target: "https://a.example.test" }
  ]);

  await App.saveNode();

  assert.equal(savedPayloads.length, 1);
  assert.equal(savedPayloads[0].activeLineId, "line-2");
  assert.deepEqual(savedPayloads[0].targets, ["https://b.example.test", "https://a.example.test"]);
  assert.equal(savedPayloads[0].realClientIpMode, "forward");
  assert.equal(App.nodes[0].activeLineId, "line-2");
  assert.deepEqual(toasts.at(-1), { message: "保存成功", type: "success" });
});

test("admin ui saveNode still shows an error toast when rollback rendering fails", async () => {
  const { App, ensureElement, context } = await createAdminInlineAppHarness({
    fetchImpl: async () => {
      throw new Error("保存接口失败");
    }
  });

  context.console.error = () => {};
  const toasts = [];
  let renderAttempts = 0;
  App.renderList = () => {
    renderAttempts += 1;
    throw new Error("渲染失败");
  };
  App.toast = (message, type = "success") => {
    toasts.push({ message, type });
  };
  App.nodes = [App.normalizeNode({
    name: "alpha",
    path: "alpha",
    lines: [
      { id: "line-1", name: "主线", target: "https://a.example.test" }
    ],
    activeLineId: "line-1"
  })];
  App.updateTags();
  App.editing = "alpha";
  App.editingActiveLineId = "line-1";
  ensureElement("in-name").value = "alpha";
  ensureElement("in-path").value = "alpha";
  ensureElement("in-remark").value = "";
  ensureElement("in-tag").value = "";
  ensureElement("in-node-headers-enabled").value = "0";
  ensureElement("in-redirect-whitelist-enabled").value = "0";
  ensureElement("in-forward-real-client-ip-enabled").value = "0";
  App.getDraftTargetEntries = () => ([
    { id: "line-1", name: "主线", target: "https://a.example.test" }
  ]);

  await assert.doesNotReject(() => App.saveNode());

  assert.ok(renderAttempts >= 1);
  assert.deepEqual(toasts.at(-1), { message: "保存接口失败", type: "error" });
});

test("admin ui renderList keeps card reuse stable after replacing the first rendered card", async () => {
  const { App, ensureElement, context } = await createAdminInlineAppHarness();
  const listContainer = ensureElement("list-container");
  const originalGetElementById = context.document.getElementById.bind(context.document);
  const originalInsertBefore = listContainer.insertBefore.bind(listContainer);

  context.document.getElementById = id => {
    const renderedCard = listContainer.childNodes.find(node => node?.id === id);
    if (renderedCard) return renderedCard;
    return originalGetElementById(id);
  };
  listContainer.insertBefore = (node, referenceNode) => {
    if (referenceNode && !listContainer.childNodes.includes(referenceNode)) {
      throw new Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
    }
    return originalInsertBefore(node, referenceNode);
  };

  App.nodes = [App.normalizeNode({
    name: "alpha",
    path: "alpha",
    remark: "旧备注",
    lines: [
      { id: "line-1", name: "主线", target: "https://a.example.test" }
    ],
    activeLineId: "line-1"
  })];
  App.updateTags();
  App.renderList();

  App.nodes = [App.normalizeNode({
    name: "alpha",
    path: "alpha",
    remark: "新备注",
    lines: [
      { id: "line-1", name: "主线", target: "https://a.example.test" }
    ],
    activeLineId: "line-1"
  })];

  assert.doesNotThrow(() => App.renderList());
  assert.match(String(listContainer.childNodes[0]?.outerHTML || ""), /新备注/);
});

test("admin ui includes client rtt pill and probe endpoint", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();

  assert.match(html, /id="client-rtt-pill"/);
  assert.match(html, /id="client-rtt-value"/);
  assert.match(html, /id="client-rtt-refresh"/);
  assert.match(html, /\/__client_rtt__\?_=/);
});

test("admin ui node modal exposes path-based basic settings and header toggle in advanced settings", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.match(html, /<label>高级设置<\/label>/);
  assert.match(html, /<div class="modal-mask" id="modal-mask">/);
  assert.doesNotMatch(html, /id="modal-mask"[^>]*closeModal/);
  assert.doesNotMatch(html, /id="proxy-mask"[^>]*closeProxyDialog/);
  assert.doesNotMatch(html, /id="settings-mask"[^>]*closeSettingsModal/);
  assert.doesNotMatch(html, /id="cf-settings-mask"[^>]*closeCfSettingsModal/);
  assert.doesNotMatch(html, /id="config-manage-mask"[^>]*closeConfigManageModal/);
  assert.doesNotMatch(html, /<label>密钥/);
  assert.match(html, /<span class="req">\*<\/span>名称/);
  assert.match(html, /<span class="req">\*<\/span>路径/);
  assert.match(html, /自定义请求头<\/label>/);
  assert.doesNotMatch(html, /自定义请求头（覆盖或新增）/);
  assert.match(html, /id="in-node-headers-enabled"/);
  assert.match(html, /id="node-headers-content"/);
  assert.match(html, /仅对当前站点的回源请求生效/);
  assert.ok(scriptMatch, "expected inline admin script");
  const script = scriptMatch[1];
  assert.match(script, /const BLOCKED_HEADER_NAMES=new Set\(/);
  assert.match(script, /const NODE_PATH_PHRASE_MAP=\{/);
  assert.match(script, /handleNodeNameInput\(value\)\{/);
  assert.match(script, /buildSuggestedNodePath\(value\)\{/);
  assert.doesNotMatch(script, /CHAR_MAP/);
  assert.match(script, /setNodePathTouched\(touched\)\{/);
  assert.match(script, /renderTargetDraft\(\)\{[\s\S]*线路名称（选填）/);
  assert.doesNotMatch(script, /renderTargetDraft\(\)\{[\s\S]*主源/);
  assert.doesNotMatch(script, /renderTargetDraft\(\)\{[\s\S]*target-order/);
  assert.match(script, /setNodeHeadersEnabled\(enabled\)\{/);
  assert.match(script, /syncModalScrollLock\(\)\{/);
  assert.match(script, /getOpenModalCloseAction\(\)\{/);
  assert.match(script, /handleGlobalKeydown\(event\)\{/);
  assert.match(script, /if\(event\.key!=='Escape'\)return;/);
  assert.match(html, /名称[\s\S]*路径[\s\S]*标签[\s\S]*备注[\s\S]*目标源站/);

  const sanitizerStart = script.indexOf("const BLOCKED_HEADER_NAMES=");
  const sanitizerEnd = script.indexOf("const App=");
  assert.notEqual(sanitizerStart, -1);
  assert.notEqual(sanitizerEnd, -1);
  const sanitizerSnippet = script.slice(sanitizerStart, sanitizerEnd);
  const context = { result: null };
  vm.createContext(context);
  new vm.Script(`${sanitizerSnippet}\nresult = sanitizeNodeHeaders({"Host":"bad","Connection":"keep-alive","X-Test":"1"});`).runInContext(context);
  assert.equal(context.result?.["X-Test"], "1");
  assert.equal(Object.keys(context.result || {}).length, 1);
});

test("admin ui node path phrase preset is externalized without single-char transliteration fallback", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /from "\.\/node-path-phrase-map\.js"/);
  assert.doesNotMatch(source, /CHAR_MAP/);
  assert.equal(NODE_PATH_PHRASE_MAP["熊猫"], "xiongmao");
  assert.equal(NODE_PATH_PHRASE_MAP["线路"], "xianlu");
});

test("admin ui node path suggestion keeps mapped phrases and leaves unmatched pure Chinese empty", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  const constantsStart = script.indexOf("const NODE_PATH_PHRASE_MAP=");
  const constantsEnd = script.indexOf("const App=");
  const normalizeMatch = script.match(/normalizeNodePathValue\(value\)\{([\s\S]*?)\},\n    buildSuggestedNodePath/);
  const suggestMatch = script.match(/buildSuggestedNodePath\(value\)\{([\s\S]*?)\},\n    setNodePathTouched/);

  assert.notEqual(constantsStart, -1);
  assert.notEqual(constantsEnd, -1);
  assert.ok(normalizeMatch);
  assert.ok(suggestMatch);

  const constantsSnippet = script.slice(constantsStart, constantsEnd);
  const normalizeMethod = `normalizeNodePathValue(value){${normalizeMatch[1]}}`;
  const suggestMethod = `buildSuggestedNodePath(value){${suggestMatch[1]}}`;
  const context = { result: null };
  vm.createContext(context);
  new vm.Script(`${constantsSnippet}
const helper={
${normalizeMethod},
${suggestMethod}
};
result={
  phrase:helper.buildSuggestedNodePath("熊猫 01"),
  unmatched:helper.buildSuggestedNodePath("自定义中文名称")
};`).runInContext(context);

  assert.equal(context.result?.phrase, "xiongmao-01");
  assert.equal(context.result?.unmatched, "");
});

test("admin ui node script preserves path and headers across normalize import clone export and save flows", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  const script = scriptMatch[1];

  assert.match(script, /normalizeNode\(node\)\{[\s\S]*headers:sanitizeNodeHeaders\(node\?\.headers\)/);
  assert.match(script, /normalizeNode\(node\)\{[\s\S]*path:String\(node\?\.path\|\|node\?\.name\|\|''\)/);
  assert.match(script, /normalizeNode\(node\)\{[\s\S]*lines:/);
  assert.match(script, /normalizeImportedNodes\(list\)\{[\s\S]*path:String\(item\?\.path\|\|item\?\.secret\|\|item\?\.name\|\|''\)/);
  assert.match(script, /buildConfigExportPayload\(includeAll=false\)\{const nodes=\(Array\.isArray\(this\.nodes\)\?this\.nodes:\[\]\)\.map\(item=>this\.normalizeNode\(item\)\)/);
  assert.match(script, /const path=document\.getElementById\('in-path'\)\.value\.trim\(\);/);
  assert.match(script, /const headerPairs=this\.collectNodeHeaderEntries\(\);[\s\S]*headers:headerPairs/);
  assert.match(script, /const rawLines=this\.getDraftTargetEntries\(\)\.map\(\(item,index\)=>this\.normalizeLineDraftEntry\(item,index\)\);[\s\S]*lines:rawLines/);
  assert.match(script, /const nextActiveLineId=String\(rawLines\.find\(item=>this\.normalizeTarget\(item\.target\)\)\?\.id\|\|this\.editingActiveLineId\|\|''\)\.trim\(\);/);
  assert.match(script, /const cloned=\{[\s\S]*path:this\.generateClonePath\(source\.path\)/);
  assert.match(script, /openModal\(nodePath=null\)\{[\s\S]*document\.getElementById\('in-path'\)\.value=node\?\.path\|\|'';/);
  assert.match(script, /this\.nodePaths\.has\(path\)/);
  assert.doesNotMatch(script, /in-secret/);
  assert.doesNotMatch(script, /secret:/);
});

test("admin ui import keeps legacy secret path from v2.4.7 exports", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";

  assert.match(
    script,
    /normalizeImportedNodes\(list\)\{[\s\S]*path:String\(item\?\.path\|\|item\?\.secret\|\|item\?\.name\|\|''\)\.trim\(\)/
  );
});

test("admin ui settings model keeps only editable redirect whitelist rules and loads aligned defaults", () => {
  const config = normalizeConfig({
    thirdPartyProxies: [{ id: "p-1", name: "One", url: "https://proxy.example.test" }],
    redirectWhitelistEntries: [{ id: "redirect-1", name: "精确域名", domain: "pan.quark.cn" }],
    wangpandirect: " aliyundrive , https://115.com/path ",
    enableH2: true,
    enableH3: true,
    peakDowngrade: false,
    protocolFallback: false,
    enablePrewarm: false,
    prewarmDepth: "poster",
    prewarmCacheTtl: 240,
    directStaticAssets: true,
    directHlsDash: true,
    sourceSameOriginProxy: false,
    forceExternalProxy: false,
    debugProxyHeaders: true,
    upstreamTimeoutMs: 12000,
    upstreamRetryAttempts: 2
  });

  const draft = createSettingsDraftFromConfig(config);

  assert.deepEqual(draft.thirdPartyProxies, [{ id: "p-1", name: "One", url: "https://proxy.example.test" }]);
  assert.equal(draft.enableH2, true);
  assert.equal(draft.enableH3, true);
  assert.equal(draft.peakDowngrade, false);
  assert.equal(draft.protocolFallback, false);
  assert.equal(draft.enablePrewarm, false);
  assert.equal(draft.prewarmDepth, "poster");
  assert.equal(draft.prewarmCacheTtl, 240);
  assert.equal(draft.directStaticAssets, true);
  assert.equal(draft.directHlsDash, true);
  assert.equal(draft.sourceSameOriginProxy, false);
  assert.equal(draft.forceExternalProxy, false);
  assert.equal(draft.debugProxyHeaders, true);
  assert.equal(draft.upstreamTimeoutMs, 12000);
  assert.equal(draft.upstreamRetryAttempts, 2);
  assert.deepEqual(
    draft.redirectWhitelistEntries.map(item => ({
      name: item.name,
      domain: item.domain
    })),
    [{ name: "精确域名", domain: "pan.quark.cn" }]
  );

  const defaults = createSettingsDraftFromConfig(normalizeConfig({}));
  assert.equal(defaults.enableH2, false);
  assert.equal(defaults.enableH3, false);
  assert.equal(defaults.peakDowngrade, true);
  assert.equal(defaults.protocolFallback, true);
  assert.equal(defaults.enablePrewarm, true);
  assert.equal(defaults.prewarmDepth, "poster_manifest");
  assert.equal(defaults.prewarmCacheTtl, 180);
  assert.equal(defaults.directStaticAssets, true);
  assert.equal(defaults.directHlsDash, true);
  assert.equal(defaults.sourceSameOriginProxy, true);
  assert.equal(defaults.forceExternalProxy, true);
  assert.equal(defaults.debugProxyHeaders, false);
  assert.equal(defaults.upstreamTimeoutMs, 30000);
  assert.equal(defaults.upstreamRetryAttempts, 1);
  assert.deepEqual(defaults.thirdPartyProxies, []);
  assert.equal(MAX_SHARED_REDIRECT_RULES, 20);
});
test("admin ui settings model saves aligned proxy fields and reuses shared redirect rules for shared redirect matching", () => {
  const nextConfig = buildConfigFromSettingsDraft(normalizeConfig({}), {
    thirdPartyProxies: [{ id: "p-2", name: "Two", url: "https://relay.example.test" }],
    redirectWhitelistEntries: [
      { id: "redirect-1", name: "网盘域名", domain: "pan.quark.cn" },
      { id: "redirect-2", name: "", domain: "aliyundrive" },
      { id: "redirect-3", name: "", domain: "115.com/path?foo=1" }
    ],
    tcping: cloneTcpingConfig({
      tcp: { count: 5, timeoutMs: 3000, latencyWarnLow: 50, latencyWarnHigh: 150 },
      head: { count: 4, timeoutMs: 2800, latencyWarnLow: 260, latencyWarnHigh: 700 }
    }),
    enableH2: true,
    enableH3: true,
    peakDowngrade: false,
    protocolFallback: false,
    enablePrewarm: false,
    prewarmDepth: "poster",
    prewarmCacheTtl: 240,
    directStaticAssets: true,
    directHlsDash: true,
    sourceSameOriginProxy: false,
    forceExternalProxy: false,
    debugProxyHeaders: true,
    upstreamTimeoutMs: 12000,
    upstreamRetryAttempts: 2
  });

  assert.deepEqual(nextConfig.thirdPartyProxies, [{ id: "p-2", name: "Two", url: "https://relay.example.test" }]);
  assert.deepEqual(nextConfig.redirectWhitelistEntries, [
    { id: "redirect-1", name: "网盘域名", domain: "pan.quark.cn" },
    { id: "redirect-3", name: "", domain: "115.com" }
  ]);
  assert.deepEqual(nextConfig.redirectWhitelistDomains, ["pan.quark.cn", "115.com"]);
  assert.equal(nextConfig.wangpandirect, "pan.quark.cn, aliyundrive, 115.com");
  assert.equal(nextConfig.enableH2, true);
  assert.equal(nextConfig.enableH3, true);
  assert.equal(nextConfig.peakDowngrade, false);
  assert.equal(nextConfig.protocolFallback, false);
  assert.equal(nextConfig.enablePrewarm, false);
  assert.equal(nextConfig.prewarmDepth, "poster");
  assert.equal(nextConfig.prewarmCacheTtl, 240);
  assert.equal(nextConfig.directStaticAssets, true);
  assert.equal(nextConfig.directHlsDash, true);
  assert.equal(nextConfig.sourceSameOriginProxy, false);
  assert.equal(nextConfig.forceExternalProxy, false);
  assert.equal(nextConfig.debugProxyHeaders, true);
  assert.equal(nextConfig.upstreamTimeoutMs, 12000);
  assert.equal(nextConfig.upstreamRetryAttempts, 2);
});
test("admin ui settings modal exposes aligned proxy network fields and shared redirect rule copy", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.match(html, /id="settings-enable-h2-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-enable-h3-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-peak-downgrade-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-protocol-fallback-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-enable-prewarm-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-prewarm-cache-ttl"/);
  assert.match(html, /id="settings-prewarm-depth"/);
  assert.match(html, /id="settings-prewarm-depth-label"/);
  assert.match(html, /id="settings-prewarm-depth-menu"/);
  assert.match(html, /class="tag-wrapper settings-depth-picker"/);
  assert.match(html, /id="settings-direct-static-assets-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-direct-hls-dash-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-source-same-origin-proxy-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-force-external-proxy-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-debug-proxy-headers-switch" class="whitelist-switch"/);
  assert.match(html, /id="settings-upstream-timeout-ms"/);
  assert.match(html, /id="settings-upstream-retry-attempts"/);
  assert.match(html, /重定向白名单/);
  assert.match(html, /给确定适合直连的域名或关键词开绿灯/);
  assert.match(html, /id="settings-advanced-toggle"/);
  assert.match(html, /id="settings-advanced-sections"/);
  assert.match(html, /这些是底层网络策略。默认值已经按稳定优先调好/);
  assert.doesNotMatch(html, /命中 <code>wangpandirect<\/code> 列表走直连/);
  assert.doesNotMatch(html, /默认已填入内置关键词/);
  assert.doesNotMatch(html, /默认开启：源站和同源跳转代理/);
  assert.doesNotMatch(html, /默认开启：强制反代外部链接/);
  assert.match(html, /id="settings-redirect-whitelist-add" class="preferred-dns-secondary" type="button" onclick="App\.addRedirectWhitelistEntry\(\)"/);
  assert.match(html, /<button class="ghost-btn" onclick="App\.resetSettingsModal\(\)">重置<\/button>/);
  assert.match(html, /<button class="ghost-btn" onclick="App\.closeSettingsModal\(\)">关闭<\/button>/);
  assert.match(html, /<button class="ghost-btn" onclick="App\.closeCfSettingsModal\(\)">关闭<\/button>/);
  assert.match(html, /普通用户一般不用动，遇到某个站点一直转圈、403 或忽快忽慢时再逐项试。/);
  assert.match(html, /播放前顺手把海报、播放列表和字幕先准备好/);
  assert.match(html, /只想让页面图片更快，就选“仅预热海报”/);
  assert.match(html, /让 css、js、favicon 这类前端静态文件直接回源/);
  assert.match(html, /上游跳到外链后，是否仍由这个面板继续代转/);
  assert.match(html, /仅在异常媒体响应上附加额外 X-Proxy-\* 头/);
  assert.match(html, /单次回源最多等多久就判定失败/);
  assert.ok(scriptMatch, "expected inline admin script");
  assert.match(scriptMatch[1], /setSettingsSwitch\(switchId,textId,enabled\)\{/);
  assert.match(scriptMatch[1], /updateSettingsFlag\(key,value\)\{this\.settingsDraft\[key\]=value===true;this\.renderSettingsList\(\);\}/);
  assert.match(scriptMatch[1], /toggleSettingsFlag\(key\)\{this\.updateSettingsFlag\(key,!this\.settingsDraft\[key\]\);\}/);
  assert.match(scriptMatch[1], /getPrewarmDepthOptions\(\)\{/);
  assert.match(scriptMatch[1], /syncPrewarmDepthMenu\(\)\{/);
  assert.match(scriptMatch[1], /togglePrewarmDepthMenu\(event\)\{/);
  assert.match(scriptMatch[1], /selectPrewarmDepth\(value,event\)\{/);
  assert.match(scriptMatch[1], /syncSettingsAdvancedToggle\(\)\{/);
  assert.match(scriptMatch[1], /toggleSettingsAdvanced\(event\)\{/);
  assert.doesNotMatch(scriptMatch[1], /addBtn\)addBtn\.disabled=list\.length>=MAX_SHARED_REDIRECT_RULES/);
  assert.doesNotMatch(scriptMatch[1], /redirectWhitelistEntries:buildSharedRedirectRuleEntries\(data,MAX_SHARED_REDIRECT_RULES\)/);
  assert.doesNotMatch(scriptMatch[1], /const FALLBACK_REDIRECT_WHITELIST_DOMAINS=/);
  assert.doesNotMatch(scriptMatch[1], /const buildSharedRedirectRuleEntries=/);
  assert.doesNotMatch(scriptMatch[1], /normalizeRedirectWhitelistDomains\(list\)\{/);
  assert.doesNotMatch(scriptMatch[1], /getFallbackRedirectWhitelistDomains\(\)\{/);
  assert.match(scriptMatch[1], /const explicitRedirectEntries=normalizeSharedRedirectRuleEntries\(/);
  assert.match(scriptMatch[1], /const explicitRedirectDomains=Array\.from\(new Set\(explicitRedirectEntries\.map\(item=>normalizeRedirectRuleHost\(item\?\.domain\)\)\.filter\(domain=>isHostLikeRedirectRule\(domain\)\)\)\);/);
  assert.match(scriptMatch[1], /preserveDraftRedirectWhitelistEntries\(list\)\{/);
  assert.match(scriptMatch[1], /renderSettingsList\(\)\{[\s\S]*const draftRedirectEntries=this\.preserveDraftRedirectWhitelistEntries\(this\.settingsDraft\.redirectWhitelistEntries\);/);
  assert.match(scriptMatch[1], /renderSettingsList\(\)\{[\s\S]*this\.settingsDraft\.redirectWhitelistEntries=draftRedirectEntries;/);
  assert.match(scriptMatch[1], /renderSettingsList\(\)\{[\s\S]*this\.syncPrewarmDepthMenu\(\);[\s\S]*this\.syncSettingsAdvancedToggle\(\);/);
  assert.match(scriptMatch[1], /updateSettingsValue\(key,value\)\{this\.settingsDraft\[key\]=key==='prewarmDepth'\?normalizePrewarmDepth\(value\):value;if\(key==='prewarmDepth'\)this\.syncPrewarmDepthMenu\(\);\}/);
  assert.match(scriptMatch[1], /renderSettingsList\(\)\{[\s\S]*class="proxy-item settings-card-item"/);
  assert.match(scriptMatch[1], /renderSettingsList\(\)\{[\s\S]*const root=document\.getElementById\('settings-proxy-list'\);[\s\S]*暂无记录/);
  assert.match(scriptMatch[1], /renderRedirectWhitelistSettingsList\(\)\{[\s\S]*class="proxy-item settings-card-item"/);
  assert.match(html, /--adm-field-bg:var\(--adm-control-bg\);/);
  assert.match(html, /--adm-segmented-bg:var\(--adm-control-bg\);/);
  assert.match(html, /\.settings-row input,\.proxy-item input,\.settings-range input,\.settings-card-item input,\.settings-depth-input\{[\s\S]*height:var\(--adm-control-h\);[\s\S]*border-radius:var\(--adm-field-radius\);[\s\S]*border:1px solid var\(--adm-field-border\);[\s\S]*background:var\(--adm-field-bg\);[\s\S]*color:var\(--adm-field-text\);[\s\S]*padding:0 12px;[\s\S]*\}/);
  assert.match(html, /html\.dark\{[\s\S]*--adm-control-border:#42506a;[\s\S]*--adm-control-text:#f3f4f6;[\s\S]*--adm-surface-card:#111827;/);
  assert.match(html, /\.settings-depth-input\{width:100%;height:var\(--adm-control-h\);padding:0 38px 0 12px;border-radius:var\(--adm-field-radius\);border:1px solid var\(--adm-field-border\);background:var\(--adm-field-bg\);color:var\(--adm-field-text\);outline:none;font-size:14px;cursor:pointer\}/);
  assert.match(html, /\.settings-toggle\{[\s\S]*display:grid;[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[\s\S]*width:200px;[\s\S]*border:1px solid var\(--adm-segmented-border\);[\s\S]*background:var\(--adm-segmented-bg\);[\s\S]*border-radius:var\(--adm-segmented-radius\);[\s\S]*overflow:hidden[\s\S]*\}/);
  assert.match(html, /\.settings-toggle button\{height:var\(--adm-segmented-button-h\);border:none;background:transparent;color:var\(--adm-segmented-text\);cursor:pointer;font-size:14px\}/);
  assert.doesNotMatch(html, /\.preferred-mode-toggle\{border:none;background:/);
  assert.doesNotMatch(html, /html\.dark \.settings-input-with-action\{background:var\(--bg\);border-color:var\(--border\)\}/);
  assert.match(html, /\.settings-advanced-toggle\{display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px 14px;border:1px solid var\(--adm-border-accent-soft\);border-radius:12px;background:linear-gradient\(180deg,#f7fbff 0%,#eef5ff 100%\);color:var\(--adm-text-strong\);cursor:pointer\}/);
  assert.match(html, /\.settings-advanced-sections\{display:grid;gap:16px;padding:14px;border:1px solid var\(--adm-border-accent-soft\);border-radius:16px;background:linear-gradient\(180deg,#fbfdff 0%,#f3f7ff 100%\)\}/);
  assert.match(html, /html\.dark \.settings-advanced-toggle\{background:linear-gradient\(180deg,rgba\(62,103,177,.22\) 0%,rgba\(34,57,97,.26\) 100%\);border-color:#4869a7;color:#f3f4f6\}/);
  assert.match(html, /html\.dark \.settings-advanced-sections\{background:linear-gradient\(180deg,rgba\(20,31,52,.9\) 0%,rgba\(14,22,37,.96\) 100%\);border-color:#33476f\}/);
  assert.match(scriptMatch[1], /resetSettingsModal\(\)\{/);
  assert.match(scriptMatch[1], /跳转规则最多 20 条/);
  assert.match(scriptMatch[1], /syncModalScrollLock\(\)\{/);
  assert.match(scriptMatch[1], /document\.body\.style\.position='fixed'/);
  assert.match(scriptMatch[1], /resetModalScrollPositions\(maskId,modalId\)\{/);
  assert.match(scriptMatch[1], /openSettingsModal\(\)\{[\s\S]*this\.resetModalScrollPositions\('settings-mask','settings-modal'\);/);
  assert.match(scriptMatch[1], /openCfSettingsModal\(\)\{[\s\S]*this\.resetModalScrollPositions\('cf-settings-mask','cf-settings-modal'\);/);
  assert.match(scriptMatch[1], /openConfigManageModal\(\)\{[\s\S]*this\.resetModalScrollPositions\('config-manage-mask','config-manage-modal'\);/);
  assert.match(scriptMatch[1], /openProxyDialog\(name\)\{[\s\S]*this\.resetModalScrollPositions\('proxy-mask','proxy-modal'\);/);
  assert.match(scriptMatch[1], /openModal\(nodeName=null\)\{[\s\S]*this\.resetModalScrollPositions\('modal-mask','modal'\);/);
});

test("admin ui node cards expose recent usage time text with unavailable fallback", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  assert.match(html, /\.recent-usage-text\{font-size:12px;color:var\(--adm-text-subtle\)/);
  assert.match(html, /\.recent-usage-btn\{border:none;background:transparent;padding:0;color:var\(--adm-text-subtle\)/);
  assert.match(scriptMatch[1], /formatRecentUsageTime\(input\)\{/);
  assert.match(scriptMatch[1], /const recentUsageText=this\.nodeActivityRefreshingPath===n\.path\?'刷新中\.\.\.':\(activity\?this\.formatRecentUsageTime\(activity\.lastSeenAt\):'未观看'\);/);
  assert.match(scriptMatch[1], /class="recent-usage-btn" type="button" onclick=\\'App\.refreshNodeUsage\('\+quotedPath\+',event\)\\'/);
  assert.match(scriptMatch[1], /class="card-path-inline" type="button" title="点击复制 \/'\+safePath\+'" onclick=\\'App\.copyNodePath\('\+quotedPath\+',event\)\\'>\/'\+safePath\+'<\/button>/);
  assert.match(scriptMatch[1], /refreshNodeUsage\(path,event\)\{event\?\.preventDefault\?\.\(\);event\?\.stopPropagation\?\.\(\);/);
  assert.doesNotMatch(scriptMatch[1], /activity-pill/);
});

test("admin ui styles consolidate button panel and pill primitives", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();

  assert.match(html, /--adm-btn-h:var\(--adm-control-h\);/);
  assert.match(html, /--adm-btn-radius:var\(--adm-control-radius\);/);
  assert.match(html, /--adm-panel-radius-md:10px;/);
  assert.match(html, /--adm-panel-radius-lg:12px;/);
  assert.match(html, /--adm-pill-radius:999px;/);
  assert.match(html, /\.target-action-btn,\.ghost-btn,\.primary-btn,\.config-manage-btn,\.preferred-dns-secondary,\.preferred-dns-apply\{[\s\S]*display:inline-flex;[\s\S]*align-items:center;[\s\S]*justify-content:center;[\s\S]*height:var\(--adm-btn-h\);[\s\S]*border-radius:var\(--adm-btn-radius\);[\s\S]*cursor:pointer[\s\S]*\}/);
  assert.match(html, /\.target-action-btn,\.ghost-btn,\.config-manage-btn,\.preferred-dns-secondary\{[\s\S]*border:1px solid var\(--adm-btn-secondary-border\);[\s\S]*background:var\(--adm-btn-secondary-bg\);[\s\S]*color:var\(--adm-btn-secondary-text\);[\s\S]*\}/);
  assert.match(html, /\.target-item,\.config-manage-option,\.settings-card-item\{[\s\S]*border:1px solid var\(--adm-border-soft\);[\s\S]*border-radius:var\(--adm-panel-radius-lg\);[\s\S]*background:var\(--adm-surface-subtle\);[\s\S]*\}/);
  assert.match(html, /\.proxy-line,\.target-item\.is-primary\{[\s\S]*border:1px solid var\(--adm-border-accent-strong\);[\s\S]*border-radius:var\(--adm-panel-radius-md\);[\s\S]*background:var\(--adm-surface-accent\);[\s\S]*\}/);
  assert.match(html, /\.client-rtt-pill,\.cf-range-pill\{[\s\S]*display:inline-flex;[\s\S]*align-items:center;[\s\S]*border-radius:var\(--adm-pill-radius\);[\s\S]*white-space:nowrap[\s\S]*\}/);
  assert.match(html, /\.preferred-dns-stack,\.preferred-dns-history-btn\{[\s\S]*padding:2px 8px;[\s\S]*border-radius:var\(--adm-pill-radius\);[\s\S]*font-size:12px;[\s\S]*line-height:16px[\s\S]*\}/);
});

test("admin ui main menu exposes site sort controls and card path copy affordance", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  assert.match(html, /\.popover \{ position:absolute; top: 100%; right:0; min-width:180px; width:max-content; max-width:none;/);
  assert.match(html, /<button class="popover-item" onclick="App\.openConfigManageModal\(\)">[\s\S]*?配置管理<\/button>/);
  assert.match(html, /站点排序/);
  assert.match(html, /路径名称/);
  assert.match(html, /最近使用/);
  assert.match(html, /class="popover-sort-label"[^>]*>[\s\S]*?<svg /);
  assert.match(html, /id="menu-sort-path"/);
  assert.match(html, /id="menu-sort-recent"/);
  assert.match(html, /id="theme-menu-btn"/);
  assert.match(scriptMatch[1], /sortMode:'path'/);
  assert.match(scriptMatch[1], /document\.getElementById\('theme-menu-btn'\)/);
  assert.match(scriptMatch[1], /setSortMode\(mode,event\)\{/);
  assert.match(scriptMatch[1], /getSortedNodes\(list=this\.nodes\)\{/);
  assert.match(scriptMatch[1], /copyNodePath\(path,event\)\{/);
  assert.match(scriptMatch[1], /class="card-path-inline"[^>]+onclick=\\'App\.copyNodePath\('\+quotedPath\+',event\)\\'/);
});

test("admin ui main menu exposes version entry linked to repository homepage", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  assert.match(html, /id="version-menu-btn"/);
  assert.match(html, /配置管理[\s\S]*<button id="version-menu-btn"[\s\S]*<div style="height:1px;background:var\(--border\);margin:4px 0"><\/div>\s*<button class="popover-item" onclick="App\.logout\(\)"/);
  assert.match(html, /id="version-menu-text">版本 V2\.4\.10</);
  assert.match(html, /id="version-menu-btn"[\s\S]*?fill="currentColor"/);
  assert.match(scriptMatch[1], /const WORKER_VERSION="2\.4\.10";/);
  assert.match(scriptMatch[1], /const GITHUB_REPOSITORY_URL="https:\/\/github\.com\/irm123gard\/Emby-Mate";/);
  assert.match(scriptMatch[1], /openRepositoryHome\(event\)\{/);
  assert.match(scriptMatch[1], /loadVersionStatus\(force=false\)\{/);
  assert.match(scriptMatch[1], /syncVersionMenu\(\)\{/);
});

test("admin ui cf card fixes range to 24h and removes selector controls", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "expected inline admin script");
  assert.match(html, /\.client-rtt-pill,\.cf-range-pill\{display:inline-flex;align-items:center;border-radius:var\(--adm-pill-radius\);white-space:nowrap;box-sizing:border-box;\}/);
  assert.match(html, /\.cf-range-pill\{padding:6px 10px;border:1px solid var\(--adm-border-accent-soft\);background:var\(--adm-surface-accent-muted\);color:var\(--adm-text-accent\);font-size:13px;font-weight:600;height:32px\}/);
  assert.match(html, /\.cf-primary-grid\{display:grid;grid-template-columns:minmax\(0,1\.45fr\) minmax\(120px,.85fr\);gap:8px 10px;width:100%;align-items:start\}/);
  assert.match(html, /\.cf-primary-item\.traffic \.cf-metric-top\{flex-wrap:nowrap\}/);
  assert.match(html, /html\.dark\{[\s\S]*--adm-surface-accent-muted:rgba\(74,128,232,.16\);[\s\S]*--adm-border-accent-soft:#4869a7;[\s\S]*--adm-text-accent:#7db1ff;/);
  assert.doesNotMatch(html, /cf-range-btn/);
  assert.doesNotMatch(html, /cf-range-list/);
  assert.match(scriptMatch[1], /renderMetric\('站点流量'/);
  assert.match(scriptMatch[1], /renderMetric\('站点流量',this\.formatCfDataSize\(trafficMetric\?\.totalBytes\),trafficMetric\?\.totalChange,'traffic'\)/);
  assert.match(scriptMatch[1], /<span class="cf-range-pill">近24小时<\/span>/);
  assert.match(scriptMatch[1], /body:JSON\.stringify\(\{action:'cfMetrics',rangeKey:'24h',mode:'full'\}\)/);
  assert.doesNotMatch(scriptMatch[1], /toggleCfRangeMenu\(event\)\{/);
  assert.doesNotMatch(scriptMatch[1], /selectCfRange\(rangeKey,event\)\{/);
});

test("admin ui mobile modal layout uses sheet-style spacing with reachable actions", async () => {
  const response = UI.renderAdminUI();
  const html = await response.text();

  assert.match(html, /\.modal-content\{flex:1 1 auto;min-height:0;max-height:min\(70vh,680px\);overflow:auto\}/);
  assert.match(html, /@media\(max-width:767px\)\{[\s\S]*\.modal-mask\{align-items:flex-end;/);
  assert.match(html, /@media\(max-width:767px\)\{[\s\S]*\.modal\{width:100%;max-width:none;max-height:min\(92vh,900px\);padding:18px 16px calc\(16px \+ env\(safe-area-inset-bottom\)\);border-radius:20px 20px 0 0;transform:translateY\(24px\)\}/);
  assert.match(html, /\.modal-actions-center>\*\{flex:1 1 140px\}/);
});

test("admin ui sorting helpers prefer path order by default and recent usage when requested", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /sortMode:'path'/);
  assert.match(source, /getSortedNodes\(list=this\.nodes\)\{/);
  assert.match(source, /if\(this\.sortMode==='recent'\)/);
  assert.match(source, /return rightTs-leftTs\|\|leftPath\.localeCompare\(rightPath,'zh'\);/);
  assert.match(source, /return leftPath\.localeCompare\(rightPath,'zh'\);/);
});

test("admin ui node list rendering reuses existing cards instead of rebuilding full html", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /getNodeCardRenderSignature\(n\)\{/);
  assert.match(source, /createNodeCardElement\(n,signature=''?\)\{/);
  assert.match(source, /syncRenderedNodeCards\(container,filtered\)\{/);
  assert.match(source, /container\.querySelectorAll\('\.card\[data-card-path\]'\)/);
  assert.match(source, /dataset\.renderSignature/);
  assert.doesNotMatch(source, /const cardHtml=filtered\.map\(n=>this\.renderNodeCard\(n\)\)\.join\(''\);/);
  assert.doesNotMatch(source, /container\.innerHTML=cardHtml;/);
});

test("admin ui cf card and node activity refresh use change-aware rendering paths", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /getCfCardRenderSignature\(\)\{/);
  assert.match(source, /if\(container\.dataset\.renderSignature===signature&&container\.innerHTML===cfCard\)return;/);
  assert.match(source, /getChangedNodeActivityPaths\(previousMap,nextMap\)\{/);
  assert.match(source, /if\(this\.sortMode==='recent'\)\{this\.renderList\(\);return nextMap;\}/);
  assert.match(source, /changedPaths\.forEach\(path=>this\.updateNodeCard\(path\)\);/);
});

test("admin ui search and tcping handlers avoid duplicate filtering and in-flight probes", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /getFilteredNodesResult\(query=this\.filterText\)\{/);
  assert.match(source, /const result=this\.getFilteredNodesResult\(next\);/);
  assert.match(source, /if\(result\.signature!==this\._lastFilterSignature\)this\.renderList\(result\.filtered,result\.signature\);/);
  assert.match(source, /renderList\(filteredNodes=null,signature=''\)\{/);
  assert.match(source, /if\(this\.tcpingCache\[path\]\?\.loading\)return;/);
});

test("admin ui search normalizes no-op queries and tcping shares target-level probe state", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /_tcpingRequestsByTarget:\{\}/);
  assert.match(source, /getNormalizedFilterText\(value\)\{return String\(value\|\|''\)\.trim\(\);\}/);
  assert.match(source, /const next=this\.getNormalizedFilterText\(val\);/);
  assert.match(source, /if\(next===this\.filterText\)\{this\.updateSearchState\(\);return;\}/);
  assert.match(source, /getTcpingCacheKey\(target\)\{return this\.normalizeTarget\(target\)\|\|'';\}/);
  assert.match(source, /getFreshTcpingResult\(target,now=Date\.now\(\)\)\{/);
  assert.match(source, /const shared=this\._tcpingRequestsByTarget\[cacheKey\];/);
});

test("admin ui background probes reuse fresh rtt samples and skip hidden node-activity polling", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /_clientRttFreshWindowMs:60000/);
  assert.match(source, /_nodeActivityFreshWindowMs:60000/);
  assert.match(source, /getTimestampAgeMs\(input,now=Date\.now\(\)\)\{/);
  assert.match(source, /isFreshTimestamp\(input,windowMs,now=Date\.now\(\)\)\{/);
  assert.match(source, /if\(!force&&this\.isFreshTimestamp\(this\.clientRtt\?\.updatedAt,this\._clientRttFreshWindowMs\)\)\{this\.updateClientRttPill\(\);return this\.clientRtt;\}/);
  assert.match(source, /if\(!force&&document\.visibilityState==='hidden'\)return this\.nodeActivityData\?\.nodeActivity\|\|null;/);
  assert.match(source, /if\(!force&&this\.isFreshTimestamp\(this\.nodeActivityData\?\.generatedAt,this\._nodeActivityFreshWindowMs\)\)return this\.nodeActivityData\?\.nodeActivity\|\|null;/);
  assert.match(source, /this\.nodeActivityRefreshTimer=setInterval\(\(\)=>\{if\(document\.visibilityState==='hidden'\)return;this\.loadNodeActivity\(false\);\},seconds\*1000\);/);
});

test("admin ui cf metrics auto refresh reuses fresh data and skips hidden polling", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");

  assert.match(source, /_cfMetricsFreshWindowMs:60000/);
  assert.match(source, /if\(!force&&document\.visibilityState==='hidden'\)return this\.cfMetricsData;/);
  assert.match(source, /if\(!force&&this\.isFreshTimestamp\(this\.cfMetricsData\?\.updatedAt\|\|this\.cfMetricsData\?\.generatedAt,this\._cfMetricsFreshWindowMs\)\)return this\.cfMetricsData;/);
  assert.match(source, /this\.cfMetricsData=\{\.\.\.data,loading:false,updatedAt:data\.updatedAt\|\|new Date\(\)\.toISOString\(\)\};/);
  assert.match(source, /if\(cfg\.showCard!==false&&this\.hasCfMetricsConfig\(\)\)this\.cfAutoRefreshTimer=setInterval\(\(\)=>\{if\(document\.visibilityState==='hidden'\)return;this\.loadCfMetrics\(false\);\},seconds\*1000\);/);
});

test("recent node usage remembers playback requests and merges with delayed analytics activity", async () => {
  resetGlobals();
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };

  await rememberRecentNodeUsage(GLOBALS, "panda", executionContext, "2026-03-17T08:00:00.000Z");
  await settleExecutionContext(executionContext);

  const recentUsage = await readRecentNodeUsageMap(GLOBALS, ["panda", "1111"]);
  const merged = mergeNodeActivityWithRecentUsage({
    panda: {
      lastSeenAt: "2026-03-16T08:00:00.000Z",
      requests: 12
    },
    "1111": {
      lastSeenAt: "2026-03-15T08:00:00.000Z",
      requests: 3
    }
  }, recentUsage);

  assert.equal(recentUsage.panda.lastSeenAt, "2026-03-17T08:00:00.000Z");
  assert.equal(merged.panda.lastSeenAt, "2026-03-17T08:00:00.000Z");
  assert.equal(merged.panda.requests, 12);
  assert.equal(merged["1111"].lastSeenAt, "2026-03-15T08:00:00.000Z");
});

test("recent node usage can skip storage reads when admin listing many nodes", async t => {
  resetGlobals();
  const originalCache = globalThis.caches.default;
  const matchCalls = [];
  globalThis.caches.default = {
    ...createCacheFacade(),
    async match(url) {
      matchCalls.push(String(url));
      throw new Error("storage lookup should be skipped");
    }
  };
  t.after(() => {
    globalThis.caches.default = originalCache;
  });

  const recentUsage = await readRecentNodeUsageMap(GLOBALS, ["alpha", "beta"], {
    allowStorageReads: false
  });

  assert.deepEqual(recentUsage, {});
  assert.deepEqual(matchCalls, []);
});

test("dist worker keeps defensive object guards in settings model for Cloudflare editor TS checks", () => {
  const distPath = path.join(process.cwd(), "dist", "worker.js");
  const distSource = fs.readFileSync(distPath, "utf8");

  assert.match(
    distSource,
    /function createSettingsDraftFromConfig\(config = \{\}\) \{\s+const base = Object\(config && typeof config === "object" \? config : void 0\);/s
  );
  assert.match(
    distSource,
    /function normalizeNodeRecord\(node = \{\}\) \{\s+const source = Object\(node && typeof node === "object" && !Array\.isArray\(node\) \? node : \{/s
  );
  assert.match(distSource, /0 6 \* \* \*/);
});

test("package.json build runs Cloudflare preflight before esbuild bundling", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

  assert.equal(typeof packageJson.scripts?.["cloudflare:preflight"], "string");
  assert.equal(packageJson.scripts?.["check:cloudflare"], "npm run cloudflare:preflight");
  assert.equal(packageJson.devDependencies?.wrangler, "4.73.0");
  assert.match(
    packageJson.scripts?.build || "",
    /^npm run cloudflare:preflight && esbuild src\/worker-entry\.js /
  );
  assert.equal(
    packageJson.scripts?.["release:github"],
    "npm run build && node scripts/prepare-github-release.mjs"
  );
  assert.equal(
    packageJson.scripts?.check,
    "npm run build && node scripts/check-release.mjs"
  );
});

test("cloudflare preflight uses local wrangler and validates src entry directly", async () => {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "cloudflare-preflight.mjs")
  ).href + `?t=${Date.now()}`;
  const module = await import(moduleUrl);

  assert.equal("stripJsonComments" in module, false);
  assert.equal("readJsoncFile" in module, false);
  assert.equal("createWranglerPreflightConfig" in module, false);
  assert.equal(typeof module.createWranglerPreflightInvocation, "function");

  const invocation = module.createWranglerPreflightInvocation({
    cwd: "/repo",
    outDir: "/tmp/preflight"
  });

  assert.match(invocation.command, /\/node_modules\/\.bin\/wrangler(?:\.cmd)?$/);
  assert.deepEqual(invocation.args, [
    "deploy",
    "src/worker-entry.js",
    "--dry-run",
    "--outdir",
    "/tmp/preflight",
    "--config",
    "wrangler.jsonc"
  ]);
  assert.equal(typeof module.createWranglerPreflightEnvironment, "function");
  assert.equal(
    module.createWranglerPreflightEnvironment({ outDir: "/tmp/preflight" }).WRANGLER_LOG_PATH,
    path.join("/tmp/preflight", "logs")
  );
});

test("github release scripts publish and validate dist worker without requiring root snapshot", async () => {
  const prepareSource = await fs.promises.readFile(
    new URL("../scripts/prepare-github-release.mjs", import.meta.url),
    "utf8"
  );
  const checkSource = await fs.promises.readFile(
    new URL("../scripts/check-release.mjs", import.meta.url),
    "utf8"
  );

  assert.match(prepareSource, /copyFile\("dist\/worker\.js"\)/);
  assert.match(prepareSource, /copyFile\("version\.json"\)/);
  assert.doesNotMatch(prepareSource, /worker-v\$\{version\}\.js/);
  assert.match(checkSource, /const distFile = path\.join\(rootDir, "dist", "worker\.js"\);/);
  assert.match(checkSource, /const versionManifestFile = path\.join\(rootDir, "version\.json"\);/);
  assert.doesNotMatch(checkSource, /snapshotFile/);
});

test("redirect whitelist merges fallback and custom domains", () => {
  const config = { redirectWhitelistDomains: ["custom.example.com"] };
  assert.equal(isManualRedirectHost("ap-cn01.emby.bangumi.ca", config.redirectWhitelistDomains), true);
  assert.equal(isManualRedirectHost("sub.custom.example.com", config.redirectWhitelistDomains), true);
  assert.equal(isManualRedirectHost("not-allowed.example.net", config.redirectWhitelistDomains), false);
});

test("prepareNodeContext derives redirect whitelist without proxy wrapper helper", async () => {
  const context = await prepareNodeContext(createRuntimeGlobals(), {
    target: "https://origin.example.test",
    redirectWhitelistEnabled: true
  }, "alpha", "", {
    redirectWhitelistDomains: [" custom.example.com "]
  });

  assert.equal(context.redirectWhitelistEnabled, true);
  assert.deepEqual(context.redirectWhitelistDomains, ["custom.example.com"]);
});

test("prepareNodeContext refreshes cached node headers when node config changes under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const first = await prepareNodeContext(globals, {
    target: "https://origin.example.test",
    headers: {
      "X-Test": "one"
    }
  }, "alpha", "");
  const second = await prepareNodeContext(globals, {
    target: "https://origin.example.test",
    headers: {
      "X-Test": "two"
    }
  }, "alpha", "");

  assert.equal(first.nodeHeaders["X-Test"], "one");
  assert.equal(second.nodeHeaders["X-Test"], "two");
});

test("prepareNodeContext prioritizes active line target order under aligned playback baseline", async () => {
  const context = await prepareNodeContext(createRuntimeGlobals(), {
    lines: [
      { id: "line-1", name: "主线", target: "https://alpha-a.example.test" },
      { id: "line-2", name: "备用", target: "https://alpha-b.example.test" }
    ],
    activeLineId: "line-2"
  }, "alpha", "");

  assert.equal(context.primaryTarget.target, "https://alpha-b.example.test");
  assert.deepEqual(
    context.targetEntries.map(entry => entry.target),
    ["https://alpha-b.example.test", "https://alpha-a.example.test"]
  );
  assert.deepEqual(
    context.nodeTargets,
    ["https://alpha-b.example.test", "https://alpha-a.example.test"]
  );
});

test("normalizeIncomingRequest derives target state without proxy buildTargetRequestState wrapper", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x");
  const targetBase = new URL("https://origin.example.test");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: ""
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/original.mkv", context);

  assert.equal(requestState.activeTargetHost, "origin.example.test");
  assert.equal(requestState.activeFinalUrl.toString(), "https://origin.example.test/videos/1/original.mkv?api_key=x");
});

test("normalizeIncomingRequest enables direct mode and disables prewarm for source-direct nodes under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x", {
    headers: {
      Range: "bytes=0-"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {},
    nodeDirectSource: true,
    enablePrewarm: true,
    prewarmDepth: "poster"
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/original.mkv", context);

  assert.equal(requestState.nodeDirectSource, true);
  assert.equal(requestState.direct307Mode, true);
  assert.equal(requestState.enablePrewarm, false);
  assert.equal(requestState.isMetadataPrewarm, false);
  assert.equal(requestState.prewarmDepth, "poster");
});
test("normalizeIncomingRequest treats PlaybackInfo as api and preserves upstream compression while normalizing Referer under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo?api_key=x", {
    headers: {
      Referer: "https://proxy.example.test/web/index.html",
      "Accept-Encoding": "gzip"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/Items/1/PlaybackInfo", context);

  assert.equal(requestState.basePathChannel, "");
  assert.equal(requestState.isStreaming, false);

  const headers = buildUpstreamHeaders(request, requestState, new URL("https://origin.example.test/emby"));
  assert.equal(headers.get("Referer"), "https://origin.example.test/web/index.html");
  assert.equal(headers.get("Accept-Encoding"), "gzip");
});
test("buildUpstreamHeaders strips Referer for big stream requests under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x", {
    headers: {
      Referer: "https://proxy.example.test/web/index.html"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/original.mkv", context);

  assert.equal(requestState.isBigStream, true);
  assert.equal(requestState.isMetadataPrewarm, false);
  assert.equal(requestState.isManifest, false);
  assert.equal(requestState.isSegment, false);

  const headers = buildUpstreamHeaders(request, requestState, "origin.example.test");
  assert.equal(headers.get("Referer"), null);
});
test("buildUpstreamHeaders strips Referer for startup range requests under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x", {
    headers: {
      Referer: "https://proxy.example.test/web/index.html",
      Range: "bytes=0-65535"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/original.mkv", context);

  assert.equal(requestState.isBigStream, true);
  assert.equal(requestState.isMetadataPrewarm, false);

  const headers = buildUpstreamHeaders(request, requestState, targetBase);
  assert.equal(headers.get("Referer"), null);
});
test("buildUpstreamHeaders keeps Range for subtitle requests under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/subtitles/2/0/Stream.srt?api_key=x", {
    headers: {
      Range: "bytes=0-127",
      Referer: "https://proxy.example.test/web/index.html"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(
    globals,
    request,
    "/videos/1/subtitles/2/0/Stream.srt",
    context
  );

  assert.equal(requestState.isSubtitle, true);
  assert.equal(requestState.isStatic, true);

  const headers = buildUpstreamHeaders(request, requestState, targetBase);
  assert.equal(headers.get("Range"), "bytes=0-127");
});

test("buildUpstreamHeaders merges node custom headers and sanitizes cookies under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest?api_key=x", {
    headers: {
      Cookie: "auth_token=proxy-secret; session=abc",
      Referer: "https://proxy.example.test/web/index.html"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/Users/u/Items/Latest", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase, {
    customHeaders: {
      Cookie: "auth_token=node-secret; node_session=xyz",
      "X-Custom-Token": "node-header"
    }
  });

  assert.equal(headers.get("X-Custom-Token"), "node-header");
  assert.equal(headers.get("Cookie"), "session=abc; node_session=xyz");
});

test("buildUpstreamHeaders preserves admin custom origin and referer overrides under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x", {
    headers: {
      Origin: "https://proxy.example.test",
      Referer: "https://proxy.example.test/web/index.html"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/original.mkv", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase, {
    customHeaders: {
      Origin: "https://special-origin.example.test",
      Referer: "https://special-origin.example.test/player"
    }
  });

  assert.equal(requestState.isBigStream, true);
  assert.equal(headers.get("Origin"), "https://special-origin.example.test");
  assert.equal(headers.get("Referer"), "https://special-origin.example.test/player");
});

test("buildUpstreamHeaders strips Referer for manifest requests under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/master.m3u8?api_key=x", {
    headers: {
      Referer: "https://proxy.example.test/web/index.html"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/videos/1/master.m3u8", context);

  assert.equal(requestState.isManifest, true);
  assert.equal(requestState.isBigStream, false);

  const headers = buildUpstreamHeaders(request, requestState, "origin.example.test");
  assert.equal(headers.get("Referer"), null);
});

test("buildUpstreamHeaders rewrites Origin and Referer to target origin for api requests under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest?api_key=x", {
    headers: {
      Origin: "https://proxy.example.test",
      Referer: "https://proxy.example.test/web/index.html?foo=1"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/Users/u/Items/Latest", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase);

  assert.equal(headers.get("Origin"), "https://origin.example.test");
  assert.equal(headers.get("Referer"), "https://origin.example.test/web/index.html?foo=1");
});

test("buildUpstreamHeaders forwards both real client IP headers by default for node upstream requests", () => {
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest", {
    headers: {
      "cf-connecting-ip": "203.0.113.99"
    }
  });
  const headers = buildUpstreamHeaders(request, {
    requestHost: "proxy.example.test",
    method: "GET",
    lowerPath: "/users/u/items/latest",
    isStreaming: false,
    isStatic: false
  }, "origin.example.test");

  assert.equal(headers.get("X-Real-IP"), "203.0.113.99");
  assert.equal(headers.get("X-Forwarded-For"), "203.0.113.99");
});

test("buildUpstreamHeaders keeps only X-Real-IP in strip mode", () => {
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest", {
    headers: {
      "cf-connecting-ip": "203.0.113.99"
    }
  });
  const headers = buildUpstreamHeaders(request, {
    requestHost: "proxy.example.test",
    method: "GET",
    lowerPath: "/users/u/items/latest",
    isStreaming: false,
    isStatic: false
  }, "origin.example.test", {
    realClientIpMode: "strip"
  });

  assert.equal(headers.get("X-Real-IP"), "203.0.113.99");
  assert.equal(headers.get("X-Forwarded-For"), null);
});

test("buildUpstreamHeaders skips real client IP forwarding when node disables it", () => {
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest", {
    headers: {
      "cf-connecting-ip": "203.0.113.99"
    }
  });
  const headers = buildUpstreamHeaders(request, {
    requestHost: "proxy.example.test",
    method: "GET",
    lowerPath: "/users/u/items/latest",
    isStreaming: false,
    isStatic: false
  }, "origin.example.test", {
    realClientIpMode: "disable"
  });

  assert.equal(headers.get("X-Real-IP"), null);
  assert.equal(headers.get("X-Forwarded-For"), null);
});

test("buildUpstreamHeaders falls back to target origin when Referer is invalid under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest?api_key=x", {
    headers: {
      Referer: "not-a-valid-url"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/Users/u/Items/Latest", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase);

  assert.equal(headers.get("Referer"), "https://origin.example.test/");
});

test("buildUpstreamHeaders forces keep-alive when forceH1 is enabled under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest?api_key=x");
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/Users/u/Items/Latest", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase, { forceH1: true });

  assert.equal(headers.get("Connection"), "keep-alive");
});

test("buildUpstreamHeaders marks websocket upgrades under aligned playback baseline", async () => {
  const globals = createRuntimeGlobals();
  const request = new Request("https://proxy.example.test/alpha/socket", {
    headers: {
      Upgrade: "websocket",
      Connection: "keep-alive"
    }
  });
  const targetBase = new URL("https://origin.example.test/emby");
  const context = {
    proxyPrefix: "/alpha",
    primaryTarget: {
      index: 0,
      target: targetBase.toString(),
      targetBase,
      targetHost: targetBase.host,
      targetBasePath: "/emby"
    },
    targetEntries: [],
    learnedBasePaths: {}
  };

  const requestState = await normalizeIncomingRequest(globals, request, "/socket", context);
  const headers = buildUpstreamHeaders(request, requestState, targetBase);

  assert.equal(requestState.isWsUpgrade, true);
  assert.equal(headers.get("Upgrade"), "websocket");
  assert.equal(headers.get("Connection"), "Upgrade");
});

test("shouldAllowTargetFailover no longer needs a PlaybackInfo special-case", () => {
  assert.equal(shouldAllowTargetFailover({
    lowerPath: "/items/1/playbackinfo",
    isStatic: false,
    isStreaming: false
  }), true);

  assert.equal(shouldAllowTargetFailover({
    lowerPath: "/videos/1/original.mkv",
    isStatic: false,
    isStreaming: true
  }), true);
});

test("playback optimization budget state derives byte range without proxy parser wrapper", () => {
  const budgetState = createPlaybackOptimizationBudgetState(new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
    }
  }));

  assert.deepEqual(budgetState.range, {
    start: PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
    end: null,
    openEnded: true
  });
  assert.equal(budgetState.degraded, true);
});

test("playback optimization budget state allows generic early jumps to skip deep-range degradation", () => {
  const budgetState = createPlaybackOptimizationBudgetState(new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
    }
  }), {
    allowEarlyJumpBudgetRelaxation: true
  });

  assert.deepEqual(budgetState.range, {
    start: PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
    end: null,
    openEnded: true
  });
  assert.equal(budgetState.degraded, false);
  assert.equal(budgetState.shouldBypassWindow, false);
  assert.equal(budgetState.shouldBypassPrime, false);
});

test("playback optimization budget state still degrades oversized bounded ranges during early jump assist", () => {
  const oversizedEnd = PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + PLAYBACK_OPTIMIZATION_MAX_BOUNDED_RANGE_BYTES;
  const budgetState = createPlaybackOptimizationBudgetState(new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-${oversizedEnd}`
    }
  }), {
    allowEarlyJumpBudgetRelaxation: true
  });

  assert.equal(budgetState.degraded, true);
  assert.equal(budgetState.reason, "range");
  assert.equal(budgetState.shouldBypassWindow, true);
});

test("proxy handle answers CORS preflight requests", async () => {
  const request = new Request("https://proxy.example.test/dongying/emby/System/Ping", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Emby-Token, Range"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "https://media.example.test/emby" },
    "/emby/System/Ping",
    "dongying",
    "",
    null,
    null
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.match(response.headers.get("Access-Control-Allow-Methods") || "", /OPTIONS/);
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Emby-Token, Range");
  assert.equal(response.headers.get("Access-Control-Max-Age"), "86400");
});

test("proxy handle answers CORS preflight requests without proxy renderCors wrapper", async () => {
  const request = new Request("https://proxy.example.test/dongying/emby/System/Ping", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Emby-Token, Range"
    }
  });

  const proxy = { ...Proxy };
  delete proxy.renderCors;

  const response = await Proxy.handle.call(
    proxy,
    request,
    { target: "https://media.example.test/emby" },
    "/emby/System/Ping",
    "dongying",
    "",
    null,
    null
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.match(response.headers.get("Access-Control-Allow-Methods") || "", /OPTIONS/);
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Emby-Token, Range");
  assert.equal(response.headers.get("Access-Control-Max-Age"), "86400");
});

test("proxy handle resolves configured cors origin under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/dongying/emby/System/Ping", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Emby-Token, Range"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "https://media.example.test/emby" },
    "/emby/System/Ping",
    "dongying",
    "",
    {
      corsOrigins: "https://app.example.test, https://tv.example.test"
    },
    null
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Emby-Token, Range");
  assert.match(response.headers.get("Vary") || "", /Origin/);
});

test("proxy handle answers preflight before invalid node validation under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Ping", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Emby-Token"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "::not-a-valid-url::" },
    "/System/Ping",
    "alpha",
    "",
    {
      corsOrigins: "https://app.example.test"
    },
    null
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Access-Control-Max-Age"), "86400");
});

test("proxy handle blocks ip blacklist under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Ping", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "203.0.113.9"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test/emby" },
    "/System/Ping",
    "alpha",
    "",
    {
      corsOrigins: "https://app.example.test",
      ipBlacklist: "203.0.113.9"
    },
    null
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden by IP Firewall");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("proxy handle applies ip firewall before invalid node validation under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Ping", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "203.0.113.9"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "::not-a-valid-url::" },
    "/System/Ping",
    "alpha",
    "",
    {
      corsOrigins: "https://app.example.test",
      ipBlacklist: "203.0.113.9"
    },
    null
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden by IP Firewall");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle blocks geo restricted requests under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Ping", {
    headers: {
      Origin: "https://app.example.test",
      "cf-connecting-ip": "198.51.100.20"
    }
  });
  Object.defineProperty(request, "cf", {
    value: { country: "HK" },
    configurable: true
  });

  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test/emby" },
    "/System/Ping",
    "alpha",
    "",
    {
      geoAllowlist: "US, JP"
    },
    null
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden by Geo Firewall");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("proxy handle rate limits repeated api requests under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  };

  const runtimeConfig = {
    corsOrigins: "https://app.example.test",
    rateLimitRpm: 1
  };
  const firstRequest = new Request("https://proxy.example.test/alpha/System/Info", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "198.51.100.10"
    }
  });
  const secondRequest = new Request("https://proxy.example.test/alpha/System/Info", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "198.51.100.10"
    }
  });

  const firstResponse = await Proxy.handle(
    firstRequest,
    { target: "https://origin.example.test/emby" },
    "/System/Info",
    "alpha",
    "",
    runtimeConfig,
    null
  );
  const secondResponse = await Proxy.handle(
    secondRequest,
    { target: "https://origin.example.test/emby" },
    "/System/Info",
    "alpha",
    "",
    runtimeConfig,
    null
  );

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 429);
  assert.equal(await secondResponse.text(), "Rate Limit Exceeded");
  assert.equal(secondResponse.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(secondResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(calls, 1);
});

test("proxy handle rate limits before invalid node validation under aligned playback baseline", async () => {
  resetGlobals();

  const runtimeConfig = {
    corsOrigins: "https://app.example.test",
    rateLimitRpm: 1
  };
  const firstRequest = new Request("https://proxy.example.test/alpha/System/Info", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "198.51.100.11"
    }
  });
  const secondRequest = new Request("https://proxy.example.test/alpha/System/Info", {
    headers: {
      Origin: "https://evil.example.test",
      "cf-connecting-ip": "198.51.100.11"
    }
  });

  const firstResponse = await Proxy.handle(
    firstRequest,
    { target: "::not-a-valid-url::" },
    "/System/Info",
    "alpha",
    "",
    runtimeConfig,
    null
  );
  const secondResponse = await Proxy.handle(
    secondRequest,
    { target: "::not-a-valid-url::" },
    "/System/Info",
    "alpha",
    "",
    runtimeConfig,
    null
  );

  assert.equal(firstResponse.status, 502);
  assert.equal(secondResponse.status, 429);
  assert.equal(await secondResponse.text(), "Rate Limit Exceeded");
  assert.equal(secondResponse.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle returns aligned bad gateway json when all upstream attempts fail", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error("origin offline");
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Origin: "https://app.example.test"
    }
  });

  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test/emby" },
    "/videos/1/original.mkv",
    "alpha",
    "",
    null,
    null
  );

  assert.equal(response.status, 502);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/i);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Proxy-Route"), "passthrough");
  const payload = await response.json();
  assert.deepEqual(payload, {
    error: "Bad Gateway",
    code: 502,
    message: "All proxy attempts failed."
  });
});

test("proxy handle returns invalid node target response under aligned playback baseline", async () => {
  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/System/Ping", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "::not-a-valid-url::" },
    "/System/Ping",
    "alpha",
    "",
    null,
    null
  );

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Invalid Node Target");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("proxy handle redirects static assets directly when directStaticAssets is enabled under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response("body { color: red; }", {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Content-Length": "20"
    }
  });

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/web/main.css?v=1", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "https://origin.example.test/emby" },
    "/web/main.css",
    "alpha",
    "",
    {
      directStaticAssets: true
    },
    null
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), "https://origin.example.test/web/main.css?v=1");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(await response.text(), "");
});

test("proxy handle redirects hls manifests directly when directHlsDash is enabled under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response("#EXTM3U\n", {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Content-Length": "8"
    }
  });

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/master.m3u8?api_key=x", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "https://origin.example.test/emby" },
    "/videos/1/master.m3u8",
    "alpha",
    "",
    {
      directHlsDash: true
    },
    null
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), "https://origin.example.test/videos/1/master.m3u8?api_key=x");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(await response.text(), "");
});

test("proxy handle redirects source-direct nodes under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("stream", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "6"
      }
    });
  };

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    {
      name: "alpha",
      target: "https://origin.example.test/emby"
    },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {
      sourceDirectNodes: ["alpha"]
    },
    null
  );

  assert.deepEqual(calls, ["https://origin.example.test/videos/1/original.mkv?api_key=x"]);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), "https://origin.example.test/videos/1/original.mkv?api_key=x");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle keeps legacy source-direct node name config working after path-based routing", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("stream", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "6"
      }
    });
  };

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/dongying/videos/1/original.mkv?api_key=x", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    {
      name: "东影",
      path: "dongying",
      target: "https://origin.example.test/emby"
    },
    "/videos/1/original.mkv",
    "dongying",
    "",
    {
      sourceDirectNodes: ["东影"]
    },
    null
  );

  assert.deepEqual(calls, ["https://origin.example.test/videos/1/original.mkv?api_key=x"]);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), "https://origin.example.test/videos/1/original.mkv?api_key=x");
});

test("proxy handle exposes external redirect when forceExternalProxy is disabled under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://origin.example.test/videos/1/original.mkv") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file.mkv"
        }
      });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  };

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "https://origin.example.test/emby" },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {
      forceExternalProxy: false
    },
    null
  );

  assert.deepEqual(calls, ["https://origin.example.test/videos/1/original.mkv"]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://cdn.example.test/file.mkv");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle exposes same-origin redirect when sourceSameOriginProxy is disabled under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://origin.example.test/videos/1/playback?api_key=x") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://origin.example.test/emby/videos/1/master.m3u8?api_key=x"
        }
      });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  };

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/playback?api_key=x", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "https://origin.example.test/emby" },
    "/videos/1/playback",
    "alpha",
    "",
    {
      sourceSameOriginProxy: false
    },
    null
  );

  assert.deepEqual(calls, ["https://origin.example.test/videos/1/playback?api_key=x"]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://origin.example.test/emby/videos/1/master.m3u8?api_key=x");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle exposes wangpan external redirect only when site whitelist is enabled", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://origin.example.test/videos/1/original.mkv") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://download.aliyundrive.com/file.mkv"
        }
      });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  };

  const response = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
      headers: {
        Origin: "https://app.example.test"
      }
    }),
    { target: "https://origin.example.test/emby", redirectWhitelistEnabled: true },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {
      forceExternalProxy: true,
      wangpandirect: "aliyundrive"
    },
    null
  );

  assert.deepEqual(calls, ["https://origin.example.test/videos/1/original.mkv"]);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://download.aliyundrive.com/file.mkv");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("proxy handle proxies websocket upgrades through upstream 101 under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  const originalResponse = globalThis.Response;

  class FakeResponse {
    constructor(body, init = {}) {
      this.body = body ?? null;
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? "";
      this.headers = init.headers instanceof Headers ? new Headers(init.headers) : new Headers(init.headers || {});
      this.webSocket = init.webSocket;
    }
  }

  globalThis.Response = FakeResponse;
  globalThis.fetch = async () => ({
    status: 101,
    statusText: "Switching Protocols",
    headers: new Headers({
      Upgrade: "websocket"
    }),
    body: null,
    webSocket: { id: "upstream-ws" }
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.Response = originalResponse;
  });

  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };

  const request = new Request("https://proxy.example.test/alpha/socket", {
    headers: {
      Upgrade: "websocket",
      Origin: "https://app.example.test"
    }
  });
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/socket",
    "alpha",
    "",
    {},
    executionContext
  );

  assert.equal(response.status, 101);
  assert.equal(response.webSocket.id, "upstream-ws");
  assert.equal(response.headers.get("Upgrade"), "websocket");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("X-Proxy-Route"), "passthrough");
});

test("admin API exposes playback optimization stats", async () => {
  GLOBALS.PlaybackOptimizationStats.redirect.followed = 2;
  GLOBALS.PlaybackOptimizationStats.redirect.cache = 3;
  GLOBALS.PlaybackOptimizationStats.updatedAt = "2026-03-11T00:00:00.000Z";

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "playbackOptimizationStats"
    })
  });

  const env = {
    ENI_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [] }; }
    }
  };

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.redirect.followed, 2);
  assert.equal(payload.redirect.cache, 3);
  assert.equal(payload.updatedAt, "2026-03-11T00:00:00.000Z");
  assert.equal("metadataJson" in payload, false);
});

test("proxy handle tracks budget-degraded playback requests in stats", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const rangeStart = PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES;
  globalThis.fetch = async () => new Response("media", {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": "5",
      "Content-Range": `bytes ${rangeStart}-${rangeStart + 4}/9999999`
    }
  });

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Range: `bytes=${rangeStart}-`
    }
  });
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("X-Proxy-Route"), "budget-degraded-passthrough");
  assert.equal(GLOBALS.PlaybackOptimizationStats.budget.degraded, 1);
});

test("proxy handle preserves route and debug diagnostics for deep-range upstream 503 responses", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const rangeStart = PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES;
  globalThis.fetch = async () => new Response("busy", {
    status: 503,
    headers: {
      "Content-Type": "video/mp4"
    }
  });

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1", {
    headers: {
      Range: `bytes=${rangeStart}-`
    }
  });
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/videos/1/original.mkv",
    "alpha",
    {
      debugProxyHeaders: true
    },
    {}
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Proxy-Route"), "budget-degraded-passthrough");
  assert.equal(response.headers.get("X-Proxy-Upstream-Status"), "503");
  assert.equal(response.headers.get("X-Proxy-Debug-Reason"), "status-503");
});

test("proxy handle suppresses completion-like stopped callbacks immediately after deep-range playback failure", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method || "GET").toUpperCase()
    });
    if (String(url).includes("/videos/1/original.mkv")) {
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    return new Response(null, { status: 204 });
  };

  const rangeStart = PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES;
  const mediaResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-stop-1&MediaSourceId=ms-1", {
      headers: {
        Range: `bytes=${rangeStart}-`
      }
    }),
    { target: "https://origin.example.test" },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {}
  );
  assert.equal(mediaResponse.status, 503);

  const progressResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/Sessions/Playing/Progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        PlaySessionId: "play-stop-1",
        PositionTicks: 120,
        RunTimeTicks: 120
      })
    }),
    { target: "https://origin.example.test" },
    "/Sessions/Playing/Progress",
    "alpha",
    "",
    {}
  );
  assert.equal(progressResponse.status, 204);

  const stoppedResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/Sessions/Playing/Stopped", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        PlaySessionId: "play-stop-1",
        PositionTicks: 120
      })
    }),
    { target: "https://origin.example.test" },
    "/Sessions/Playing/Stopped",
    "alpha",
    "",
    {}
  );

  assert.equal(stoppedResponse.status, 204);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1)?.url.includes("/Sessions/Playing/Stopped"), false);
});

test("proxy handle still forwards partial stopped callbacks after deep-range playback failure", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method || "GET").toUpperCase()
    });
    if (String(url).includes("/videos/2/original.mkv")) {
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    return new Response(null, { status: 204 });
  };

  const rangeStart = PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES;
  const mediaResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/videos/2/original.mkv?PlaySessionId=play-stop-2&MediaSourceId=ms-2", {
      headers: {
        Range: `bytes=${rangeStart}-`
      }
    }),
    { target: "https://origin.example.test" },
    "/videos/2/original.mkv",
    "alpha",
    "",
    {}
  );
  assert.equal(mediaResponse.status, 503);

  const progressResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/Sessions/Playing/Progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        PlaySessionId: "play-stop-2",
        PositionTicks: 60,
        RunTimeTicks: 120
      })
    }),
    { target: "https://origin.example.test" },
    "/Sessions/Playing/Progress",
    "alpha",
    "",
    {}
  );
  assert.equal(progressResponse.status, 204);

  const stoppedResponse = await Proxy.handle(
    new Request("https://proxy.example.test/alpha/Sessions/Playing/Stopped", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        PlaySessionId: "play-stop-2",
        PositionTicks: 80
      })
    }),
    { target: "https://origin.example.test" },
    "/Sessions/Playing/Stopped",
    "alpha",
    "",
    {}
  );

  assert.equal(stoppedResponse.status, 204);
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1)?.url.includes("/Sessions/Playing/Stopped"), true);
});

test("proxy handle serves tagged image requests through the lightweight image branch with stronger cache headers", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response("image-bytes", {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "CF-Cache-Status": "HIT"
    }
  });

  const request = new Request("https://proxy.example.test/alpha/Items/1/Images/Primary?tag=demo", {
    headers: {
      Origin: "https://app.example.test"
    }
  });
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/Items/1/Images/Primary",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=2592000, stale-while-revalidate=86400, immutable");
  assert.equal(response.headers.get("X-Emby-Proxy-Cache"), "HIT");
  assert.equal(response.headers.get("X-Proxy-Route"), "passthrough");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
});

test("normalizeIndependentImageRequest keeps image requests out of learned basepath state", async () => {
  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  context.learnedBasePaths = {
    apiBasePath: "/emby",
    mediaBasePath: "/emby"
  };
  const request = new Request("https://proxy.example.test/alpha/Items/1/Images/Primary?tag=demo");
  const requestState = await normalizeIndependentImageRequest(GLOBALS, request, "/Items/1/Images/Primary", context);

  assert.equal(requestState.basePathChannel, "");
  assert.equal(requestState.learnedBasePath, "");
  assert.equal(requestState.usedCachedBasePath, false);
  assert.equal(requestState.activeFinalUrl.pathname, "/Items/1/Images/Primary");
});

test("dispatchIndependentImageUpstream keeps image redirects out of playback optimization stats", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/Items/1/Images/Primary?tag=demo") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/poster.jpg"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/poster.jpg") {
      return new Response("img", {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Items/1/Images/Primary?tag=demo");
  const requestState = await normalizeIndependentImageRequest(GLOBALS, request, "/Items/1/Images/Primary", context);
  const diagnostics = createDiagnostics("/Items/1/Images/Primary", requestState);
  diagnostics.skipPlaybackStats = true;

  const upstream = await dispatchIndependentImageUpstream({
    request,
    requestState,
    context,
    diagnostics
  });
  const response = finalizeDiagnostics(GLOBALS, upstream.response, diagnostics, request);

  assert.equal(upstream.route, "followed");
  assert.equal(response.headers.get("X-Proxy-Route"), "followed");
  assert.equal(GLOBALS.PlaybackOptimizationStats.redirect.followed, 0);
  assert.deepEqual(calls, [
    "https://origin.example.test/Items/1/Images/Primary?tag=demo",
    "https://cdn.example.test/poster.jpg"
  ]);
});

test("proxy handle keeps image 404 requests out of basepath fallback and playback stats", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("missing", {
      status: 404,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  };

  const request = new Request("https://proxy.example.test/alpha/Items/1/Images/Primary?tag=demo");
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/Items/1/Images/Primary",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Proxy-Route"), "passthrough");
  assert.deepEqual(calls, ["https://origin.example.test/Items/1/Images/Primary?tag=demo"]);
  assert.equal(GLOBALS.PlaybackOptimizationStats.basepath.cache, 0);
  assert.equal(GLOBALS.PlaybackOptimizationStats.basepath.fallback, 0);
});

test("finalizeDiagnostics counts basepath stats for budget-decorated routes", () => {
  resetGlobals();
  const response = finalizeDiagnostics(
    GLOBALS,
    new Response("ok", { status: 200 }),
    { route: "budget-degraded-basepath-cache" },
    new Request("https://proxy.example.test/alpha/videos/1/original.mkv")
  );

  assert.equal(response.headers.get("X-Proxy-Route"), "budget-degraded-basepath-cache");
  assert.equal(GLOBALS.PlaybackOptimizationStats.basepath.cache, 1);
});

test("finalizeDiagnostics can skip playback stats for non-playback routes", () => {
  resetGlobals();
  const response = finalizeDiagnostics(
    GLOBALS,
    new Response("ok", { status: 200 }),
    { route: "followed", skipPlaybackStats: true },
    new Request("https://proxy.example.test/alpha/Items/1/Images/Primary")
  );

  assert.equal(response.headers.get("X-Proxy-Route"), "followed");
  assert.equal(GLOBALS.PlaybackOptimizationStats.redirect.followed, 0);
});

test("admin API save accepts line-based nodes without legacy targets", async () => {
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "save",
      name: "alpha",
      lines: [
        { name: "主线", target: "https://a.example.test/" },
        { name: "备用", target: "http://b.example.test" }
      ],
      headers: {
        "X-Test": "1"
      }
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();
  const saved = JSON.parse(store.get("node:alpha"));

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(saved.target, "https://a.example.test");
  assert.deepEqual(saved.targets, ["https://a.example.test", "http://b.example.test"]);
  assert.equal(saved.activeLineId, "line-1");
  assert.deepEqual(saved.lines, [
    {
      id: "line-1",
      name: "主线",
      target: "https://a.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    },
    {
      id: "line-2",
      name: "备用",
      target: "http://b.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    }
  ]);
  assert.deepEqual(saved.headers, { "X-Test": "1" });
});

test("admin API save keeps site edits available through subsequent list reads", async () => {
  resetGlobals();
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  const saveResponse = await handleAdminApiRequest(new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "save",
      name: "手机版站点",
      path: "mobile",
      remark: "移动端验证",
      tag: "手机",
      redirectWhitelistEnabled: true,
      lines: [
        { name: "主线", target: "https://mobile-a.example.test/" },
        { name: "备用", target: "https://mobile-b.example.test/" }
      ],
      headers: {
        "X-Mobile": "1"
      }
    })
  }), env);

  assert.equal(saveResponse.status, 200);

  const listResponse = await handleAdminApiRequest(new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "list"
    })
  }), env);
  const payload = await listResponse.json();
  const savedNode = payload.nodes.find(item => item.path === "mobile");

  assert.equal(listResponse.status, 200);
  assert.ok(savedNode);
  assert.equal(savedNode.name, "手机版站点");
  assert.equal(savedNode.remark, "移动端验证");
  assert.equal(savedNode.tag, "手机");
  assert.equal(savedNode.redirectWhitelistEnabled, true);
  assert.equal(savedNode.realClientIpMode, "forward");
  assert.deepEqual(savedNode.targets, [
    "https://mobile-a.example.test",
    "https://mobile-b.example.test"
  ]);
  assert.deepEqual(savedNode.headers, { "X-Mobile": "1" });
});

test("admin API import defaults missing real client IP mode to forward", async () => {
  resetGlobals();
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  const importResponse = await handleAdminApiRequest(new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "import",
      nodes: [
        {
          name: "旧版站点",
          path: "legacy-node",
          target: "https://legacy.example.test/"
        }
      ]
    })
  }), env);

  assert.equal(importResponse.status, 200);

  const listResponse = await handleAdminApiRequest(new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "list"
    })
  }), env);
  const payload = await listResponse.json();
  const savedNode = payload.nodes.find(item => item.path === "legacy-node");

  assert.ok(savedNode);
  assert.equal(savedNode.realClientIpMode, "forward");
});

test("admin API import accepts line-based nodes and config payload", async () => {
  const store = new Map();
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "import",
      nodes: [
        {
          name: "beta",
          lines: [
            { name: "主线", target: "https://beta-a.example.test/" },
            { name: "备用", target: "https://beta-b.example.test/" }
          ],
          headers: {
            "X-Test": "2"
          }
        }
      ],
      config: {
        enablePrewarm: false,
        directSourceNodes: [" beta "]
      }
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();
  const savedNode = JSON.parse(store.get("node:beta"));
  const savedConfig = JSON.parse(store.get("sys:theme"));

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(savedNode.target, "https://beta-a.example.test");
  assert.deepEqual(savedNode.targets, ["https://beta-a.example.test", "https://beta-b.example.test"]);
  assert.equal(savedNode.activeLineId, "line-1");
  assert.deepEqual(savedNode.headers, { "X-Test": "2" });
  assert.equal(savedConfig.enablePrewarm, false);
  assert.deepEqual(savedConfig.sourceDirectNodes, ["beta"]);
});

test("admin API list normalizes mixed legacy and line-based nodes", async () => {
  resetGlobals();
  const store = new Map([
    ["node:legacy", JSON.stringify({
      target: "https://legacy.example.test/",
      targets: ["https://legacy.example.test/", "https://legacy-b.example.test/"],
      headers: {
        "X-Test": "legacy"
      }
    })],
    ["node:gamma", JSON.stringify({
      lines: [
        { name: "主线", target: "https://gamma-a.example.test/" },
        { name: "备用", target: "https://gamma-b.example.test/" }
      ],
      activeLineId: "line-2",
      headers: {
        "X-Test": "gamma"
      }
    })]
  ]);
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  await rememberRecentNodeUsage(GLOBALS, "gamma", null, Date.parse("2026-03-18T10:00:00.000Z"));

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "list"
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();
  const nodesByName = Object.fromEntries(payload.nodes.map(node => [node.name, node]));

  assert.equal(response.status, 200);
  assert.equal(payload.nodeActivityAvailable, true);
  assert.equal(payload.nodeActivity.gamma.lastSeenAt, "2026-03-18T10:00:00.000Z");
  assert.equal(payload.nodeActivity.gamma.requests, 1);
  assert.deepEqual(nodesByName.legacy.targets, ["https://legacy.example.test", "https://legacy-b.example.test"]);
  assert.equal(nodesByName.legacy.target, "https://legacy.example.test");
  assert.equal(nodesByName.legacy.activeLineId, "line-1");
  assert.deepEqual(nodesByName.legacy.lines, [
    {
      id: "line-1",
      name: "线路1",
      target: "https://legacy.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    },
    {
      id: "line-2",
      name: "线路2",
      target: "https://legacy-b.example.test",
      latencyMs: null,
      latencyUpdatedAt: ""
    }
  ]);
  assert.equal(nodesByName.gamma.target, "https://gamma-a.example.test");
  assert.equal(nodesByName.gamma.activeLineId, "line-2");
  assert.deepEqual(nodesByName.gamma.headers, { "X-Test": "gamma" });
});

test("admin ui homepage init parallelizes config and list loading while hydrating recent usage from list payload", async () => {
  const source = await fs.promises.readFile(new URL("../src/admin/ui/admin-script.js", import.meta.url), "utf8");
  const requestListMatch = source.match(/async requestNodeList\(\)\{([\s\S]*?)\},\s*applyNodeListPayload\(/);
  const applyListMatch = source.match(/applyNodeListPayload\(data,silent=false\)\{([\s\S]*?)\},\s*cancelInitialCfMetricsLoad\(/);
  const cancelInitialMatch = source.match(/cancelInitialCfMetricsLoad\(\)\{([\s\S]*?)\},\s*scheduleInitialCfMetricsLoad\(/);
  const scheduleInitialMatch = source.match(/scheduleInitialCfMetricsLoad\(\)\{([\s\S]*?)\},\s*async refresh\(/);
  const refreshMatch = source.match(/async refresh\(silent=false\)\{([\s\S]*?)\},\s*median\(/);
  const initMatch = source.match(/async init\(\)\{([\s\S]*?)\},\s*async loadConfig\(/);

  assert.ok(requestListMatch, "expected requestNodeList function source");
  assert.ok(applyListMatch, "expected applyNodeListPayload function source");
  assert.ok(cancelInitialMatch, "expected cancelInitialCfMetricsLoad function source");
  assert.ok(scheduleInitialMatch, "expected scheduleInitialCfMetricsLoad function source");
  assert.ok(refreshMatch, "expected refresh function source");
  assert.ok(initMatch, "expected init function source");
  assert.match(requestListMatch[1], /const res=await fetch\('\/admin',\{method:'POST',body:JSON\.stringify\(\{action:'list'\}\)\}\);/);
  assert.match(requestListMatch[1], /const data=await res\.json\(\)\.catch\(\(\)=>\(\{\}\)\);/);
  assert.match(requestListMatch[1], /if\(!res\.ok\|\|data\.error\)throw new Error\(data\.error\|\|'加载节点列表失败'\);/);
  assert.match(applyListMatch[1], /const nextActivityMap=\(data&&typeof data\.nodeActivity==='object'\)\?data\.nodeActivity:\{\};/);
  assert.match(applyListMatch[1], /this\.nodeActivityData=\{nodeActivityAvailable:nextAvailable,nodeActivity:nextActivityMap,generatedAt:data\.generatedAt\|\|''\};/);
  assert.doesNotMatch(applyListMatch[1], /this\.loadCfMetrics\(true\)\.catch\(\(\)=>\{\}\);/);
  assert.match(applyListMatch[1], /this\.cancelInitialCfMetricsLoad\(\);/);
  assert.match(cancelInitialMatch[1], /clearTimeout\(this\.initialCfMetricsTimer\);/);
  assert.match(scheduleInitialMatch[1], /this\.initialCfMetricsTimer=setTimeout\(\(\)=>\{this\.initialCfMetricsTimer=null;this\.loadCfMetrics\(true\)\.catch\(\(\)=>\{\}\);\},180\);/);
  assert.match(refreshMatch[1], /const data=await this\.requestNodeList\(\);/);
  assert.match(refreshMatch[1], /this\.applyNodeListPayload\(data,silent\);/);
  assert.doesNotMatch(refreshMatch[1], /this\.loadNodeActivity\(true\)\.catch\(\(\)=>\{\}\);/);
  assert.match(initMatch[1], /const listPromise=this\.requestNodeList\(\);/);
  assert.match(initMatch[1], /await this\.loadConfig\(\);/);
  assert.match(initMatch[1], /this\.applyNodeListPayload\(await listPromise,true\);/);
  assert.match(initMatch[1], /this\.scheduleInitialCfMetricsLoad\(\);/);
  assert.doesNotMatch(initMatch[1], /await this\.loadClientRtt\(true\)/);
});

test("admin api list avoids cache storage fan-out for larger node sets", async t => {
  resetGlobals();
  const originalCache = globalThis.caches.default;
  const matchCalls = [];
  globalThis.caches.default = {
    ...createCacheFacade(),
    async match(url) {
      matchCalls.push(String(url));
      throw new Error("unexpected recent-usage cache lookup");
    }
  };
  t.after(() => {
    globalThis.caches.default = originalCache;
  });

  const store = new Map();
  const keys = [];
  for (let index = 1; index <= 21; index++) {
    const pathName = `node-${index}`;
    keys.push({ name: `node:${pathName}` });
    store.set(`node:${pathName}`, JSON.stringify({
      name: `节点${index}`,
      target: `https://${pathName}.example.test/`
    }));
  }
  const env = {
    ENI_KV: {
      async list() {
        return { keys };
      },
      async get(key, options = {}) {
        const value = store.get(key);
        if (!value) return null;
        return options.type === "json" ? JSON.parse(value) : value;
      }
    }
  };

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "list"
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.nodes.length, 21);
  assert.equal(payload.nodeActivityAvailable, false);
  assert.deepEqual(matchCalls, []);
});

test("followRedirectChain does not bypass disabled site whitelist with built-in redirect terms", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("ok", { status: 200, headers: { "Content-Type": "video/mp4" } });
  };

  const result = await followRedirectChain({
    initialResponse: new Response(null, {
      status: 302,
      headers: { Location: "https://tenant.sharepoint.cn/file.mkv" }
    }),
    initialUrl: new URL("https://origin.example.test/videos/1/original.mkv"),
    targetHost: "origin.example.test",
    redirectWhitelistEnabled: false,
    redirectWhitelistDomains: [],
    baseHeaders: new Headers(),
    method: "GET",
    hasBody: false,
    getReplayBody: async () => null,
    cf: {},
    nodeName: "alpha",
    nodeTarget: "https://origin.example.test",
    context: {
      forceExternalProxy: true,
      wangpanDirectKeywords: ""
    }
  });

  assert.equal(result.route, "followed");
  assert.equal(result.response?.status, 200);
  assert.deepEqual(calls, ["https://tenant.sharepoint.cn/file.mkv"]);
});

test("followRedirectChain still directs configured whitelist hosts when site whitelist is enabled", async () => {
  const result = await followRedirectChain({
    initialResponse: new Response(null, {
      status: 302,
      headers: { Location: "https://media.ctyun.cn/file.mkv" }
    }),
    initialUrl: new URL("https://origin.example.test/videos/2/original.mkv"),
    targetHost: "origin.example.test",
    redirectWhitelistEnabled: true,
    redirectWhitelistDomains: ["ctyun.cn", "ctyunxs.cn"],
    baseHeaders: new Headers(),
    method: "GET",
    hasBody: false,
    getReplayBody: async () => null,
    cf: {},
    nodeName: "beta",
    nodeTarget: "https://origin.example.test",
    context: {
      forceExternalProxy: true,
      wangpanDirectKeywords: ""
    }
  });

  assert.equal(result.route, "direct-whitelist");
  assert.equal(result.response?.headers.get("Location"), "https://media.ctyun.cn/file.mkv");
});

test("redirect policy uses unified default redirect rule source without local wangpan fallback constant", async () => {
  const source = await fs.promises.readFile(new URL("../src/proxy/routing/redirect-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DEFAULT_WANGPAN_DIRECT_TERMS/);
});

test("redirect default term preset is externalized and manual host subset remains derived", async () => {
  const source = await fs.promises.readFile(new URL("../src/config/defaults.js", import.meta.url), "utf8");

  assert.match(source, /from "\.\/default-redirect-rule-terms\.js"/);
  assert.deepEqual(DEFAULT_REDIRECT_RULE_TERMS, DEFAULT_REDIRECT_RULE_TERM_PRESET);
  assert.ok(DEFAULT_REDIRECT_RULE_TERMS.includes("quark.cn"));
  assert.ok(MANUAL_REDIRECT_DOMAINS.includes("ctyun.cn"));
});

test("admin API tcping by node name updates line latency ordering under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = new Map([
    ["node:alpha", JSON.stringify({
      lines: [
        { id: "line-1", name: "主线", target: "https://alpha-a.example.test" },
        { id: "line-2", name: "备用", target: "https://alpha-b.example.test" }
      ],
      activeLineId: "line-1"
    })],
    [CONFIG_STORAGE_KEY, JSON.stringify(normalizeConfig({
      pingTimeout: 5000,
      pingCacheMinutes: 0
    }))]
  ]);
  const env = {
    ENI_KV: {
      async get(key, options = {}) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return options.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, String(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }))
        };
      }
    }
  };

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method, "HEAD");
    if (String(url).includes("alpha-a.example.test")) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(null, { status: 200 });
    }
    if (String(url).includes("alpha-b.example.test")) {
      await new Promise(resolve => setTimeout(resolve, 1));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const request = new Request("https://proxy.example.test/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "tcping",
      name: "alpha",
      forceRefresh: true
    })
  });

  const response = await handleAdminApiRequest(request, env);
  const payload = await response.json();
  const saved = JSON.parse(store.get("node:alpha"));

  assert.equal(response.status, 200);
  assert.equal(payload.activeLineId, "line-2");
  assert.equal(payload.activeLineName, "备用");
  assert.equal(saved.activeLineId, "line-2");
  assert.equal(saved.lines[0].id, "line-2");
  assert.equal(saved.lines[1].id, "line-1");
  assert.ok(Number.isFinite(saved.lines[0].latencyMs));
  assert.ok(Number.isFinite(saved.lines[1].latencyMs));
  assert.match(saved.lines[0].latencyUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(saved.lines[1].latencyUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("response header policy applies security/static cache headers and handles cache status", () => {
  const headers = new Headers({
    Vary: "Accept-Encoding",
    "Set-Cookie": "k=v"
  });
  applyBaseProxySecurityHeaders(headers);
  applyStaticStreamingCacheHeaders(headers, {
    isStatic: true,
    isImage: false,
    isStaticFile: true,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: false
  }, "HIT");

  assert.equal(headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(headers.get("Referrer-Policy"), "origin-when-cross-origin");
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=15552000; preload");
  assert.equal(headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-XSS-Protection"), "1; mode=block");
  assert.equal(headers.get("X-Powered-By"), null);
  assert.equal(headers.get("Vary"), "Accept-Encoding");
  assert.equal(headers.get("Set-Cookie"), "k=v");
  assert.equal(headers.get("Cache-Control"), "public, max-age=86400");
  assert.equal(headers.get("X-Emby-Proxy-Cache"), "HIT");
});

test("response header policy applies dynamic proxy cors headers under aligned playback baseline", () => {
  const headers = new Headers();
  applyBaseProxySecurityHeaders(headers);
  applyProxyCorsHeaders(headers, new Request("https://proxy.example.test/alpha/System/Ping", {
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Headers": "X-Emby-Token, Range"
    }
  }));

  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(headers.get("Access-Control-Allow-Headers"), "X-Emby-Token, Range");
  assert.match(headers.get("Access-Control-Allow-Methods") || "", /OPTIONS/);
  assert.equal(headers.get("Access-Control-Expose-Headers"), "Content-Length, Content-Range, X-Emby-Auth-Token");
  assert.match(headers.get("Vary") || "", /Origin/);
  assert.match(headers.get("Vary") || "", /Access-Control-Request-Headers/);
});

test("response header policy covers image static and generic streaming passthrough branches", () => {
  const imageHeaders = new Headers({
    "X-Emby-Proxy-Cache": "MISS"
  });
  applyStaticStreamingCacheHeaders(imageHeaders, {
    isStatic: true,
    isImage: true,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: true,
    isStreaming: false,
    activeFinalUrl: new URL("https://origin.example.test/Items/1/Images/Primary?tag=demo")
  });
  assert.equal(imageHeaders.get("Cache-Control"), "public, max-age=2592000, stale-while-revalidate=86400, immutable");
  assert.equal(imageHeaders.get("X-Emby-Proxy-Cache"), null);

  const headImageHeaders = new Headers({
    Vary: "Accept-Encoding",
    "Set-Cookie": "k=v"
  });
  applyStaticStreamingCacheHeaders(headImageHeaders, {
    isStatic: false,
    isImage: true,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: false,
    activeFinalUrl: new URL("https://origin.example.test/Items/2/Images/Primary")
  }, "HIT");
  assert.equal(headImageHeaders.get("Cache-Control"), "public, max-age=2592000, stale-while-revalidate=86400");
  assert.equal(headImageHeaders.get("Vary"), "Accept-Encoding");
  assert.equal(headImageHeaders.get("Set-Cookie"), "k=v");
  assert.equal(headImageHeaders.get("X-Emby-Proxy-Cache"), "HIT");

  const streamingHeaders = new Headers();
  applyStaticStreamingCacheHeaders(streamingHeaders, {
    isStatic: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: true,
    isManifest: false,
    isMetadataPrewarm: false,
    isBigStream: false
  });
  assert.equal(streamingHeaders.get("Cache-Control"), null);
});

test("response header policy keeps manifest responses conservative while preserving image and stream cache semantics", () => {
  const manifestHeaders = new Headers();
  applyStaticStreamingCacheHeaders(manifestHeaders, {
    isStatic: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: true,
    isManifest: true,
    isMetadataPrewarm: false,
    isBigStream: false
  });
  assert.equal(manifestHeaders.get("Cache-Control"), "no-store");

  const prewarmHeaders = new Headers();
  applyStaticStreamingCacheHeaders(prewarmHeaders, {
    isStatic: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: true,
    isManifest: false,
      isMetadataPrewarm: true,
      isBigStream: false
  }, "", { prewarmCacheTtl: 180 });
  assert.equal(prewarmHeaders.get("Cache-Control"), null);

  const bigStreamHeaders = new Headers();
  applyStaticStreamingCacheHeaders(bigStreamHeaders, {
    isStatic: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: true,
    isManifest: false,
    isMetadataPrewarm: false,
    isBigStream: true
  });
  assert.equal(bigStreamHeaders.get("Cache-Control"), "no-store");

  const redirectedHeaders = new Headers();
  applyStaticStreamingCacheHeaders(redirectedHeaders, {
    isStatic: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    imageCacheMaxAge: 86400 * 30,
    isImmutableStatic: false,
    isStreaming: false,
    isManifest: false,
    isMetadataPrewarm: false,
    isBigStream: false
  }, "", { proxiedExternalRedirect: true });
  assert.equal(redirectedHeaders.get("Cache-Control"), "no-store");
});

test("shouldUseIndependentImagePath only enables the lightweight image branch for plain image gets", () => {
  assert.equal(shouldUseIndependentImagePath({
    method: "GET",
    rangeHeader: "",
    isImage: true
  }), true);
  assert.equal(shouldUseIndependentImagePath({
    method: "HEAD",
    rangeHeader: "",
    isImage: true
  }), true);
  assert.equal(shouldUseIndependentImagePath({
    method: "GET",
    rangeHeader: "bytes=0-1",
    isImage: true
  }), false);
  assert.equal(shouldUseIndependentImagePath({
    method: "GET",
    rangeHeader: "",
    isImage: false
  }), false);
});

test("shouldUseIndependentMetadataPath only enables the lightweight metadata branch for plain subtitle and manifest gets", () => {
  assert.equal(shouldUseIndependentMetadataPath({
    method: "GET",
    rangeHeader: "",
    direct307Mode: false,
    isSubtitle: true,
    isManifest: false
  }), true);
  assert.equal(shouldUseIndependentMetadataPath({
    method: "HEAD",
    rangeHeader: "",
    direct307Mode: false,
    isSubtitle: false,
    isManifest: true
  }), true);
  assert.equal(shouldUseIndependentMetadataPath({
    method: "GET",
    rangeHeader: "bytes=0-1",
    direct307Mode: false,
    isSubtitle: true,
    isManifest: false
  }), false);
  assert.equal(shouldUseIndependentMetadataPath({
    method: "GET",
    rangeHeader: "",
    direct307Mode: true,
    isSubtitle: false,
    isManifest: true
  }), false);
});

test("src-file-map covers every src javascript file by relative path", () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testsDir, "..");
  const srcDir = path.join(repoRoot, "src");
  const mapPath = path.join(srcDir, "src-file-map.md");
  const mapContent = fs.readFileSync(mapPath, "utf8");

  const stack = [srcDir];
  const jsFiles = [];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".js")) {
        jsFiles.push(fullPath);
      }
    }
  }

  const relativePaths = jsFiles
    .map(file => path.relative(repoRoot, file).replaceAll(path.sep, "/"));

  const missing = relativePaths
    .filter(name => !mapContent.includes(`\`${name}\``))
    .sort();

  assert.deepEqual(missing, []);
});

test("migrated modules remove deprecated compatibility shell files", () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testsDir, "..");
  const deprecatedFiles = [
    "src/.DS_Store",
    "src/config/constants.js",
    "src/config/compatibility.js",
    "src/config/runtime-config.js",
    "src/core/auth.js",
    "src/core/node-targets.js",
    "src/ui/ui.js",
    "src/ui/icons.js",
    "src/telemetry/playback-telemetry.js",
    "src/proxy/playback-url-compat.js",
    "src/proxy/proxy-response-payload-rewrite.js",
    "src/proxy/proxy-response-rewrite.js",
    "src/proxy/proxy-client-path.js",
    "src/proxy/proxy-incoming-path.js",
    "src/proxy/proxy-url-utils.js",
    "src/proxy/proxy-location-rewrite.js",
    "src/proxy/proxy-redirect-chain.js",
    "src/proxy/proxy-redirect-whitelist.js",
    "src/proxy/proxy-dispatch-upstream.js",
    "src/proxy/proxy-upstream-attempt.js",
    "src/proxy/proxy-upstream-headers.js",
    "src/proxy/proxy-fallback-strategy.js",
    "src/proxy/proxy-failover-utils.js",
    "src/proxy/proxy-response-orchestrator.js",
    "src/proxy/proxy-response-streaming.js",
    "src/proxy/proxy-response-header-policy.js",
    "src/proxy/proxy-response-size.js",
    "src/proxy/proxy-request-state.js",
    "src/proxy/proxy-node-context.js",
    "src/proxy/proxy-static-cache.js",
    "src/proxy/proxy-diagnostics.js",
    "src/proxy/proxy-playback-prewarm.js",
    "src/proxy/proxy-playback-telemetry.js",
    "src/proxy/proxy-playback-affinity.js",
    "src/proxy/proxy-basepath-state.js",
    "src/proxy/proxy-redirect-cache.js",
    "src/proxy/proxy-metadata-coalesce.js",
    "src/proxy/proxy-playback-optimization.js",
    "src/proxy/proxy-websocket.js",
    "src/proxy/playback-range-windows.js",
    "src/proxy/proxy.js",
    "src/proxy/compat/payload-rewrite.js",
    "src/proxy/compat/playback-url-compat.js",
    "src/proxy/media/prewarm.js",
    "src/proxy/routing/playback-affinity.js",
    "src/probes/network-probe.js",
    "src/proxy/compat/response-rewrite.js",
    "src/proxy/pipeline/metadata-coalesce.js",
    "src/core/database.js"
  ];
  const deprecatedDirectories = [
    "src/core"
  ];

  const remaining = deprecatedFiles.filter((relativePath) =>
    fs.existsSync(path.join(repoRoot, relativePath))
  );
  const remainingDirectories = deprecatedDirectories.filter((relativePath) =>
    fs.existsSync(path.join(repoRoot, relativePath))
  );

  assert.deepEqual(remaining, []);
  assert.deepEqual(remainingDirectories, []);
});

test("proxy handle removes deprecated internal helper wrappers", () => {
  const removedHelpers = [
    "touchPlaybackOptimizationStats",
    "recordPlaybackOptimizationRoute",
    "getPlaybackOptimizationStats",
    "normalizeProxyArtifactPath",
    "normalizeExternalRedirectCachePath",
    "buildExternalRedirectCacheKey",
    "buildExternalRedirectPersistenceStorageKey",
    "collectPlaybackAffinityTokens",
    "collectPlaybackAffinityTokensFromUrlValue",
    "extractPlaybackPathAffinity",
    "buildPlaybackAffinityCacheKey",
    "readPlaybackTargetAffinityIndex",
    "rememberPlaybackTargetAffinity",
    "resolvePreferredPlaybackTargetEntry",
    "bindPlaybackInfoTargetAffinity",
    "getRedirectCachePersistenceContext",
    "scheduleContextTask",
    "resolveCachedExternalRedirectUrl",
    "persistExternalRedirectUrl",
    "getCachedExternalRedirectUrl",
    "rememberExternalRedirectUrl",
    "clearExternalRedirectUrl",
    "claimExternalRedirectResolution",
    "settleExternalRedirectResolution",
    "normalizeBasePathState",
    "getCachedBasePathState",
    "getCachedLearnedBasePath",
    "cacheLearnedBasePath",
    "rememberContextLearnedBasePath",
    "clearCachedLearnedBasePath",
    "clearCachedNodeContext",
    "syncNodeContextLearnedBasePaths",
    "clearCachedNodeState",
    "collectPlaybackInfoRedirectPrewarmValues",
    "buildPlaybackInfoPrewarmProxyUrl",
    "extractPlaybackInfoPrewarmBasePath",
    "prewarmExternalRedirectRequest",
    "prewarmStartupRangeWindowRequest",
    "schedulePlaybackInfoRedirectPrewarm",
    "createReplayBodyAccessor",
    "buildUpstreamHeaders",
    "buildCloudflareFetchOptions",
    "ensureBasePath",
    "buildExternalRedirectHeaders",
    "fetchExternalRedirectHit",
    "followRedirectChain",
    "buildRedirectErrorResponse",
    "createDiagnostics",
    "prepareNodeContext",
    "normalizeIncomingRequest",
    "dispatchUpstream",
    "applyFallbackStrategy",
    "rewriteProxyResponse",
    "normalizeRedirectCachePersistenceTtl",
    "getRedirectCacheKvBinding",
    "bumpPlaybackOptimizationStat",
    "createPlaybackOptimizationBudgetState",
    "markPlaybackOptimizationBudgetDegraded",
    "shouldBypassPlaybackWindowForBudget",
    "shouldBypassPlaybackPrimeForBudget",
    "shouldTrackPlaybackResponse",
    "extractPlaybackTelemetryMeta",
    "buildProxyResponseBody",
    "createPlaybackTelemetryTransform",
    "wrapPlaybackTelemetryBody",
    "isBenignStreamTermination",
    "safeCloseReadableController",
    "buildTargetRequestState",
    "parseSingleByteRangeHeader",
    "shouldCaptureTailRangeWindow",
    "asynchronouslyPrimeTailRangeWindow",
    "maybeServeSeekRangeWindow",
    "shouldSynchronouslyPrimeSeekRangeWindow",
    "captureSeekRangeWindow",
    "synchronouslyPrimeSeekRangeWindow",
    "buildTailRangeWindowCacheKey",
    "buildSeekRangeWindowCacheKey",
    "maybeServeTailRangeWindow",
    "parseResponseByteRange",
    "rememberTailRangeWindow",
    "rememberSeekRangeWindow",
    "concatUint8Arrays",
    "buildStartupRangeWindowHeaders",
    "isOpenEndedByteRange",
    "normalizeClientFacingUrl",
    "rewritePlaybackInfoUrls",
    "rewriteStreamingResponseUrls",
    "normalizeComparableHost",
    "stripProxyPrefix",
    "inferBasePathFromRequestPath",
    "extractEmbeddedProxyPath",
    "normalizeMediaBasePath",
    "stripKnownApiBasePath",
    "detectBasePathChannel",
    "shouldApplyLearnedBasePath",
    "shouldTryBasePathFallback",
    "getBasePathFallbacks",
    "shouldAllowTargetFailover",
    "shouldRetryMetadata404OnAlternateTarget",
    "orderTargetEntries",
    "describeUpstreamFailure",
    "decorateBudgetRoute",
    "normalizeExternalRedirectMethod",
    "shouldIgnoreExternalRedirectQueryParam",
    "extractMetadataJsonAuthSignature",
    "buildCanonicalExternalRedirectUrl",
    "hashCanonicalRedirectCacheKey",
    "extractAbsolutePathnameFromMixedPath"
  ];

  for (const helperName of removedHelpers) {
    assert.equal(helperName in Proxy, false, `${helperName} should not remain on Proxy`);
  }
});

test("proxy static policy constants live outside Proxy", async () => {
  const proxyConstants = await import("../src/proxy/shared/constants.js");
  const migratedConstants = [
    "MAX_EXTERNAL_REDIRECT_HOPS",
    "MEDIA_BASE_PATH_CACHE_TTL_MS",
    "NODE_CONTEXT_CACHE_TTL_MS",
    "EXTERNAL_REDIRECT_CACHE_TTL_MS",
    "PLAYBACK_OPTIMIZATION_BUDGET_MAX_MS",
    "PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES",
    "PLAYBACK_OPTIMIZATION_MAX_BOUNDED_RANGE_BYTES",
    "RETRYABLE_ORIGIN_STATUSES",
    "LOGIN_COMPAT_AUTH"
  ];

  for (const constantName of migratedConstants) {
    assert.equal(constantName in proxyConstants, true, `${constantName} should be exported from proxy shared constants`);
    assert.equal(constantName in Proxy, false, `${constantName} should not remain on Proxy`);
  }

  assert.equal(proxyConstants.MAX_EXTERNAL_REDIRECT_HOPS, 3);
  assert.ok(proxyConstants.RETRYABLE_ORIGIN_STATUSES.has(500));
  assert.match(proxyConstants.LOGIN_COMPAT_AUTH, /Emby Mate/);
});

test("range windows module only exposes shared parsing helpers after seek/tail retirement", async () => {
  const rangeWindowsModule = await import("../src/proxy/media/range-windows.js");

  assert.equal(typeof rangeWindowsModule.parseSingleByteRangeHeader, "function");
  assert.equal(typeof rangeWindowsModule.parseResponseByteRange, "function");
  assert.equal(typeof rangeWindowsModule.parseResponseByteRangeFromHeaders, "function");
  assert.equal(typeof rangeWindowsModule.concatUint8Arrays, "function");
  assert.equal(typeof rangeWindowsModule.isOpenEndedByteRange, "function");
  assert.equal("asynchronouslyPrimeTailRangeWindow" in rangeWindowsModule, false);
  assert.equal("buildTailRangeWindowCacheKey" in rangeWindowsModule, false);
  assert.equal("buildSeekRangeWindowCacheKey" in rangeWindowsModule, false);
  assert.equal("maybeServeTailRangeWindow" in rangeWindowsModule, false);
  assert.equal("maybeServeSeekRangeWindow" in rangeWindowsModule, false);
  assert.equal("shouldSynchronouslyPrimeSeekRangeWindow" in rangeWindowsModule, false);
  assert.equal("captureSeekRangeWindow" in rangeWindowsModule, false);
  assert.equal("synchronouslyPrimeSeekRangeWindow" in rangeWindowsModule, false);
  assert.equal("rememberTailRangeWindow" in rangeWindowsModule, false);
  assert.equal("rememberSeekRangeWindow" in rangeWindowsModule, false);
  assert.equal("rememberSuccessfulPlaybackStart" in rangeWindowsModule, false);
  assert.equal("hasSuccessfulPlaybackStart" in rangeWindowsModule, false);
});

test("rewriteProxyResponse keeps first playback responses free of retired seek/tail warming", async () => {
  resetGlobals();

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(promise);
    }
  };

  const output = await rewriteProxyResponse({
    request,
    requestState,
    context,
    response: new Response(new TextEncoder().encode("ABCDEF"), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "6",
        "Content-Range": "bytes 0-5/12"
      }
    }),
    diagnostics,
    executionContext
  });

  await output.arrayBuffer();
  await Promise.all(executionContext.tasks);

  assert.equal("StartupRangeWindowCache" in GLOBALS, false);
  assert.equal("TailRangeWindowCache" in GLOBALS, false);
  assert.equal("SeekRangeWindowCache" in GLOBALS, false);
  assert.equal(GLOBALS.PlaybackHeadWindowCache.size, 1);
  assert.equal(GLOBALS.PlaybackJumpWindowCache.size, 0);
  assert.equal(executionContext.tasks.length >= 1, true);
});

test("buildMetadataPrewarmTargets keeps lightweight metadata only and skips heavy video byte paths", () => {
  const payload = {
    MediaSources: [
      {
        Id: "media-8",
        PosterUrl: "/Items/9/Images/Primary",
        ManifestUrl: "/videos/8/main.m3u8?tag=manifest-8",
        SubtitleUrl: "/videos/8/subtitles/1/Stream.srt?api_key=secret",
        DirectStreamUrl: "/videos/8/original.mkv?api_key=secret"
      },
      {
        Id: "media-9",
        ManifestUrl: "/videos/9/main.m3u8?tag=manifest-9",
        SubtitleUrl: "/videos/9/subtitles/2/Stream.srt?api_key=secret",
        DebugPreview: "/Items/999/Images/Primary",
        DirectStreamUrl: "/videos/9/original.mkv?api_key=secret"
      }
    ]
  };

  const targets = buildMetadataPrewarmTargets(
    "/Items/9/PlaybackInfo",
    payload,
    new URL("https://origin.example.test"),
    "/alpha",
    "poster_manifest",
    "media-9"
  );
  const posterOnlyTargets = buildMetadataPrewarmTargets(
    "/Items/9/PlaybackInfo",
    payload,
    new URL("https://origin.example.test"),
    "/alpha",
    "poster",
    "media-9"
  );
  const basePathedTargets = buildMetadataPrewarmTargets(
    "/emby/Items/9/PlaybackInfo",
    payload,
    new URL("https://origin.example.test/emby"),
    "/alpha",
    "poster",
    "media-9"
  );

  assert.deepEqual(
    targets.map(item => item.proxyLocation),
    [
      "/alpha/Items/9/Images/Primary",
      "/alpha/videos/9/main.m3u8?tag=manifest-9",
      "/alpha/videos/9/subtitles/2/Stream.srt?api_key=secret"
    ]
  );
  assert.equal(targets.some(item => /original\.mkv/i.test(item.proxyLocation)), false);
  assert.deepEqual(posterOnlyTargets.map(item => item.proxyLocation), [
    "/alpha/Items/9/Images/Primary"
  ]);
  assert.deepEqual(basePathedTargets.map(item => item.proxyLocation), [
    "/alpha/Items/9/Images/Primary"
  ]);
  assert.equal(targets.some(item => item.proxyLocation.includes("/Items/999/Images/Primary")), false);
});

test("buildMetadataPrewarmTargets falls back to payload scan when requested media source is missing", () => {
  const payload = {
    MediaSources: [
      {
        Id: "media-8",
        ManifestUrl: "/videos/8/main.m3u8?tag=manifest-8",
        SubtitleUrl: "/videos/8/subtitles/1/Stream.srt?api_key=secret",
        DirectStreamUrl: "/videos/8/original.mkv?api_key=secret"
      }
    ]
  };

  const targets = buildMetadataPrewarmTargets(
    "/Items/9/PlaybackInfo",
    payload,
    new URL("https://origin.example.test"),
    "/alpha",
    "poster_manifest",
    "missing-media-source"
  );

  assert.deepEqual(
    targets.map(item => item.proxyLocation),
    [
      "/alpha/Items/9/Images/Primary",
      "/alpha/videos/8/main.m3u8?tag=manifest-8",
      "/alpha/videos/8/subtitles/1/Stream.srt?api_key=secret"
    ]
  );
});

test("buildMetadataPrewarmTargets falls back to targeted recursive scan when whitelisted media source fields are absent", () => {
  const payload = {
    MediaSources: [
      {
        Id: "media-9",
        AlternateSubtitle: "/videos/9/subtitles/9/Stream.srt?api_key=secret",
        DebugManifest: "/videos/9/main.m3u8?tag=manifest-9",
        DirectStreamUrl: "/videos/9/original.mkv?api_key=secret"
      }
    ]
  };

  const targets = buildMetadataPrewarmTargets(
    "/Items/9/PlaybackInfo",
    payload,
    new URL("https://origin.example.test"),
    "/alpha",
    "poster_manifest",
    "media-9"
  );

  assert.deepEqual(
    targets.map(item => item.proxyLocation),
    [
      "/alpha/Items/9/Images/Primary",
      "/alpha/videos/9/main.m3u8?tag=manifest-9",
      "/alpha/videos/9/subtitles/9/Stream.srt?api_key=secret"
    ]
  );
});

test("metadata cache helpers only whitelist safe manifests and normalize proxy cache keys conservatively", async () => {
  resetGlobals();
  const safeManifest = new URL("https://proxy.example.test/alpha/Videos/1/main.m3u8?MediaSourceId=1&tag=abc&PlaySessionId=play-1&api_key=secret");
  const unsafeManifest = new URL("https://proxy.example.test/alpha/Videos/1/main.m3u8?MediaSourceId=1&tag=abc&transcoding=true");
  const subtitleUrl = new URL("https://proxy.example.test/alpha/videos/1/subtitles/2/Stream.srt?api_key=secret&PlaySessionId=play-1");

  assert.equal(isWhitelistedMetadataManifestUrl(safeManifest), true);
  assert.equal(isWhitelistedMetadataManifestUrl(unsafeManifest), false);
  assert.equal(shouldWorkerCacheMetadataUrl(safeManifest), true);
  assert.equal(shouldWorkerCacheMetadataUrl(unsafeManifest), false);
  assert.equal(shouldWorkerCacheMetadataUrl(subtitleUrl), true);
  assert.equal(
    normalizeWorkerMetadataCacheUrl(safeManifest).toString(),
    "https://proxy.example.test/alpha/Videos/1/main.m3u8?mediasourceid=1&tag=abc"
  );
  assert.equal(
    buildWorkerMetadataCacheKey(safeManifest),
    "https://proxy.example.test/alpha/Videos/1/main.m3u8?mediasourceid=1&tag=abc"
  );

  await storeWorkerMetadataCache(
    safeManifest,
    new Response("#EXTM3U", {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl"
      }
    }),
    {
      isManifest: true
    },
    {
      sourceUrl: safeManifest,
      prewarmCacheTtl: 180
    }
  );
  const cachedManifest = await matchWorkerMetadataCache(new URL("https://proxy.example.test/alpha/Videos/1/main.m3u8?tag=abc&MediaSourceId=1&PlaySessionId=play-2&api_key=secret"));
  assert.ok(cachedManifest);
  assert.equal(await cachedManifest.text(), "#EXTM3U");
  assert.equal(cachedManifest.headers.get("Cache-Control"), "public, max-age=180");
});

test("maybePrewarmMetadataResponse schedules lightweight metadata prewarm on JSON GET responses", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method || "GET").toUpperCase(),
      range: init.headers?.get?.("Range") || "",
      prewarm: init.headers?.get?.("X-Metadata-Prewarm") || "",
      ifModifiedSince: init.headers?.get?.("If-Modified-Since"),
      ifNoneMatch: init.headers?.get?.("If-None-Match")
    });
    return new Response("warm", {
      status: 200,
      headers: {
        "Content-Type": String(url).includes(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : (String(url).includes(".srt") ? "text/plain" : "image/jpeg")
      }
    });
  };

  const request = new Request("https://proxy.example.test/alpha/Items/9?api_key=x", {
    headers: {
      "x-emby-token": "x"
    }
  });
  const response = new Response(JSON.stringify({
    MediaSources: [
      {
        PosterUrl: "/Items/9/Images/Primary",
        ManifestUrl: "/videos/9/main.m3u8?tag=manifest",
        SubtitleUrl: "/videos/9/subtitles/1/Stream.srt?api_key=secret",
        DirectStreamUrl: "/videos/9/original.mkv?api_key=secret"
      }
    ]
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };

  await maybePrewarmMetadataResponse({
    request,
    response,
    requestState: {
      method: "GET",
      enablePrewarm: true,
      prewarmDepth: "poster_manifest",
      isMetadataPrewarm: false,
      isImage: false,
      isStaticFile: false,
      isSubtitle: false,
      isManifest: false,
      isSegment: false,
      isBigStream: false,
      activeNormalizedPath: "/Items/9",
      activeTargetBase: new URL("https://origin.example.test"),
      activeFinalUrl: new URL("https://origin.example.test/Items/9"),
      activeTargetHost: "origin.example.test"
    },
    context: {
      proxyPrefix: "/alpha",
      prewarmTimeoutMs: 3000,
      path: "alpha",
      name: "alpha"
    },
    executionContext
  });

  await settleExecutionContext(executionContext);

  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/Items/9/Images/Primary",
      method: "GET",
      range: "",
      prewarm: "1",
      ifModifiedSince: null,
      ifNoneMatch: null
    },
    {
      url: "https://origin.example.test/videos/9/main.m3u8?tag=manifest",
      method: "GET",
      range: "",
      prewarm: "1",
      ifModifiedSince: null,
      ifNoneMatch: null
    },
    {
      url: "https://origin.example.test/videos/9/subtitles/1/Stream.srt?api_key=secret",
      method: "GET",
      range: "",
      prewarm: "1",
      ifModifiedSince: null,
      ifNoneMatch: null
    }
  ]);

  calls.length = 0;

  await maybePrewarmMetadataResponse({
    request,
    response,
    requestState: {
      method: "GET",
      enablePrewarm: true,
      prewarmDepth: "poster_manifest",
      isMetadataPrewarm: false,
      isImage: false,
      isStaticFile: false,
      isSubtitle: false,
      isManifest: false,
      isSegment: false,
      isBigStream: false,
      activeNormalizedPath: "/Items/9",
      activeTargetBase: new URL("https://origin.example.test"),
      activeFinalUrl: new URL("https://origin.example.test/Items/9"),
      activeTargetHost: "origin.example.test"
    },
    context: {
      proxyPrefix: "/alpha",
      prewarmTimeoutMs: 3000,
      path: "alpha",
      name: "alpha"
    },
    executionContext
  });

  await settleExecutionContext(executionContext);
  assert.deepEqual(calls, []);
});

test("maybePrewarmMetadataResponse skips oversized json payloads and dedupes concurrent warms", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method || "GET").toUpperCase(),
      prewarm: init.headers?.get?.("X-Metadata-Prewarm") || ""
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response("warm", {
      status: 200,
      headers: {
        "Content-Type": String(url).includes(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "image/jpeg"
      }
    });
  };

  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };
  const request = new Request("https://proxy.example.test/alpha/Items/9/PlaybackInfo?api_key=x", {
    headers: {
      "x-emby-token": "x"
    }
  });
  const baseRequestState = {
    method: "GET",
    enablePrewarm: true,
    prewarmDepth: "poster_manifest",
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isBigStream: false,
    activeNormalizedPath: "/Items/9/PlaybackInfo",
    activeTargetBase: new URL("https://origin.example.test"),
    activeFinalUrl: new URL("https://origin.example.test/Items/9/PlaybackInfo"),
    activeTargetHost: "origin.example.test"
  };
  const context = {
    proxyPrefix: "/alpha",
    prewarmTimeoutMs: 3000,
    path: "alpha",
    name: "alpha"
  };

  await maybePrewarmMetadataResponse({
    request,
    response: new Response(JSON.stringify({
      MediaSources: [
        {
          PosterUrl: "/Items/9/Images/Primary",
          ManifestUrl: "/videos/9/main.m3u8?tag=manifest"
        }
      ]
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(600 * 1024)
      }
    }),
    requestState: baseRequestState,
    context,
    executionContext
  });

  await settleExecutionContext(executionContext);
  assert.deepEqual(calls, []);

  calls.length = 0;
  executionContext.tasks.length = 0;
  const response = new Response(JSON.stringify({
    MediaSources: [
      {
        PosterUrl: "/Items/9/Images/Primary",
        ManifestUrl: "/videos/9/main.m3u8?tag=manifest"
      }
    ]
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "2048"
    }
  });

  await Promise.all([
    maybePrewarmMetadataResponse({
      request,
      response: response.clone(),
      requestState: baseRequestState,
      context,
      executionContext
    }),
    maybePrewarmMetadataResponse({
      request,
      response: response.clone(),
      requestState: baseRequestState,
      context,
      executionContext
    })
  ]);

  await settleExecutionContext(executionContext);
  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/Items/9/Images/Primary",
      method: "GET",
      prewarm: "1"
    },
    {
      url: "https://origin.example.test/videos/9/main.m3u8?tag=manifest",
      method: "GET",
      prewarm: "1"
    }
  ]);
});

test("createFetchWithRedirectsHandlers returns followed final url for downstream prewarm usage", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const normalized = String(url);
    if (normalized === "https://origin.example.test/emby/videos/1/original.mkv?api_key=x") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file.mkv?api_key=x"
        }
      });
    }
    if (normalized === "https://cdn.example.test/file.mkv?api_key=x") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": "bytes 0-2/1000",
          "Content-Length": "3"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalized}`);
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x");
  const currentState = {
    method: "GET",
    activeFinalUrl: new URL("https://origin.example.test/emby/videos/1/original.mkv?api_key=x")
  };
  const handlers = createFetchWithRedirectsHandlers({
    request,
    currentState,
    context: {
      name: "alpha",
      redirectWhitelistEnabled: false,
      redirectWhitelistDomains: [],
      forceExternalProxy: true
    },
    targetEntry: {
      target: "https://origin.example.test/emby",
      targetHost: "origin.example.test"
    },
    replay: {
      hasBody: false,
      getReplayBody: async () => null
    },
    cf: {
      cacheEverything: false,
      cacheTtl: 0
    },
    newHeaders: new Headers()
  });

  const result = await handlers.fetchWithRedirects(currentState.activeFinalUrl, false);

  assert.equal(result.route, "followed");
  assert.equal(result.finalUrl?.toString(), "https://cdn.example.test/file.mkv?api_key=x");
  assert.equal(result.resolvedRedirectUrl, "https://cdn.example.test/file.mkv?api_key=x");
});

test("createFetchWithRedirectsHandlers retries retryable upstream status on the same target under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("busy", { status: 503 });
    }
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x");
  const currentState = {
    method: "GET",
    activeFinalUrl: new URL("https://origin.example.test/emby/videos/1/original.mkv?api_key=x")
  };
  const handlers = createFetchWithRedirectsHandlers({
    request,
    currentState,
    context: {
      name: "alpha",
      redirectWhitelistEnabled: false,
      redirectWhitelistDomains: [],
      forceExternalProxy: true,
      upstreamRetryAttempts: 1
    },
    targetEntry: {
      target: "https://origin.example.test/emby",
      targetHost: "origin.example.test"
    },
    replay: {
      hasBody: false,
      getReplayBody: async () => null
    },
    cf: {
      cacheEverything: false,
      cacheTtl: 0
    },
    newHeaders: new Headers()
  });

  const result = await handlers.fetchWithRedirects(currentState.activeFinalUrl, false);

  assert.equal(result.response.status, 200);
  assert.equal(calls, 2);
});

test("createFetchWithRedirectsHandlers retries 403 once with stripped auth under aligned protocol fallback", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const headers = init.headers;
    calls.push({
      authorization: headers?.get?.("Authorization") || null,
      embyAuthorization: headers?.get?.("X-Emby-Authorization") || null,
      connection: headers?.get?.("Connection") || null
    });
    if (calls.length === 1) {
      return new Response("blocked", { status: 403 });
    }
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x");
  const currentState = {
    method: "GET",
    activeFinalUrl: new URL("https://origin.example.test/emby/videos/1/original.mkv?api_key=x")
  };
  const handlers = createFetchWithRedirectsHandlers({
    request,
    currentState,
    context: {
      name: "alpha",
      redirectWhitelistEnabled: false,
      redirectWhitelistDomains: [],
      forceExternalProxy: true,
      protocolFallback: true
    },
    targetEntry: {
      target: "https://origin.example.test/emby",
      targetHost: "origin.example.test"
    },
    replay: {
      hasBody: false,
      getReplayBody: async () => null
    },
    cf: {
      cacheEverything: false,
      cacheTtl: 0
    },
    newHeaders: new Headers({
      Authorization: "Bearer secret",
      "X-Emby-Authorization": "Emby token"
    })
  });

  const result = await handlers.fetchWithRedirects(currentState.activeFinalUrl, false);

  assert.equal(result.response.status, 200);
  assert.deepEqual(calls, [
    {
      authorization: "Bearer secret",
      embyAuthorization: "Emby token",
      connection: null
    },
    {
      authorization: null,
      embyAuthorization: null,
      connection: "keep-alive"
    }
  ]);
});

test("createFetchWithRedirectsHandlers aborts stalled upstream fetch with configured timeout under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init = {}) => {
    await new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv?api_key=x");
  const currentState = {
    method: "GET",
    activeFinalUrl: new URL("https://origin.example.test/emby/videos/1/original.mkv?api_key=x")
  };
  const handlers = createFetchWithRedirectsHandlers({
    request,
    currentState,
    context: {
      name: "alpha",
      redirectWhitelistEnabled: false,
      redirectWhitelistDomains: [],
      forceExternalProxy: true,
      upstreamTimeoutMs: 10
    },
    targetEntry: {
      target: "https://origin.example.test/emby",
      targetHost: "origin.example.test"
    },
    replay: {
      hasBody: false,
      getReplayBody: async () => null
    },
    cf: {
      cacheEverything: false,
      cacheTtl: 0
    },
    newHeaders: new Headers()
  });

  await assert.rejects(
    handlers.fetchWithRedirects(currentState.activeFinalUrl, false),
    error => error?.code === "UPSTREAM_TIMEOUT"
  );
});

test("rewriteProxyResponse rewrites redirect location without proxy rewriteLocation wrapper", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Info");

  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      lowerPath: "/system/info",
      activeNormalizedPath: "/System/Info",
      activeTargetBase: new URL("https://origin.example.test/emby")
    },
    context: {
      name: "alpha",
      path: "alpha"
    },
    response: new Response(null, {
      status: 302,
      headers: {
        Location: "/web/index.html"
      }
    }),
    diagnostics: {
      route: "passthrough"
    }
  });

  assert.equal(output.headers.get("Location"), "/alpha/web/index.html");
});

test("rewriteProxyResponse strips Alt-Svc when http3 is disabled under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/System/Info");

  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      lowerPath: "/system/info",
      activeNormalizedPath: "/System/Info",
      activeTargetBase: new URL("https://origin.example.test/emby"),
      isStatic: false,
      isManifest: false,
      isMetadataPrewarm: false,
      isBigStream: false
    },
    context: {
      name: "alpha",
      path: "alpha",
      enableH3: false,
      forceH1: false
    },
    response: new Response("ok", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Alt-Svc": "h3=\":443\"; ma=86400"
      }
    }),
    diagnostics: {
      route: "passthrough"
    },
    upstreamState: {
      route: "passthrough"
    }
  });

  assert.equal(output.headers.get("Alt-Svc"), null);
});

test("rewriteProxyResponse passes through upstream websocket upgrades under aligned playback baseline", async t => {
  resetGlobals();
  const originalResponse = globalThis.Response;

  class FakeResponse {
    constructor(body, init = {}) {
      this.body = body ?? null;
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? "";
      this.headers = init.headers instanceof Headers ? new Headers(init.headers) : new Headers(init.headers || {});
      this.webSocket = init.webSocket;
    }
  }

  globalThis.Response = FakeResponse;
  t.after(() => {
    globalThis.Response = originalResponse;
  });

  const request = new Request("https://proxy.example.test/alpha/socket", {
    headers: {
      Upgrade: "websocket",
      Origin: "https://app.example.test"
    }
  });
  const requestState = {
    method: "GET",
    isWsUpgrade: true,
    direct307Mode: false,
    requestHost: "proxy.example.test",
    lowerPath: "/socket",
    activeNormalizedPath: "/socket",
    activeTargetBase: new URL("https://origin.example.test"),
    activeTargetHost: "origin.example.test",
    activeFinalUrl: new URL("https://origin.example.test/socket")
  };
  const diagnostics = createDiagnostics("/socket", {
    activeNormalizedPath: "/socket",
    activeFinalUrl: new URL("https://origin.example.test/socket"),
    activeTargetHost: "origin.example.test",
    activeTargetIndex: 0
  });

  const output = await rewriteProxyResponse({
    request,
    requestState,
    context: {
      name: "alpha",
      key: "",
      finalOrigin: "https://app.example.test",
      sourceSameOriginProxy: true
    },
    response: {
      status: 101,
      statusText: "Switching Protocols",
      headers: new Headers({
        Upgrade: "websocket"
      }),
      body: null,
      webSocket: { id: "upstream-socket" }
    },
    diagnostics,
    upstreamState: {
      route: "passthrough"
    }
  });

  assert.equal(output.status, 101);
  assert.equal(output.webSocket.id, "upstream-socket");
  assert.equal(output.headers.get("Upgrade"), "websocket");
  assert.equal(output.headers.get("X-Proxy-Route"), "passthrough");
});

test("rewriteProxyResponse finalizes diagnostics without proxy finalize wrapper", async () => {
  resetGlobals();

  const request = new Request("https://proxy.example.test/alpha/System/Info");

  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      lowerPath: "/system/info",
      activeNormalizedPath: "/System/Info",
      activeTargetBase: new URL("https://origin.example.test/emby"),
      requestHost: "proxy.example.test"
    },
    context: {
      name: "alpha",
      key: ""
    },
    response: new Response("ok", {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": "2"
      }
    }),
    diagnostics: {
      route: "redirect-cache-followed",
      targetIndex: 1,
      targetCount: 1,
      incomingPath: "/System/Info",
      normalizedPath: "/System/Info",
      upstreamPath: "/System/Info"
    }
  });

  assert.equal(output.status, 200);
  assert.equal(output.headers.get("X-Proxy-Route"), "redirect-cache-followed");
  assert.equal(GLOBALS.PlaybackOptimizationStats.redirect.cache, 1);
  assert.equal(GLOBALS.PlaybackOptimizationStats.redirect.followed, 1);
});

test("response orchestrator wires lightweight metadata prewarm before streaming body prep", async () => {
  const source = await fs.promises.readFile(
    new URL("../src/proxy/pipeline/response-orchestrator.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /maybePrewarmMetadataResponse\(\{/);
  assert.match(source, /attachPlaybackWindowCapture\(GLOBALS,\s*\{/);
  assert.match(source, /prepareStreamingResponseBody\(\{\s*responseBody:\s*attachPlaybackWindowCapture\(GLOBALS,\s*\{/);
});
test("rewriteProxyResponse keeps only the aligned baseline route header among proxy diagnostics", async () => {
  resetGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Origin: "https://app.example.test",
      "cf-placement": "HKG"
    }
  });
  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      isStatic: false,
      isImage: false,
      isStaticFile: false,
      isSubtitle: false,
      isManifest: false,
      isMetadataPrewarm: false,
      isBigStream: true,
      direct307Mode: false,
      lowerPath: "/videos/1/original.mkv",
      requestHost: "proxy.example.test",
      activeNormalizedPath: "/videos/1/original.mkv",
      activeTargetBase: new URL("https://origin.example.test"),
      activeTargetHost: "origin.example.test",
      activeFinalUrl: new URL("https://origin.example.test/videos/1/original.mkv")
    },
    context: {
      name: "alpha",
      key: "",
      finalOrigin: "https://app.example.test",
      sourceSameOriginProxy: true
    },
    response: new Response("stream-body", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "11"
      }
    }),
    diagnostics: {
      route: "passthrough",
      hops: 2,
      upstreamMs: 12.4,
      rewriteMs: 1.5,
      incomingPath: "/alpha/videos/1/original.mkv",
      normalizedPath: "/videos/1/original.mkv",
      upstreamPath: "/videos/1/original.mkv",
      targetHost: "origin.example.test",
      targetIndex: 1,
      targetCount: 2,
      failover: "1",
      failoverReason: "status-503"
    },
    executionContext: null,
    upstreamState: {
      route: "passthrough"
    }
  });

  assert.equal(output.headers.get("X-Proxy-Route"), "passthrough");
  assert.equal(output.headers.get("X-Proxy-Redirect-Hops"), null);
  assert.equal(output.headers.get("X-Proxy-Target-Index"), null);
  assert.equal(output.headers.get("X-Proxy-Target-Count"), null);
  assert.equal(output.headers.get("X-Proxy-Failover"), null);
  assert.equal(output.headers.get("X-Proxy-Failover-Reason"), null);
  assert.equal(output.headers.get("X-Proxy-Path-In"), null);
  assert.equal(output.headers.get("X-Proxy-Path-Normalized"), null);
  assert.equal(output.headers.get("X-Proxy-Upstream-Path"), null);
  assert.equal(output.headers.get("X-Proxy-Target-Host"), null);
  assert.equal(output.headers.get("X-Proxy-Final-Host"), null);
  assert.equal(output.headers.get("X-Proxy-Upstream-Status"), null);
  assert.equal(output.headers.get("X-Proxy-Upstream-Type"), null);
  assert.equal(output.headers.get("X-Proxy-Upstream-Cache"), null);
  assert.equal(output.headers.get("X-Proxy-Playback-Mode"), null);
  assert.equal(output.headers.get("X-Proxy-Hops"), null);
  assert.equal(output.headers.get("X-Proxy-Debug-Reason"), null);
  assert.equal(output.headers.get("X-CF-Placement"), null);
  assert.equal(output.headers.get("Server-Timing"), null);
  assert.equal(output.headers.get("Access-Control-Expose-Headers"), "Content-Length, Content-Range, X-Emby-Auth-Token");
});

test("rewriteProxyResponse emits optional debug headers only for abnormal media responses when enabled", async () => {
  resetGlobals();
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Origin: "https://app.example.test"
    }
  });
  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      isStatic: false,
      isImage: false,
      isStaticFile: false,
      isSubtitle: false,
      isManifest: false,
      isMetadataPrewarm: false,
      isBigStream: true,
      direct307Mode: false,
      lowerPath: "/videos/1/original.mkv",
      requestHost: "proxy.example.test",
      activeNormalizedPath: "/videos/1/original.mkv",
      activeTargetBase: new URL("https://origin.example.test"),
      activeTargetHost: "origin.example.test",
      activeFinalUrl: new URL("https://origin.example.test/videos/1/original.mkv")
    },
    context: {
      name: "alpha",
      key: "",
      finalOrigin: "https://app.example.test",
      sourceSameOriginProxy: true
    },
    response: new Response("stream-body", {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Content-Length": "11"
      }
    }),
    diagnostics: {
      route: "followed",
      hops: 1,
      incomingPath: "/alpha/videos/1/original.mkv",
      normalizedPath: "/videos/1/original.mkv",
      upstreamPath: "/videos/1/original.mkv",
      targetHost: "origin.example.test",
      targetIndex: 1,
      targetCount: 1,
      debugProxyHeadersEnabled: true,
      debugProxyHeadersEligible: true,
      finalHost: "cdn.example.test",
      upstreamStatus: 403,
      upstreamContentType: "text/html; charset=UTF-8",
      upstreamCacheStatus: "MISS",
      debugReason: "startup-followed-html-4xx"
    },
    executionContext: null,
    upstreamState: {
      route: "followed"
    }
  });

  assert.equal(output.headers.get("X-Proxy-Route"), "followed");
  assert.equal(output.headers.get("X-Proxy-Final-Host"), "cdn.example.test");
  assert.equal(output.headers.get("X-Proxy-Upstream-Status"), "403");
  assert.equal(output.headers.get("X-Proxy-Upstream-Type"), "text/html; charset=UTF-8");
  assert.equal(output.headers.get("X-Proxy-Upstream-Cache"), "MISS");
  assert.equal(output.headers.get("X-Proxy-Hops"), "1");
  assert.equal(output.headers.get("X-Proxy-Debug-Reason"), "startup-followed-html-4xx");
  assert.match(output.headers.get("Access-Control-Expose-Headers") || "", /X-Proxy-Final-Host/);
  assert.match(output.headers.get("Access-Control-Expose-Headers") || "", /X-Proxy-Debug-Reason/);
  assert.match(output.headers.get("Access-Control-Expose-Headers") || "", /X-Proxy-Upstream-Cache/);
});

test("rewriteProxyResponse leaves PlaybackInfo payload untouched under aligned playback baseline", async () => {
  resetGlobals();
  const request = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo");
  const originalBody = JSON.stringify({
    MediaSources: [
      {
        DirectStreamUrl: "https://origin.example.test/emby/videos/1/original.mkv?api_key=x"
      }
    ]
  });
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };

  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "POST",
      lowerPath: "/items/1/playbackinfo",
      activeNormalizedPath: "/Items/1/PlaybackInfo",
      requestUrl: new URL(request.url),
      requestHost: "proxy.example.test",
      activeTargetHost: "origin.example.test",
      activeRewriteBasePath: "/emby",
      activeTargetBase: new URL("https://origin.example.test/emby"),
      isStreaming: false
    },
    context: {
      name: "alpha",
      key: ""
    },
    response: new Response(originalBody, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(originalBody.length)
      }
    }),
    diagnostics: {
      route: "passthrough",
      rewriteMs: 0
    },
    executionContext
  });

  assert.equal(await output.text(), originalBody);
  await settleExecutionContext(executionContext);
  const recentUsage = await readRecentNodeUsageMap(GLOBALS, ["alpha"]);
  assert.equal(recentUsage.alpha.lastSeenAt.length > 0, true);
});

test("rewriteProxyResponse leaves streaming text payload untouched under aligned playback baseline", async () => {
  const request = new Request("https://proxy.example.test/alpha/videos/1/master.m3u8");
  const originalBody = "https://origin.example.test/emby/videos/1/original.mkv?api_key=x";

  const output = await rewriteProxyResponse({
    request,
    requestState: {
      method: "GET",
      lowerPath: "/videos/1/master.m3u8",
      activeNormalizedPath: "/videos/1/master.m3u8",
      requestUrl: new URL(request.url),
      requestHost: "proxy.example.test",
      activeTargetHost: "origin.example.test",
      activeRewriteBasePath: "/emby",
      activeTargetBase: new URL("https://origin.example.test/emby"),
      isStreaming: true
    },
    context: {
      name: "alpha",
      key: ""
    },
    response: new Response(originalBody, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": String(originalBody.length)
      }
    }),
    diagnostics: {
      route: "passthrough",
      rewriteMs: 0
    }
  });

  assert.equal(await output.text(), originalBody);
});

test("rewriteProxyResponse can expose playback mode diagnostics for PlaybackInfo requests in debug mode", async () => {
  resetGlobals();
  const request = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo?PlaySessionId=play-1");
  const originalBody = JSON.stringify({
    MediaSources: [
      {
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        TranscodingUrl: ""
      }
    ]
  });

  const requestState = {
    method: "GET",
    lowerPath: "/items/1/playbackinfo",
    activeNormalizedPath: "/Items/1/PlaybackInfo",
    requestUrl: new URL(request.url),
    requestHost: "proxy.example.test",
    activeTargetHost: "origin.example.test",
    activeTargetBase: new URL("https://origin.example.test/emby"),
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/PlaybackInfo?PlaySessionId=play-1"),
    isBigStream: false,
    isManifest: false,
    isSegment: false,
    isSubtitle: false,
    isImage: false,
    isStaticFile: false,
    isMetadataPrewarm: false,
    isPlaybackInfo: true,
    debugProxyHeaders: true
  };
  const diagnostics = createDiagnostics("/Items/1/PlaybackInfo", requestState);
  const output = await rewriteProxyResponse({
    request,
    requestState,
    context: {
      name: "alpha",
      finalOrigin: "https://app.example.test",
      sourceSameOriginProxy: true
    },
    response: new Response(originalBody, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    }),
    diagnostics,
    executionContext: null,
    upstreamState: {
      route: "passthrough"
    }
  });

  assert.equal(output.headers.get("X-Proxy-Route"), "passthrough");
  assert.equal(output.headers.get("X-Proxy-Playback-Mode"), "direct_stream");
  assert.match(output.headers.get("Access-Control-Expose-Headers") || "", /X-Proxy-Playback-Mode/);
  assert.equal(await output.text(), originalBody);
});

test("shouldUseStartupMediaFastPath only selects startup playback requests", () => {
  assert.equal(shouldUseStartupMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=0-"
  }), true);

  assert.equal(shouldUseStartupMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=512-2047"
  }), true);

  assert.equal(shouldUseStartupMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
  }), false);

  assert.equal(shouldUseStartupMediaFastPath({
    method: "HEAD",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: true,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=0-1"
  }), false);
});

test("shouldUseContinuationMediaFastPath only selects continued playback requests", () => {
  assert.equal(shouldUseContinuationMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=2048-"
  }), true);

  assert.equal(shouldUseContinuationMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=0-"
  }), false);

  assert.equal(shouldUseContinuationMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: false,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
  }), true);

  assert.equal(shouldUseContinuationMediaFastPath({
    method: "GET",
    looksLikeVideoRoute: true,
    isStreaming: true,
    isMetadataPrewarm: true,
    isImage: false,
    isStaticFile: false,
    isSubtitle: false,
    isManifest: false,
    isSegment: false,
    isWsUpgrade: false,
    rangeHeader: "bytes=2048-"
  }), false);
});
test("dispatchUpstream prefers passthrough for the first open-ended playback request", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      range: init.headers?.get?.("Range") || ""
    });
    return new Response("ABCDEFGH", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "8",
        "Content-Range": "bytes 0-7/8"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "passthrough");
  assert.equal(upstream.response.status, 206);
  assert.equal(upstream.response.headers.get("Content-Range"), "bytes 0-7/8");
  assert.equal(await upstream.response.text(), "ABCDEFGH");
  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
      range: "bytes=0-"
    }
  ]);
});

test("dispatchUpstream returns a passthrough bad gateway when no candidate targets remain", async () => {
  resetGlobals();

  const preparedContext = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const context = {
    ...preparedContext,
    targetEntries: []
  };
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", preparedContext);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);

  const upstream = await dispatchUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "passthrough");
  assert.equal(upstream.budgetDegraded, false);
  assert.ok(upstream.errorResponse instanceof Response);
  assert.equal(upstream.errorResponse.status, 502);
  assert.equal(upstream.errorResponse.headers.get("Content-Type"), "application/json; charset=utf-8");
});

test("dispatchStartupMediaUpstream keeps startup playback redirects on the short path", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-1.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-1.mkv") {
      return new Response("ABCDEFGH", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/8"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchStartupMediaUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "followed");
  assert.equal(upstream.response.status, 206);
  assert.equal(await upstream.response.text(), "ABCDEFGH");
  assert.equal(GLOBALS.PlaybackOptimizationStats.budget.degraded, 0);
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    "https://cdn.example.test/file-1.mkv"
  ]);
});

test("dispatchStartupMediaUpstream falls back to direct external redirect when followed startup playback returns html 403", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-1.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-1.mkv") {
      return new Response("<html>forbidden</html>", {
        status: 403,
        headers: {
          "Content-Type": "text/html; charset=UTF-8"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  context.forceExternalProxy = true;
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchStartupMediaUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "direct-external");
  assert.equal(upstream.response.status, 302);
  assert.equal(upstream.response.headers.get("Location"), "https://cdn.example.test/file-1.mkv");
  assert.equal(diagnostics.route, "direct-external");
  assert.equal(diagnostics.finalHost, "cdn.example.test");
  assert.equal(diagnostics.upstreamStatus, 403);
  assert.equal(diagnostics.upstreamContentType, "text/html; charset=UTF-8");
  assert.equal(diagnostics.upstreamCacheStatus, "");
  assert.equal(diagnostics.debugReason, "startup-followed-html-4xx");
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    "https://cdn.example.test/file-1.mkv",
    "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1"
  ]);
});

test("dispatchContinuationMediaUpstream keeps continued playback redirects on the short path while preserving budget routes", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/12/original.mkv?DeviceId=a&MediaSourceId=ms-12&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-12.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-12.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 64-68/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/12/original.mkv?DeviceId=a&MediaSourceId=ms-12&api_key=x&PlaySessionId=play-1",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/12/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/12/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  calls.length = 0;

  const continuationRequest = new Request(
    `https://proxy.example.test/alpha/videos/12/original.mkv?DeviceId=b&DeviceName=tablet&Client=senplayer&MediaSourceId=ms-12&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000`,
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const continuationState = await normalizeIncomingRequest(GLOBALS, continuationRequest, "/videos/12/original.mkv", context);
  const continuationDiagnostics = createDiagnostics("/videos/12/original.mkv", continuationState);
  const continuationUpstream = await dispatchContinuationMediaUpstream({
    request: continuationRequest,
    requestState: continuationState,
    context,
    diagnostics: continuationDiagnostics
  });

  assert.equal(continuationUpstream.response.status, 206);
  assert.equal(continuationUpstream.route, "redirect-cache");
  assert.equal(continuationDiagnostics.route, "budget-degraded-redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-12.mkv"]);
});

test("dispatchContinuationMediaUpstream reuses redirect resolutions established by startup playback requests", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/21/original.mkv?DeviceId=a&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-21.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-21.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const startupRequest = new Request(
    "https://proxy.example.test/alpha/videos/21/original.mkv?DeviceId=a&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const startupState = await normalizeIncomingRequest(GLOBALS, startupRequest, "/videos/21/original.mkv", context);
  const startupDiagnostics = createDiagnostics("/videos/21/original.mkv", startupState);
  const startupUpstream = await dispatchStartupMediaUpstream({
    request: startupRequest,
    requestState: startupState,
    context,
    diagnostics: startupDiagnostics
  });

  assert.equal(startupUpstream.response.status, 206);
  assert.equal(startupUpstream.route, "followed");

  calls.length = 0;

  const continuationRequest = new Request(
    `https://proxy.example.test/alpha/videos/21/original.mkv?DeviceId=b&DeviceName=tablet&Client=senplayer&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000`,
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const continuationState = await normalizeIncomingRequest(GLOBALS, continuationRequest, "/videos/21/original.mkv", context);
  const continuationDiagnostics = createDiagnostics("/videos/21/original.mkv", continuationState);
  const continuationUpstream = await dispatchContinuationMediaUpstream({
    request: continuationRequest,
    requestState: continuationState,
    context,
    diagnostics: continuationDiagnostics
  });

  assert.equal(continuationUpstream.response.status, 206);
  assert.equal(continuationUpstream.route, "redirect-cache");
  assert.equal(continuationDiagnostics.route, "budget-degraded-redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-21.mkv"]);
});

test("dispatchContinuationMediaUpstream rehydrates shallow startup continuations from a seeded sticky lane when redirect cache was cleared", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/21/original.mkv?DeviceId=a&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-21.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-21.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 629318-629322/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const startupRequest = new Request(
    "https://proxy.example.test/alpha/videos/21/original.mkv?DeviceId=a&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const startupState = await normalizeIncomingRequest(GLOBALS, startupRequest, "/videos/21/original.mkv", context);
  const startupDiagnostics = createDiagnostics("/videos/21/original.mkv", startupState);
  const startupUpstream = await dispatchStartupMediaUpstream({
    request: startupRequest,
    requestState: startupState,
    context,
    diagnostics: startupDiagnostics
  });

  assert.equal(startupUpstream.response.status, 206);
  assert.equal(startupUpstream.route, "followed");
  assert.equal(GLOBALS.PlaybackContinuationLanes?.size, 1);

  clearExternalRedirectUrl(
    GLOBALS,
    startupState.method,
    startupState.activeFinalUrl,
    context
  );
  calls.length = 0;

  const continuationRequest = new Request(
    "https://proxy.example.test/alpha/videos/21/original.mkv?DeviceId=a&MediaSourceId=ms-21&api_key=x&PlaySessionId=play-1",
    {
      headers: {
        Range: "bytes=629318-"
      }
    }
  );
  const continuationState = await normalizeIncomingRequest(GLOBALS, continuationRequest, "/videos/21/original.mkv", context);
  const continuationDiagnostics = createDiagnostics("/videos/21/original.mkv", continuationState);
  const continuationUpstream = await dispatchContinuationMediaUpstream({
    request: continuationRequest,
    requestState: continuationState,
    context,
    diagnostics: continuationDiagnostics
  });

  assert.equal(continuationUpstream.response.status, 206);
  assert.equal(continuationUpstream.route, "redirect-cache");
  assert.equal(continuationDiagnostics.route, "redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-21.mkv"]);
});

test("dispatchContinuationMediaUpstream retries one deep continuation 503 before surfacing failure", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://cdn.example.test/file-22.mkv" && calls.length === 1) {
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    if (normalizedUrl === "https://origin.example.test/videos/22/original.mkv?DeviceId=a&MediaSourceId=ms-22&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-22.mkv"
        }
      });
    }
    if (normalizedUrl === "https://origin.example.test/videos/22/original.mkv?DeviceId=b&Client=senplayer&MediaSourceId=ms-22&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-22.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-22.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/22/original.mkv?DeviceId=a&MediaSourceId=ms-22&api_key=x&PlaySessionId=play-1",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/22/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/22/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  calls.length = 0;

  const continuationRequest = new Request(
    "https://proxy.example.test/alpha/videos/22/original.mkv?DeviceId=b&Client=senplayer&MediaSourceId=ms-22&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const continuationState = await normalizeIncomingRequest(GLOBALS, continuationRequest, "/videos/22/original.mkv", context);
  const continuationDiagnostics = createDiagnostics("/videos/22/original.mkv", continuationState);
  const continuationUpstream = await dispatchContinuationMediaUpstream({
    request: continuationRequest,
    requestState: continuationState,
    context,
    diagnostics: continuationDiagnostics
  });

  assert.equal(continuationUpstream.response.status, 206);
  assert.equal(continuationUpstream.route, "followed");
  assert.equal(continuationDiagnostics.route, "budget-degraded-followed");
  assert.equal(continuationDiagnostics.upstreamStatus, 206);
  assert.deepEqual(calls, [
    "https://cdn.example.test/file-22.mkv",
    "https://origin.example.test/videos/22/original.mkv?DeviceId=b&Client=senplayer&MediaSourceId=ms-22&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000",
    "https://cdn.example.test/file-22.mkv"
  ]);
});

test("dispatchContinuationMediaUpstream records and reuses a sticky continuation lane for the same session", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  let phase = "initial";
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin-a.example.test/videos/31/original.mkv?MediaSourceId=ms-31&PlaySessionId=play-31") {
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    if (normalizedUrl === "https://origin-b.example.test/videos/31/original.mkv?MediaSourceId=ms-31&PlaySessionId=play-31") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": phase === "initial" ? "bytes 67108864-67108868/1000" : "bytes 67110912-67110916/1000"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");

  const firstRequest = new Request(
    "https://proxy.example.test/alpha/videos/31/original.mkv?MediaSourceId=ms-31&PlaySessionId=play-31",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const firstState = await normalizeIncomingRequest(GLOBALS, firstRequest, "/videos/31/original.mkv", context);
  const firstDiagnostics = createDiagnostics("/videos/31/original.mkv", firstState);
  const firstUpstream = await dispatchContinuationMediaUpstream({
    request: firstRequest,
    requestState: firstState,
    context,
    diagnostics: firstDiagnostics
  });

  assert.equal(firstUpstream.response.status, 206);
  assert.equal(firstUpstream.route, "origin-failover");
  assert.equal(firstDiagnostics.route, "budget-degraded-origin-failover");
  assert.equal(GLOBALS.PlaybackContinuationLanes?.size, 1);
  const firstLane = [...GLOBALS.PlaybackContinuationLanes.values()][0];
  assert.equal(firstLane?.targetIndex, 1);
  assert.equal(firstLane?.targetHost, "origin-b.example.test");

  phase = "reuse";
  calls.length = 0;

  const secondRequest = new Request(
    "https://proxy.example.test/alpha/videos/31/original.mkv?MediaSourceId=ms-31&PlaySessionId=play-31",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 2048}-`
      }
    }
  );
  const secondState = await normalizeIncomingRequest(GLOBALS, secondRequest, "/videos/31/original.mkv", context);
  const secondDiagnostics = createDiagnostics("/videos/31/original.mkv", secondState);
  const secondUpstream = await dispatchContinuationMediaUpstream({
    request: secondRequest,
    requestState: secondState,
    context,
    diagnostics: secondDiagnostics
  });

  assert.equal(secondUpstream.response.status, 206);
  assert.equal(secondUpstream.route, "passthrough");
  assert.equal(secondDiagnostics.route, "budget-degraded-passthrough");
  assert.deepEqual(calls, [
    "https://origin-b.example.test/videos/31/original.mkv?MediaSourceId=ms-31&PlaySessionId=play-31"
  ]);
});

test("dispatchContinuationMediaUpstream ignores expired sticky continuation lanes", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin-a.example.test/videos/32/original.mkv?MediaSourceId=ms-32&PlaySessionId=play-32") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 67108864-67108868/1000"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");

  const continuationRequest = new Request(
    "https://proxy.example.test/alpha/videos/32/original.mkv?MediaSourceId=ms-32&PlaySessionId=play-32",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const continuationState = await normalizeIncomingRequest(GLOBALS, continuationRequest, "/videos/32/original.mkv", context);
  continuationState.playbackWindowSessionKey = buildPlaybackWindowSessionKey(continuationState);
  GLOBALS.PlaybackContinuationLanes.set(continuationState.playbackWindowSessionKey, {
    targetIndex: 1,
    targetHost: "origin-b.example.test",
    route: "passthrough",
    updatedAt: Date.now() - 60000
  });
  const continuationDiagnostics = createDiagnostics("/videos/32/original.mkv", continuationState);
  const continuationUpstream = await dispatchContinuationMediaUpstream({
    request: continuationRequest,
    requestState: continuationState,
    context,
    diagnostics: continuationDiagnostics
  });

  assert.equal(continuationUpstream.response.status, 206);
  assert.equal(continuationUpstream.route, "passthrough");
  assert.equal(continuationDiagnostics.route, "budget-degraded-passthrough");
  assert.deepEqual(calls, [
    "https://origin-a.example.test/videos/32/original.mkv?MediaSourceId=ms-32&PlaySessionId=play-32"
  ]);
});

test("dispatchContinuationMediaUpstream clears sticky continuation lanes after terminal continuation failure", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  let phase = "warm";
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin-a.example.test/videos/33/original.mkv?MediaSourceId=ms-33&PlaySessionId=play-33") {
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    if (normalizedUrl === "https://origin-b.example.test/videos/33/original.mkv?MediaSourceId=ms-33&PlaySessionId=play-33") {
      if (phase === "warm") {
        return new Response("media", {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "5",
            "Content-Range": "bytes 67108864-67108868/1000"
          }
        });
      }
      return new Response("busy", {
        status: 503,
        headers: {
          "Content-Type": "video/mp4"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/33/original.mkv?MediaSourceId=ms-33&PlaySessionId=play-33",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES}-`
      }
    }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/33/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/33/original.mkv", warmState);
  const warmUpstream = await dispatchContinuationMediaUpstream({
    request: warmRequest,
    requestState: warmState,
    context,
    diagnostics: warmDiagnostics
  });

  assert.equal(warmUpstream.response.status, 206);
  assert.equal(GLOBALS.PlaybackContinuationLanes?.size, 1);

  phase = "fail";
  calls.length = 0;

  const failingRequest = new Request(
    "https://proxy.example.test/alpha/videos/33/original.mkv?MediaSourceId=ms-33&PlaySessionId=play-33",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 2048}-`
      }
    }
  );
  const failingState = await normalizeIncomingRequest(GLOBALS, failingRequest, "/videos/33/original.mkv", context);
  const failingDiagnostics = createDiagnostics("/videos/33/original.mkv", failingState);
  const failingUpstream = await dispatchContinuationMediaUpstream({
    request: failingRequest,
    requestState: failingState,
    context,
    diagnostics: failingDiagnostics
  });

  assert.equal(Number(failingUpstream.response?.status || failingUpstream.errorResponse?.status || 0), 503);
  assert.equal(GLOBALS.PlaybackContinuationLanes?.size, 0);
});

test("dispatchContinuationMediaUpstream applies one narrow stall recovery after repeated small deep-range advances", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const range = init.headers?.get?.("Range") || "";
    calls.push({ url: normalizedUrl, range });
    if (normalizedUrl === "https://origin-a.example.test/videos/41/original.mkv?MediaSourceId=ms-41&PlaySessionId=play-41") {
      return new Response("media-a", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    if (normalizedUrl === "https://origin-b.example.test/videos/41/original.mkv?MediaSourceId=ms-41&PlaySessionId=play-41") {
      return new Response("media-b", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");

  const starts = [
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 256 * 1024,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 512 * 1024
  ];
  for (const start of starts) {
    const request = new Request(
      "https://proxy.example.test/alpha/videos/41/original.mkv?MediaSourceId=ms-41&PlaySessionId=play-41",
      {
        headers: {
          Range: `bytes=${start}-`
        }
      }
    );
    const state = await normalizeIncomingRequest(GLOBALS, request, "/videos/41/original.mkv", context);
    const diagnostics = createDiagnostics("/videos/41/original.mkv", state);
    const upstream = await dispatchContinuationMediaUpstream({
      request,
      requestState: state,
      context,
      diagnostics
    });
    assert.equal(upstream.response.status, 206);
  }

  calls.length = 0;

  const recoveryRequest = new Request(
    "https://proxy.example.test/alpha/videos/41/original.mkv?MediaSourceId=ms-41&PlaySessionId=play-41",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
      }
    }
  );
  const recoveryState = await normalizeIncomingRequest(GLOBALS, recoveryRequest, "/videos/41/original.mkv", context);
  const recoveryDiagnostics = createDiagnostics("/videos/41/original.mkv", recoveryState);
  const recoveryUpstream = await dispatchContinuationMediaUpstream({
    request: recoveryRequest,
    requestState: recoveryState,
    context,
    diagnostics: recoveryDiagnostics
  });

  assert.equal(recoveryUpstream.response.status, 206);
  assert.equal(recoveryUpstream.route, "origin-failover");
  assert.equal(recoveryDiagnostics.route, "budget-degraded-origin-failover");
  assert.deepEqual(calls, [
    {
      url: "https://origin-b.example.test/videos/41/original.mkv?MediaSourceId=ms-41&PlaySessionId=play-41",
      range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
    }
  ]);
});

test("dispatchContinuationMediaUpstream does not arm stall recovery for healthy large deep-range advances", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const range = init.headers?.get?.("Range") || "";
    calls.push({ url: normalizedUrl, range });
    if (normalizedUrl === "https://origin-a.example.test/videos/42/original.mkv?MediaSourceId=ms-42&PlaySessionId=play-42") {
      return new Response("media-a", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    if (normalizedUrl === "https://origin-b.example.test/videos/42/original.mkv?MediaSourceId=ms-42&PlaySessionId=play-42") {
      return new Response("media-b", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");

  const starts = [
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 16 * 1024 * 1024,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 32 * 1024 * 1024
  ];
  for (const start of starts) {
    const request = new Request(
      "https://proxy.example.test/alpha/videos/42/original.mkv?MediaSourceId=ms-42&PlaySessionId=play-42",
      {
        headers: {
          Range: `bytes=${start}-`
        }
      }
    );
    const state = await normalizeIncomingRequest(GLOBALS, request, "/videos/42/original.mkv", context);
    const diagnostics = createDiagnostics("/videos/42/original.mkv", state);
    const upstream = await dispatchContinuationMediaUpstream({
      request,
      requestState: state,
      context,
      diagnostics
    });
    assert.equal(upstream.response.status, 206);
  }

  calls.length = 0;

  const steadyRequest = new Request(
    "https://proxy.example.test/alpha/videos/42/original.mkv?MediaSourceId=ms-42&PlaySessionId=play-42",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 48 * 1024 * 1024}-`
      }
    }
  );
  const steadyState = await normalizeIncomingRequest(GLOBALS, steadyRequest, "/videos/42/original.mkv", context);
  const steadyDiagnostics = createDiagnostics("/videos/42/original.mkv", steadyState);
  const steadyUpstream = await dispatchContinuationMediaUpstream({
    request: steadyRequest,
    requestState: steadyState,
    context,
    diagnostics: steadyDiagnostics
  });

  assert.equal(steadyUpstream.response.status, 206);
  assert.equal(steadyUpstream.route, "passthrough");
  assert.equal(steadyDiagnostics.route, "budget-degraded-passthrough");
  assert.deepEqual(calls, [
    {
      url: "https://origin-a.example.test/videos/42/original.mkv?MediaSourceId=ms-42&PlaySessionId=play-42",
      range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 48 * 1024 * 1024}-`
    }
  ]);
});

test("dispatchContinuationMediaUpstream clears redirect cache once when a continuation stall recovery is armed", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/43/original.mkv?MediaSourceId=ms-43&PlaySessionId=play-43") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://cdn.example.test/file-43.mkv"
        }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-43.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/43/original.mkv?MediaSourceId=ms-43&PlaySessionId=play-43",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/43/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/43/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  const recoveryRequest = new Request(
    "https://proxy.example.test/alpha/videos/43/original.mkv?MediaSourceId=ms-43&PlaySessionId=play-43",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
      }
    }
  );
  const recoveryState = await normalizeIncomingRequest(GLOBALS, recoveryRequest, "/videos/43/original.mkv", context);
  recoveryState.playbackWindowSessionKey = buildPlaybackWindowSessionKey(recoveryState);
  GLOBALS.PlaybackContinuationStalls.set(recoveryState.playbackWindowSessionKey, {
    lastRangeStart: PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 512 * 1024,
    targetIndex: 0,
    updatedAt: Date.now(),
    smallAdvanceStreak: 2
  });

  calls.length = 0;

  const recoveryDiagnostics = createDiagnostics("/videos/43/original.mkv", recoveryState);
  const recoveryUpstream = await dispatchContinuationMediaUpstream({
    request: recoveryRequest,
    requestState: recoveryState,
    context,
    diagnostics: recoveryDiagnostics
  });

  assert.equal(recoveryUpstream.response.status, 206);
  assert.equal(recoveryUpstream.route, "followed");
  assert.equal(recoveryDiagnostics.route, "budget-degraded-followed");
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/43/original.mkv?MediaSourceId=ms-43&PlaySessionId=play-43",
    "https://cdn.example.test/file-43.mkv"
  ]);
});

test("dispatchContinuationMediaUpstream caps the first stall recovery probe and falls back to the original target", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const range = init.headers?.get?.("Range") || "";
    calls.push({ url: normalizedUrl, range });
    if (normalizedUrl === "https://origin-a.example.test/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44") {
      return new Response("media-a", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    if (normalizedUrl === "https://origin-b.example.test/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44") {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      return new Response("media-b", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": `${range.replace("=", " ")}4/1000`.replace("bytes ", "bytes ")
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    lines: [
      { id: "line-1", name: "主线", target: "https://origin-a.example.test/emby" },
      { id: "line-2", name: "备用", target: "https://origin-b.example.test/emby" }
    ],
    activeLineId: "line-1"
  }, "alpha", "");
  context.continuationRecoveryTimeoutMs = 25;

  const starts = [
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 256 * 1024,
    PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 512 * 1024
  ];
  for (const start of starts) {
    const request = new Request(
      "https://proxy.example.test/alpha/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44",
      {
        headers: {
          Range: `bytes=${start}-`
        }
      }
    );
    const state = await normalizeIncomingRequest(GLOBALS, request, "/videos/44/original.mkv", context);
    const diagnostics = createDiagnostics("/videos/44/original.mkv", state);
    const upstream = await dispatchContinuationMediaUpstream({
      request,
      requestState: state,
      context,
      diagnostics
    });
    assert.equal(upstream.response.status, 206);
  }

  calls.length = 0;

  const recoveryRequest = new Request(
    "https://proxy.example.test/alpha/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44",
    {
      headers: {
        Range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
      }
    }
  );
  const recoveryState = await normalizeIncomingRequest(GLOBALS, recoveryRequest, "/videos/44/original.mkv", context);
  const recoveryDiagnostics = createDiagnostics("/videos/44/original.mkv", recoveryState);
  const recoveryUpstream = await dispatchContinuationMediaUpstream({
    request: recoveryRequest,
    requestState: recoveryState,
    context,
    diagnostics: recoveryDiagnostics
  });

  assert.equal(recoveryUpstream.response.status, 206);
  assert.equal(recoveryUpstream.route, "origin-failover");
  assert.equal(recoveryDiagnostics.route, "budget-degraded-origin-failover");
  assert.deepEqual(calls, [
    {
      url: "https://origin-b.example.test/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44",
      range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
    },
    {
      url: "https://origin-a.example.test/videos/44/original.mkv?MediaSourceId=ms-44&PlaySessionId=play-44",
      range: `bytes=${PLAYBACK_OPTIMIZATION_DEEP_RANGE_START_BYTES + 768 * 1024}-`
    }
  ]);
});

test("proxy handle falls back to the generic path when startup playback needs media basepath recovery", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1") {
      return new Response("missing", {
        status: 404,
        headers: {
          "Content-Type": "text/plain"
        }
      });
    }
    if (normalizedUrl === "https://origin.example.test/emby/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1") {
      return new Response("ABCDEFGH", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/8"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/videos/1/original.mkv",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("X-Proxy-Route"), "basepath-fallback");
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    "https://origin.example.test/emby/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1"
  ]);
});

test("proxy handle falls back to the generic path when lightweight metadata fast path needs media basepath recovery", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/1/main.m3u8?tag=demo") {
      return new Response("missing", {
        status: 404,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl"
        }
      });
    }
    if (normalizedUrl === "https://origin.example.test/emby/videos/1/main.m3u8?tag=demo") {
      return new Response("#EXTM3U", {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/main.m3u8?tag=demo");
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/videos/1/main.m3u8",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Proxy-Route"), "basepath-fallback");
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/1/main.m3u8?tag=demo",
    "https://origin.example.test/emby/videos/1/main.m3u8?tag=demo"
  ]);
  assert.equal(GLOBALS.PlaybackOptimizationStats.basepath.fallback, 0);
});

test("proxy handle falls back to the generic path when subtitle fast path needs media basepath recovery", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/1/subtitles/1/Stream.srt?api_key=x") {
      return new Response("missing", {
        status: 404,
        headers: {
          "Content-Type": "text/plain"
        }
      });
    }
    if (normalizedUrl === "https://origin.example.test/emby/videos/1/subtitles/1/Stream.srt?api_key=x") {
      return new Response("subtitle", {
        status: 200,
        headers: {
          "Content-Type": "text/plain"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const request = new Request("https://proxy.example.test/alpha/videos/1/subtitles/1/Stream.srt?api_key=x");
  const response = await Proxy.handle(
    request,
    { target: "https://origin.example.test" },
    "/videos/1/subtitles/1/Stream.srt",
    "alpha",
    "",
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Proxy-Route"), "basepath-fallback");
  assert.deepEqual(calls, [
    "https://origin.example.test/videos/1/subtitles/1/Stream.srt?api_key=x",
    "https://origin.example.test/emby/videos/1/subtitles/1/Stream.srt?api_key=x"
  ]);
  assert.equal(GLOBALS.PlaybackOptimizationStats.basepath.fallback, 0);
});

test("dispatchUpstream keeps near-head startup probes on passthrough instead of startup merge", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      range: init.headers?.get?.("Range") || ""
    });
    return new Response("CDEFGH", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "6",
        "Content-Range": "bytes 2-7/8"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=2-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "passthrough");
  assert.equal(upstream.response.status, 206);
  assert.equal(upstream.response.headers.get("Content-Range"), "bytes 2-7/8");
  assert.equal(await upstream.response.text(), "CDEFGH");
  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
      range: "bytes=2-"
    }
  ]);
});

test("dispatchUpstream no longer synchronously primes startup windows for first playback requests", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      range: init.headers?.get?.("Range") || ""
    });
    return new Response("ABCDEFGH", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "8",
        "Content-Range": "bytes 0-7/8"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchUpstream({ request, requestState, context, diagnostics });

  assert.equal(upstream.route, "passthrough");
  assert.equal(upstream.response.status, 206);
  assert.equal(upstream.response.headers.get("Content-Range"), "bytes 0-7/8");
  assert.equal(await upstream.response.text(), "ABCDEFGH");
  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
      range: "bytes=0-"
    }
  ]);
});

test("dispatchUpstream keeps large bounded playback requests on passthrough without startup assistance", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      range: init.headers?.get?.("Range") || ""
    });
    return new Response("ORIGIN", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "6",
        "Content-Range": "bytes 0-5/100000000"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const request = new Request(
    "https://proxy.example.test/alpha/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
    {
      headers: {
        Range: "bytes=0-737298105"
      }
    }
  );
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.route, "passthrough");
  assert.equal(await upstream.response.text(), "ORIGIN");
  assert.deepEqual(calls, [
    {
      url: "https://origin.example.test/videos/1/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1",
      range: "bytes=0-737298105"
    }
  ]);
});

test("buildExternalRedirectCacheKey canonicalizes equivalent media urls and shares GET/HEAD without proxy wrapper", () => {
  const getKey = buildExternalRedirectCacheKey(
    "GET",
    "https://origin.example.test/emby/videos/1/original.mkv?api_key=x&DeviceId=a&t=1",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const headKey = buildExternalRedirectCacheKey(
    "HEAD",
    "https://origin.example.test/videos/1/original.mkv?DeviceId=a&api_key=x",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const playbackInfoWarmKey = buildExternalRedirectCacheKey(
    "HEAD",
    "https://origin.example.test/videos/1/original.mkv?DeviceId=a&MediaSourceId=ms-1&api_key=x&PlaySessionId=play-1",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const firstPlaybackGetKey = buildExternalRedirectCacheKey(
    "GET",
    "https://origin.example.test/videos/1/original.mkv?MediaSourceId=ms-1&api_key=x&DeviceId=a&PlaySessionId=play-2",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const resumedPlaybackKey = buildExternalRedirectCacheKey(
    "GET",
    "https://origin.example.test/videos/1/original.mkv?MediaSourceId=ms-1&api_key=x&DeviceId=a&PlaySessionId=play-3&StartTimeTicks=900000",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const deviceSwappedPlaybackKey = buildExternalRedirectCacheKey(
    "GET",
    "https://origin.example.test/videos/1/original.mkv?MediaSourceId=ms-1&api_key=x&DeviceId=b&PlaySessionId=play-4&Client=senplayer&DeviceName=tablet",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const malformedKey = buildExternalRedirectCacheKey(
    "GET",
    "https://origin.example.test/embyemby/videos/1/original.mkv?DeviceId=a&api_key=x&random=1",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );
  const compactMalformedKey = buildExternalRedirectCacheKey(
    "HEAD",
    "https://origin.example.test/embyvideos/1/original.mkv?api_key=x&DeviceId=a",
    { noiseQueryKeys: EXTERNAL_REDIRECT_CACHE_NOISE_QUERY_KEYS }
  );

  assert.equal(getKey, headKey);
  assert.equal(playbackInfoWarmKey, firstPlaybackGetKey);
  assert.equal(playbackInfoWarmKey, resumedPlaybackKey);
  assert.equal(playbackInfoWarmKey, deviceSwappedPlaybackKey);
  assert.equal(getKey, malformedKey);
  assert.equal(getKey, compactMalformedKey);
});

test("createRuntimeGlobals no longer exposes seek/tail playback caches or stats buckets", () => {
  const globals = createRuntimeGlobals();
  assert.equal("TailRangeWindowCache" in globals, false);
  assert.equal("SeekRangeWindowCache" in globals, false);
  assert.equal("SuccessfulPlaybackStartCache" in globals, false);
  assert.equal("tail" in globals.PlaybackOptimizationStats, false);
  assert.equal("seek" in globals.PlaybackOptimizationStats, false);
});

test("normalizeIncomingPath repairs malformed emby playback path variants without proxy wrapper", () => {
  const requestUrl = new URL("https://proxy.example.test/panda/emby/videos/1/original.mp4");
  assert.equal(
    normalizeIncomingPath("/embyemby/videos/1/original.mp4", requestUrl, "/emby", "/panda"),
    "/emby/videos/1/original.mp4"
  );
  assert.equal(
    normalizeIncomingPath("/embyvideos/1/original.mp4", requestUrl, "/emby", "/panda"),
    "/emby/videos/1/original.mp4"
  );
  assert.equal(
    normalizeIncomingPath("/emby/panda/emby/videos/1/original.mp4", requestUrl, "/emby", "/panda"),
    "/emby/videos/1/original.mp4"
  );
  assert.equal(
    normalizeIncomingPath("/emby/https://proxy.example.test/panda/videos/1/original.mp4", requestUrl, "/emby", "/panda"),
    "/emby/videos/1/original.mp4"
  );
});

test("redirect cache persistence is optional and defaults to fail-open", async () => {
  resetGlobals();
  const kvStore = new Map();
  const kv = {
    async get(key, options = {}) {
      const value = kvStore.get(String(key));
      if (value == null) return null;
      if (options.type === "json") return JSON.parse(String(value));
      return String(value);
    },
    async put(key, value) {
      kvStore.set(String(key), String(value));
    },
    async delete(key) {
      kvStore.delete(String(key));
      return true;
    }
  };
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(Promise.resolve(promise));
    }
  };
  const enabledContext = {
    redirectCachePersistenceEnabled: true,
    redirectCachePersistenceTtlSeconds: 120,
    redirectCacheKv: kv,
    executionContext
  };
  const disabledContext = {
    redirectCachePersistenceEnabled: false,
    redirectCachePersistenceTtlSeconds: 120,
    redirectCacheKv: kv,
    executionContext: {
      tasks: [],
      waitUntil(promise) {
        this.tasks.push(Promise.resolve(promise));
      }
    }
  };

  const originUrl = "https://origin.example.test/embyvideos/1/original.mkv?api_key=x&DeviceId=a";
  const canonicalUrl = "https://origin.example.test/videos/1/original.mkv?DeviceId=a&api_key=x";
  const redirectUrl = "https://cdn.example.test/media/1.mkv";

  rememberExternalRedirectUrl(GLOBALS, "GET", originUrl, redirectUrl, { context: enabledContext });
  await Promise.allSettled(enabledContext.executionContext.tasks);
  GLOBALS.ExternalRedirectCache.clear();

  const resolved = await resolveCachedExternalRedirectUrl(GLOBALS, "HEAD", canonicalUrl, enabledContext);
  assert.equal(resolved?.toString(), redirectUrl);

  GLOBALS.ExternalRedirectCache.clear();
  const skipped = await resolveCachedExternalRedirectUrl(GLOBALS, "GET", canonicalUrl, disabledContext);
  assert.equal(skipped, null);
});

test("learned base path caches and clears by channel", async () => {
  resetGlobals();
  await cacheLearnedBasePath(GLOBALS, "dongying", "media", "/emby");
  await cacheLearnedBasePath(GLOBALS, "dongying", "api", "/jellyfin");

  assert.equal(await getCachedLearnedBasePath(GLOBALS, "dongying", "media"), "/emby");
  assert.equal(await getCachedLearnedBasePath(GLOBALS, "dongying", "api"), "/jellyfin");

  await clearCachedLearnedBasePath(GLOBALS, "dongying", "media");
  assert.equal(await getCachedLearnedBasePath(GLOBALS, "dongying", "media"), "");
  assert.equal(await getCachedLearnedBasePath(GLOBALS, "dongying", "api"), "/jellyfin");
});

test("base path channel detection recognizes prefixed media and api paths", () => {
  assert.equal(detectBasePathChannel("/emby/videos/1/original.mkv"), "media");
  assert.equal(detectBasePathChannel("/jellyfin/Items/1/PlaybackInfo"), "api");
});

test("cf cache keys distinguish host mode and part under fixed 24h window", () => {
  const config = { accountId: "acc" };
  assert.equal(CFAnalytics.FIXED_RANGE.key, "24h");
  assert.notEqual(
    CFAnalytics.buildCacheKey(config, "worker", "full", "a.example.com"),
    CFAnalytics.buildCacheKey(config, "worker", "activity", "a.example.com")
  );
  assert.notEqual(
    CFAnalytics.buildCacheKey(config, "worker", "full", "a.example.com"),
    CFAnalytics.buildCacheKey(config, "worker", "full", "b.example.com")
  );
  assert.notEqual(
    CFAnalytics.buildMetricPartCacheKey(config, "worker", "summary", "a.example.com"),
    CFAnalytics.buildMetricPartCacheKey(config, "worker", "topPaths", "a.example.com")
  );
  assert.match(
    CFAnalytics.buildMetricPartCacheKey(config, "worker", "activity", "a.example.com"),
    /\|activity\|a\.example\.com\|activity$/
  );
});

test("cf activity cache invalidation tracks configured node signature", async t => {
  const originalGetConfig = CFAnalytics.getConfig;
  const originalParseScriptName = CFAnalytics.parseScriptName;
  const originalListConfiguredNodePaths = CFAnalytics.listConfiguredNodePaths;
  const originalGetMetricPart = CFAnalytics.getMetricPart;
  t.after(() => {
    CFAnalytics.getConfig = originalGetConfig;
    CFAnalytics.parseScriptName = originalParseScriptName;
    CFAnalytics.listConfiguredNodePaths = originalListConfiguredNodePaths;
    CFAnalytics.getMetricPart = originalGetMetricPart;
  });

  let seenSuffix = "";
  CFAnalytics.getConfig = async () => ({
    accountId: "acc",
    apiToken: "token",
    workerUrl: "https://dash.example.test/workers/services/view/worker"
  });
  CFAnalytics.parseScriptName = () => "worker";
  CFAnalytics.listConfiguredNodePaths = async () => ["panda", "1111"];
  CFAnalytics.getMetricPart = async options => {
    seenSuffix = String(options.cacheKeySuffix || "");
    return {
      value: {
        enabled: true,
        mode: "activity",
        rangeKey: "24h",
        rangeLabel: "近24小时",
        generatedAt: "2026-03-20T12:00:00.000Z",
        updatedAt: "2026-03-20T12:00:00.000Z",
        nodeActivityAvailable: false,
        nodeActivity: {}
      },
      cacheHit: false
    };
  };

  const response = await CFAnalytics.handleMetrics(
    "24h",
    {},
    "activity",
    new Request("https://media.example.test/admin")
  );
  const data = await response.json();

  assert.equal(seenSuffix, "1111,panda");
  assert.equal(data.rangeKey, "24h");
});

test("cf top paths only keep configured site nodes", () => {
  const rows = [
    {
      dimensions: { metric: "/admin" },
      count: 99,
      sum: { edgeResponseBytes: 9999 }
    },
    {
      dimensions: { metric: "/1111/emby/Items/1/Images/Primary" },
      count: 8,
      sum: { edgeResponseBytes: 800 }
    },
    {
      dimensions: { metric: "/Panda/emby/videos/2/original.mkv" },
      count: 5,
      sum: { edgeResponseBytes: 1200 }
    },
    {
      dimensions: { metric: "/__client_rtt__" },
      count: 10,
      sum: { edgeResponseBytes: 10 }
    },
    {
      dimensions: { metric: "/dongying/web/index.html" },
      count: 3,
      sum: { edgeResponseBytes: 300 }
    },
    {
      dimensions: { metric: "/other/emby/System/Ping" },
      count: 20,
      sum: { edgeResponseBytes: 400 }
    }
  ];

  const result = CFAnalytics.normalizeTopPaths(rows, ["1111", "panda", "dongying"]);

  assert.deepEqual(
    result.map(item => item.path),
    ["panda", "1111", "dongying"]
  );
  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 2);
  assert.equal(result[2].rank, 3);
});

test("cf top paths query filters configured node paths before Cloudflare applies limit", async t => {
  const originalRunQuery = CFAnalytics.runQuery;
  t.after(() => {
    CFAnalytics.runQuery = originalRunQuery;
  });

  let capturedVariables = null;
  CFAnalytics.runQuery = async (_config, _query, variables) => {
    capturedVariables = variables;
    return {
      data: {
        viewer: {
          zones: [{
            topPaths: []
          }]
        }
      }
    };
  };

  const result = await CFAnalytics.fetchZoneTopPaths(
    { apiToken: "token" },
    "zone-1",
    "media.example.test",
    "2026-03-19T00:00:00Z",
    "2026-03-20T00:00:00Z",
    100,
    ["1111", "panda"]
  );

  assert.equal(result.available, true);
  assert.deepEqual(capturedVariables?.filter?.AND?.[3], {
    OR: [
      { clientRequestPath: "/1111" },
      { clientRequestPath_like: "/1111/%" },
      { clientRequestPath: "/panda" },
      { clientRequestPath_like: "/panda/%" }
    ]
  });
});

test("cf site traffic filters match exact node paths and nested requests only", () => {
  assert.deepEqual(
    CFAnalytics.buildNodeTrafficPathFilters(["1111", "panda", "1111", ""]),
    [
      { clientRequestPath: "/1111" },
      { clientRequestPath_like: "/1111/%" },
      { clientRequestPath: "/panda" },
      { clientRequestPath_like: "/panda/%" }
    ]
  );
});

test("cf summary metrics aggregate configured site path traffic for fixed 24h", async t => {
  const originalResolveAnalyticsContext = CFAnalytics.resolveAnalyticsContext;
  const originalFetchZoneNodeTrafficRows = CFAnalytics.fetchZoneNodeTrafficRows;
  const originalDateNow = Date.now;
  t.after(() => {
    CFAnalytics.resolveAnalyticsContext = originalResolveAnalyticsContext;
    CFAnalytics.fetchZoneNodeTrafficRows = originalFetchZoneNodeTrafficRows;
    Date.now = originalDateNow;
  });

  const queryCalls = [];
  CFAnalytics.resolveAnalyticsContext = async () => ({
    hostname: "auto.example.test",
    zone: { id: "zone-1" },
    error: null
  });
  CFAnalytics.fetchZoneNodeTrafficRows = async (_config, zoneId, hostname, nodePaths, since) => {
    queryCalls.push({ zoneId, hostname, nodePaths: [...nodePaths] });
    if (String(since).startsWith("2026-03-18T12:00:00.000Z")) {
      return {
        available: true,
        rows: [
          {
            count: 2,
            dimensions: { datetimeHour: "2026-03-19T13:00:00Z" },
            sum: { edgeResponseBytes: 100 }
          }
        ]
      };
    }
    return {
      available: true,
      rows: [
        {
          count: 6,
          dimensions: { datetimeHour: "2026-03-20T10:00:00Z" },
          sum: { edgeResponseBytes: 300 }
        },
        {
          count: 4,
          dimensions: { datetimeHour: "2026-03-20T11:00:00Z" },
          sum: { edgeResponseBytes: 200 }
        }
      ]
    };
  };
  Date.now = () => Date.parse("2026-03-20T12:00:00Z");

  const result = await CFAnalytics.computeSummaryMetrics(
    { workerUrl: "https://dash.example.test/workers/services/view/worker" },
    "worker",
    CFAnalytics.FIXED_RANGE,
    "auto.example.test",
    ["1111", "panda"]
  );

  assert.equal(queryCalls.length, 2);
  assert.deepEqual(queryCalls[0].nodePaths, ["1111", "panda"]);
  assert.equal(result.rangeKey, "24h");
  assert.equal(result.metrics.requests.value, 10);
  assert.equal(result.metrics.trafficSummary.totalBytes, 500);
  assert.equal(result.metrics.trafficSummary.estimated, false);
  assert.match(result.domainTrafficHint, /已配置站点路径/);
  assert.match(result.recentDomainsHint, /近24小时/);
});

test("buildCloudflareFetchOptions keeps metadata JSON out of edge cache while caching subtitle and image but not manifest", () => {
  const metadataOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: true,
    isSubtitle: false,
    isImage: false,
    isManifest: false,
    prewarmCacheTtl: 180,
    activeFinalUrl: new URL("https://origin.example.test/items/1?api_key=secret&_t=1")
  });
  const subtitleOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: true,
    isManifest: false,
    isImage: false,
    prewarmCacheTtl: 180,
    activeFinalUrl: new URL("https://origin.example.test/videos/1/subtitles/2/0/Stream.srt?api_key=secret")
  });
  const imageOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isManifest: false,
    isImage: true,
    imageCacheMaxAge: 86400 * 30,
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/Images/Primary?maxWidth=400&quality=90&tag=abc&api_key=secret")
  });
  const prewarmedImageOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: true,
    isSubtitle: false,
    isManifest: false,
    isImage: true,
    prewarmCacheTtl: 180,
    imageCacheMaxAge: 86400 * 30,
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/Images/Primary?tag=abc&api_key=secret")
  });
  const manifestOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isManifest: true,
    isImage: false,
    activeFinalUrl: new URL("https://origin.example.test/videos/1/main.m3u8?MediaSourceId=1&tag=abc")
  });
  const unsafeManifestOptions = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isManifest: true,
    isImage: false,
    activeFinalUrl: new URL("https://origin.example.test/videos/1/main.m3u8?MediaSourceId=1&tag=abc&transcoding=true")
  });

  assert.equal(metadataOptions.cacheEverything, false);
  assert.equal(metadataOptions.cacheTtl, 0);
  assert.equal("cacheKey" in metadataOptions, false);
  assert.equal("cacheTtlByStatus" in metadataOptions, false);
  assert.equal(subtitleOptions.cacheEverything, true);
  assert.equal(subtitleOptions.cacheTtl, 86400);
  assert.equal("cacheKey" in subtitleOptions, false);
  assert.equal("cacheTtlByStatus" in subtitleOptions, false);
  assert.equal(imageOptions.cacheEverything, true);
  assert.equal(imageOptions.cacheTtl, 86400 * 30);
  assert.equal(prewarmedImageOptions.cacheEverything, true);
  assert.equal(prewarmedImageOptions.cacheTtl, 86400 * 30);
  assert.equal(
    imageOptions.cacheKey,
    "https://origin.example.test/emby/Items/1/Images/Primary?api_key=secret&maxWidth=400&quality=90&tag=abc"
  );
  assert.equal(manifestOptions.cacheEverything, false);
  assert.equal(manifestOptions.cacheTtl, 0);
  assert.equal("cacheKey" in manifestOptions, false);
  assert.equal(unsafeManifestOptions.cacheEverything, false);
  assert.equal(unsafeManifestOptions.cacheTtl, 0);
});
test("buildCloudflareFetchOptions canonicalizes image cache keys without collapsing distinct transforms", () => {
  const first = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isImage: true,
    imageCacheMaxAge: 86400 * 30,
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/Images/Primary?quality=90&maxWidth=400&api_key=secret&t=1&tag=abc")
  });
  const second = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isImage: true,
    imageCacheMaxAge: 86400 * 30,
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/Images/Primary?tag=abc&api_key=secret&maxWidth=400&quality=90&cb=2")
  });
  const variant = buildCloudflareFetchOptions({
    method: "GET",
    rangeHeader: "",
    isMetadataPrewarm: false,
    isSubtitle: false,
    isImage: true,
    imageCacheMaxAge: 86400 * 30,
    activeFinalUrl: new URL("https://origin.example.test/emby/Items/1/Images/Primary?tag=abc&api_key=secret&maxWidth=800&quality=90")
  });

  assert.equal(first.cacheKey, second.cacheKey);
  assert.notEqual(first.cacheKey, variant.cacheKey);
});

test("cf metric part returns stale cache while refreshing", async () => {
  resetGlobals();
  const config = { accountId: "acc" };
  const key = CFAnalytics.buildMetricPartCacheKey(config, "worker", "summary", "media.example.test");
  GLOBALS.CfMetricsSummaryCache.set(key, {
    exp: Date.now() - 1000,
    staleUntil: Date.now() + 60_000,
    value: { marker: "stale" }
  });

  let refreshed = false;
  const result = await CFAnalytics.getMetricPart({
    part: "summary",
    config,
    scriptName: "worker",
    range: CFAnalytics.FIXED_RANGE,
    requestHost: "media.example.test",
    compute: async () => {
      refreshed = true;
      return { marker: "fresh" };
    }
  });

  assert.equal(result.cacheHit, true);
  assert.deepEqual(result.value, { marker: "stale" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshed, true);
});

test("cf analytics source no longer keeps historical range matrices or unused host-range helpers", async () => {
  const source = await fs.promises.readFile(new URL("../src/integrations/cf-analytics.js", import.meta.url), "utf8");

  assert.match(source, /FIXED_RANGE/);
  assert.doesNotMatch(source, /RANGES:/);
  assert.doesNotMatch(source, /CACHE_TTL_MS_BY_RANGE/);
  assert.doesNotMatch(source, /TOP_PATHS_TIMEOUT_MS_BY_RANGE/);
  assert.doesNotMatch(source, /fetchRecentDomainRows\(/);
  assert.doesNotMatch(source, /fetchZoneHostTrafficRows\(/);
});

test("playback telemetry wrapper treats aborted reads as graceful close", async () => {
  resetGlobals();
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  let cancelled = false;
  const fakeBody = {
    getReader() {
      let callCount = 0;
      return {
        async read() {
          if (callCount++ === 0) {
            return { done: false, value: new Uint8Array([1, 2, 3]) };
          }
          throw abortError;
        },
        async cancel() {
          cancelled = true;
        }
      };
    }
  };

  const wrapped = wrapPlaybackTelemetryBody(fakeBody, {
    host: "media.example.test",
    playSessionId: "play",
    mediaSourceId: "source",
    deviceId: "device",
    path: "/videos/1/original.mkv"
  });
  const reader = wrapped.getReader();
  const first = await reader.read();
  const second = await reader.read();

  assert.equal(first.done, false);
  assert.equal(first.value.byteLength, 3);
  assert.equal(second.done, true);
  assert.equal(cancelled, false);
});

test("buildProxyResponseBody uses FixedLengthStream when content length is known", async t => {
  resetGlobals();
  const originalFixedLengthStream = globalThis.FixedLengthStream;
  let capturedLength = 0;

  class FakeFixedLengthStream {
    constructor(length) {
      capturedLength = length;
      const inner = new TransformStream();
      this.readable = inner.readable;
      this.writable = inner.writable;
    }
  }

  globalThis.FixedLengthStream = FakeFixedLengthStream;
  t.after(() => {
    if (typeof originalFixedLengthStream === "undefined") {
      delete globalThis.FixedLengthStream;
      return;
    }
    globalThis.FixedLengthStream = originalFixedLengthStream;
  });

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    }
  });

  const output = buildProxyResponseBody(body, {
    contentLength: 4,
    telemetryMeta: {
      host: "proxy.example.test",
      nodeName: "alpha",
      path: "/videos/1/original.mkv",
      playSessionId: "play-1",
      mediaSourceId: "ms-1",
      deviceId: "device-1",
      itemId: "1"
    }
  });
  const buffer = new Uint8Array(await new Response(output).arrayBuffer());

  assert.equal(capturedLength, 4);
  assert.deepEqual([...buffer], [1, 2, 3, 4]);
});

test("buildProxyResponseBody bypasses FixedLengthStream for non-playback responses", async t => {
  resetGlobals();
  const originalFixedLengthStream = globalThis.FixedLengthStream;
  let fixedLengthStreamUsed = false;

  class FakeFixedLengthStream {
    constructor() {
      fixedLengthStreamUsed = true;
      const inner = new TransformStream();
      this.readable = inner.readable;
      this.writable = inner.writable;
    }
  }

  globalThis.FixedLengthStream = FakeFixedLengthStream;
  t.after(() => {
    if (typeof originalFixedLengthStream === "undefined") {
      delete globalThis.FixedLengthStream;
      return;
    }
    globalThis.FixedLengthStream = originalFixedLengthStream;
  });

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      controller.close();
    }
  });

  const output = buildProxyResponseBody(body, {
    contentLength: 11,
    telemetryMeta: null
  });
  const text = await new Response(output).text();

  assert.equal(fixedLengthStreamUsed, false);
  assert.equal(text, '{"ok":true}');
});

test("dispatchUpstream fails over playbackinfo requests to the next target", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    if (String(url).startsWith("https://a.example.test")) {
      return new Response(JSON.stringify({ error: "busy" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ MediaSources: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo?PlaySessionId=play1");
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/Items/1/PlaybackInfo", context);
  const diagnostics = createDiagnostics("/Items/1/PlaybackInfo", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 200);
  assert.equal(upstream.requestState.activeTargetHost, "b.example.test");
  assert.equal(diagnostics.failover, "1");
  assert.equal(diagnostics.failoverReason, "status-503");
  assert.deepEqual(
    calls.map(item => item.host),
    ["a.example.test", "b.example.test"]
  );
});

test("dispatchUpstream does not fail over playbackinfo 404 responses under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    return new Response("missing", { status: 404, headers: { "Content-Type": "application/json" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo?PlaySessionId=play1");
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/Items/1/PlaybackInfo", context);
  const diagnostics = createDiagnostics("/Items/1/PlaybackInfo", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 404);
  assert.equal(upstream.requestState.activeTargetHost, "a.example.test");
  assert.equal(diagnostics.failover, "0");
  assert.equal(diagnostics.failoverReason, "");
  assert.deepEqual(
    calls.map(item => item.host),
    ["a.example.test"]
  );
});

test("dispatchUpstream fails over single-item metadata 404 requests to the next target", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const host = init.headers?.get?.("Host") || "";
    calls.push({ url: String(url), host });
    if (host === "a.example.test") {
      return new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    return new Response(JSON.stringify({ Id: "580166" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Users/demo/Items/580166");
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/Users/demo/Items/580166", context);
  const diagnostics = createDiagnostics("/Users/demo/Items/580166", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 200);
  assert.equal(upstream.requestState.activeTargetHost, "b.example.test");
  assert.equal(diagnostics.failover, "1");
  assert.equal(diagnostics.failoverReason, "status-404");
  assert.deepEqual(
    calls.map(item => item.host),
    ["a.example.test", "b.example.test"]
  );
});

test("dispatchUpstream does not fail over image 404 requests", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    return new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Items/1/Images/Primary?tag=demo");
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/Items/1/Images/Primary", context);
  const diagnostics = createDiagnostics("/Items/1/Images/Primary", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, "a.example.test");
  assert.equal(diagnostics.failover, "0");
});

test("dispatchUpstream fails over direct streaming GET requests under aligned playback baseline", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    if (String(url).startsWith("https://a.example.test")) {
      return new Response("busy", { status: 503, headers: { "Content-Type": "video/mp4" } });
    }
    return new Response("media", { status: 206, headers: { "Content-Type": "video/mp4" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv");
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const diagnostics = createDiagnostics("/videos/1/original.mkv", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 206);
  assert.equal(upstream.requestState.activeTargetHost, "b.example.test");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(item => item.host), ["a.example.test", "b.example.test"]);
  assert.equal(diagnostics.failover, "1");
  assert.equal(diagnostics.failoverReason, "status-503");
});

test("dispatchUpstream does not fail over POST requests with a body", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    return new Response("busy", { status: 503, headers: { "Content-Type": "application/json" } });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/Users/AuthenticateByName", {
    method: "POST",
    body: JSON.stringify({ Username: "demo", Pw: "demo" }),
    headers: { "Content-Type": "application/json" }
  });
  const requestState = await normalizeIncomingRequest(GLOBALS, request, "/Users/AuthenticateByName", context);
  const diagnostics = createDiagnostics("/Users/AuthenticateByName", requestState);
  const upstream = await dispatchUpstream({ request: request, requestState: requestState, context: context, diagnostics: diagnostics });

  assert.equal(upstream.response.status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, "a.example.test");
  assert.equal(diagnostics.failover, "0");
});

test("playbackinfo responses no longer seed target affinity under aligned playback baseline", async () => {
  resetGlobals();
  const context = await prepareNodeContext(GLOBALS, {
    target: "https://a.example.test",
    targets: ["https://a.example.test", "https://b.example.test"]
  }, "alpha", "");
  const playbackInfoRequest = new Request("https://proxy.example.test/alpha/Items/1/PlaybackInfo?PlaySessionId=play-1");
  const playbackInfoState = await normalizeIncomingRequest(GLOBALS, playbackInfoRequest, "/Items/1/PlaybackInfo", context);

  const output = await rewriteProxyResponse({
    request: playbackInfoRequest,
    requestState: {
      ...playbackInfoState,
      activeTargetIndex: 1,
      activeTargetHost: "b.example.test"
    },
    context,
    response: new Response(JSON.stringify({
      MediaSources: [
        {
          Id: "ms-1",
          DirectStreamUrl: "/alpha/videos/1381242/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1"
        }
      ]
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }),
    diagnostics: {
      route: "passthrough",
      rewriteMs: 0
    }
  });
  await output.text();

  const mediaRequest = new Request("https://proxy.example.test/alpha/videos/1381242/original.mkv?PlaySessionId=play-1&MediaSourceId=ms-1");
  const mediaState = await normalizeIncomingRequest(GLOBALS, mediaRequest, "/videos/1381242/original.mkv", context);

  assert.equal(mediaState.activeTargetHost, "a.example.test");
  assert.equal("targetLockedByAffinity" in mediaState, false);
});

test("buildUpstreamHeaders mirrors Emby auth headers and patches login requests", () => {
  const loginRequest = new Request("https://proxy.example.test/alpha/Users/AuthenticateByName", {
    method: "POST",
    headers: {
      "X-Emby-Authorization": 'Emby Client="Web", Device="Browser", DeviceId="d", Version="1.0.0"'
    }
  });
  const loginHeaders = buildUpstreamHeaders(loginRequest, {
    requestHost: "proxy.example.test",
    method: "POST",
    lowerPath: "/users/authenticatebyname",
    isStreaming: false,
    isStatic: false
  }, "origin.example.test");

  assert.equal(
    loginHeaders.get("Authorization"),
    'Emby Client="Web", Device="Browser", DeviceId="d", Version="1.0.0"'
  );
  assert.equal(
    buildUpstreamHeaders(new Request("https://proxy.example.test/alpha/Users/AuthenticateByName", {
      method: "POST"
    }), {
      requestHost: "proxy.example.test",
      method: "POST",
      lowerPath: "/users/authenticatebyname",
      isStreaming: false,
      isStatic: false
    }, "origin.example.test").get("X-Emby-Authorization"),
    LOGIN_COMPAT_AUTH
  );
});

test("buildUpstreamHeaders mirrors emby auth headers for non-login api requests under aligned playback baseline", () => {
  const request = new Request("https://proxy.example.test/alpha/Users/u/Items/Latest", {
    headers: {
      "X-Emby-Authorization": 'MediaBrowser Client=TabletClient,Device=iPad, DeviceId="d", Version=10.0.6, Token=x',
      "X-Emby-Token": "x"
    }
  });
  const headers = buildUpstreamHeaders(request, {
    requestHost: "proxy.example.test",
    method: "GET",
    lowerPath: "/users/u/items/latest",
    isStreaming: false,
    isStatic: false
  }, "origin.example.test");

  assert.equal(
    headers.get("X-Emby-Authorization"),
    'MediaBrowser Client=TabletClient,Device=iPad, DeviceId="d", Version=10.0.6, Token=x'
  );
  assert.equal(
    headers.get("Authorization"),
    'MediaBrowser Client=TabletClient,Device=iPad, DeviceId="d", Version=10.0.6, Token=x'
  );
  assert.equal(headers.get("X-Emby-Token"), "x");
});

test("followRedirectChain strips auth and origin headers for external redirects", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let capturedHeaders = null;
  globalThis.fetch = async (_url, init = {}) => {
    capturedHeaders = init.headers;
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  const result = await followRedirectChain({
    initialResponse: new Response(null, {
      status: 302,
      headers: { Location: "https://cdn.example.test/file.m3u8" }
    }),
    initialUrl: new URL("https://origin.example.test/videos/1/original.mkv"),
    targetHost: "origin.example.test",
    redirectWhitelistEnabled: false,
    redirectWhitelistDomains: [],
    baseHeaders: new Headers({
      Authorization: "Bearer secret",
      Cookie: "sid=1",
      Origin: "https://proxy.example.test",
      Referer: "https://proxy.example.test/web/index.html",
      "X-Emby-Authorization": "Emby token"
    }),
    method: "GET",
    hasBody: false,
    getReplayBody: async () => null,
    cf: {},
    nodeName: "alpha",
    nodeTarget: "https://origin.example.test"
  });

  assert.equal(result.errorResponse, null);
  assert.equal(capturedHeaders.get("Authorization"), null);
  assert.equal(capturedHeaders.get("Cookie"), null);
  assert.equal(capturedHeaders.get("Origin"), null);
  assert.equal(capturedHeaders.get("Referer"), null);
  assert.equal(capturedHeaders.get("X-Emby-Authorization"), null);
});

test("buildExternalRedirectHeaders preserves admin custom origin and referer when explicitly allowed under aligned playback baseline", () => {
  const headers = buildExternalRedirectHeaders(new Headers({
    Authorization: "Bearer secret",
    Cookie: "sid=1",
    Origin: "https://special-origin.example.test",
    Referer: "https://special-origin.example.test/player",
    "X-Emby-Authorization": "Emby token"
  }), new URL("https://cdn.example.test/file.m3u8"), {
    keepOrigin: true,
    keepReferer: true
  });

  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("Cookie"), null);
  assert.equal(headers.get("X-Emby-Authorization"), null);
  assert.equal(headers.get("Origin"), "https://special-origin.example.test");
  assert.equal(headers.get("Referer"), "https://special-origin.example.test/player");
});

test("buildRedirectErrorResponse applies dynamic cors headers under aligned playback baseline", () => {
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv", {
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Headers": "X-Emby-Token, Range"
    }
  });
  const response = buildRedirectErrorResponse({
    code: "UPSTREAM_REDIRECT_LOOP",
    node: "alpha",
    target: "https://origin.example.test",
    hops: 8
  }, request);

  assert.equal(response.status, 502);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/i);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "X-Emby-Token, Range");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Proxy-Route"), "followed");
  assert.equal(response.headers.get("X-Proxy-Debug-Reason"), "UPSTREAM_REDIRECT_LOOP");
  assert.match(response.headers.get("Vary") || "", /Origin/);
});

test("dispatchUpstream reuses cached external redirects for later media requests", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), host: init.headers?.get?.("Host") || "" });
    if (String(url) === "https://origin.example.test/videos/1/original.mkv") {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file.mkv" }
      });
    }
    if (String(url) === "https://cdn.example.test/file.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/videos/1/original.mkv");

  const firstState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const firstDiagnostics = createDiagnostics("/videos/1/original.mkv", firstState);
  const firstUpstream = await dispatchUpstream({ request: request, requestState: firstState, context: context, diagnostics: firstDiagnostics });
  assert.equal(firstUpstream.response.status, 206);
  assert.deepEqual(
    calls.map(item => item.url),
    ["https://origin.example.test/videos/1/original.mkv", "https://cdn.example.test/file.mkv"]
  );

  calls.length = 0;
  const secondState = await normalizeIncomingRequest(GLOBALS, request, "/videos/1/original.mkv", context);
  const secondDiagnostics = createDiagnostics("/videos/1/original.mkv", secondState);
  const secondUpstream = await dispatchUpstream({ request: request, requestState: secondState, context: context, diagnostics: secondDiagnostics });
  assert.equal(secondUpstream.response.status, 206);
  assert.equal(secondUpstream.route, "redirect-cache");
  assert.deepEqual(
    calls.map(item => item.url),
    ["https://cdn.example.test/file.mkv"]
  );
});

test("dispatchUpstream dedupes concurrent external redirect resolution for the same media URL", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  let releaseOriginRedirect = null;
  const originRedirectReady = new Promise(resolve => {
    releaseOriginRedirect = resolve;
  });
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/2/original.mkv") {
      await originRedirectReady;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file-2.mkv" }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-2.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  const request = new Request("https://proxy.example.test/alpha/videos/2/original.mkv");

  const firstState = await normalizeIncomingRequest(GLOBALS, request, "/videos/2/original.mkv", context);
  const firstDiagnostics = createDiagnostics("/videos/2/original.mkv", firstState);
  const firstUpstreamPromise = dispatchUpstream({ request: request, requestState: firstState, context: context, diagnostics: firstDiagnostics });

  await new Promise(resolve => setTimeout(resolve, 0));

  const secondState = await normalizeIncomingRequest(GLOBALS, request, "/videos/2/original.mkv", context);
  const secondDiagnostics = createDiagnostics("/videos/2/original.mkv", secondState);
  const secondUpstreamPromise = dispatchUpstream({ request: request, requestState: secondState, context: context, diagnostics: secondDiagnostics });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    calls.filter(url => url === "https://origin.example.test/videos/2/original.mkv").length,
    1
  );

  releaseOriginRedirect();

  const [firstUpstream, secondUpstream] = await Promise.all([firstUpstreamPromise, secondUpstreamPromise]);
  assert.equal(firstUpstream.response.status, 206);
  assert.equal(secondUpstream.response.status, 206);
  assert.equal(
    calls.filter(url => url === "https://origin.example.test/videos/2/original.mkv").length,
    1
  );
  assert.equal(
    calls.filter(url => url === "https://cdn.example.test/file-2.mkv").length,
    2
  );
  assert.equal(secondUpstream.route, "redirect-cache");
});

test("dispatchUpstream reuses redirect-cache for equivalent media urls", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (
      normalizedUrl === "https://origin.example.test/videos/3/original.mkv?DeviceId=a&api_key=x&t=1" ||
      normalizedUrl === "https://origin.example.test/emby/videos/3/original.mkv?DeviceId=a&api_key=x&t=1"
    ) {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file-3.mkv" }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-3.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");
  const firstRequest = new Request("https://proxy.example.test/alpha/videos/3/original.mkv?DeviceId=a&api_key=x&t=1");

  const firstState = await normalizeIncomingRequest(GLOBALS, firstRequest, "/videos/3/original.mkv", context);
  const firstDiagnostics = createDiagnostics("/videos/3/original.mkv", firstState);
  const firstUpstream = await dispatchUpstream({ request: firstRequest, requestState: firstState, context: context, diagnostics: firstDiagnostics });
  assert.equal(firstUpstream.response.status, 206);

  calls.length = 0;
  const secondRequest = new Request("https://proxy.example.test/alpha/emby/videos/3/original.mkv?api_key=x&DeviceId=a", {
    method: "HEAD"
  });
  const secondState = await normalizeIncomingRequest(GLOBALS, secondRequest, "/emby/videos/3/original.mkv", context);
  const secondDiagnostics = createDiagnostics("/emby/videos/3/original.mkv", secondState);
  const secondUpstream = await dispatchUpstream({ request: secondRequest, requestState: secondState, context: context, diagnostics: secondDiagnostics });
  assert.equal(secondUpstream.response.status, 206);
  assert.equal(secondUpstream.route, "redirect-cache");
  assert.deepEqual(
    calls,
    ["https://cdn.example.test/file-3.mkv"]
  );
});

test("dispatchUpstream reuses redirect-cache across playbackinfo HEAD warming and later GET playback requests", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/9/original.mkv?DeviceId=a&MediaSourceId=ms-9&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file-9.mkv" }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-9.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/9/original.mkv?DeviceId=a&MediaSourceId=ms-9&api_key=x&PlaySessionId=play-1",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/9/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/9/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  calls.length = 0;

  const playbackRequest = new Request(
    "https://proxy.example.test/alpha/videos/9/original.mkv?DeviceId=a&MediaSourceId=ms-9&api_key=x&PlaySessionId=play-2"
  );
  const playbackState = await normalizeIncomingRequest(GLOBALS, playbackRequest, "/videos/9/original.mkv", context);
  const playbackDiagnostics = createDiagnostics("/videos/9/original.mkv", playbackState);
  const playbackUpstream = await dispatchUpstream({ request: playbackRequest, requestState: playbackState, context, diagnostics: playbackDiagnostics });
  assert.equal(playbackUpstream.response.status, 206);
  assert.equal(playbackUpstream.route, "redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-9.mkv"]);
});

test("dispatchUpstream reuses redirect-cache when resumed playback adds StartTimeTicks noise", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/10/original.mkv?DeviceId=a&MediaSourceId=ms-10&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file-10.mkv" }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-10.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/10/original.mkv?DeviceId=a&MediaSourceId=ms-10&api_key=x&PlaySessionId=play-1",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/10/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/10/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  calls.length = 0;

  const resumedPlaybackRequest = new Request(
    "https://proxy.example.test/alpha/videos/10/original.mkv?DeviceId=a&MediaSourceId=ms-10&api_key=x&PlaySessionId=play-2&StartTimeTicks=900000"
  );
  const resumedPlaybackState = await normalizeIncomingRequest(GLOBALS, resumedPlaybackRequest, "/videos/10/original.mkv", context);
  const resumedPlaybackDiagnostics = createDiagnostics("/videos/10/original.mkv", resumedPlaybackState);
  const resumedPlaybackUpstream = await dispatchUpstream({
    request: resumedPlaybackRequest,
    requestState: resumedPlaybackState,
    context,
    diagnostics: resumedPlaybackDiagnostics
  });
  assert.equal(resumedPlaybackUpstream.response.status, 206);
  assert.equal(resumedPlaybackUpstream.route, "redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-10.mkv"]);
});

test("dispatchUpstream reuses redirect-cache when later playback only changes device and client noise", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    const normalizedUrl = String(url);
    calls.push(normalizedUrl);
    if (normalizedUrl === "https://origin.example.test/videos/11/original.mkv?DeviceId=a&MediaSourceId=ms-11&api_key=x&PlaySessionId=play-1") {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.test/file-11.mkv" }
      });
    }
    if (normalizedUrl === "https://cdn.example.test/file-11.mkv") {
      return new Response("media", {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/5"
        }
      });
    }
    throw new Error(`unexpected fetch: ${normalizedUrl}`);
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test/emby"
  }, "alpha", "");

  const warmRequest = new Request(
    "https://proxy.example.test/alpha/videos/11/original.mkv?DeviceId=a&MediaSourceId=ms-11&api_key=x&PlaySessionId=play-1",
    { method: "HEAD" }
  );
  const warmState = await normalizeIncomingRequest(GLOBALS, warmRequest, "/videos/11/original.mkv", context);
  const warmDiagnostics = createDiagnostics("/videos/11/original.mkv", warmState);
  const warmUpstream = await dispatchUpstream({ request: warmRequest, requestState: warmState, context, diagnostics: warmDiagnostics });
  assert.equal(warmUpstream.response.status, 206);
  assert.equal(warmUpstream.route, "followed");

  calls.length = 0;

  const playbackRequest = new Request(
    "https://proxy.example.test/alpha/videos/11/original.mkv?DeviceId=b&DeviceName=tablet&Client=senplayer&MediaSourceId=ms-11&api_key=x&PlaySessionId=play-2"
  );
  const playbackState = await normalizeIncomingRequest(GLOBALS, playbackRequest, "/videos/11/original.mkv", context);
  const playbackDiagnostics = createDiagnostics("/videos/11/original.mkv", playbackState);
  const playbackUpstream = await dispatchUpstream({ request: playbackRequest, requestState: playbackState, context, diagnostics: playbackDiagnostics });
  assert.equal(playbackUpstream.response.status, 206);
  assert.equal(playbackUpstream.route, "redirect-cache");
  assert.deepEqual(calls, ["https://cdn.example.test/file-11.mkv"]);
});

test("metadata json GET responses asynchronously prewarm lightweight assets without rewriting payloads", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    const normalizedMethod = String(init?.method || "GET").toUpperCase();
    calls.push({
      method: normalizedMethod,
      url: normalizedUrl,
      prewarm: init?.headers?.get?.("X-Metadata-Prewarm") || ""
    });
    return new Response(null, {
      status: 204,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  const playbackInfoRequest = new Request(
    "https://proxy.example.test/alpha/Items/9/PlaybackInfo?MediaSourceId=media-9",
    {
      headers: {
        "x-emby-token": "x"
      }
    }
  );
  const playbackInfoState = await normalizeIncomingRequest(GLOBALS, 
    playbackInfoRequest,
    "/Items/9/PlaybackInfo",
    context
  );
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(promise);
    }
  };
  const output = await rewriteProxyResponse({
    request: playbackInfoRequest,
    requestState: playbackInfoState,
    context,
    response: new Response(JSON.stringify({
      MediaSources: [
        {
          Id: "media-8",
          PosterUrl: "/Items/9/Images/Primary",
          ManifestUrl: "/videos/8/main.m3u8?tag=manifest-8",
          SubtitleUrl: "/videos/8/subtitles/1/Stream.srt?api_key=x",
          DirectStreamUrl: "/videos/8/original.mkv?DeviceId=a&MediaSourceId=media-8&api_key=x"
        },
        {
          Id: "media-9",
          ManifestUrl: "/videos/9/main.m3u8?tag=manifest-9",
          SubtitleUrl: "/videos/9/subtitles/2/Stream.srt?api_key=x",
          DebugPreview: "/Items/999/Images/Primary",
          DirectStreamUrl: "/videos/9/original.mkv?DeviceId=a&MediaSourceId=media-9&api_key=x"
        }
      ]
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }),
    diagnostics: {
      route: "passthrough",
      rewriteMs: 0
    },
    executionContext
  });
  const bodyText = await output.text();
  await settleExecutionContext(executionContext);

  assert.match(bodyText, /DirectStreamUrl/);
  assert.equal(await getCachedLearnedBasePath(GLOBALS, "alpha", "media"), "");
  assert.equal(context.learnedBasePaths.mediaBasePath || "", "");
  assert.equal("SuccessfulPlaybackStartCache" in GLOBALS, false);
  assert.deepEqual(calls, [{
    method: "GET",
    url: "https://origin.example.test/Items/9/Images/Primary",
    prewarm: "1"
  },{
    method: "GET",
    url: "https://origin.example.test/videos/9/main.m3u8?tag=manifest-9",
    prewarm: "1"
  },{
    method: "GET",
    url: "https://origin.example.test/videos/9/subtitles/2/Stream.srt?api_key=x",
    prewarm: "1"
  }]);
  assert.equal(calls.some(item => item.url.includes("/Items/999/Images/Primary")), false);
});

test("playbackinfo post responses no longer trigger old redirect prewarm semantics", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      method: String(init?.method || "GET").toUpperCase(),
      url: String(url),
      prewarm: init?.headers?.get?.("X-Metadata-Prewarm") || ""
    });
    return new Response(null, {
      status: 204,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  };

  const context = await prepareNodeContext(GLOBALS, {
    target: "https://origin.example.test"
  }, "alpha", "");
  context.prewarmDepth = "poster";
  const playbackInfoRequest = new Request(
    "https://proxy.example.test/alpha/Items/9/PlaybackInfo",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-emby-token": "x"
      },
      body: JSON.stringify({
        MediaSourceId: "media-9"
      })
    }
  );
  const playbackInfoState = await normalizeIncomingRequest(
    GLOBALS,
    playbackInfoRequest,
    "/Items/9/PlaybackInfo",
    context
  );
  const executionContext = {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(promise);
    }
  };
  const output = await rewriteProxyResponse({
    request: playbackInfoRequest,
    requestState: playbackInfoState,
    context,
    response: new Response(JSON.stringify({
      MediaSources: [
        {
          Id: "media-8",
          PosterUrl: "/Items/9/Images/Primary",
          ManifestUrl: "/videos/9/main.m3u8?tag=manifest",
          SubtitleUrl: "/videos/9/subtitles/1/Stream.srt?api_key=x",
          DirectStreamUrl: "/videos/8/original.mkv?DeviceId=a&MediaSourceId=media-8&api_key=x"
        },
        {
          Id: "media-9",
          DirectStreamUrl: "/videos/9/original.mkv?DeviceId=a&MediaSourceId=media-9&api_key=x"
        }
      ]
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }),
    diagnostics: {
      route: "passthrough",
      rewriteMs: 0
    },
    executionContext
  });

  assert.equal(playbackInfoState.requestedMediaSourceId, "media-9");
  assert.match(await output.text(), /DirectStreamUrl/);
  await settleExecutionContext(executionContext);
  assert.deepEqual(calls, []);
});

test("proxy handle serves cached images from worker metadata cache before hitting upstream", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("poster-body", {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg"
      }
    });
  };

  const node = { target: "https://origin.example.test" };
  const runtimeConfig = {};
  const executionContext = { tasks: [], waitUntil(promise) { this.tasks.push(promise); } };
  const request = new Request("https://proxy.example.test/alpha/Items/9/Images/Primary?tag=poster&api_key=x", {
    headers: { "x-emby-token": "x" }
  });

  const first = await Proxy.handle(request, node, "/Items/9/Images/Primary", "alpha", runtimeConfig, executionContext, {});
  await settleExecutionContext(executionContext);
  assert.equal(await first.text(), "poster-body");
  assert.equal(fetchCount, 1);

  globalThis.fetch = async () => {
    throw new Error("unexpected upstream fetch on cached image");
  };
  const second = await Proxy.handle(request, node, "/Items/9/Images/Primary", "alpha", runtimeConfig, { tasks: [], waitUntil() {} }, {});
  assert.equal(await second.text(), "poster-body");
  assert.equal(second.headers.get("X-Proxy-Route"), "metadata-cache");
  assert.equal(second.headers.get("Cache-Control"), "public, max-age=2592000, stale-while-revalidate=86400, immutable");
});

test("proxy handle serves safe manifests from worker metadata cache while keeping downstream cache-control conservative", async t => {
  resetGlobals();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("#EXTM3U", {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl"
      }
    });
  };

  const node = { target: "https://origin.example.test" };
  const runtimeConfig = { prewarmCacheTtl: 180 };
  const executionContext = { tasks: [], waitUntil(promise) { this.tasks.push(promise); } };
  const request = new Request("https://proxy.example.test/alpha/Videos/9/main.m3u8?MediaSourceId=1&tag=manifest&api_key=x", {
    headers: { "x-emby-token": "x" }
  });

  const first = await Proxy.handle(request, node, "/Videos/9/main.m3u8", "alpha", runtimeConfig, executionContext, {});
  await settleExecutionContext(executionContext);
  assert.equal(await first.text(), "#EXTM3U");
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  assert.equal(fetchCount, 1);

  globalThis.fetch = async () => {
    throw new Error("unexpected upstream fetch on cached manifest");
  };
  const second = await Proxy.handle(request, node, "/Videos/9/main.m3u8", "alpha", runtimeConfig, { tasks: [], waitUntil() {} }, {});
  assert.equal(await second.text(), "#EXTM3U");
  assert.equal(second.headers.get("X-Proxy-Route"), "metadata-cache");
  assert.equal(second.headers.get("Cache-Control"), "no-store");
});

test("metadata cache helper avoids globalThis.caches for workers editor type compatibility", () => {
  const source = fs.readFileSync(new URL("../src/proxy/media/metadata-cache.js", import.meta.url), "utf8");
  assert.match(source, /typeof caches !== "undefined" \? caches\.default : null/);
  assert.doesNotMatch(source, /globalThis\.caches/);
});
