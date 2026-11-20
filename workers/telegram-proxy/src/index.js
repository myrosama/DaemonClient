export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    // Handle CORS Preflight (OPTIONS request)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*", // Allow all headers (important for Content-Type)
        },
      });
    }

    if (!targetUrl) {
      return new Response("Missing 'url' query parameter.", { status: 400 });
    }

    // Relay to Telegram ONLY.
    //
    // This worker exists so a browser can talk to the Telegram Bot API, which
    // sends no CORS headers of its own. It used to forward ANY url for ANY
    // caller, with no authentication — an open relay, on a public hostname,
    // that also passed the caller's Authorization and Cookie headers through
    // and reflected every response header back with `Access-Control-Allow-
    // Origin: *`. That is usable to reach private addresses, to launder
    // traffic through this account, and to burn its request quota.
    //
    // The equivalent endpoint inside the API worker was locked down earlier;
    // this one is a separate deployment and was missed.
    // Exact host, not a suffix rule. `endsWith(".telegram.org")` would admit
    // a Cyrillic homograph — `аpi.telegram.org` normalises to the real
    // subdomain `xn--pi-6kc.telegram.org` — and every caller in this repo
    // builds exactly `https://api.telegram.org/...`, so the wider rule buys
    // nothing. An empty port means the https default, 443.
    let allowed = false;
    try {
      const t = new URL(targetUrl);
      allowed = t.protocol === "https:" && t.hostname === "api.telegram.org" && t.port === "";
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return new Response("This proxy only relays to api.telegram.org", {
        status: 403,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Forward only what Telegram needs. Copying the whole header set sent the
    // caller's own credentials to the target — harmless when the target is
    // always Telegram, but it was not always Telegram, and defence in depth
    // costs nothing here.
    const newHeaders = new Headers();
    for (const name of ["content-type", "content-length", "accept", "range"]) {
      const value = request.headers.get(name);
      if (value) newHeaders.set(name, value);
    }

    const newRequestInit = {
      method: request.method,
      headers: newHeaders,
      // Telegram does not redirect; following one would let a response steer
      // this request somewhere outside the allowlist we just enforced.
      redirect: "manual",
    };

    // Forward the body for POST/PUT requests
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      newRequestInit.body = request.body;
    }

    try {
      const response = await fetch(targetUrl, newRequestInit);

      // Create a new response based on the target's response
      // We stream the body directly
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      // Add CORS headers to the response so the browser accepts it
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      newResponse.headers.set("Access-Control-Allow-Headers", "*");
      newResponse.headers.set("Access-Control-Expose-Headers", "*"); // Expose all headers to JS

      return newResponse;

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { 
        status: 500,
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
        }
      });
    }
  },
};