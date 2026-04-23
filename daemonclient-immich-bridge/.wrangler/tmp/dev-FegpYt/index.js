var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-Y96rzO/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// .wrangler/tmp/bundle-Y96rzO/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/index.js
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const respondJson = /* @__PURE__ */ __name((data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }, "respondJson");
    try {
      if (path === "/api/auth/login" && request.method === "POST") {
        const body = await request.json();
        return respondJson({
          accessToken: "mock_jwt_token_daemonclient",
          userId: "daemonclient_user",
          userEmail: body.email || "user@daemonclient.uz",
          firstName: "Daemon",
          lastName: "Client",
          isAdmin: true
        });
      }
      if (path === "/api/auth/logout" && request.method === "POST") {
        return respondJson({ successful: true });
      }
      if (path === "/api/user/me" && request.method === "GET") {
        return respondJson({
          id: "daemonclient_user",
          email: "user@daemonclient.uz",
          firstName: "Daemon",
          lastName: "Client",
          isAdmin: true,
          status: "active",
          profileImagePath: "",
          shouldChangePassword: false,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          deletedAt: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      if (path === "/api/server-info" && request.method === "GET") {
        return respondJson({
          diskAvailable: "999999999999",
          diskSize: "999999999999",
          diskUse: "0",
          diskAvailableRaw: 999999999999,
          diskSizeRaw: 999999999999,
          diskUseRaw: 0,
          diskUsagePercentage: 0
        });
      }
      if (path === "/api/server-info/features" && request.method === "GET") {
        return respondJson({
          facialRecognition: false,
          map: false,
          trash: false,
          smartSearch: false,
          oauth: false,
          oauthAutoLaunch: false,
          passwordLogin: true
        });
      }
      if (path === "/api/asset" && request.method === "GET") {
        const projectId = "daemonclient-c0625";
        const userId = "Xb9vNZZB89MzYqBIfj3jW40J7oH2";
        try {
          const fsResponse = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/default-daemon-client/users/${userId}/photos`);
          if (fsResponse.ok) {
            const fsData = await fsResponse.json();
            const docs = fsData.documents || [];
            const assets = docs.map((doc) => {
              const fields = doc.fields;
              return {
                id: doc.name.split("/").pop(),
                deviceAssetId: fields.id?.stringValue || doc.name,
                ownerId: userId,
                deviceId: "web",
                type: fields.fileType?.stringValue?.startsWith("video/") ? "VIDEO" : "IMAGE",
                originalPath: fields.fileName?.stringValue || "unknown.jpg",
                originalFileName: fields.fileName?.stringValue || "unknown.jpg",
                resized: false,
                fileCreatedAt: fields.uploadedAt?.timestampValue || (/* @__PURE__ */ new Date()).toISOString(),
                fileModifiedAt: fields.uploadedAt?.timestampValue || (/* @__PURE__ */ new Date()).toISOString(),
                updatedAt: fields.uploadedAt?.timestampValue || (/* @__PURE__ */ new Date()).toISOString(),
                isFavorite: fields.isFavorite?.booleanValue || false,
                isArchived: fields.archived?.booleanValue || false,
                isTrashed: fields.trashed?.booleanValue || false
                // We would map other exif details here if needed
              };
            });
            return respondJson(assets);
          }
        } catch (err) {
          console.error("Firestore fetch failed", err);
        }
        return respondJson([]);
      }
      if (path === "/api/asset" && request.method === "POST") {
        return respondJson({
          id: "dummy_asset_id_" + Date.now(),
          status: "created"
        }, 201);
      }
      if (path === "/api/system-config" && request.method === "GET") {
        return respondJson({
          machineLearning: { enabled: false },
          oauth: { enabled: false },
          passwordLogin: { enabled: true },
          theme: { customCss: "" },
          library: { watch: { enabled: false } },
          trash: { enabled: false }
        });
      }
      return respondJson({ error: "Endpoint not implemented by DaemonClient Bridge", path }, 404);
    } catch (e) {
      return respondJson({ error: e.message }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Y96rzO/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Y96rzO/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
