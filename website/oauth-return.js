(() => {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/" && path !== "/index.html") return;

  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");

  if (accessToken && refreshToken) {
    window.location.replace(`/api-tester.html${window.location.hash}`);
    return;
  }

  const code = params.get("code");
  if (code) {
    const backendUrl = (window.APIDESK_CONFIG?.backendUrl || "").replace(/\/+$/, "");
    if (backendUrl) {
      window.location.replace(`${backendUrl}/api/auth/callback?code=${encodeURIComponent(code)}`);
    }
    return;
  }

  if (params.has("error") || params.has("error_code")) {
    window.location.replace("/api-tester.html?auth_error=1");
  }
})();
