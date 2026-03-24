import {
    GITHUB_REPOSITORY_BRANCH,
    GITHUB_REPOSITORY_URL,
    GITHUB_REPOSITORY_VERSION_PATH,
    VERSION_STATUS_ERROR_RETRY_MS,
    VERSION_STATUS_LAZY_TTL_MS,
    WORKER_VERSION,
    normalizeVersionManifestRecord,
    normalizeVersionStatusRecord,
    buildGitHubRepositoryRawUrl,
    compareVersions
} from "../app/version.js";
import {
    readStoredVersionStatus,
    writeStoredVersionStatus
} from "../storage/version-status-repository.js";

export async function fetchRemoteWorkerVersion(fetchImpl = fetch) {
    const rawUrl = buildGitHubRepositoryRawUrl(
        GITHUB_REPOSITORY_VERSION_PATH,
        GITHUB_REPOSITORY_URL,
        GITHUB_REPOSITORY_BRANCH
    );
    if (!rawUrl) {
        throw new Error("仓库地址配置无效");
    }

    const response = await fetchImpl(rawUrl, {
        method: "GET",
        headers: {
            Accept: "application/javascript, text/plain;q=0.9, */*;q=0.1",
            "Cache-Control": "no-cache"
        }
    });
    if (!response.ok) {
        throw new Error(`GitHub 返回异常状态 ${response.status}`);
    }

    const manifest = normalizeVersionManifestRecord(await response.json());
    const remoteVersion = manifest.version;
    if (!remoteVersion) {
        throw new Error("未能解析仓库 version.json 版本");
    }

    return {
        remoteVersion,
        rawUrl
    };
}

export async function compareRepositoryWorkerVersion({
    fetchImpl = fetch,
    now = new Date()
} = {}) {
    const checkedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

    try {
        const { remoteVersion } = await fetchRemoteWorkerVersion(fetchImpl);
        const comparison = compareVersions(WORKER_VERSION, remoteVersion);

        return normalizeVersionStatusRecord({
            currentVersion: WORKER_VERSION,
            remoteVersion,
            status: comparison < 0 ? "update-available" : "equal",
            checkedAt,
            error: ""
        });
    } catch (error) {
        return normalizeVersionStatusRecord({
            currentVersion: WORKER_VERSION,
            remoteVersion: "",
            status: "error",
            checkedAt,
            error: error?.message || "版本检查失败"
        });
    }
}

export function shouldRefreshStoredVersionStatus(record = {}, options = {}) {
    const now = options.now instanceof Date ? options.now.getTime() : Date.parse(String(options.now || ""));
    const normalizedRecord = normalizeVersionStatusRecord(record);
    const checkedAt = Date.parse(String(normalizedRecord.checkedAt || ""));
    if (!normalizedRecord.checkedAt || normalizedRecord.status === "unknown") return true;
    if (!Number.isFinite(now) || !Number.isFinite(checkedAt)) return true;
    const maxAgeMs = normalizedRecord.status === "error"
        ? VERSION_STATUS_ERROR_RETRY_MS
        : VERSION_STATUS_LAZY_TTL_MS;
    return now - checkedAt >= maxAgeMs;
}

export async function runVersionCheck(env, options = {}) {
    const result = await compareRepositoryWorkerVersion(options);
    await writeStoredVersionStatus(env, result);
    return result;
}

export async function readLazyVersionStatus(env, options = {}) {
    const stored = await readStoredVersionStatus(env);
    if (options.force !== true && !shouldRefreshStoredVersionStatus(stored, options)) {
        return stored;
    }
    return runVersionCheck(env, options);
}
