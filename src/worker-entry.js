import { handleWorkerRequest } from "./app/worker-routes.js";

export default {
    async fetch(request, env, ctx) {
        return handleWorkerRequest(request, env, ctx);
    }
};
