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

    // Prepare the new request
    // We must be careful with headers. We want to forward almost everything,
    // ESPECIALLY the Content-Type (which contains the multipart boundary).
    const newHeaders = new Headers(request.headers);
    
    // Cloudflare/Browsers sometimes add headers we don't want to forward to the target
    newHeaders.delete("Host"); 
    newHeaders.delete("Cf-Ray");
    newHeaders.delete("Cf-Visitor");
    newHeaders.delete("Cf-Connecting-Ip");
    // Note: Do NOT delete Content-Type or Content-Length if present

    const newRequestInit = {
      method: request.method,
      headers: newHeaders,
      redirect: "follow",
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