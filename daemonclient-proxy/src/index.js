export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Usage: https://your-worker.workers.dev/?url=https://api.telegram.org/...
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response("Missing 'url' query parameter.", { status: 400 });
    }

    // 1. Fetch the file from Telegram
    const telegramResponse = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers
    });

    // 2. Create a new response based on Telegram's response
    const newResponse = new Response(telegramResponse.body, telegramResponse);

    // 3. ADD THE CORS HEADERS (The Magic Part)
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    newResponse.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    newResponse.headers.set("Access-Control-Allow-Headers", "*");

    return newResponse;
  },
};