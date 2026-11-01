// Supplied at runtime by the backend from its public environment configuration.
const BACKEND_URL = (window.APIDESK_CONFIG?.backendUrl || "").replace(/\/+$/, "");

const sendButton = document.getElementById("send");
let requestLogs = [];
let requestLogsError = "";
let refreshRequest = null;
const API_COOKIE_JAR_KEY = "apidesk.apiCookieJar";

function readApiCookieJar() {
  try {
    const cookies = JSON.parse(sessionStorage.getItem(API_COOKIE_JAR_KEY) || "[]");
    return Array.isArray(cookies) ? cookies : [];
  } catch {
    return [];
  }
}

function saveApiCookieJar(cookies) {
  if (!Array.isArray(cookies)) return;
  try {
    sessionStorage.setItem(API_COOKIE_JAR_KEY, JSON.stringify(cookies));
  } catch {
    toast("Could not store API cookies in this browser session.");
  }
}
window.clearApiCookieJar = () => saveApiCookieJar([]);

function readableApiError(detail, fallback) {
  if (typeof detail === "string" && detail.trim()) return friendlyErrorMessage(detail, fallback);
  if (detail && typeof detail === "object") {
    if (typeof detail.message === "string") return friendlyErrorMessage(detail.message, fallback);
    try { return friendlyErrorMessage(JSON.stringify(detail), fallback); } catch { /* Use the fallback below. */ }
  }
  return friendlyErrorMessage(fallback);
}

async function refreshAccessToken() {
  if (refreshRequest) return refreshRequest;
  const refreshToken = sessionStorage.getItem("apidesk.refreshToken");
  if (!refreshToken) return null;

  refreshRequest = (async () => {
    const response = await fetch(`${BACKEND_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshtoken: refreshToken }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* The error below covers an empty response. */ }
    if (!response.ok) {
      if (response.status === 401) return null;
      throw new Error(data.detail || "Could not refresh the session.");
    }

    const accessToken = data.accestoken || data.access_token || data.accessToken;
    const nextRefreshToken = data.resfreshtoken || data.refresh_token || data.refreshToken;
    if (!accessToken || !nextRefreshToken) {
      throw new Error("The refresh endpoint did not return both tokens.");
    }
    sessionStorage.setItem("apidesk.accessToken", accessToken);
    sessionStorage.setItem("apidesk.refreshToken", nextRefreshToken);
    document.dispatchEvent(new CustomEvent("apidesk:tokens-refreshed", {
      detail: { accessToken, refreshToken: nextRefreshToken },
    }));
    return accessToken;
  })();

  try {
    return await refreshRequest;
  } finally {
    refreshRequest = null;
  }
}

async function authorizedFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let response = await fetch(url, { ...options, headers });
  if (response.status !== 401) return response;

  try {
    const newAccessToken = await refreshAccessToken();
    if (!newAccessToken) {
      document.dispatchEvent(new CustomEvent("apidesk:session-expired"));
      return response;
    }
    headers.set("Authorization", `Bearer ${newAccessToken}`);
    response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      document.dispatchEvent(new CustomEvent("apidesk:session-expired"));
    }
    return response;
  } catch (error) {
    toast(error.message || "Could not refresh the session.");
    return response;
  }
}

function renderRequestLogs() {
  const output = document.getElementById("requestLogsOutput");
  if (!output) return;
  output.replaceChildren();
  if (requestLogsError) {
    const notice = document.createElement("div");
    notice.className = "request-log-notice request-log-error";
    notice.textContent = requestLogsError;
    output.append(notice);
    return;
  }
  requestLogs.forEach((log) => {
    const dateValue = log.created || log.created_at || log.timestamp;
    const date = dateValue ? new Date(dateValue) : null;
    const time = date && !Number.isNaN(date.getTime())
      ? date.toLocaleTimeString()
      : "--:--:--";
    const endpoint = log.endpoint || "Unknown endpoint";
    const code = log.statuscode ?? log.statusCode ?? "-";
    const message = friendlyErrorMessage(log.message || "Request completed.");
    const isError = Number(code) === 0 || Number(code) >= 400 || /error|fail|could not/i.test(message);
    const line = document.createElement("div");
    line.className = `request-log-line ${isError ? "request-log-error" : "request-log-success"}`;
    const endpointMatch = endpoint.match(/^([A-Z]+)\s+(.+)$/i);
    const method = endpointMatch?.[1] || "HTTP";
    const url = endpointMatch?.[2] || endpoint;
    const elapsed = message.match(/\bin\s+([\d.]+)\s*ms\b/i)?.[1];
    const outcomeLabels = {
      200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
      301: "Redirect", 302: "Redirect", 304: "Not Modified",
      400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
      404: "Not Found", 408: "Timeout", 409: "Conflict",
      422: "Unprocessable", 429: "Rate Limited", 500: "Server Error",
      502: "Bad Gateway", 503: "Unavailable",
    };
    const outcome = outcomeLabels[Number(code)] || (isError ? "Error" : "OK");
    const timeCell = document.createElement("span");
    timeCell.className = "request-log-time";
    timeCell.textContent = `[${time}]`;
    const codeCell = document.createElement("strong");
    codeCell.className = "request-log-code";
    codeCell.textContent = String(code);
    const methodCell = document.createElement("span");
    methodCell.className = "request-log-method";
    methodCell.textContent = method;
    const urlCell = document.createElement("span");
    urlCell.className = "request-log-endpoint";
    urlCell.textContent = url;
    urlCell.title = url;
    const resultCell = document.createElement("span");
    resultCell.className = "request-log-result";
    resultCell.textContent = `${outcome}  ·  ${elapsed ? `${elapsed} ms` : "—"}`;
    resultCell.title = message;
    line.append(timeCell, codeCell, methodCell, urlCell, resultCell);
    output.append(line);
  });
  if (!requestLogs.length) {
    const empty = document.createElement("div");
    empty.className = "request-log-notice";
    empty.textContent = "No request logs yet.";
    output.append(empty);
  }
  output.scrollTop = output.scrollHeight;
}
window.renderRequestLogs = renderRequestLogs;

async function loadRequestLogs(accessToken = sessionStorage.getItem("apidesk.accessToken")) {
  const output = document.getElementById("requestLogsOutput");
  if (!accessToken) {
    requestLogsError = "Sign in to load request logs.";
    renderRequestLogs();
    return;
  }
  requestLogsError = "";
  if (output) output.textContent = "Loading request logs...";

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/user/logs`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not load request logs.");
    requestLogs = Array.isArray(data) ? [...data] : [];
    requestLogs.sort((left, right) => {
      const leftDate = Date.parse(left.created || left.created_at || left.timestamp || "");
      const rightDate = Date.parse(right.created || right.created_at || right.timestamp || "");
      return Number.isNaN(leftDate) || Number.isNaN(rightDate) ? 0 : leftDate - rightDate;
    });
    requestLogsError = "";
    renderRequestLogs();
  } catch (error) {
    requestLogsError = friendlyErrorMessage(`Could not load request logs: ${error.message}`);
    renderRequestLogs();
    throw error;
  }
}

async function recordRequestLog(entry) {
  requestLogsError = "";
  const localEntry = {
    ...entry,
    message: friendlyErrorMessage(entry.message || "Request completed."),
    created: new Date().toISOString(),
  };
  requestLogs.push(localEntry);
  renderRequestLogs();

  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (!accessToken) return;
  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/user/logs/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        endpoint: localEntry.endpoint,
        statuscode: localEntry.statuscode,
        message: localEntry.message,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data);
      localEntry.message += ` (log save failed: ${detail})`;
      toast(`Could not save request log: ${detail}`);
    } else if (data && typeof data === "object") {
      Object.assign(localEntry, data);
      localEntry.created ||= new Date().toISOString();
    }
  } catch (error) {
    const message = friendlyErrorMessage(error);
    localEntry.message += ` (log save failed: ${message})`;
    toast(`Could not save request log: ${message}`);
  }
  renderRequestLogs();
}

document.getElementById("responseContent").addEventListener("click", async (event) => {
  if (!event.target.closest("#refreshLogs")) return;
  try {
    await loadRequestLogs();
  } catch (error) {
    requestLogsError = friendlyErrorMessage(`Could not load request logs: ${error.message}`);
    renderRequestLogs();
  }
});

document.addEventListener("apidesk:logs-view-open", async () => {
  try {
    await loadRequestLogs();
  } catch (error) {
    requestLogsError = friendlyErrorMessage(`Could not load request logs: ${error.message}`);
    renderRequestLogs();
  }
});

document.addEventListener("apidesk:logged-out", () => {
  requestLogs = [];
  requestLogsError = "Sign in to load request logs.";
  renderRequestLogs();
});

// Read key/value rows from the Params or Headers panel.
function readBackendRows(panelId) {
  const rows = document.querySelectorAll(`#${panelId} .kv-row`);
  const result = {};

  rows.forEach((row) => {
    const key = row.querySelector('[data-field="key"]').value.trim();
    const value = row.querySelector('[data-field="value"]').value;

    if (key) result[key] = value;
  });

  return result;
}

// Global headers are written one per line, for example: Accept: application/json
function readGlobalHeaders() {
  const text = document.getElementById("globalHeaders").value;
  const headers = {};

  text.split(/\r?\n/).forEach((line) => {
    const colon = line.indexOf(":");
    if (colon === -1) return;

    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name) headers[name] = value;
  });

  return headers;
}

function encodeBasicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let text = "";
  bytes.forEach((byte) => (text += String.fromCharCode(byte)));
  return btoa(text);
}

function addAuthHeader(headers) {
  const type = document.getElementById("authType").value;
  const value = document.getElementById("authValue").value;

  if (type === "bearer" && value) {
    headers.Authorization = `Bearer ${value}`;
  }

  if (type === "basic") {
    const username = document.getElementById("authUser").value;
    const password = document.getElementById("authPass").value;
    headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
  }

  if (type === "apikey" && value) {
    const name = document.getElementById("authKey").value || "X-API-Key";
    headers[name] = value;
  }
}

function buildRequestData() {
  const headers = readGlobalHeaders();
  addAuthHeader(headers);

  // Headers set on this request override global or generated auth headers.
  Object.assign(headers, readBackendRows("headersRows"));

  const timeoutMs = Number(document.getElementById("timeoutMs").value) || 30000;

  return {
    url: document.getElementById("url").value.trim(),
    method: document.getElementById("method").value,
    params: readBackendRows("paramsRows"),
    headers,
    body: document.getElementById("body").value,
    bodyType: document.getElementById("bodyType").value,
    authType: document.getElementById("authType").value,
    timeout: timeoutMs / 1000,
    followredirection: document.getElementById("followRedirects").checked,
    credentialsMode: document.getElementById("credentialsMode").value,
    cookies: readApiCookieJar(),
    maxResponseMb: Number(document.getElementById("maxResponseMb").value) || 10,
    retryCount: Number(document.getElementById("retryCount").value) || 0,
    retryDelay: Number(document.getElementById("retryDelay").value) || 0,
  };
}

function showResponse(data) {
  let json = data.json ?? null;

  // Some endpoints return text instead of a parsed JSON value.
  if (json === null && data.text) {
    try {
      json = JSON.parse(data.text);
    } catch {
      // Keep json as null when the response is plain text.
    }
  }

  const headers = data.headers || {};
  const contentType =
    Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1] || "";

  // app.js owns the response display and its Pretty/Raw/Preview controls.
  lastResponse = {
    ok: true,
    status: data.status,
    statusText: data.reason || "",
    ms: data.time,
    size: data.size,
    contentType,
    raw: data.text || "",
    json,
    headers: Object.entries(headers),
    cookies: Array.isArray(data.cookies) ? data.cookies : readApiCookieJar(),
  };
  saveApiCookieJar(lastResponse.cookies);

  recordResponseTiming(lastResponse.ms);
  responseMeta(lastResponse);
  renderResponse();
}

function isLoopbackRequestUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function buildTargetUrl(requestData) {
  const target = new URL(requestData.url);
  Object.entries(requestData.params || {}).forEach(([key, value]) => {
    target.searchParams.set(key, value);
  });
  return target;
}

async function sendLoopbackRequest(requestData) {
  const target = buildTargetUrl(requestData);
  const timeoutMs = Math.max(1, Number(requestData.timeout) || 30) * 1000;
  const maxBytes = Math.max(1, Number(requestData.maxResponseMb) || 10) * 1024 * 1024;
  let lastError;

  for (let attempt = 0; attempt <= (Number(requestData.retryCount) || 0); attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    try {
      const method = String(requestData.method || "GET").toUpperCase();
      const requestHeaders = { ...(requestData.headers || {}) };
      if (requestData.body && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-type")) {
        requestHeaders["Content-Type"] = ({
          json: "application/json",
          urlencoded: "application/x-www-form-urlencoded",
          raw: "text/plain",
          graphql: "application/graphql",
        })[requestData.bodyType] || "text/plain";
      }
      const response = await fetch(target.href, {
        method,
        headers: requestHeaders,
        body: ["GET", "HEAD"].includes(method) || !requestData.body ? undefined : requestData.body,
        credentials: requestData.credentialsMode === "include" ? "include" : "omit",
        redirect: requestData.followredirection ? "follow" : "manual",
        signal: controller.signal,
      });

      const reader = response.body?.getReader();
      const chunks = [];
      let totalBytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`Response exceeded the ${requestData.maxResponseMb || 10} MB limit.`);
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      chunks.forEach((chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      });
      const text = new TextDecoder().decode(bytes);
      const responseHeaders = Object.fromEntries(response.headers.entries());

      return {
        ok: response.ok,
        status: response.status,
        reason: response.statusText,
        time: Math.round(performance.now() - startedAt),
        size: totalBytes,
        finalurl: response.url || target.href,
        headers: responseHeaders,
        // Browsers hide Set-Cookie from JavaScript; cookies are managed by fetch.
        cookies: [],
        text,
      };
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        lastError = new Error(`Request timed out after ${timeoutMs} ms.`);
      }
      if (attempt < (Number(requestData.retryCount) || 0)) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(requestData.retryDelay) || 0)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError?.name === "TypeError") {
    throw new Error("Could not reach the local API. Check that it is running and allows this APIDesk origin in its CORS settings. Your browser may also ask for local network access.");
  }
  throw lastError || new Error("The local API request failed.");
}

async function sendRequest() {
  const requestData = buildRequestData();

  if (!requestData.url) {
    toast("Enter a URL first.");
    return;
  }

  sendButton.disabled = true;
  sendButton.textContent = "Sending…";

  try {
    const isLocal = isLoopbackRequestUrl(requestData.url);
    let response;
    let data;

    if (isLocal) {
      data = await sendLoopbackRequest(requestData);
      // A reachable API returning 4xx/5xx is still a valid response to display.
      response = { ok: true, status: data.status };
    } else {
      response = await fetch(`${BACKEND_URL}/api/sendrequest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });
      data = await response.json();
    }

    if (!isLocal) saveApiCookieJar(data.cookies);
    await recordRequestLog({
      endpoint: `${requestData.method} ${requestData.url}`,
      statuscode: response.ok ? (Number(data.status) || 0) : response.status,
      message: response.ok
        ? `Received HTTP ${data.status} ${data.reason || ""} in ${data.time ?? 0} ms.`
        : String(data.detail || data.reason || "The request failed."),
    });

    if (!response.ok) {
      toast(data.detail || data.reason || `The request returned HTTP ${data.status}.`);
      return;
    }

    showResponse(data);
  } catch (error) {
    const message = friendlyErrorMessage(error);
    await recordRequestLog({
      endpoint: `${requestData.method} ${requestData.url}`,
      statuscode: 0,
      message,
    });
    toast(message);
  } finally {
    sendButton.disabled = false;
    sendButton.innerHTML = "<span>➤</span> Send";
  }
}

sendButton.addEventListener("click", sendRequest);

document.addEventListener('apidesk:auth-submit', async (event)=>{
  event.preventDefault();
  const {email, password, mode, onRegistered, onLoggedIn} = event.detail;
  if (mode === 'register'){

      const authbutton=document.getElementById('authSubmit');
      authbutton.disabled=true;
      try{
        const res=await fetch(`${BACKEND_URL}/api/auth/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: email, password: password})});
        const data=await res.json();
        if (!res.ok){
          toast(data.detail || "Auth error! Try again later");
          return;
        }
        onRegistered();
      } catch (error){
        toast(error.message || "Server error!");
      } finally{
        authbutton.disabled=false;
      }}
  
  if (mode === 'login'){
    const authbutton=document.getElementById('authSubmit');
    authbutton.disabled=true;
    try{
      const loginres=await fetch(`${BACKEND_URL}/api/auth/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: email, password: password})});
      const data=await loginres.json();
      if (!loginres.ok){
        toast(data.detail || "Auth error! Try again later");
        return;
      }
      onLoggedIn(email, data);

    } catch (error){
      toast(error.message || "Server error!");
    } finally{
      authbutton.disabled=false;
    }
  }
});

document.addEventListener('apidesk:logout-confirmed', async (event)=>{
  event.preventDefault();
  const { refreshToken, onLoggedOut }=event.detail;
  try{
    const res=await fetch(`${BACKEND_URL}/api/auth/logout`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({refreshtoken: refreshToken})});
    const data=await res.json();
    if (!res.ok){
      toast(data.detail || "Server error");
      return;
    }
    onLoggedOut();
  } catch (error){
    toast(error.message || "Server error!");
  }
})

document.addEventListener('apidesk:oauth-login', async (event)=>{
  event.preventDefault();
  const {provider}=event.detail;
  if (provider === 'google'){
    try{
      window.location.href=`${BACKEND_URL}/api/auth/oauth/${provider}`;

    } catch (error){
      toast(error.message || "Server error!");
    }}

  if (provider === 'github'){
    try{
      window.location.href=`${BACKEND_URL}/api/auth/oauth/${provider}`;
      
    } catch (error){
      toast(error.message || "Server error!");
    }
  }
})

document.addEventListener("apidesk:user-profile", async (event) => {
  event.preventDefault();
  const { onProfile, onError } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (!accessToken) {
    onError?.("Please log in again to view your account details.");
    return;
  }

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    if (!response.ok) {
      onError?.(readableApiError(data.detail, "Could not load account details."));
      return;
    }
    onProfile?.(data);
  } catch (error) {
    onError?.(friendlyErrorMessage(error, "Could not load account details."));
  }
});

document.addEventListener("apidesk:account-delete", async (event) => {
  event.preventDefault();
  const { onDeleted, onError } = event.detail || {};
  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (!accessToken) {
    onError?.("Please log in again before deleting your account.");
    return;
  }

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/users/delete`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch { /* This endpoint may return no response body. */ }
      onError?.(readableApiError(data.detail, "Could not delete the account."));
      return;
    }
    onDeleted?.();
  } catch (error) {
    onError?.(friendlyErrorMessage(error, "Could not delete the account."));
  }
});

document.addEventListener("apidesk:session-ready", async (event) => {
  const { accessToken } = event.detail;
  const headers = { Authorization: `Bearer ${accessToken}` };
  loadRequestLogs(accessToken).catch((error) => {
    requestLogsError = friendlyErrorMessage(`Could not load request logs: ${error.message}`);
    renderRequestLogs();
  });

  try {
    const foldersResponse = await authorizedFetch(`${BACKEND_URL}/api/folders`, { headers });
    const foldersData = await foldersResponse.json();

    if (!foldersResponse.ok) {
      toast(foldersData.detail || "Could not load folders.");
      return;
    }

    const fetchRequests = async (folderId) => {
      const query = new URLSearchParams({ folderid: folderId });
      const response = await authorizedFetch(`${BACKEND_URL}/api/requests?${query}`, { headers });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || `Could not load requests for folder ${folderId}.`);
      }
      return Array.isArray(data) ? data : [];
    };

    const requestGroups = await Promise.all([
      fetchRequests("null"),
      ...foldersData.map((folder) => fetchRequests(String(folder.id))),
    ]);
    document.dispatchEvent(new CustomEvent("apidesk:saved-data-loaded", {
      detail: {
        folders: foldersData,
        requests: requestGroups.flat(),
      },
    }));

    try {
      const collectionsResponse = await authorizedFetch(`${BACKEND_URL}/api/collections`, { headers });
      const collectionRows = await collectionsResponse.json();
      if (!collectionsResponse.ok) {
        throw new Error(collectionRows.detail || "Could not load collections.");
      }
      const collectionsWithRequests = await Promise.all(
        (Array.isArray(collectionRows) ? collectionRows : []).map(async (collection) => {
          const query = new URLSearchParams({
            folderid: "null",
            collectionid: String(collection.id),
          });
          const requestsResponse = await authorizedFetch(`${BACKEND_URL}/api/requests?${query}`, { headers });
          const requests = await requestsResponse.json();
          if (!requestsResponse.ok) {
            throw new Error(requests.detail || `Could not load requests for collection ${collection.name}.`);
          }
          const collectionRequests = Array.isArray(requests)
            ? requests.filter((request) =>
                String(request.collectionid ?? request.collectionId ?? "") === String(collection.id),
              )
            : [];
          return { ...collection, requests: collectionRequests };
        }),
      );
      document.dispatchEvent(new CustomEvent("apidesk:collections-loaded", {
        detail: {
          collections: collectionsWithRequests,
        },
      }));
    } catch (error) {
      toast(error.message || "Could not load collections.");
    }
  } catch (error) {
    toast(error.message || "Could not load saved requests.");
  }
});

document.addEventListener("apidesk:collection-add", async (event) => {
  event.preventDefault();
  const { name, headers = [], variables = [], authType = "none", authConfig = {}, settings = {}, requestIds = [], onCreated } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/addcollection`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        name, headers, variables, authtype: authType, authconfig: authConfig,
        settings, requestids: requestIds,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast(data.detail || "Could not create collection.");
      return;
    }

    const collection = Array.isArray(data) ? data[0] : data;
    let requests = [];
    if (collection?.id) {
      const query = new URLSearchParams({ collectionid: String(collection.id) });
      const requestsResponse = await authorizedFetch(`${BACKEND_URL}/api/requests?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const requestData = await requestsResponse.json();
      if (!requestsResponse.ok) {
        toast(requestData.detail || "Collection created, but its requests could not be loaded.");
      } else {
        requests = Array.isArray(requestData) ? requestData : [];
      }
    }
    onCreated?.({ ...collection, requests });
  } catch (error) {
    toast(error.message || "Could not create collection.");
  }
});

document.addEventListener("apidesk:collection-requests-add", async (event) => {
  event.preventDefault();
  const { collectionId, requests = [], onAdded, onAddFailed } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");
  if (!accessToken) {
    toast("Please log in again.");
    onAddFailed?.(new Error("Please log in again."));
    return;
  }

  const rowsToObject = (rows = []) => Array.isArray(rows)
    ? Object.fromEntries(rows.filter((row) => row.key?.trim()).map((row) => [row.key.trim(), row.value]))
    : (rows || {});
  const created = [];
  try {
    for (const request of requests) {
      const response = await authorizedFetch(`${BACKEND_URL}/api/request/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          name: (request.name || `${request.method || "GET"} ${request.url || ""}`).slice(0, 30),
          method: request.method || "GET",
          url: request.url || "",
          params: rowsToObject(request.params),
          headers: rowsToObject(request.headers),
          bodyType: request.bodyType || request.bodytype || "json",
          body: request.body || "",
          folderid: null,
          collectionid: collectionId,
        }),
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const error = new Error(readableApiError(data?.detail, "Could not add request copy to collection."));
        toast(error.message);
        onAddFailed?.(error, created);
        return;
      }
      created.push(Array.isArray(data) ? data[0] : data);
    }
    onAdded?.(created);
  } catch (error) {
    toast(error.message || "Could not add request copy to collection.");
    onAddFailed?.(error, created);
  }
});

document.addEventListener("apidesk:folder-add", async (event) => {
  event.preventDefault();

  const { name, onCreated } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/folders/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name }),
    });

    const data = await response.json();

    if (!response.ok) {
      toast(data.detail || "Could not create folder.");
      return;
    }

    const folder = Array.isArray(data) ? data[0] : data;
    if (!folder?.id) {
      toast("The server did not return the new folder.");
      return;
    }

    onCreated({ id: String(folder.id), name: folder.name || name });
  } catch (error) {
    toast(error.message || "Could not create folder.");
  }
});

document.addEventListener("apidesk:folder-rename", async (event) => {
  event.preventDefault();

  const { id, name, onRenamed } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/folders/edit/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      toast(data.detail || "Could not rename folder.");
      return;
    }

    onRenamed(data);
  } catch (error) {
    toast(error.message || "Could not rename folder.");
  }
});

document.addEventListener("apidesk:folder-delete", async (event) => {
  event.preventDefault();

  const { id, onDeleted } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/folders/delete/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {
      }
      toast(data.detail || "Could not delete folder.");
      return;
    }

    onDeleted();
  } catch (error) {
    toast(error.message || "Could not delete folder.");
  }
});

document.addEventListener("apidesk:add-request-to-folder", async (event) => {
  event.preventDefault();

  const { folderId, request, onAdded, onAddFailed } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  const rowsToObject = (rows = []) =>
    Object.fromEntries(
      rows
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value]),
    );

  if (!accessToken) {
    toast("Please log in again.");
    onAddFailed?.(new Error("Please log in again."));
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/folders/addrequest/${encodeURIComponent(folderId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          ...request,
          params: rowsToObject(request.params),
          headers: rowsToObject(request.headers),
        }),
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {
      }
      const error = new Error(readableApiError(data.detail, "Could not add request to folder."));
      toast(error.message);
      onAddFailed?.(error);
      return;
    }

    const data = await response.json();
    onAdded(Array.isArray(data) ? data[0] : data);
  } catch (error) {
    toast(error.message || "Could not add request to folder.");
    onAddFailed?.(error);
  }
});

document.addEventListener("apidesk:request-save", async (event) => {
  event.preventDefault();

  const { request, onSaved, onSaveFailed } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  const rowsToObject = (rows = []) =>
    Object.fromEntries(
      rows
        .filter((row) => row.key?.trim())
        .map((row) => [row.key.trim(), row.value]),
    );

  if (!accessToken) {
    toast("Please log in again.");
    onSaveFailed?.(new Error("Please log in again."));
    return;
  }

  try {
    const response = await authorizedFetch(`${BACKEND_URL}/api/request/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        name: request.name || `${request.method} ${request.url}`.slice(0, 30),
        method: request.method,
        url: request.url,
        params: rowsToObject(request.params),
        headers: rowsToObject(request.headers),
        bodyType: request.bodyType,
        body: request.body,
        folderid: null,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = readableApiError(data.detail, "Could not save request.");
      toast(message);
      onSaveFailed?.(new Error(message));
      return;
    }

    onSaved(Array.isArray(data) ? data[0] : data);
  } catch (error) {
    toast(error.message || "Could not save request.");
    onSaveFailed?.(error);
  }
});

document.addEventListener("apidesk:request-rename", async (event) => {
  event.preventDefault();

  const { id, name, onRenamed, onRenameFailed } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    onRenameFailed?.();
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/request/rename/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {}
      toast(data.detail || "Could not rename request.");
      onRenameFailed?.();
      return;
    }

    onRenamed({ name });
  } catch (error) {
    toast(error.message || "Could not rename request.");
    onRenameFailed?.();
  }
});

document.addEventListener("apidesk:request-delete", async (event) => {
  event.preventDefault();

  const { id, onDeleted } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/request/delete/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {}
      toast(data.detail || "Could not delete request.");
      return;
    }
    onDeleted();
  } catch (error) {
    toast(error.message || "Could not delete request.");
  }
});

document.addEventListener("apidesk:collection-delete", async (event) => {
  event.preventDefault();

  const { id, onDeleted } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/collections/delete/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {}
      toast(data.detail || "Could not delete collection.");
      return;
    }

    onDeleted();
  } catch (error) {
    toast(error.message || "Could not delete collection.");
  }
});

document.addEventListener("apidesk:collection-update", async (event) => {
  event.preventDefault();

  const {
    id, name, headers, variables, authType, authConfig, settings, onUpdated,
  } = event.detail;
  const accessToken = sessionStorage.getItem("apidesk.accessToken");

  if (!accessToken) {
    toast("Please log in again.");
    return;
  }

  try {
    const response = await authorizedFetch(
      `${BACKEND_URL}/api/collections/update=${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          name,
          headers,
          variables,
          authtype: authType,
          authconfig: authConfig,
          settings,
        }),
      },
    );

    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {}
      toast(data.detail || "Could not update collection.");
      return;
    }

    onUpdated();
  } catch (error) {
    toast(error.message || "Could not update collection.");
  }
});

const initialAccessToken = sessionStorage.getItem("apidesk.accessToken");
if (initialAccessToken) {
  document.dispatchEvent(new CustomEvent("apidesk:session-ready", {
    detail: { accessToken: initialAccessToken },
  }));
}


