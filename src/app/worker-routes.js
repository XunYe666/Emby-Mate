import { handleAdminRouteRequest } from "./admin-routes.js";
import { handleProxyNodeRequest } from "./proxy-routes.js";
import { handleClientRttProbe } from "../probes/rtt-probe.js";

export function decodePathSegments(pathname = "/") {
    return String(pathname || "/")
        .split("/")
        .filter(Boolean)
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch (_) {
                return segment;
            }
        });
}

export async function handleWorkerRequest(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__client_rtt__") {
        return handleClientRttProbe();
    }

    const segments = decodePathSegments(url.pathname);
    const root = segments[0];

    if (root === "admin") {
        return handleAdminRouteRequest(request, env);
    }

    if (root) {
        const response = await handleProxyNodeRequest({
            request,
            nodePath: root,
            segments,
            env,
            ctx
        });
        if (response) return response;
    }

    return new Response("Not Found", { status: 404 });
}
