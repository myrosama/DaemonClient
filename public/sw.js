// public/sw.js - The Correct Proxy

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Intercept requests to our special '/tg-proxy/' path
  if (url.pathname.startsWith('/tg-proxy/')) {
    
    // Extract the real Telegram file path
    const tgFilePath = url.pathname.substring('/tg-proxy/'.length) + url.search;
    const actualUrl = `https://api.telegram.org/${tgFilePath}`;

    // Fetch the actual URL *WITHOUT* no-cors
    // We forward the original request's headers (like Range) to support partial downloads
    event.respondWith(
      fetch(actualUrl, {
        method: event.request.method,
        headers: event.request.headers,
        // mode: 'cors' is the default, so we don't need to set it manually.
        // We explicitly REMOVED 'no-cors' so we can actually read the data.
      })
    );
  }
});