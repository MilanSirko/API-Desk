const $ = (id) => document.getElementById(id);
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      toast("Browser storage is full.");
    }
  },
};
const HISTORY_LIMIT = 30;
let currentUser = sessionStorage.getItem("apidesk.user") || "";
let currentRefreshToken = sessionStorage.getItem("apidesk.refreshToken") || "";
let currentAccessToken = sessionStorage.getItem("apidesk.accessToken") || "";
const savedKey = (email) =>
  `apidesk.saved.${encodeURIComponent(email.trim().toLowerCase())}`;
let saved = currentUser ? storage.get(savedKey(currentUser), []) : [];
const foldersKey = (email) =>
  `apidesk.folders.${encodeURIComponent(email.trim().toLowerCase())}`;
let folders = currentUser ? storage.get(foldersKey(currentUser), []) : [];
let selectedFolder = "";
const expandedFolderIds = new Set();
const collectionsKey = (email) =>
  `apidesk.collections.${encodeURIComponent(email.trim().toLowerCase())}`;
let collections = currentUser ? storage.get(collectionsKey(currentUser), []) : [];
const expandedCollectionIds = new Set();
let history = storage.get("apidesk.history", []);
const globalHeadersStorageKey = "apidesk.globalHeaders";
let timings = storage
  .get("apidesk.responseTimings", [])
  .filter((time) => Number.isFinite(time) && time >= 0)
  .slice(-6);
let lastResponse = null;
let currentView = "body";
let responseBodyMode = "pretty";
let jsonPathOutput = null;
let selectedSaved = -1;
let toastTimer;

function friendlyErrorMessage(message, fallback = "Server error. Please try again later.") {
  const text = message instanceof Error ? message.message : String(message ?? "");
  if (/failed to fetch|networkerror|network error|load failed/i.test(text)) {
    return fallback;
  }
  return text || fallback;
}

function recordResponseTiming(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0) return;
  timings = [...timings, time].slice(-6);
  storage.set("apidesk.responseTimings", timings);
}

function toast(message, type = "error") {
  let displayMessage;
  if (typeof message === "string") {
    displayMessage = message;
  } else if (message instanceof Error) {
    displayMessage = message.message;
  } else if (Array.isArray(message)) {
    displayMessage = message
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const location = Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== "body").join(" → ")
          : "";
        const description = item.msg || JSON.stringify(item);
        return location ? `${location}: ${description}` : description;
      })
      .join(" | ");
  } else if (message && typeof message === "object") {
    displayMessage =
      message.message || message.detail || JSON.stringify(message);
  } else {
    displayMessage = String(message ?? "");
  }
  displayMessage = friendlyErrorMessage(displayMessage);

  const authOverlay = $("authOverlay");
  const authForm = $("authForm");
  if (
    type !== "success" &&
    authOverlay &&
    !authOverlay.classList.contains("hidden") &&
    authForm &&
    !authForm.classList.contains("hidden")
  ) {
    let authError = $("authError");
    if (!authError) {
      authError = document.createElement("p");
      authError.id = "authError";
      authError.className = "auth-error";
      authError.setAttribute("role", "alert");
      $("authSubmit").before(authError);
    }
    authError.textContent = displayMessage;
    return;
  }

  $("toast").textContent = displayMessage;
  $("toast").classList.toggle("success", type === "success");
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2300);
}
function renderRows(containerId, rows, kind) {
  const container = $(containerId);
  if (!rows.length) {
    container.innerHTML = `<div class="sidebar-empty">${kind === "params" ? "No parameters yet. Add a row or enter parameters directly in the URL." : "No custom headers yet. The content type is set automatically."}</div>`;
    return;
  }
  container.innerHTML = rows
    .map(
      (row, index) =>
        `<div class="kv-row"><input data-kind="${kind}" data-index="${index}" data-field="key" aria-label="${kind === "params" ? "Parameter name" : "Header name"}" placeholder="Key" value="${escapeHtml(row.key)}"><input data-kind="${kind}" data-index="${index}" data-field="value" aria-label="${kind === "params" ? "Parameter value" : "Header value"}" placeholder="Value" value="${escapeHtml(row.value)}"><button class="remove-row" data-remove="${kind}" data-index="${index}" aria-label="Remove row">×</button></div>`,
    )
    .join("");
}
function readRows(kind) {
  const containerId = kind === "params" ? "paramsRows" : "headersRows";
  return [...$(containerId).querySelectorAll(".kv-row")].map((row) => ({
    key: row.querySelector('[data-field="key"]').value,
    value: row.querySelector('[data-field="value"]').value,
  }));
}
function setRows(kind, rows) {
  renderRows(kind === "params" ? "paramsRows" : "headersRows", rows, kind);
  updateCounts();
}
function updateCounts() {
  $("paramCount").textContent =
    readRows("params").filter((row) => row.key.trim()).length || "";
  $("headerCount").textContent =
    readRows("headers").filter((row) => row.key.trim()).length || "";
}
function updateHistorySummary() {
  $("historySummary").textContent = history.length
    ? `${history.length} previous requests - local history`
    : "Request history is stored on this device";
  $("requestCount").textContent = saved.length;
}

function showAppDialog({ title, message, value, options, checkboxOptions, confirmLabel, danger, maxLength, onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay";
  overlay.setAttribute("role", "presentation");

  const dialog = document.createElement("section");
  dialog.className = "app-dialog";
  if (checkboxOptions?.length) dialog.classList.add("app-dialog-wide");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const heading = document.createElement("h2");
  heading.textContent = title;
  dialog.append(heading);

  if (message) {
    const description = document.createElement("p");
    description.textContent = message;
    dialog.append(description);
  }

  let input = null;
  const checkboxInputs = [];
  if (options) {
    input = document.createElement("select");
    input.className = "app-dialog-input app-dialog-select";
    input.setAttribute("aria-label", title);
    options.forEach(({ value: optionValue, label, disabled = false }) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = label;
      option.disabled = disabled;
      input.append(option);
    });
    if (value !== undefined) input.value = value;
    dialog.append(input);
  } else if (value !== undefined) {
    input = document.createElement("input");
    input.className = "app-dialog-input";
    input.value = value;
    input.maxLength = maxLength || 80;
    input.setAttribute("aria-label", title);
    dialog.append(input);
  }

  if (checkboxOptions?.length) {
    const label = document.createElement("label");
    label.className = "app-dialog-multi-label";
    label.textContent = "Add existing requests now (optional)";
    const list = document.createElement("div");
    list.className = "app-dialog-checkbox-list";
    checkboxOptions.forEach(({ value: optionValue, label: optionLabel }) => {
      const row = document.createElement("label");
      row.className = "app-dialog-checkbox-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = optionValue;
      checkbox.setAttribute("aria-label", optionLabel);
      checkboxInputs.push(checkbox);
      const text = document.createElement("span");
      text.textContent = optionLabel;
      row.append(checkbox, text);
      list.append(row);
    });
    dialog.append(label, list);
  }

  const actions = document.createElement("div");
  actions.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "app-dialog-cancel";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = danger ? "app-dialog-confirm danger" : "app-dialog-confirm";
  confirm.textContent = confirmLabel || "Save";
  actions.append(cancel, confirm);
  dialog.append(actions);
  overlay.append(dialog);

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && input && event.target === input) {
      event.preventDefault();
      confirm.click();
    }
  };
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", () => {
    const result = input ? input.value.trim() : undefined;
    if (input && !result) {
      input.focus();
      input.setCustomValidity(options ? "Select a folder." : "Enter a name.");
      input.reportValidity();
      return;
    }
    close();
    const selectedValues = checkboxInputs
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
    onConfirm(result, selectedValues);
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.append(overlay);
  (input || confirm).focus();
}

function renderSavedItems(folderId) {
  return saved
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.folderId || "") === folderId)
    .map(
      ({ item, index }) =>
        `<div class="saved-item ${selectedSaved === index ? "active" : ""}" data-open="${index}" title="${escapeHtml(item.url)}"><span class="method-pill method-${escapeHtml(item.method)}">${escapeHtml(item.method)}</span><span class="saved-url">${escapeHtml(item.name)}</span>${folderId ? `<button class="row-action" data-move-request-out="${index}" title="Move to All requests" aria-label="Move request to All requests">−</button>` : ""}<button class="row-action" data-rename-request="${index}" title="Rename request" aria-label="Rename request">✎</button><button class="remove-row" data-delete="${index}" aria-label="Delete saved request">×</button></div>`,
    )
    .join("");
}

function renderCollectionItems(collection, collectionIndex) {
  return (collection.requests || [])
    .map((request, requestIndex) =>
      `<div class="saved-item collection-request" data-open-collection-request="${collectionIndex}:${requestIndex}" title="${escapeHtml(request.url)}"><span class="method-pill method-${escapeHtml(request.method)}">${escapeHtml(request.method)}</span><span class="saved-url">${escapeHtml(request.name || request.url)}</span><button class="row-action" data-rename-collection-request="${collectionIndex}:${requestIndex}" title="Rename request" aria-label="Rename request">✎</button><button class="remove-row" data-delete-collection-request="${collectionIndex}:${requestIndex}" title="Delete request copy" aria-label="Delete request copy">×</button></div>`,
    )
    .join("");
}

function requestSignature(request) {
  const normalizedRows = (rows) => {
    const entries = Array.isArray(rows)
      ? rows.filter((row) => row.key).map((row) => [row.key.toLowerCase(), String(row.value ?? "")])
      : Object.entries(rows || {}).map(([key, value]) => [key.toLowerCase(), String(value ?? "")]);
    return entries.sort(([left], [right]) => left.localeCompare(right));
  };
  return JSON.stringify([
    String(request.method || "GET").toUpperCase(),
    String(request.url || "").trim(),
    normalizedRows(request.params),
    normalizedRows(request.headers),
    request.bodyType || request.bodytype || "json",
    request.body || "",
  ]);
}

function uniqueSavedRequestChoices(excludeRequests = []) {
  const seen = new Set(excludeRequests.map(requestSignature));
  const choices = [];
  saved.forEach((request) => {
    const signature = requestSignature(request);
    if (seen.has(signature)) return;
    seen.add(signature);
    choices.push(request);
  });
  return choices;
}

function makeCollectionCopy(request) {
  return {
    ...request,
    id: `copy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    folderId: "",
    params: (request.params || []).map((row) => ({ ...row })),
    headers: (request.headers || []).map((row) => ({ ...row })),
  };
}

function showCollectionSettingsDialog(collection) {
  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay";
  const dialog = document.createElement("section");
  dialog.className = "app-dialog collection-settings-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const title = document.createElement("h2");
  title.textContent = "Collection settings";
  dialog.append(title);

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };

  const makeField = (labelText, value, type = "text", options = null) => {
    const label = document.createElement("label");
    label.className = "collection-setting-field";
    label.append(document.createTextNode(labelText));
    const control = options ? document.createElement("select") : document.createElement("input");
    control.className = "app-dialog-input";
    if (options) {
      options.forEach(([optionValue, optionLabel]) => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionLabel;
        control.append(option);
      });
      control.value = value;
    } else {
      control.type = type;
      control.value = value ?? "";
    }
    label.append(control);
    return { label, control };
  };

  const { label: nameLabel, control: nameInput } = makeField("Collection name", collection.name);
  nameInput.maxLength = 30;
  nameInput.required = true;
  dialog.append(nameLabel);

  const addRowsEditor = (headingText, initialRows, firstPlaceholder, secondPlaceholder, noteText = "") => {
    const section = document.createElement("div");
    section.className = "collection-settings-section";
    const heading = document.createElement("h3");
    heading.textContent = headingText;
    let note = null;
    if (noteText) {
      note = document.createElement("p");
      note.className = "collection-settings-note";
      note.textContent = noteText;
    }
    const rows = document.createElement("div");
    rows.className = "collection-setting-rows";
    const addRow = (row = {}) => {
      const line = document.createElement("div");
      line.className = "collection-setting-row";
      const key = document.createElement("input");
      key.className = "app-dialog-input";
      key.placeholder = firstPlaceholder;
      key.value = row.key || "";
      const value = document.createElement("input");
      value.className = "app-dialog-input";
      value.placeholder = secondPlaceholder;
      value.value = row.value || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "folder-action collection-delete";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${headingText} row`);
      remove.addEventListener("click", () => line.remove());
      line.append(key, value, remove);
      rows.append(line);
    };
    (Array.isArray(initialRows) ? initialRows : []).forEach(addRow);
    if (!rows.children.length) addRow();
    const add = document.createElement("button");
    add.type = "button";
    add.className = "app-dialog-add-row";
    add.textContent = "+ Add row";
    add.addEventListener("click", () => addRow());
    section.append(heading);
    if (note) section.append(note);
    section.append(rows, add);
    dialog.append(section);
    return () => [...rows.querySelectorAll(".collection-setting-row")]
      .map((line) => {
        const [key, value] = line.querySelectorAll("input");
        return { key: key.value.trim(), value: value.value };
      })
      .filter((row) => row.key);
  };

  const readVariables = addRowsEditor(
    "Shared variables",
    collection.variables,
    "Variable name",
    "Value",
    "Use {{variable_name}} in URLs, params, headers, or the request body.",
  );
  const readHeaders = addRowsEditor(
    "Shared headers",
    collection.headers,
    "Header name",
    "Value",
  );

  const auth = collection.auth || {};
  const authHeading = document.createElement("h3");
  authHeading.className = "collection-settings-section-title";
  authHeading.textContent = "Shared authorization";
  dialog.append(authHeading);
  const authGrid = document.createElement("div");
  authGrid.className = "collection-settings-grid";
  const authType = makeField("Type", auth.type || "none", "text", [
    ["none", "No auth"],
    ["bearer", "Bearer token"],
    ["basic", "Basic Auth"],
    ["apikey", "API key"],
  ]);
  const authValue = makeField("Token / API key value", auth.value || "", "password");
  const authUser = makeField("Basic username", auth.user || "");
  const authPass = makeField("Basic password", auth.password || "", "password");
  const authKey = makeField("API key header name", auth.key || "X-API-Key");
  authGrid.append(authType.label, authValue.label, authUser.label, authPass.label, authKey.label);
  dialog.append(authGrid);

  const settings = collection.settings || {};
  const settingsHeading = document.createElement("h3");
  settingsHeading.className = "collection-settings-section-title";
  settingsHeading.textContent = "Shared request settings";
  dialog.append(settingsHeading);
  const settingsGrid = document.createElement("div");
  settingsGrid.className = "collection-settings-grid";
  const timeout = makeField("Timeout (ms)", settings.timeoutMs ?? 30000, "number");
  const credentials = makeField("Send cookies", settings.credentialsMode || "same-origin", "text", [
    ["same-origin", "Same-origin only"],
    ["include", "Include for all origins"],
    ["omit", "Never"],
  ]);
  const maxSize = makeField("Max response (MB)", settings.maxResponseMb ?? 10, "number");
  const retries = makeField("Retry count", settings.retryCount ?? 0, "number");
  const retryDelay = makeField("Retry delay (ms)", settings.retryDelay ?? 500, "number");
  settingsGrid.append(timeout.label, credentials.label, maxSize.label, retries.label, retryDelay.label);
  const redirectsLabel = document.createElement("label");
  redirectsLabel.className = "collection-setting-checkbox";
  const redirects = document.createElement("input");
  redirects.type = "checkbox";
  redirects.checked = settings.followRedirects !== false;
  redirectsLabel.append(redirects, document.createTextNode("Follow redirects"));
  settingsGrid.append(redirectsLabel);
  dialog.append(settingsGrid);

  const actions = document.createElement("div");
  actions.className = "app-dialog-actions collection-settings-actions";
  const removeCollection = document.createElement("button");
  removeCollection.type = "button";
  removeCollection.className = "app-dialog-confirm danger collection-settings-remove";
  removeCollection.textContent = "Delete collection";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "app-dialog-cancel";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "app-dialog-confirm";
  save.textContent = "Save settings";
  actions.append(removeCollection, cancel, save);
  dialog.append(actions);
  overlay.append(dialog);

  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  save.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity("Enter a collection name.");
      nameInput.reportValidity();
      return;
    }
    const headers = readHeaders();
    const variables = readVariables();
    const auth = {
      type: authType.control.value,
      value: authValue.control.value,
      user: authUser.control.value,
      password: authPass.control.value,
      key: authKey.control.value,
    };
    const updatedSettings = {
      timeoutMs: Number(timeout.control.value) || 30000,
      credentialsMode: credentials.control.value,
      followRedirects: redirects.checked,
      maxResponseMb: Number(maxSize.control.value) || 10,
      retryCount: Number(retries.control.value) || 0,
      retryDelay: Number(retryDelay.control.value) || 0,
    };
    const applyUpdates = () => {
      collection.name = name;
      collection.variables = variables;
      collection.headers = headers;
      collection.auth = auth;
      collection.settings = updatedSettings;
      storage.set(collectionsKey(currentUser), collections);
      close();
      renderSaved();
      toast("Collection settings saved.", "success");
    };
    if (String(collection.id).startsWith("collection-")) {
      applyUpdates();
      return;
    }
    const updateEvent = new CustomEvent("apidesk:collection-update", {
      detail: {
        id: String(collection.id),
        name,
        headers,
        variables,
        authType: auth.type,
        authConfig: {
          value: auth.value,
          user: auth.user,
          password: auth.password,
          key: auth.key,
        },
        settings: updatedSettings,
        onUpdated: applyUpdates,
      },
      cancelable: true,
    });
    document.dispatchEvent(updateEvent);
    if (!updateEvent.defaultPrevented) applyUpdates();
  });
  removeCollection.addEventListener("click", () => {
    close();
    confirmCollectionDelete(collection);
  });

  document.addEventListener("keydown", onKeyDown);
  document.body.append(overlay);
  nameInput.focus();
}

function confirmCollectionDelete(collection) {
  showAppDialog({
    title: "Delete collection?",
    message: `Delete “${collection.name}” and all its request copies?`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => {
      const onDeleted = () => {
        collections = collections.filter((item) => item !== collection);
        expandedCollectionIds.delete(String(collection.id));
        storage.set(collectionsKey(currentUser), collections);
        renderSaved();
        toast("Collection deleted.", "success");
      };
      if (collection.id && !String(collection.id).startsWith("collection-")) {
        const deleteEvent = new CustomEvent("apidesk:collection-delete", {
          detail: { id: String(collection.id), onDeleted },
          cancelable: true,
        });
        document.dispatchEvent(deleteEvent);
        if (!deleteEvent.defaultPrevented) onDeleted();
      } else {
        onDeleted();
      }
    },
  });
}

function renderCollections() {
  $("collectionList").innerHTML = collections
    .map((collection, index) => {
      const id = String(collection.id);
      const expanded = expandedCollectionIds.has(id);
      const requests = collection.requests || [];
      return `<div class="folder-entry collection-entry"><div class="folder-row"><button class="folder-select" data-toggle-collection="${escapeHtml(id)}" aria-expanded="${expanded}" title="${escapeHtml(collection.name)}"><span class="folder-chevron">${expanded ? "▾" : "▸"}</span><span class="folder-icon">▤</span><span>${escapeHtml(collection.name)}</span><small>${requests.length}</small></button><button class="folder-action collection-add" data-add-to-collection="${escapeHtml(id)}" title="Add request copies" aria-label="Add request copies">+</button><button class="folder-action collection-settings" data-settings-collection="${escapeHtml(id)}" title="Collection settings" aria-label="Collection settings">⚙</button><button class="folder-action collection-delete" data-delete-collection="${escapeHtml(id)}" title="Delete collection" aria-label="Delete collection">×</button></div>${expanded ? `<div class="folder-requests">${renderCollectionItems(collection, index) || '<div class="folder-empty">No requests in this collection yet.</div>'}</div>` : ""}</div>`;
    })
    .join("");
}

function renderSaved() {
  renderCollections();
  $("folderList").innerHTML = folders
    .map((folder) => {
      const folderId = String(folder.id);
      const expanded = expandedFolderIds.has(folderId);
      const count = saved.filter((item) => String(item.folderId || "") === folderId).length;
      return `<div class="folder-entry"><div class="folder-row ${selectedFolder === folderId ? "active" : ""}"><button class="folder-select" data-toggle-folder="${escapeHtml(folderId)}" aria-expanded="${expanded}" title="${escapeHtml(folder.name)}"><span class="folder-chevron">${expanded ? "▾" : "▸"}</span><span class="folder-icon">📁</span><span>${escapeHtml(folder.name)}</span><small>${count}</small></button><button class="folder-action folder-add" data-add-request-to-folder="${escapeHtml(folderId)}" title="Add current request to folder" aria-label="Add current request to folder">+</button><button class="folder-action folder-edit" data-rename-folder="${escapeHtml(folderId)}" title="Rename folder" aria-label="Rename folder">✎</button><button class="folder-action folder-delete" data-delete-folder="${escapeHtml(folderId)}" title="Delete folder" aria-label="Delete folder">×</button></div>${expanded ? `<div class="folder-requests">${renderSavedItems(folderId) || '<div class="folder-empty">No requests in this folder yet.</div>'}</div>` : ""}</div>`;
    })
    .join("");

  const unfiledRequests = renderSavedItems("");
  $("requestList").innerHTML = unfiledRequests ||
    `<div class="sidebar-empty">${currentUser ? "No requests outside folders." : "Sign in to use folders and saved requests."}</div>`;
  updateHistorySummary();
}

$("collectionList").addEventListener("click", (event) => {
  const renameCopy = event.target.closest("[data-rename-collection-request]");
  if (renameCopy) {
    event.stopPropagation();
    const [collectionIndex, requestIndex] = renameCopy.dataset.renameCollectionRequest.split(":").map(Number);
    const collection = collections[collectionIndex];
    const request = collection?.requests?.[requestIndex];
    if (!request) return;
    showAppDialog({
      title: "Rename request copy",
      value: request.name || "",
      confirmLabel: "Save",
      maxLength: 30,
      onConfirm: (name) => {
        const previousName = request.name;
        const onRenamed = (updated = {}) => {
          request.name = updated.name || name;
          storage.set(collectionsKey(currentUser), collections);
          renderSaved();
          toast("Request copy renamed.", "success");
        };
        const onRenameFailed = () => {
          request.name = previousName;
          storage.set(collectionsKey(currentUser), collections);
          renderSaved();
        };
        if (request.id && !String(request.id).startsWith("copy-")) {
          const renameEvent = new CustomEvent("apidesk:request-rename", {
            detail: { id: String(request.id), name, onRenamed, onRenameFailed },
            cancelable: true,
          });
          document.dispatchEvent(renameEvent);
          if (!renameEvent.defaultPrevented) onRenamed({ name });
        } else {
          onRenamed({ name });
        }
      },
    });
    return;
  }

  const deleteCopy = event.target.closest("[data-delete-collection-request]");
  if (deleteCopy) {
    event.stopPropagation();
    const [collectionIndex, requestIndex] = deleteCopy.dataset.deleteCollectionRequest.split(":").map(Number);
    const collection = collections[collectionIndex];
    const request = collection?.requests?.[requestIndex];
    if (!request) return;
    showAppDialog({
      title: "Delete request copy?",
      message: `Delete “${request.name || request.url}” from “${collection.name}”?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        const onDeleted = () => {
          collection.requests.splice(requestIndex, 1);
          storage.set(collectionsKey(currentUser), collections);
          renderSaved();
          toast("Request copy deleted.", "success");
        };
        if (request.id && !String(request.id).startsWith("copy-")) {
          const deleteEvent = new CustomEvent("apidesk:request-delete", {
            detail: { id: String(request.id), onDeleted },
            cancelable: true,
          });
          document.dispatchEvent(deleteEvent);
          if (!deleteEvent.defaultPrevented) onDeleted();
        } else {
          onDeleted();
        }
      },
    });
    return;
  }

  const settingsButton = event.target.closest("[data-settings-collection]");
  if (settingsButton) {
    event.stopPropagation();
    const collection = collections.find(
      (item) => String(item.id) === settingsButton.dataset.settingsCollection,
    );
    if (collection) showCollectionSettingsDialog(collection);
    return;
  }

  const add = event.target.closest("[data-add-to-collection]");
  if (add) {
    event.stopPropagation();
    const collection = collections.find(
      (item) => String(item.id) === add.dataset.addToCollection,
    );
    if (!collection) return;
    const choices = uniqueSavedRequestChoices(collection.requests || []);
    if (!choices.length) {
      toast("There are no new requests to add to this collection.");
      return;
    }
    showAppDialog({
      title: `Add requests to ${collection.name}`,
      message: "Select request copies to add.",
      checkboxOptions: choices.map((request, index) => ({
        value: String(index),
        label: `${request.name || request.url} — ${request.method || "GET"} ${request.url || ""}`,
      })),
      confirmLabel: "Add selected",
      onConfirm: (_value, selectedValues) => {
        if (!selectedValues.length) {
          toast("Select at least one request.");
          return;
        }
        const selectedRequests = selectedValues
          .map((index) => choices[Number(index)])
          .filter(Boolean);
        const onAdded = (createdRows = []) => {
          const copies = Array.isArray(createdRows) && createdRows.length
            ? createdRows.map(normalizeCollectionRequest)
            : selectedRequests.map(makeCollectionCopy);
          collection.requests.push(...copies);
          storage.set(collectionsKey(currentUser), collections);
          renderSaved();
          toast("Request copies added to collection.", "success");
        };
        const addEvent = new CustomEvent("apidesk:collection-requests-add", {
          detail: {
            collectionId: String(collection.id),
            requests: selectedRequests,
            onAdded,
          },
          cancelable: true,
        });
        document.dispatchEvent(addEvent);
        if (!addEvent.defaultPrevented) onAdded();
      },
    });
    return;
  }

  const deleteButton = event.target.closest("[data-delete-collection]");
  if (deleteButton) {
    event.stopPropagation();
    const collection = collections.find(
      (item) => String(item.id) === deleteButton.dataset.deleteCollection,
    );
    if (!collection) return;
    confirmCollectionDelete(collection);
    return;
  }

  const toggle = event.target.closest("[data-toggle-collection]");
  if (toggle) {
    const id = toggle.dataset.toggleCollection;
    if (expandedCollectionIds.has(id)) expandedCollectionIds.delete(id);
    else expandedCollectionIds.add(id);
    renderSaved();
    return;
  }

  const open = event.target.closest("[data-open-collection-request]");
  if (open) {
    const [collectionIndex, requestIndex] = open.dataset.openCollectionRequest
      .split(":")
      .map(Number);
    const collection = collections[collectionIndex];
    const request = collection?.requests?.[requestIndex];
    if (!request) return;
    selectedSaved = -1;
    loadRequest(request, collection);
    renderSaved();
  }
});

// Convert rows returned by the API into the format used by the sidebar/editor.
function loadSavedDataFromApi(data = {}) {
  if (!currentUser) return;

  folders = (Array.isArray(data.folders) ? data.folders : []).map((folder) => ({
    id: String(folder.id),
    name: folder.name || "Untitled folder",
  }));
  saved = (Array.isArray(data.requests) ? data.requests : []).map((item) => ({
    id: String(item.id),
    name: item.name || `${item.method || "GET"} ${item.url || ""}`.slice(0, 30),
    method: item.method || "GET",
    url: item.url || "",
    params: Object.entries(item.params || {}).map(([key, value]) => ({ key, value: String(value ?? "") })),
    headers: Object.entries(item.headers || {}).map(([key, value]) => ({ key, value: String(value ?? "") })),
    body: item.body || "",
    bodyType: item.bodytype || item.bodyType || "json",
    folderId: item.folderid == null ? "" : String(item.folderid),
  }));
  selectedFolder = "";
  selectedSaved = -1;
  storage.set(foldersKey(currentUser), folders);
  storage.set(savedKey(currentUser), saved);
  renderSaved();
}

document.addEventListener("apidesk:saved-data-loaded", (event) => {
  loadSavedDataFromApi(event.detail || {});
});

function databaseValueToRows(value) {
  if (Array.isArray(value)) {
    return value.map((row) => ({
      key: String(row.key ?? ""),
      value: String(row.value ?? ""),
    }));
  }
  return Object.entries(value || {}).map(([key, rowValue]) => ({
    key,
    value: String(rowValue ?? ""),
  }));
}

function normalizeCollectionRequest(request) {
  return {
    id: request.id == null ? undefined : String(request.id),
    name: request.name || `${request.method || "GET"} ${request.url || ""}`.slice(0, 30),
    method: request.method || "GET",
    url: request.url || "",
    params: databaseValueToRows(request.params),
    headers: databaseValueToRows(request.headers),
    body: request.body || "",
    bodyType: request.bodytype || request.bodyType || "json",
    authType: request.authType || request.authtype || "none",
    authValue: request.authValue || "",
    authUser: request.authUser || "",
    authPass: request.authPass || "",
    authKey: request.authKey || "X-API-Key",
  };
}

function loadCollectionsFromApi(rows = []) {
  if (!currentUser) return;
  collections = (Array.isArray(rows) ? rows : []).map((row) => {
    const authConfig = row.authconfig || row.authConfig || row.auth || {};
    const settings = row.settings || {};
    const requests = row.requests || row.collection_requests || [];
    return {
      id: String(row.id),
      name: row.name || "Untitled collection",
      description: row.description || "",
      variables: databaseValueToRows(row.variables),
      headers: databaseValueToRows(row.headers),
      auth: {
        type: row.authtype || row.authType || authConfig.type || "none",
        value: authConfig.value || authConfig.token || "",
        user: authConfig.user || authConfig.username || "",
        password: authConfig.password || "",
        key: authConfig.key || authConfig.header || "X-API-Key",
      },
      settings,
      requests: (Array.isArray(requests) ? requests : []).map(normalizeCollectionRequest),
    };
  });
  expandedCollectionIds.clear();
  storage.set(collectionsKey(currentUser), collections);
  renderSaved();
}

document.addEventListener("apidesk:collections-loaded", (event) => {
  loadCollectionsFromApi(event.detail?.collections || []);
});

function captureRequest() {
  return {
    method: $("method").value,
    url: $("url").value.trim(),
    params: readRows("params"),
    headers: readRows("headers"),
    body: $("body").value,
    bodyType: $("bodyType").value,
    authType: $("authType").value,
    authValue: $("authValue").value,
    authUser: $("authUser").value,
    authPass: $("authPass").value,
    authKey: $("authKey").value,
    timeoutMs: $("timeoutMs").value,
    credentialsMode: $("credentialsMode").value,
    followRedirects: $("followRedirects").checked,
    maxResponseMb: $("maxResponseMb").value,
    retryCount: $("retryCount").value,
    retryDelay: $("retryDelay").value,
  };
}
function requestWithCollectionSettings(item, collection) {
  if (!collection) return item;
  const variables = Object.fromEntries(
    (collection.variables || [])
      .filter((row) => row.key)
      .map((row) => [row.key, String(row.value ?? "")]),
  );
  const replaceVariables = (value) =>
    String(value ?? "").replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key) =>
      Object.hasOwn(variables, key) ? variables[key] : match,
    );
  const toRows = (rows) =>
    Array.isArray(rows)
      ? rows.map((row) => ({ key: row.key, value: row.value }))
      : Object.entries(rows || {}).map(([key, value]) => ({ key, value: String(value ?? "") }));
  const mergedHeaders = new Map();
  [...toRows(collection.headers), ...toRows(item.headers)].forEach((row) => {
    const key = replaceVariables(row.key).trim();
    if (key) mergedHeaders.set(key.toLowerCase(), { key, value: replaceVariables(row.value) });
  });

  const effective = {
    ...item,
    url: replaceVariables(item.url),
    params: toRows(item.params).map((row) => ({
      key: replaceVariables(row.key),
      value: replaceVariables(row.value),
    })),
    headers: [...mergedHeaders.values()],
    body: replaceVariables(item.body),
  };

  const auth = collection.auth || {};
  if (auth.type && auth.type !== "none") {
    effective.authType = auth.type;
    effective.authValue = replaceVariables(auth.value);
    effective.authUser = replaceVariables(auth.user);
    effective.authPass = replaceVariables(auth.password);
    effective.authKey = replaceVariables(auth.key || "X-API-Key");
  }
  const settings = collection.settings || {};
  effective.timeoutMs = settings.timeoutMs ?? item.timeoutMs ?? 30000;
  effective.credentialsMode = settings.credentialsMode || item.credentialsMode || "same-origin";
  effective.followRedirects = settings.followRedirects ?? item.followRedirects ?? true;
  effective.maxResponseMb = settings.maxResponseMb ?? item.maxResponseMb ?? 10;
  effective.retryCount = settings.retryCount ?? item.retryCount ?? 0;
  effective.retryDelay = settings.retryDelay ?? item.retryDelay ?? 500;
  return effective;
}

function loadRequest(item, collection = null) {
  item = requestWithCollectionSettings(item, collection);
  $("method").value = item.method || "GET";
  updateMethodColor();
  $("url").value = item.url || "";
  setRows("params", item.params || []);
  setRows("headers", item.headers || []);
  $("body").value = item.body || "";
  $("bodyType").value =
    item.bodyType === "text" ? "raw" : item.bodyType || "json";
  updateBodyPlaceholder();
  $("authType").value = item.authType || "none";
  $("authValue").value = item.authValue || "";
  $("authUser").value = item.authUser || "";
  $("authPass").value = item.authPass || "";
  $("authKey").value = item.authKey || "X-API-Key";
  $("timeoutMs").value = item.timeoutMs ?? 30000;
  $("credentialsMode").value = item.credentialsMode || "same-origin";
  $("followRedirects").checked = item.followRedirects !== false;
  $("maxResponseMb").value = item.maxResponseMb ?? 10;
  $("retryCount").value = item.retryCount ?? 0;
  $("retryDelay").value = item.retryDelay ?? 500;
  updateAuthFields();
  $("requestTitle").textContent = item.name || "Build a request";
  $("crumbName").textContent = item.name || "New request";
}
const bodyPlaceholders = {
  json: '{\n  "name": "Ada Lovelace",\n  "active": true\n}',
  "form-data": "name=Ada Lovelace\nemail=ada@example.com",
  urlencoded: "name=Ada%20Lovelace&email=ada%40example.com",
  raw: "Plain text request body",
  graphql: "query {\n  users {\n    id\n    name\n  }\n}",
};
function updateBodyPlaceholder() {
  $("body").placeholder = bodyPlaceholders[$("bodyType").value] || "";
}
function setRequestTab(name) {
  document
    .querySelectorAll("#requestTabs .tab")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.pane === name),
    );
  document
    .querySelectorAll(".request-panel")
    .forEach((panel) =>
      panel.classList.toggle("hidden", panel.id !== `pane-${name}`),
    );
}
function setResponseTab(name) {
  currentView = name;
  document
    .querySelectorAll("#responseTabs .tab, #logsTab")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.view === name),
    );
  renderResponse();
  if (name === "logs") {
    document.dispatchEvent(new CustomEvent("apidesk:logs-view-open"));
  }
}
function responseMeta(response) {
  const code = Number(response.status);
  const statusClass = `status-pill ${!Number.isFinite(code) ? "status-error" : code < 300 ? "status-success" : code < 400 ? "status-redirect" : code < 500 ? "status-client-error" : "status-error"}`;
  $("responseMeta").innerHTML =
    `<span class="${statusClass}">${escapeHtml(response.status || "Error")} ${escapeHtml(response.statusText || "")}</span><span>${Number(response.ms).toLocaleString("en-US")} ms</span><span>${formatSize(response.size || 0)}</span>`;
  $("responseMeta").classList.remove("hidden");
  $("responseTools").classList.remove("hidden");
}
function formatSize(bytes) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(2)} MB`;
}
function formatJson(text, json) {
  const formatted = json === null ? text : JSON.stringify(json, null, 2);
  return escapeHtml(formatted).replace(
    /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
    (match, string, colon, bool) =>
      string
        ? `<span class="${colon ? "json-key" : "json-string"}">${string}</span>${colon || ""}`
        : bool
          ? `<span class="json-bool">${match}</span>`
          : `<span class="json-number">${match}</span>`,
  );
}
function jsonMetrics(value) {
  let keys = 0,
    maxDepth = 0,
    arrays = 0,
    objects = 0;
  const visit = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(node)) {
      arrays++;
      node.forEach((child) => visit(child, depth + 1));
    } else if (node && typeof node === "object") {
      objects++;
      const entries = Object.entries(node);
      keys += entries.length;
      entries.forEach(([, child]) => visit(child, depth + 1));
    }
  };
  visit(value, 1);
  return {
    keys,
    maxDepth,
    arrays,
    objects,
    rootItems: Array.isArray(value) ? value.length : null,
  };
}
function evaluateJsonPath(root, path) {
  const source = path.trim();
  if (!source.startsWith("$"))
    throw new Error("A JSONPath expression must start with $.");
  let nodes = [root],
    i = 1;
  const recursiveFind = (value, key, matches) => {
    if (Array.isArray(value))
      value.forEach((child) => recursiveFind(child, key, matches));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([name, child]) => {
        if (key === "*" || name === key) matches.push(child);
        recursiveFind(child, key, matches);
      });
  };
  while (i < source.length) {
    if (source.startsWith("..", i)) {
      i += 2;
      const match = source.slice(i).match(/^([\w$]+|\*)/);
      if (!match) throw new Error("Invalid recursive JSONPath expression.");
      const key = match[1],
        found = [];
      nodes.forEach((node) => recursiveFind(node, key, found));
      nodes = found;
      i += match[0].length;
      continue;
    }
    if (source[i] === ".") {
      i++;
      const match = source.slice(i).match(/^([\w$]+|\*)/);
      if (!match) throw new Error("Invalid JSONPath property.");
      const key = match[1];
      nodes = nodes.flatMap((node) =>
        key === "*"
          ? Array.isArray(node)
            ? node
            : node && typeof node === "object"
              ? Object.values(node)
              : []
          : node != null && Object.hasOwn(Object(node), key)
            ? [node[key]]
            : [],
      );
      i += match[0].length;
      continue;
    }
    if (source[i] === "[") {
      const end = source.indexOf("]", i);
      if (end < 0) throw new Error("Unclosed bracket in JSONPath expression.");
      const selector = source.slice(i + 1, end).trim();
      if (selector === "*")
        nodes = nodes.flatMap((node) =>
          Array.isArray(node)
            ? node
            : node && typeof node === "object"
              ? Object.values(node)
              : [],
        );
      else if (/^\d+$/.test(selector))
        nodes = nodes.flatMap((node) =>
          Array.isArray(node) && Number(selector) < node.length
            ? [node[Number(selector)]]
            : [],
        );
      else if (/^(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')$/.test(selector)) {
        const key =
          selector[0] === '"'
            ? JSON.parse(selector)
            : selector.slice(1, -1).replace(/\\'/g, "'");
        nodes = nodes.flatMap((node) =>
          node != null && Object.hasOwn(Object(node), key) ? [node[key]] : [],
        );
      } else if (selector.startsWith("?(") && selector.endsWith(")")) {
        const test = selector
          .slice(2, -1)
          .trim()
          .match(
            /^@(?:\.([\w$]+)|\[['"]([^'"\]]+)['"]\])\s*(==|!=|>=|<=|>|<)\s*(.+)$/,
          );
        if (!test)
          throw new Error("Use a filter expression such as [?(@.price < 10)].");
        const prop = test[1] || test[2],
          operator = test[3];
        let expected;
        try {
          expected = JSON.parse(test[4]);
        } catch {
          expected = test[4].replace(/^'|'$/g, "");
        }
        const matches = (value) => {
          const actual = value?.[prop];
          switch (operator) {
            case "==":
              return actual === expected;
            case "!=":
              return actual !== expected;
            case ">":
              return actual > expected;
            case "<":
              return actual < expected;
            case ">=":
              return actual >= expected;
            case "<=":
              return actual <= expected;
          }
        };
        nodes = nodes.flatMap((node) =>
          (Array.isArray(node) ? node : []).filter(matches),
        );
      } else throw new Error("Unsupported JSONPath selector.");
      i = end + 1;
      continue;
    }
    throw new Error(`Unexpected character in JSONPath expression: ${source[i]}`);
  }
  return nodes;
}
function renderBody() {
  const raw = lastResponse.raw || "";
  const contentType = (lastResponse.contentType || "").toLowerCase();
  if (!raw) return '<div class="empty-body">The response body is empty.</div>';
  if (responseBodyMode === "preview") {
    if (
      contentType.includes("text/html") ||
      /^<!doctype html|^<html[\s>]/i.test(raw.trim())
    ) {
      const safeHtml = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline';"><body style="font:14px system-ui;color:#222;padding:12px">${raw}</body>`;
      return `<iframe class="html-preview" sandbox="" title="HTML response preview" srcdoc="${escapeHtml(safeHtml)}"></iframe>`;
    }
    if (contentType.startsWith("image/")) {
      const source = raw.startsWith("data:")
        ? raw
        : `data:${contentType};base64,${raw}`;
      return `<div class="image-preview"><img src="${escapeHtml(source)}" alt="Image response preview"></div>`;
    }
    return '<div class="empty-body">HTML or image preview is not available for this response.</div>';
  }
  const text =
    responseBodyMode === "pretty"
      ? lastResponse.json === null
        ? raw
        : JSON.stringify(lastResponse.json, null, 2)
      : raw;
  const search = $("jsonSearch").value.trim();
  let output =
    responseBodyMode === "pretty" && lastResponse.json !== null
      ? formatJson(raw, lastResponse.json)
      : escapeHtml(text);
  if (search) {
    const escapedSearch = escapeHtml(search).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    output = output.replace(
      new RegExp(escapedSearch, "gi"),
      (match) => `<mark>${match}</mark>`,
    );
  }
  return `<pre class="code-output">${output}</pre>`;
}
function renderResponse() {
  const output = $("responseContent");
  $("bodyControls").classList.toggle(
    "hidden",
    currentView !== "body" || !lastResponse?.ok,
  );
  document
    .querySelectorAll("[data-body-mode]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.bodyMode === responseBodyMode,
      ),
    );
  if (currentView === "logs") {
    output.classList.add("logs-view");
    output.innerHTML = '<section class="request-logs"><div class="request-logs-heading"><b>Terminal</b><button class="outline-button" id="refreshLogs" type="button">Refresh</button></div><div id="requestLogsOutput" class="request-logs-output" role="log" aria-live="polite">Sign in to load request logs.</div></section>';
    window.renderRequestLogs?.();
    return;
  }
  output.classList.remove("logs-view");
  if (!lastResponse) {
    output.innerHTML = '<div class="empty-state"><span class="empty-icon">↗</span><b>No response yet</b><p>Send a request to see the response details and statistics here.</p></div>';
    return;
  }
  if (!lastResponse.ok) {
    output.innerHTML = `<div class="error-box">${escapeHtml(lastResponse.error)}\n\nThe browser may have blocked this request because of the API's CORS policy. Check the browser Network panel for details.</div>`;
    return;
  }
  if (currentView === "body") {
    const jsonResult =
      jsonPathOutput === null
        ? ""
        : jsonPathOutput.error
          ? `<div class="jsonpath-result error-box">${escapeHtml(jsonPathOutput.error)}</div>`
          : `<details class="jsonpath-result" open><summary>${jsonPathOutput.values.length} JSONPath result${jsonPathOutput.values.length === 1 ? "" : "s"}</summary><pre class="code-output">${escapeHtml(JSON.stringify(jsonPathOutput.values, null, 2))}</pre></details>`;
    output.innerHTML = `${renderBody()}${jsonResult}`;
  } else if (currentView === "headers") {
    output.innerHTML = lastResponse.headers.length
      ? `<table class="data-table">${lastResponse.headers.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</table>`
      : '<div class="empty-body">The response does not contain readable headers.</div>';
  } else if (currentView === "cookies") {
    const cookies = Array.isArray(lastResponse.cookies) ? lastResponse.cookies : [];
    const clearButton = cookies.length
      ? '<button class="outline-button cookie-jar-clear" id="clearApiCookieJar" type="button">Clear cookie jar</button>'
      : "";
    const rows = cookies.map((cookie) => {
      const flags = [cookie.secure ? "Secure" : "", cookie.httpOnly ? "HttpOnly" : "", cookie.sameSite ? `SameSite=${cookie.sameSite}` : ""]
        .filter(Boolean).join(" · ") || "-";
      const expires = cookie.expires ? new Date(Number(cookie.expires) * 1000).toLocaleString() : "Session";
      return `<tr><td>${escapeHtml(cookie.name)}</td><td>${escapeHtml(cookie.value)}</td><td>${escapeHtml(cookie.domain)}</td><td>${escapeHtml(cookie.path || "/")}</td><td>${escapeHtml(expires)}</td><td>${escapeHtml(flags)}</td></tr>`;
    }).join("");
    output.innerHTML = `${cookies.length ? `<div class="cookie-jar-toolbar"><span>Cookies saved for this browser session</span>${clearButton}</div><div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-body">No API cookies are stored yet. Choose “Include for all origins” in Settings to store cookies from external APIs.</div>'}`;
  } else {
    const stats = jsonMetrics(lastResponse.json);
    const cards = [
      [
        "HTTP status",
        `${lastResponse.status} ${lastResponse.statusText}`,
        lastResponse.status < 300
          ? "good"
          : lastResponse.status < 400
            ? "status-redirect-text"
            : lastResponse.status < 500
              ? "status-client-text"
              : "status-error-text",
      ],
      ["Response time", `${lastResponse.ms} ms`, ""],
      ["Response size", formatSize(lastResponse.size), ""],
      ["Content type", lastResponse.contentType || "-", ""],
      ["Response headers", lastResponse.headers.length, ""],
      [
        "Valid JSON",
        lastResponse.json !== null ? "Yes" : "No",
        lastResponse.json !== null ? "good" : "",
      ],
      ["JSON keys", lastResponse.json !== null ? stats.keys : "-", ""],
      ["Max depth", lastResponse.json !== null ? stats.maxDepth : "-", ""],
      [
        "Objects / arrays",
        lastResponse.json !== null
          ? `${stats.objects} / ${stats.arrays}`
          : "-",
        "",
      ],
      ["Root items", stats.rootItems === null ? "-" : stats.rootItems, ""],
      [
        "Average response time",
        timings.length
          ? `${Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length)} ms`
          : "-",
        "",
      ],
      [
        "Slowest / fastest",
        timings.length
          ? `${Math.max(...timings)} / ${Math.min(...timings)} ms`
          : "-",
        "",
      ],
    ];
    const max = Math.max(...timings, 1);
    output.innerHTML = `<div class="stats-grid">${cards.map(([label, value, cls]) => `<div class="stat-card"><span>${escapeHtml(label)}</span><b class="${cls}">${escapeHtml(value)}</b></div>`).join("")}</div><div class="timing-chart"><div class="chart-title"><span>Response time  -  latest ${timings.length} of 6 requests</span><b>ms</b></div><div class="bars">${timings.map((time, index) => `<div class="bar-column" style="height:${Math.max(5, (time / max) * 100)}%" data-tip="Recent request ${index + 1}  -  ${time} ms"></div>`).join("")}</div></div>`;
  }
}
function updateAuthFields() {
  const type = $("authType").value;
  $("authValueWrap").classList.toggle(
    "hidden",
    !["bearer", "apikey"].includes(type),
  );
  $("authUserWrap").classList.toggle("hidden", type !== "basic");
  $("authPassWrap").classList.toggle("hidden", type !== "basic");
  $("authKeyWrap").classList.toggle("hidden", type !== "apikey");
}
function updateMethodColor() {
  const method = $("method");
  method.className = `method-select method-${method.value}`;
}

$("requestTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-pane]");
  if (tab) setRequestTab(tab.dataset.pane);
});
$("responseTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-view]");
  if (tab) setResponseTab(tab.dataset.view);
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#clearApiCookieJar")) {
    window.clearApiCookieJar?.();
    if (lastResponse) lastResponse.cookies = [];
    renderResponse();
    toast("API cookie jar cleared.", "success");
    return;
  }
  const mode = event.target.closest("[data-body-mode]");
  if (mode) {
    responseBodyMode = mode.dataset.bodyMode;
    renderResponse();
    return;
  }
  if (event.target.closest("#applyJsonPath")) {
    if (!lastResponse || lastResponse.json === null) {
      jsonPathOutput = { error: "The response is not valid JSON." };
    } else {
      try {
        jsonPathOutput = {
          values: evaluateJsonPath(lastResponse.json, $("jsonPath").value),
        };
      } catch (error) {
        jsonPathOutput = { error: error.message };
      }
    }
    renderResponse();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "jsonSearch" && lastResponse) renderResponse();
});
document.addEventListener("change", (event) => {
  if (event.target.id !== "commonHeaderSelect" || !event.target.value) return;
  const commonHeaders = {
    "accept-json": ["Accept", "application/json"],
    "content-json": ["Content-Type", "application/json"],
    "authorization-bearer": ["Authorization", "Bearer "],
    "cache-control": ["Cache-Control", "no-cache"],
    "accept-language": ["Accept-Language", "en-US,en;q=0.9"],
    "x-requested-with": ["X-Requested-With", "XMLHttpRequest"],
  };
  const [key, value] = commonHeaders[event.target.value] || [];
  if (!key) return;
  const rows = readRows("headers");
  const existingIndex = rows.findIndex((row) => row.key.trim().toLowerCase() === key.toLowerCase());
  if (existingIndex >= 0) rows[existingIndex] = { key, value };
  else rows.push({ key, value });
  setRows("headers", rows);
  event.target.value = "";
  const targetRow = existingIndex >= 0 ? existingIndex + 1 : rows.length;
  const valueInput = $("headersRows").querySelector(`.kv-row:nth-child(${targetRow}) [data-field="value"]`);
  valueInput?.focus();
  if (key === "Authorization") valueInput?.setSelectionRange(value.length, value.length);
});
document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add-row]");
  if (add) {
    const kind = add.dataset.addRow;
    setRows(kind, [...readRows(kind), { key: "", value: "" }]);
    const rows = $(kind === "params" ? "paramsRows" : "headersRows");
    rows.lastElementChild?.querySelector("input")?.focus();
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    const kind = remove.dataset.remove;
    const rows = readRows(kind);
    rows.splice(Number(remove.dataset.index), 1);
    setRows(kind, rows);
  }
});
document.addEventListener("input", (event) => {
  if (event.target.matches(".kv-row input")) updateCounts();
});
function handleSavedRequestClick(event) {
  const moveOut = event.target.closest("[data-move-request-out]");
  if (moveOut) {
    event.stopPropagation();
    const index = Number(moveOut.dataset.moveRequestOut);
    const request = saved[index];
    if (!request) return;
    if (!request.id) {
      toast("This request has no server ID yet. Reload the saved requests and try again.");
      return;
    }

    const onSavedOutsideFolder = (row = {}) => {
      const unfiledRequest = {
        ...request,
        id: row.id ? String(row.id) : undefined,
        folderId: "",
      };
      saved.unshift(unfiledRequest);
      selectedSaved = 0;
      selectedFolder = "";
      storage.set(savedKey(currentUser), saved);
      renderSaved();

      const onOldRequestDeleted = () => {
        const oldIndex = saved.findIndex(
          (item) => String(item.id) === String(request.id),
        );
        if (oldIndex >= 0) {
          saved.splice(oldIndex, 1);
          if (selectedSaved > oldIndex) selectedSaved -= 1;
        }
        storage.set(savedKey(currentUser), saved);
        renderSaved();
        toast("Request moved to All requests.", "success");
      };
      const deleteEvent = new CustomEvent("apidesk:request-delete", {
        detail: { id: String(request.id), onDeleted: onOldRequestDeleted },
        cancelable: true,
      });
      document.dispatchEvent(deleteEvent);
      if (!deleteEvent.defaultPrevented) onOldRequestDeleted();
    };

    const saveEvent = new CustomEvent("apidesk:request-save", {
      detail: { request, onSaved: onSavedOutsideFolder },
      cancelable: true,
    });
    document.dispatchEvent(saveEvent);
    if (!saveEvent.defaultPrevented) onSavedOutsideFolder();
    return;
  }

  const rename = event.target.closest("[data-rename-request]");
  if (rename) {
    event.stopPropagation();
    const index = Number(rename.dataset.renameRequest);
    const request = saved[index];
    if (!request) return;
    showAppDialog({
      title: "Rename request",
      value: request.name || "",
      confirmLabel: "Save",
      maxLength: 30,
      onConfirm: (name) => {
        const previousName = request.name;
        request.name = name;
        storage.set(savedKey(currentUser), saved);
        renderSaved();

        const onRenamed = (updatedRequest = {}) => {
          request.name = updatedRequest.name || name;
          storage.set(savedKey(currentUser), saved);
          if (selectedSaved === index) {
            $("requestTitle").textContent = request.name;
            $("crumbName").textContent = request.name;
          }
          renderSaved();
          toast("Request renamed.", "success");
        };
        const onRenameFailed = () => {
          request.name = previousName;
          storage.set(savedKey(currentUser), saved);
          if (selectedSaved === index) {
            $("requestTitle").textContent = previousName;
            $("crumbName").textContent = previousName;
          }
          renderSaved();
        };

        if (request.id) {
          const renameEvent = new CustomEvent("apidesk:request-rename", {
            detail: {
              id: String(request.id),
              name,
              onRenamed,
              onRenameFailed,
            },
            cancelable: true,
          });
          document.dispatchEvent(renameEvent);
          if (!renameEvent.defaultPrevented) toast("Request renamed.", "success");
        } else {
          if (selectedSaved === index) {
            $("requestTitle").textContent = name;
            $("crumbName").textContent = name;
          }
          toast("Request renamed.", "success");
        }
      },
    });
    return;
  }
  const del = event.target.closest("[data-delete]");
  if (del) {
    event.stopPropagation();
    const index = Number(del.dataset.delete);
    const request = saved[index];
    if (!request) return;

    showAppDialog({
      title: "Delete request?",
      message: `Delete “${request.name || request.url}”? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        const onDeleted = () => {
          saved.splice(index, 1);
          if (selectedSaved === index) {
            selectedSaved = -1;
            loadRequest({ method: "GET", url: "", params: [], headers: [], body: "" });
          } else if (selectedSaved > index) {
            selectedSaved -= 1;
          }
          storage.set(savedKey(currentUser), saved);
          renderSaved();
          toast("Request deleted.", "success");
        };

        if (request.id) {
          const deleteEvent = new CustomEvent("apidesk:request-delete", {
            detail: { id: String(request.id), onDeleted },
            cancelable: true,
          });
          document.dispatchEvent(deleteEvent);
          if (!deleteEvent.defaultPrevented) onDeleted();
        } else {
          onDeleted();
        }
      },
    });
    return;
  }
  const item = event.target.closest("[data-open]");
  if (item) {
    selectedSaved = Number(item.dataset.open);
    loadRequest(saved[selectedSaved]);
    renderSaved();
  }
}

$("requestList").addEventListener("click", handleSavedRequestClick);
function requestDisplayName(request) {
  let path = request.url;
  try { path = new URL(request.url).pathname || request.url; } catch { /* Keep relative URL as entered. */ }
  return `${request.method} ${path}`.slice(0, 30);
}

function finishRequestMoveToFolder(existing, request, folderId) {
  const finishMove = () => {
    const oldIndex = existing
      ? saved.findIndex((item) => item === existing || (existing.id && String(item.id) === String(existing.id)))
      : -1;
    if (oldIndex >= 0) saved.splice(oldIndex, 1);

    request.folderId = String(folderId);
    saved.unshift(request);
    selectedSaved = 0;
    selectedFolder = String(folderId);
    expandedFolderIds.add(String(folderId));
    storage.set(savedKey(currentUser), saved);
    renderSaved();
    toast("Request moved to folder.", "success");
  };

  if (existing?.id) {
    const deleteEvent = new CustomEvent("apidesk:request-delete", {
      detail: { id: String(existing.id), onDeleted: finishMove },
      cancelable: true,
    });
    document.dispatchEvent(deleteEvent);
    if (!deleteEvent.defaultPrevented) finishMove();
    return;
  }

  finishMove();
}

function saveRequestToUnfiled() {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Log in to save requests.");
    return;
  }
  const request = captureRequest();
  if (!request.url) {
    toast("Enter a URL before saving.");
    return;
  }
  request.name = requestDisplayName(request);
  request.folderId = "";
  const onSaved = (row = {}) => {
    const savedRequest = {
      ...request,
      id: row.id ? String(row.id) : undefined,
      name: row.name || request.name,
      folderId: "",
    };
    saved.unshift(savedRequest);
    selectedSaved = 0;
    saved = saved.slice(0, 100);
    selectedFolder = "";
    storage.set(savedKey(currentUser), saved);
    $("requestTitle").textContent = savedRequest.name;
    $("crumbName").textContent = savedRequest.name;
    renderSaved();
    toast("Request saved.", "success");
  };
  const saveEvent = new CustomEvent("apidesk:request-save", {
    detail: { request, onSaved },
    cancelable: true,
  });
  document.dispatchEvent(saveEvent);
  // Local fallback until backend.js handles the save event.
  if (!saveEvent.defaultPrevented) onSaved();
}

$("saveRequest").addEventListener("click", saveRequestToUnfiled);

$("saveToFolder").addEventListener("click", () => {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Log in to save requests.");
    return;
  }
  if (!folders.length) {
    toast("Create a folder first.");
    return;
  }
  const request = captureRequest();
  if (!request.url) {
    toast("Enter a URL before saving.");
    return;
  }
  const options = folders.map((folder) => ({ value: String(folder.id), label: folder.name }));
  showAppDialog({
    title: "Save request to folder",
    options,
    value: selectedFolder && folders.some((folder) => String(folder.id) === selectedFolder) ? selectedFolder : options[0].value,
    confirmLabel: "Save",
    onConfirm: (folderId) => {
      const existing = selectedSaved >= 0 ? saved[selectedSaved] : null;
      request.name = existing?.name || requestDisplayName(request);
      request.folderId = String(folderId);
      const onAdded = (createdRequest = {}) => {
        if (createdRequest.id) request.id = String(createdRequest.id);
        finishRequestMoveToFolder(existing, request, folderId);
      };
      const addEvent = new CustomEvent("apidesk:add-request-to-folder", {
        detail: { folderId: String(folderId), request, onAdded },
        cancelable: true,
      });
      document.dispatchEvent(addEvent);
      if (!addEvent.defaultPrevented) {
        onAdded();
      }
    },
  });
});
$("allRequests").addEventListener("click", () => {
  selectedFolder = "";
  selectedSaved = -1;
  renderSaved();
});
$("newFolder").addEventListener("click", () => {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Sign in to create a folder.");
    return;
  }
  showAppDialog({
    title: "Create folder",
    value: "",
    confirmLabel: "Create",
    maxLength: 30,
    onConfirm: (name) => {
      const onCreated = (createdFolder) => {
        const folder = {
          id: String(createdFolder.id),
          name: createdFolder.name || name,
        };
        folders = folders.filter((item) => String(item.id) !== folder.id);
        folders.push(folder);
        selectedFolder = folder.id;
        expandedFolderIds.add(folder.id);
        selectedSaved = -1;
        storage.set(foldersKey(currentUser), folders);
        renderSaved();
        toast("Folder created.", "success");
      };

      const folderEvent = new CustomEvent("apidesk:folder-add", {
        detail: { name, onCreated },
        cancelable: true,
      });
      document.dispatchEvent(folderEvent);

      // Keep the local demo behavior until a backend handler takes over this event.
      if (!folderEvent.defaultPrevented) {
        onCreated({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
        });
      }
    },
  });
});

function openApiRows(value) {
  if (Array.isArray(value)) {
    return value.filter((row) => row?.key?.trim()).map((row) => [row.key.trim(), row.value ?? ""]);
  }
  return Object.entries(value || {});
}

function openApiDocument(sources) {
  const paths = {};
  const servers = new Set();
  const tags = new Set();
  const securitySchemes = {};
  const operationIds = new Set();
  const contentTypes = {
    json: "application/json",
    "form-data": "multipart/form-data",
    urlencoded: "application/x-www-form-urlencoded",
    raw: "text/plain",
    graphql: "application/graphql",
  };

  sources.forEach((source) => {
    const sharedHeaders = source.kind === "Collection" ? openApiRows(source.item.headers) : [];
    const variables = Object.fromEntries(openApiRows(source.item.variables).map(([key, value]) => [key, String(value ?? "")]));
    const replaceVariables = (value) => String(value ?? "").replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key) => variables[key] ?? match);
    tags.add(source.name);

    source.requests.forEach((request) => {
      if (!request.url) return;
      let parsed;
      try {
        parsed = new URL(replaceVariables(request.url), window.location.origin);
      } catch {
        return;
      }
      const serverUrl = parsed.origin;
      servers.add(serverUrl);
      const path = (parsed.pathname || "/").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const method = String(request.method || "GET").toLowerCase();
      if (!/^(get|put|post|delete|patch|options|head|trace)$/.test(method)) return;

      const headers = new Map();
      [...sharedHeaders, ...openApiRows(request.headers)].forEach(([key, value]) => {
        headers.set(String(key).toLowerCase(), [String(key), replaceVariables(value)]);
      });
      const contentTypeHeader = [...headers.values()].find(([key]) => key.toLowerCase() === "content-type")?.[1];
      const mediaType = contentTypeHeader || contentTypes[request.bodyType || request.bodytype || "json"] || "application/json";

      const parameters = [];
      const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      pathNames.forEach((name) => parameters.push({ name, in: "path", required: true, schema: { type: "string" } }));

      const queryValues = new Map();
      parsed.searchParams.forEach((value, key) => queryValues.set(key, value));
      openApiRows(request.params).forEach(([key, value]) => queryValues.set(replaceVariables(key), replaceVariables(value)));
      queryValues.forEach((value, name) => parameters.push({ name, in: "query", required: false, schema: { type: "string" }, example: String(value) }));

      const auth = source.kind === "Collection" && source.item.auth?.type && source.item.auth.type !== "none"
        ? source.item.auth
        : {
            type: request.authType || "none",
            value: request.authValue,
            user: request.authUser,
            password: request.authPass,
            key: request.authKey,
          };
      let securityName = "";
      if (auth.type === "bearer") {
        securityName = "bearerAuth";
        securitySchemes[securityName] = { type: "http", scheme: "bearer" };
      } else if (auth.type === "basic") {
        securityName = "basicAuth";
        securitySchemes[securityName] = { type: "http", scheme: "basic" };
      } else if (auth.type === "apikey") {
        const headerName = auth.key || "X-API-Key";
        securityName = `apiKey_${headerName.replace(/[^A-Za-z0-9_]/g, "_")}`;
        securitySchemes[securityName] = { type: "apiKey", in: "header", name: headerName };
      }

      headers.forEach(([name, value]) => {
        const lower = name.toLowerCase();
        if (["content-type", "authorization"].includes(lower)) return;
        if (auth.type === "apikey" && lower === String(auth.key || "X-API-Key").toLowerCase()) return;
        parameters.push({ name, in: "header", required: false, schema: { type: "string" }, example: replaceVariables(value) });
      });

      const rawBody = replaceVariables(request.body || "");
      const operation = {
        summary: request.name || `${request.method || "GET"} ${parsed.pathname}`,
        operationId: "",
        tags: [source.name],
        servers: [{ url: serverUrl }],
        responses: { default: { description: "API response" } },
      };
      if (parameters.length) operation.parameters = parameters;
      const operationBase = `${method}_${(request.name || parsed.pathname).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "request"}`;
      let operationId = operationBase;
      let suffix = 2;
      while (operationIds.has(operationId)) operationId = `${operationBase}_${suffix++}`;
      operationIds.add(operationId);
      operation.operationId = operationId;
      if (securityName) operation.security = [{ [securityName]: [] }];

      if (rawBody && !["get", "head"].includes(method)) {
        let example = rawBody;
        if (mediaType.includes("json")) {
          try { example = JSON.parse(rawBody); } catch { /* Keep a text example when the body is not valid JSON. */ }
        }
        operation.requestBody = {
          required: true,
          content: { [mediaType]: { schema: {}, example } },
        };
      }

      paths[path] ||= {};
      if (!paths[path][method]) paths[path][method] = operation;
      else {
        const duplicates = paths[path][method]["x-apidesk-sources"] || [];
        duplicates.push(source.name);
        paths[path][method]["x-apidesk-sources"] = [...new Set(duplicates)];
      }
    });
  });

  const document = {
    openapi: "3.0.3",
    info: { title: "APIDesk export", version: "1.0.0" },
    servers: [...servers].map((url) => ({ url })),
    paths,
  };
  if (tags.size) document.tags = [...tags].map((name) => ({ name }));
  if (Object.keys(securitySchemes).length) document.components = { securitySchemes };
  return document;
}

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === "object") return `${pad}-\n${toYaml(item, indent + 2)}`;
      return `${pad}- ${yamlScalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return `${pad}{}`;
    return entries.map(([key, child]) => {
      const yamlKey = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
      if (child && typeof child === "object" && (Array.isArray(child) ? child.length : Object.keys(child).length)) {
        return `${pad}${yamlKey}:\n${toYaml(child, indent + 2)}`;
      }
      if (Array.isArray(child)) return `${pad}${yamlKey}: []`;
      if (child && typeof child === "object") return `${pad}${yamlKey}: {}`;
      return `${pad}${yamlKey}: ${yamlScalar(child)}`;
    }).join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function showOpenApiExportDialog() {
  const folderSources = folders.map((folder) => ({
      kind: "Folder",
      id: `folder:${folder.id}`,
      name: folder.name,
      requests: saved.filter((request) => String(request.folderId || "") === String(folder.id)),
      item: folder,
    }));
  const collectionSources = collections.map((collection) => ({
      kind: "Collection",
      id: `collection:${collection.id}`,
      name: collection.name,
      requests: collection.requests || [],
      item: collection,
    }));
  const sources = [
    ...(folderSources.length ? [{ kind: "All folders", name: "All folders", children: folderSources }] : []),
    ...(collectionSources.length ? [{ kind: "All collections", name: "All collections", children: collectionSources }] : []),
    ...folderSources,
    ...collectionSources,
  ];

  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay";
  const dialog = document.createElement("section");
  dialog.className = "app-dialog app-dialog-wide export-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.textContent = "Export OpenAPI";
  const formatLabel = document.createElement("label");
  formatLabel.className = "export-format-label";
  formatLabel.textContent = "File format";
  const format = document.createElement("select");
  format.className = "app-dialog-input app-dialog-select";
  format.innerHTML = '<option value="json">JSON</option><option value="yaml">YAML</option>';
  formatLabel.append(format);

  const sourceLabel = document.createElement("label");
  sourceLabel.className = "export-format-label";
  sourceLabel.textContent = "Folder or collection";
  const sourceSelect = document.createElement("select");
  sourceSelect.className = "app-dialog-input app-dialog-select";
  const sourcePlaceholder = document.createElement("option");
  sourcePlaceholder.value = "";
  sourcePlaceholder.textContent = sources.length ? "Select one folder or collection" : "No folders or collections available";
  sourceSelect.append(sourcePlaceholder);
  sources.forEach((source, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = source.kind.startsWith("All ")
      ? source.kind
      : `${source.kind}: ${source.name}`;
    sourceSelect.append(option);
  });
  sourceLabel.append(sourceSelect);

  const error = document.createElement("p");
  error.className = "export-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "app-dialog-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "app-dialog-confirm";
  exportButton.textContent = "Export";
  exportButton.disabled = !sources.length;
  exportButton.addEventListener("click", () => {
    const selectedSource = sourceSelect.value === "" ? null : sources[Number(sourceSelect.value)];
    if (!selectedSource) {
      error.textContent = "Select one folder or collection.";
      return;
    }
    const selectedSources = selectedSource.children || [selectedSource];
    if (!selectedSources.length) {
      error.textContent = "The selected folder or collection could not be found.";
      return;
    }
    const openApi = openApiDocument(selectedSources);
    if (!Object.keys(openApi.paths).length) {
      error.textContent = "The selected folder or collection does not contain exportable requests.";
      return;
    }
    const isYaml = format.value === "yaml";
    const content = isYaml ? `${toYaml(openApi)}\n` : JSON.stringify(openApi, null, 2);
    const blob = new Blob([content], { type: isYaml ? "application/yaml" : "application/json" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    const sourceSlug = selectedSource.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "selection";
    link.download = `openapi-${sourceSlug}-${new Date().toISOString().slice(0, 10)}.${isYaml ? "yaml" : "json"}`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    overlay.remove();
    toast("OpenAPI file exported.", "success");
  });
  actions.append(cancel, exportButton);
  dialog.append(title, formatLabel, sourceLabel, error, actions);
  overlay.append(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
  sourceSelect.focus();
}

$("exportCollections").addEventListener("click", showOpenApiExportDialog);

function parseOpenApiRequests(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("The file must contain an OpenAPI document.");
  }
  if (!/^3\./.test(String(spec.openapi || "")) || !spec.paths || typeof spec.paths !== "object") {
    throw new Error("This file must be a valid OpenAPI 3.x document with paths.");
  }
  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
  const resolveRef = (value) => {
    if (!value?.$ref?.startsWith("#/")) return value;
    return value.$ref.slice(2).split("/").reduce((node, part) => node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], spec) || value;
  };
  const resolveValue = (value) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const exampleFromSchema = (schema = {}) => {
    if (Object.hasOwn(schema, "example")) return schema.example;
    if (Object.hasOwn(schema, "default")) return schema.default;
    if (schema.type === "object") {
      return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, exampleFromSchema(value)]));
    }
    if (schema.type === "array") return [exampleFromSchema(schema.items || {})];
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return false;
    return "";
  };
  const operations = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths)) {
    const pathItem = resolveRef(rawPathItem);
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase()) || !operation || typeof operation !== "object") continue;
      const params = [];
      const headers = [];
      for (const rawParameter of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
        const parameter = resolveRef(rawParameter);
        if (!parameter || !parameter.name || parameter.in === "path" || parameter.in === "cookie") continue;
        const sample = Object.hasOwn(parameter, "example")
          ? parameter.example
          : parameter.schema ? exampleFromSchema(parameter.schema) : "";
        const row = { key: parameter.name, value: resolveValue(sample) };
        if (parameter.in === "query") params.push(row);
        if (parameter.in === "header") headers.push(row);
      }
      const server = operation.servers?.[0]?.url || spec.servers?.[0]?.url || window.location.origin;
      const base = server.replace(/\/$/, "");
      const url = `${base}${path.startsWith("/") ? path : `/${path}`}` || path;
      let body = "";
      let bodyType = "json";
      const content = resolveRef(operation.requestBody)?.content || {};
      const mediaType = Object.keys(content).find((type) => type === "application/json") || Object.keys(content)[0];
      if (mediaType) {
        const media = resolveRef(content[mediaType]) || {};
        const example = media.example ?? Object.values(media.examples || {})[0]?.value ?? exampleFromSchema(media.schema || {});
        bodyType = mediaType === "application/x-www-form-urlencoded" ? "urlencoded"
          : mediaType === "multipart/form-data" ? "form-data"
            : mediaType === "application/graphql" ? "graphql"
              : mediaType === "text/plain" ? "raw" : "json";
        body = bodyType === "json" ? (typeof example === "string" ? example : JSON.stringify(example, null, 2)) : resolveValue(example);
        if (!headers.some((header) => header.key.toLowerCase() === "content-type")) headers.push({ key: "Content-Type", value: mediaType });
      }
      const generatedName = `${method.toUpperCase()} ${path}`;
      operations.push({
        name: String(operation.summary || operation.operationId || generatedName).slice(0, 30),
        method: method.toUpperCase(), url, params, headers, bodyType, body, folderId: "",
      });
    }
  }
  if (!operations.length) throw new Error("No HTTP operations were found in this OpenAPI file.");
  return operations;
}

function showOpenApiImportDialog() {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Log in to import requests.");
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay";
  const dialog = document.createElement("section");
  dialog.className = "app-dialog app-dialog-wide export-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.textContent = "Import OpenAPI";
  const description = document.createElement("p");
  description.className = "export-description";
  description.textContent = "Choose an OpenAPI 3.x JSON or YAML file, then select where its requests should be imported.";
  const targetLabel = document.createElement("label");
  targetLabel.className = "export-format-label";
  targetLabel.textContent = "Import destination";
  const targetSelect = document.createElement("select");
  targetSelect.className = "app-dialog-input app-dialog-select";
  const allRequestsOption = document.createElement("option");
  allRequestsOption.value = "all";
  allRequestsOption.textContent = "All requests";
  targetSelect.append(allRequestsOption);
  folders.forEach((folder) => {
    const option = document.createElement("option");
    option.value = `folder:${folder.id}`;
    option.textContent = `Folder: ${folder.name}`;
    targetSelect.append(option);
  });
  collections.forEach((collection) => {
    const option = document.createElement("option");
    option.value = `collection:${collection.id}`;
    option.textContent = `Collection: ${collection.name}`;
    targetSelect.append(option);
  });
  targetLabel.append(targetSelect);
  const fileLabel = document.createElement("label");
  fileLabel.className = "export-format-label";
  fileLabel.textContent = "OpenAPI file (.json, .yaml, .yml)";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,.yaml,.yml,application/json,application/yaml,text/yaml";
  fileInput.className = "app-dialog-input openapi-file-input";
  fileLabel.append(fileInput);
  const status = document.createElement("p");
  status.className = "import-status";
  status.setAttribute("role", "status");
  let parsedRequests = null;
  let reading = false;
  let nextRequestIndex = 0;
  const actions = document.createElement("div");
  actions.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "app-dialog-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.className = "app-dialog-confirm";
  importButton.textContent = "Import";
  importButton.disabled = true;
  fileInput.addEventListener("change", async () => {
    parsedRequests = null;
    nextRequestIndex = 0;
    importButton.disabled = true;
    const file = fileInput.files?.[0];
    if (!file) { status.textContent = ""; return; }
    try {
      const text = await file.text();
      const isJson = file.name.toLowerCase().endsWith(".json");
      const spec = isJson ? JSON.parse(text) : window.jsyaml?.load(text);
      if (!isJson && !window.jsyaml) throw new Error("The YAML parser could not be loaded. Refresh the page and try again.");
      parsedRequests = parseOpenApiRequests(spec);
      status.textContent = `${parsedRequests.length} request${parsedRequests.length === 1 ? "" : "s"} found.`;
      status.classList.remove("is-error");
      importButton.disabled = false;
    } catch (error) {
      status.classList.add("is-error");
      status.textContent = error.message || "Could not read this OpenAPI file.";
    }
  });
  importButton.addEventListener("click", async () => {
    if (!parsedRequests?.length || reading) return;
    reading = true;
    importButton.disabled = true;
    cancel.disabled = true;
    fileInput.disabled = true;
    const destination = targetSelect.value;
    const [destinationType, destinationId] = destination.split(":", 2);
    const targetFolder = destinationType === "folder"
      ? folders.find((folder) => String(folder.id) === destinationId)
      : null;
    const targetCollection = destinationType === "collection"
      ? collections.find((collection) => String(collection.id) === destinationId)
      : null;
    if ((destinationType === "folder" && !targetFolder) || (destinationType === "collection" && !targetCollection)) {
      status.classList.add("is-error");
      status.textContent = "The selected folder or collection no longer exists. Close this window and try again.";
      reading = false;
      cancel.disabled = false;
      importButton.disabled = false;
      fileInput.disabled = false;
      return;
    }
    targetSelect.disabled = true;
    for (; nextRequestIndex < parsedRequests.length; nextRequestIndex += 1) {
      const request = parsedRequests[nextRequestIndex];
      try {
        if (destinationType === "folder") {
          const row = await new Promise((resolve, reject) => {
            const addEvent = new CustomEvent("apidesk:add-request-to-folder", {
              detail: { folderId: String(targetFolder.id), request, onAdded: resolve, onAddFailed: reject },
              cancelable: true,
            });
            document.dispatchEvent(addEvent);
            if (!addEvent.defaultPrevented) resolve({});
          });
          saved.unshift({ ...request, id: row?.id ? String(row.id) : undefined, folderId: String(targetFolder.id) });
          selectedFolder = String(targetFolder.id);
          expandedFolderIds.add(String(targetFolder.id));
        } else if (destinationType === "collection") {
          const rows = await new Promise((resolve, reject) => {
            const addEvent = new CustomEvent("apidesk:collection-requests-add", {
              detail: {
                collectionId: String(targetCollection.id),
                requests: [request],
                onAdded: resolve,
                onAddFailed: (error) => reject(error),
              },
              cancelable: true,
            });
            document.dispatchEvent(addEvent);
            if (!addEvent.defaultPrevented) resolve([request]);
          });
          const importedRow = Array.isArray(rows) ? rows[0] : rows;
          targetCollection.requests ||= [];
          targetCollection.requests.push(normalizeCollectionRequest(importedRow || request));
          expandedCollectionIds.add(String(targetCollection.id));
          storage.set(collectionsKey(currentUser), collections);
        } else {
          const row = await new Promise((resolve, reject) => {
            const saveEvent = new CustomEvent("apidesk:request-save", {
              detail: { request, onSaved: resolve, onSaveFailed: reject },
              cancelable: true,
            });
            document.dispatchEvent(saveEvent);
            if (!saveEvent.defaultPrevented) resolve({});
          });
          saved.unshift({ ...request, id: row?.id ? String(row.id) : undefined, folderId: "" });
          selectedFolder = "";
        }
      } catch (error) {
        status.classList.add("is-error");
        status.textContent = `${nextRequestIndex} of ${parsedRequests.length} imported into ${targetFolder?.name || targetCollection?.name || "All requests"}. ${error.message || "Saving failed."} You can retry the remaining requests.`;
        break;
      }
    }
    saved = saved.slice(0, 100);
    selectedSaved = 0;
    selectedFolder = "";
    storage.set(savedKey(currentUser), saved);
    renderSaved();
    if (nextRequestIndex === parsedRequests.length) {
      if (destinationType === "collection") storage.set(collectionsKey(currentUser), collections);
      overlay.remove();
      renderSaved();
      toast(`${nextRequestIndex} requests imported to ${targetFolder?.name || targetCollection?.name || "All requests"}.`, "success");
    } else {
      reading = false;
      cancel.disabled = false;
      importButton.disabled = false;
      importButton.textContent = "Retry remaining";
    }
  });
  actions.append(cancel, importButton);
  dialog.append(title, description, targetLabel, fileLabel, status, actions);
  overlay.append(dialog);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  fileInput.focus();
}

$("importOpenApi").addEventListener("click", showOpenApiImportDialog);

$("createCollection").addEventListener("click", () => {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Log in to create a collection.");
    return;
  }

  const choices = uniqueSavedRequestChoices();
  const checkboxOptions = choices.map((request, index) => ({
    value: String(index),
    label: `${request.name || request.url} — ${request.method || "GET"} ${request.url || ""}`,
  }));
  showAppDialog({
    title: "Create collection",
    message: choices.length
      ? "Pick any requests to copy into this collection. You can also add copies later."
      : "You can add request copies to this collection later.",
    value: "",
    checkboxOptions: checkboxOptions.length ? checkboxOptions : null,
    confirmLabel: "Create",
    maxLength: 30,
    onConfirm: (name, selectedValues) => {
      const selectedRequests = selectedValues
        .map((index) => choices[Number(index)])
        .filter(Boolean);
      const onCreated = (createdCollection = {}) => {
        const collection = {
          id: String(createdCollection.id || `collection-${Date.now()}-${Math.random().toString(16).slice(2)}`),
          name: createdCollection.name || name,
          description: createdCollection.description || "",
          headers: databaseValueToRows(createdCollection.headers),
          variables: databaseValueToRows(createdCollection.variables),
          auth: createdCollection.auth || {
            type: createdCollection.authtype || "none",
            ...(createdCollection.authconfig || {}),
          },
          settings: createdCollection.settings || {},
          requests: Array.isArray(createdCollection.requests)
            ? createdCollection.requests.map(normalizeCollectionRequest)
            : selectedRequests.map(makeCollectionCopy),
        };
        collections.unshift(collection);
        expandedCollectionIds.add(String(collection.id));
        storage.set(collectionsKey(currentUser), collections);
        renderSaved();
        toast("Collection created.", "success");
      };
      const collectionEvent = new CustomEvent("apidesk:collection-add", {
        detail: {
          name,
          headers: [],
          variables: [],
          authType: "none",
          authConfig: {},
          settings: {},
          requestIds: selectedRequests.map((request) => request.id).filter(Boolean),
          onCreated,
        },
        cancelable: true,
      });
      document.dispatchEvent(collectionEvent);
      if (!collectionEvent.defaultPrevented) onCreated({ name });
    },
  });
});

function addCurrentRequestToFolder(folderId) {
  if (!currentUser) {
    setAuthMode("login");
    $("authOverlay").classList.remove("hidden");
    toast("Log in to save requests.");
    return;
  }
  const request = captureRequest();
  if (!request.url) {
    toast("Enter a URL before adding the request to a folder.");
    return;
  }

  const existing = selectedSaved >= 0 ? saved[selectedSaved] : null;
  let requestPath = request.url;
  try {
    requestPath = new URL(request.url).pathname || request.url;
  } catch {
    // Keep the entered URL as the fallback path for relative URLs.
  }
  const defaultName = `${request.method} ${requestPath}`.slice(0, 30);
  request.name =
    String(existing?.name || defaultName).trim().slice(0, 30) || defaultName;
  request.folderId = String(folderId);

  const onAdded = (createdRequest = {}) => {
    if (createdRequest.id) request.id = String(createdRequest.id);
    $("requestTitle").textContent = request.name;
    $("crumbName").textContent = request.name;
    finishRequestMoveToFolder(existing, request, folderId);
  };

  const addRequestEvent = new CustomEvent("apidesk:add-request-to-folder", {
    detail: { folderId: String(folderId), request, onAdded },
    cancelable: true,
  });
  document.dispatchEvent(addRequestEvent);

  // Keep local behavior until a backend handler takes over this event.
  if (!addRequestEvent.defaultPrevented) onAdded();
}

$("folderList").addEventListener("click", (event) => {
  if (
    event.target.closest("[data-open], [data-rename-request], [data-delete], [data-move-request-out]")
  ) {
    handleSavedRequestClick(event);
    return;
  }
  const add = event.target.closest("[data-add-request-to-folder]");
  if (add) {
    addCurrentRequestToFolder(add.dataset.addRequestToFolder);
    return;
  }
  const select = event.target.closest("[data-toggle-folder]");
  if (select) {
    const folderId = select.dataset.toggleFolder;
    selectedFolder = folderId;
    if (expandedFolderIds.has(folderId)) expandedFolderIds.delete(folderId);
    else expandedFolderIds.add(folderId);
    selectedSaved = -1;
    renderSaved();
    return;
  }
  const rename = event.target.closest("[data-rename-folder]");
  if (rename) {
    const folder = folders.find(
      (item) => item.id === rename.dataset.renameFolder,
    );
    if (!folder) return;
    showAppDialog({
      title: "Rename folder",
      value: folder.name,
      confirmLabel: "Save",
      maxLength: 30,
      onConfirm: (name) => {
        const onRenamed = (updatedFolder = {}) => {
          folder.name = updatedFolder.name || name;
          storage.set(foldersKey(currentUser), folders);
          renderSaved();
          toast("Folder renamed.", "success");
        };
        const previousName = folder.name;
        const onRenameFailed = () => {
          folder.name = previousName;
          storage.set(foldersKey(currentUser), folders);
          renderSaved();
        };

        // Update the visible folder immediately while the backend saves it.
        folder.name = name;
        storage.set(foldersKey(currentUser), folders);
        renderSaved();

        const renameEvent = new CustomEvent("apidesk:folder-rename", {
          detail: { id: String(folder.id), name, onRenamed, onRenameFailed },
          cancelable: true,
        });
        document.dispatchEvent(renameEvent);

        // Keep local behavior until the backend handles this event.
        if (!renameEvent.defaultPrevented) {
          toast("Folder renamed.", "success");
        }
      },
    });
    return;
  }
  const del = event.target.closest("[data-delete-folder]");
  if (del) {
    const folder = folders.find((item) => item.id === del.dataset.deleteFolder);
    if (!folder) return;
    showAppDialog({
      title: "Delete folder?",
      message: `Delete “${folder.name}”? Requests inside will be moved to All requests.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        const onDeleted = () => {
          saved.forEach((item) => {
            if (String(item.folderId || "") === String(folder.id)) {
              item.folderId = "";
            }
          });
          folders = folders.filter(
            (item) => String(item.id) !== String(folder.id),
          );
          expandedFolderIds.delete(String(folder.id));
          if (String(selectedFolder) === String(folder.id)) selectedFolder = "";
          storage.set(foldersKey(currentUser), folders);
          storage.set(savedKey(currentUser), saved);
          renderSaved();
          toast("Folder deleted.", "success");
        };
        const deleteEvent = new CustomEvent("apidesk:folder-delete", {
          detail: { id: String(folder.id), onDeleted },
          cancelable: true,
        });
        document.dispatchEvent(deleteEvent);

        // Keep local behavior until the backend handles this event.
        if (!deleteEvent.defaultPrevented) onDeleted();
      },
    });
  }
});
$("authType").addEventListener("change", updateAuthFields);
$("bodyType").addEventListener("change", updateBodyPlaceholder);
$("method").addEventListener("change", updateMethodColor);
$("copyResponse").addEventListener("click", async () => {
  if (!lastResponse?.ok) return;
  try {
    await navigator.clipboard.writeText(lastResponse.raw);
    toast("Response body copied to clipboard.", "success");
  } catch {
    toast("Clipboard access is unavailable here.");
  }
});
$("downloadResponse").addEventListener("click", () => {
  if (!lastResponse?.ok) return;
  const blob = new Blob([lastResponse.raw], {
    type: lastResponse.contentType || "text/plain",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `api-response-${Date.now()}.${lastResponse.json !== null ? "json" : "txt"}`;
  link.click();
  URL.revokeObjectURL(link.href);
});

setRows("params", []);
setRows("headers", []);
updateAuthFields();
updateMethodColor();
updateBodyPlaceholder();
$("globalHeaders").value = storage.get(globalHeadersStorageKey, "");
$("globalHeaders").addEventListener("input", () =>
  storage.set(globalHeadersStorageKey, $("globalHeaders").value),
);
renderSaved();
let authMode = "login";
let sessionExpiryHandling = false;

function setLoginButtonState(isLoggedIn, email = "") {
  const button = $("loginBtn");
  button.classList.toggle("logged-in", isLoggedIn);
  button.textContent = isLoggedIn ? `${email} - Log out` : "Log in";
  $("accountSettingsBtn").classList.toggle("hidden", !isLoggedIn);
}

function showAccountSettings() {
  document.querySelector(".account-settings-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "account-settings-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "accountSettingsTitle");

  const panel = document.createElement("section");
  panel.className = "account-settings-panel";

  const heading = document.createElement("div");
  heading.className = "account-settings-heading";
  const title = document.createElement("h2");
  title.id = "accountSettingsTitle";
  title.textContent = "Account settings";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "account-settings-close";
  close.setAttribute("aria-label", "Close settings");
  close.textContent = "×";
  close.addEventListener("click", () => overlay.remove());
  heading.append(title, close);

  const profile = document.createElement("div");
  profile.className = "account-profile";
  profile.textContent = "Loading profile…";

  const deleteAccount = document.createElement("button");
  deleteAccount.type = "button";
  deleteAccount.className = "account-delete-button";
  deleteAccount.textContent = "Delete account";
  deleteAccount.addEventListener("click", showAccountDeletionDialog);

  panel.append(heading, profile, deleteAccount);
  overlay.append(panel);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.append(overlay);

  const showError = (message) => {
    if (!overlay.isConnected) return;
    profile.textContent = message || "Could not load account details.";
    profile.classList.add("account-profile-error");
  };
  const showProfile = (data = {}) => {
    if (!overlay.isConnected) return;
    profile.classList.remove("account-profile-error");
    profile.replaceChildren();
    const fields = [
      ["Email", data.email || currentUser || "—"],
      ["User ID", data.userid || "—"],
      ["Created", data.created || "—"],
    ];
    fields.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "account-profile-row";
      const name = document.createElement("span");
      name.textContent = label;
      const content = document.createElement("b");
      content.textContent = String(value);
      row.append(name, content);
      profile.append(row);
    });
  };

  const profileEvent = new CustomEvent("apidesk:user-profile", {
    detail: { onProfile: showProfile, onError: showError },
    cancelable: true,
  });
  document.dispatchEvent(profileEvent);
  if (!profileEvent.defaultPrevented) showError("Profile API is not connected.");
}

function showAccountDeletionDialog() {
  document.querySelector(".account-delete-overlay")?.remove();
  const challenge = String(Math.floor(1000 + Math.random() * 9000));
  const overlay = document.createElement("div");
  overlay.className = "app-dialog-overlay account-delete-overlay";
  overlay.setAttribute("role", "presentation");

  const dialog = document.createElement("section");
  dialog.className = "app-dialog account-delete-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "deleteAccountTitle");
  const title = document.createElement("h2");
  title.id = "deleteAccountTitle";
  title.textContent = "Delete account";
  const explanation = document.createElement("p");
  explanation.textContent = "This action permanently deletes your account. Type DELETE and the verification number to continue.";

  const wordLabel = document.createElement("label");
  wordLabel.className = "account-delete-label";
  wordLabel.textContent = "Type DELETE";
  const wordInput = document.createElement("input");
  wordInput.className = "app-dialog-input account-delete-input";
  wordInput.type = "text";
  wordInput.autocomplete = "off";
  wordInput.spellcheck = false;
  wordLabel.append(wordInput);

  const codeLabel = document.createElement("label");
  codeLabel.className = "account-delete-label";
  codeLabel.textContent = "Enter this number";
  const code = document.createElement("strong");
  code.className = "account-delete-code";
  code.textContent = challenge;
  const codeInput = document.createElement("input");
  codeInput.className = "app-dialog-input account-delete-input";
  codeInput.type = "text";
  codeInput.inputMode = "numeric";
  codeInput.autocomplete = "off";
  codeInput.maxLength = 4;
  codeLabel.append(code, codeInput);

  const status = document.createElement("p");
  status.className = "account-delete-status";
  status.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "app-dialog-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const proceed = document.createElement("button");
  proceed.type = "button";
  proceed.className = "app-dialog-confirm danger";
  proceed.textContent = "Continue";
  proceed.disabled = true;

  const validate = () => { proceed.disabled = wordInput.value !== "DELETE" || codeInput.value !== challenge; };
  wordInput.addEventListener("input", validate);
  codeInput.addEventListener("input", validate);
  proceed.addEventListener("click", () => {
    if (proceed.disabled) return;
    const confirmTitle = document.createElement("h2");
    confirmTitle.textContent = "Confirm account deletion";
    const confirmMessage = document.createElement("p");
    confirmMessage.textContent = "This cannot be undone. Do you want to permanently delete your account?";
    const confirmActions = document.createElement("div");
    confirmActions.className = "app-dialog-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "app-dialog-cancel";
    back.textContent = "Go back";
    back.addEventListener("click", () => {
      dialog.replaceChildren(title, explanation, wordLabel, codeLabel, status, actions);
      validate();
      wordInput.focus();
    });
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "app-dialog-confirm danger";
    confirm.textContent = "Yes, delete account";
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      back.disabled = true;
      confirm.textContent = "Deleting account...";
      status.textContent = "";
      const onDeleted = () => {
        const user = currentUser;
        if (user) {
          try {
            localStorage.removeItem(savedKey(user));
            localStorage.removeItem(foldersKey(user));
            localStorage.removeItem(collectionsKey(user));
          } catch { /* The server account is already deleted; continue clearing this session. */ }
        }
        currentUser = "";
        currentRefreshToken = "";
        currentAccessToken = "";
        sessionStorage.removeItem("apidesk.user");
        sessionStorage.removeItem("apidesk.refreshToken");
        sessionStorage.removeItem("apidesk.accessToken");
        saved = [];
        folders = [];
        collections = [];
        expandedCollectionIds.clear();
        expandedFolderIds.clear();
        selectedFolder = "";
        selectedSaved = -1;
        setLoginButtonState(false);
        document.dispatchEvent(new CustomEvent("apidesk:logged-out"));
        document.querySelector(".account-settings-overlay")?.remove();
        overlay.remove();
        renderSaved();
        toast("Your account has been deleted.", "success");
      };
      const onError = (message) => {
        confirm.disabled = false;
        back.disabled = false;
        confirm.textContent = "Yes, delete account";
        status.classList.add("is-error");
        status.textContent = message || "Could not delete the account. Please try again.";
      };
      const deleteEvent = new CustomEvent("apidesk:account-delete", {
        detail: { onDeleted, onError },
        cancelable: true,
      });
      document.dispatchEvent(deleteEvent);
      if (!deleteEvent.defaultPrevented) onError("Account deletion service is not connected.");
    });
    confirmActions.append(back, confirm);
    dialog.replaceChildren(confirmTitle, confirmMessage, status, confirmActions);
    confirm.focus();
  });

  actions.append(cancel, proceed);
  dialog.append(title, explanation, wordLabel, codeLabel, status, actions);
  overlay.append(dialog);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  wordInput.focus();
}

function finishLogout() {
  currentUser = "";
  currentRefreshToken = "";
  currentAccessToken = "";
  sessionStorage.removeItem("apidesk.user");
  sessionStorage.removeItem("apidesk.refreshToken");
  sessionStorage.removeItem("apidesk.accessToken");
  saved = [];
  folders = [];
  collections = [];
  expandedCollectionIds.clear();
  expandedFolderIds.clear();
  selectedFolder = "";
  selectedSaved = -1;
  setLoginButtonState(false);
  document.dispatchEvent(new CustomEvent("apidesk:logged-out"));
  document.querySelector(".account-settings-overlay")?.remove();
  $("authOverlay").classList.add("hidden");
  renderSaved();
  toast("You are logged out.", "success");
}

function completeLogin(userEmail, tokenData = {}) {
  const accessToken =
    tokenData?.access_token || tokenData?.accessToken || tokenData?.accestoken || "";
  const refreshToken =
    tokenData?.refresh_token ||
    tokenData?.refreshToken ||
    tokenData?.tefreshtoken ||
    tokenData?.resfreshtoken ||
    "";

  currentUser = userEmail;
  sessionExpiryHandling = false;
  currentAccessToken = accessToken;
  currentRefreshToken = refreshToken;
  sessionStorage.setItem("apidesk.user", userEmail);
  if (accessToken) sessionStorage.setItem("apidesk.accessToken", accessToken);
  else sessionStorage.removeItem("apidesk.accessToken");
  if (refreshToken) sessionStorage.setItem("apidesk.refreshToken", refreshToken);
  else sessionStorage.removeItem("apidesk.refreshToken");
  saved = storage.get(savedKey(userEmail), []);
  folders = storage.get(foldersKey(userEmail), []);
  collections = storage.get(collectionsKey(userEmail), []);
  expandedCollectionIds.clear();
  selectedFolder = "";
  selectedSaved = -1;
  setLoginButtonState(true, userEmail);
  $("authOverlay").classList.add("hidden");
  renderSaved();
  toast("You are logged in.", "success");

  if (accessToken) {
    document.dispatchEvent(
      new CustomEvent("apidesk:session-ready", {
        detail: { email: userEmail, accessToken },
      }),
    );
  }
}

document.addEventListener("apidesk:tokens-refreshed", (event) => {
  currentAccessToken = event.detail?.accessToken || currentAccessToken;
  currentRefreshToken = event.detail?.refreshToken || currentRefreshToken;
});

document.addEventListener("apidesk:session-expired", () => {
  if (sessionExpiryHandling || !currentUser) return;
  sessionExpiryHandling = true;
  finishLogout();
  showAuthForm("login");
  $("authOverlay").classList.remove("hidden");
  toast("Your session expired. Please log in again.");
});

function emailFromAccessToken(accessToken) {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims.email || claims.user_metadata?.email || "";
  } catch {
    return "";
  }
}

function showAuthForm(mode = "login") {
  const form = $("authForm");
  form.classList.remove("hidden");
  document.querySelector(".auth-switch").classList.remove("hidden");
  document.querySelector(".auth-note")?.classList.remove("hidden");
  document.querySelectorAll(
    ".email-verification-message, .email-verification-done, .logout-confirm-message, .logout-confirm-actions",
  )
    .forEach((element) => element.remove());
  const authError = $("authError");
  if (authError) authError.remove();
  setAuthMode(mode);
}

// Call this after the backend confirms that registration succeeded.
function showEmailVerification(email) {
  $("authForm").classList.add("hidden");
  document.querySelector(".auth-switch").classList.add("hidden");
  $("oauthOptions").classList.add("hidden");
  document.querySelector(".auth-note")?.classList.add("hidden");
  $("authTitle").textContent = "Check your email";
  $("authSubtitle").textContent = `We sent a verification link to ${email}. Open it, then return here.`;

  const dialog = document.querySelector(".auth-dialog");
  const message = document.createElement("p");
  message.className = "auth-note email-verification-message";
  message.textContent = "After you verify your email using the link, click Done to log in.";

  const done = document.createElement("button");
  done.type = "button";
  done.className = "auth-submit email-verification-done";
  done.textContent = "Done";
  done.addEventListener("click", () => {
    showAuthForm("login");
    $("loginPassword").value = "";
    $("loginEmail").focus();
  });
  dialog.append(message, done);
}

window.showEmailVerification = showEmailVerification;

function showLogoutConfirm() {
  document
    .querySelectorAll(".logout-confirm-message, .logout-confirm-actions")
    .forEach((element) => element.remove());
  $("authForm").classList.add("hidden");
  document.querySelector(".auth-switch").classList.add("hidden");
  $("oauthOptions").classList.add("hidden");
  document.querySelector(".auth-note")?.classList.add("hidden");
  document.querySelectorAll(
    ".email-verification-message, .email-verification-done",
  ).forEach((element) => element.remove());
  $("authTitle").textContent = "Log out";
  $("authSubtitle").textContent = "Are you sure you want to log out?";

  const dialog = document.querySelector(".auth-dialog");
  const message = document.createElement("p");
  message.className = "auth-note logout-confirm-message";
  message.textContent = "You can log in again at any time.";

  const actions = document.createElement("div");
  actions.className = "logout-confirm-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "logoutCancel";
  cancel.className = "auth-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () =>
    $("authOverlay").classList.add("hidden"),
  );

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.id = "logoutConfirm";
  confirm.className = "auth-danger";
  confirm.textContent = "Log out";
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    const logoutEvent = new CustomEvent("apidesk:logout-confirmed", {
      detail: {
        refreshToken: currentRefreshToken,
        accessToken: currentAccessToken,
        onLoggedOut: finishLogout,
      },
      cancelable: true,
    });
    document.dispatchEvent(logoutEvent);
    if (!logoutEvent.defaultPrevented) finishLogout();
  });

  actions.append(cancel, confirm);
  dialog.append(message, actions);
  $("authOverlay").classList.remove("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  const authError = $("authError");
  if (authError) authError.remove();
  document
    .querySelectorAll("[data-auth-mode]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.authMode === mode),
    );
  $("authTitle").textContent =
    mode === "login" ? "Welcome back" : "Create your account";
  $("authSubtitle").textContent =
    mode === "login"
      ? "Log in to your APIDesk account"
      : "Register for an APIDesk account";
  $("authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
  $("oauthOptions").classList.toggle("hidden", mode !== "login");
  $("confirmPasswordWrap").classList.toggle("hidden", mode !== "register");
  $("legalAcceptanceWrap").classList.toggle("hidden", mode !== "register");
  $("acceptLegal").required = mode === "register";
  $("acceptLegal").checked = false;
  $("loginPassword").autocomplete =
    mode === "login" ? "current-password" : "new-password";
  $("confirmPassword").required = mode === "register";
}
$("loginBtn").addEventListener("click", () => {
  if (currentUser) {
    showLogoutConfirm();
    return;
  }
  showAuthForm("login");
  $("authOverlay").classList.remove("hidden");
});
$("accountSettingsBtn").addEventListener("click", () => {
  if (!currentUser) return;
  showAccountSettings();
});
$("authClose").addEventListener("click", () =>
  $("authOverlay").classList.add("hidden"),
);
$("authOverlay").addEventListener("click", (event) => {
  if (event.target === $("authOverlay"))
    $("authOverlay").classList.add("hidden");
});
document
  .querySelectorAll("[data-auth-mode]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      setAuthMode(button.dataset.authMode),
    ),
  );
$("authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (
    authMode === "register" &&
    $("loginPassword").value !== $("confirmPassword").value
  ) {
    toast("Passwords do not match.");
    $("confirmPassword").focus();
    return;
  }
  const email = $("loginEmail").value.trim().toLowerCase();
  if (!email || $("loginPassword").value.length < 8) {
    toast("Enter a valid email and a password with at least 8 characters.");
    return;
  }
  const mode = authMode;
  const password = $("loginPassword").value;
  const onRegistered = () => showEmailVerification(email);
  const onLoggedIn = (userEmail = email, tokenData = {}) =>
    completeLogin(userEmail, tokenData);

  const authEvent = new CustomEvent("apidesk:auth-submit", {
    detail: { mode, email, password, onRegistered, onLoggedIn },
    cancelable: true,
  });
  document.dispatchEvent(authEvent);
  if (!authEvent.defaultPrevented) {
    toast("Connect an auth handler in backend.js to continue.");
  }
});
document.querySelectorAll("[data-oauth-provider]").forEach((button) => {
  button.addEventListener("click", () => {
    const oauthEvent = new CustomEvent("apidesk:oauth-login", {
      detail: { provider: button.dataset.oauthProvider },
      cancelable: true,
    });
    document.dispatchEvent(oauthEvent);
    if (!oauthEvent.defaultPrevented) {
      const backendUrl = (window.APIDESK_CONFIG?.backendUrl || "").replace(/\/+$/, "");
      window.location.href = `${backendUrl}/api/auth/oauth/${encodeURIComponent(button.dataset.oauthProvider)}`;
    }
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("authOverlay").classList.add("hidden");
});
if (currentUser) setLoginButtonState(true, currentUser);

const oauthHash = new URLSearchParams(window.location.hash.slice(1));
const oauthAccessToken = oauthHash.get("access_token");
const oauthRefreshToken = oauthHash.get("refresh_token");
if (oauthAccessToken && oauthRefreshToken) {
  const oauthEmail = emailFromAccessToken(oauthAccessToken);
  if (oauthEmail) {
    completeLogin(oauthEmail, {
      access_token: oauthAccessToken,
      refresh_token: oauthRefreshToken,
    });
  } else {
    showAuthForm("login");
    $("authOverlay").classList.remove("hidden");
    toast("OAuth sign-in succeeded, but the account email was not found.");
  }
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
} else if (new URLSearchParams(window.location.search).has("auth_error")) {
  showAuthForm("login");
  $("authOverlay").classList.remove("hidden");
  toast("OAuth sign-in failed. Please try again.");
  window.history.replaceState(null, "", window.location.pathname);
}
