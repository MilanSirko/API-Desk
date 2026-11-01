(() => {
  const backendUrl = window.APIDESK_CONFIG?.backendUrl?.replace(/\/+$/, "");
  if (!backendUrl) return;

  fetch(`${backendUrl}/root`, {
    method: "GET",
    mode: "cors",
    cache: "no-store",
    keepalive: true,
  }).catch(() => {
    // Waking the API is best-effort; it should never block the website.
  });
})();
