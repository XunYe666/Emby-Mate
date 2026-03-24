export const WORKER_VERSION = "2.4.10";
export const GITHUB_REPOSITORY_URL = "https://github.com/irm123gard/Emby-Mate";
export const GITHUB_REPOSITORY_BRANCH = "main";
export const GITHUB_REPOSITORY_VERSION_PATH = "version.json";
export const GITHUB_REPOSITORY_WORKER_PATH = "dist/worker.js";
export const VERSION_STATUS_LAZY_TTL_MS = 24 * 60 * 60 * 1000;
export const VERSION_STATUS_ERROR_RETRY_MS = 60 * 60 * 1000;
export const WORKER_VERSION_MARKER = `EMBY_MATE_VERSION=${WORKER_VERSION}`;
export const VERSION_STATUS_STORAGE_KEY = "sys:version-status";

const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

function normalizeRepositoryUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function normalizeVersionString(value) {
    const normalized = String(value || "").trim().replace(/^v/i, "");
    return VERSION_PATTERN.test(normalized) ? normalized : "";
}

export function formatVersionLabel(value) {
    const normalized = normalizeVersionString(value);
    return normalized ? `V${normalized}` : "V--";
}

export function compareVersions(left, right) {
    const leftVersion = normalizeVersionString(left);
    const rightVersion = normalizeVersionString(right);
    if (!leftVersion || !rightVersion) return 0;

    const leftParts = leftVersion.split(".").map((item) => Number(item));
    const rightParts = rightVersion.split(".").map((item) => Number(item));
    const size = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < size; index += 1) {
        const leftPart = leftParts[index] || 0;
        const rightPart = rightParts[index] || 0;
        if (leftPart > rightPart) return 1;
        if (leftPart < rightPart) return -1;
    }
    return 0;
}

export function buildGitHubRepositoryRawUrl(
    pathName = GITHUB_REPOSITORY_VERSION_PATH,
    repositoryUrl = GITHUB_REPOSITORY_URL,
    branch = GITHUB_REPOSITORY_BRANCH
) {
    const normalizedRepositoryUrl = normalizeRepositoryUrl(repositoryUrl);
    const match = normalizedRepositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (!match) return "";
    const owner = match[1];
    const repo = match[2];
    const normalizedBranch = String(branch || "").trim() || GITHUB_REPOSITORY_BRANCH;
    const normalizedPath = String(pathName || "").trim().replace(/^\/+/, "");
    if (!normalizedPath) return "";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${normalizedBranch}/${normalizedPath}`;
}

export function normalizeVersionManifestRecord(record = {}) {
    return {
        version: normalizeVersionString(record.version) || WORKER_VERSION,
        workerPath: String(record.workerPath || GITHUB_REPOSITORY_WORKER_PATH).trim() || GITHUB_REPOSITORY_WORKER_PATH,
        updatedAt: String(record.updatedAt || "").trim()
    };
}

export function normalizeVersionStatusRecord(record = {}) {
    const currentVersion = normalizeVersionString(record.currentVersion) || WORKER_VERSION;
    const remoteVersion = normalizeVersionString(record.remoteVersion);
    const rawStatus = String(record.status || "").trim().toLowerCase();
    const status = rawStatus === "update-available" || rawStatus === "equal" || rawStatus === "error"
        ? rawStatus
        : "unknown";

    return {
        currentVersion,
        remoteVersion,
        status,
        checkedAt: String(record.checkedAt || "").trim(),
        error: String(record.error || "").trim()
    };
}
