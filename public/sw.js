// public/sw.js - The In-Browser Zero-Cost Proxy

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // We only want to intercept requests to our special '/tg-proxy/' path.
  if (url.pathname.startsWith('/tg-proxy/')) {
    
    // Extract the real Telegram file path from our custom URL.
    const tgFilePath = url.pathname.substring('/tg-proxy/'.length) + url.search;
    const actualUrl = `https://api.telegram.org/${tgFilePath}`;

    // Respond with a fetch request made in 'no-cors' mode.
    // This is the magic that bypasses the CORS restrictions.
    event.respondWith(
      fetch(actualUrl, { mode: 'no-cors' })
    );
  }
});