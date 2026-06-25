const state = {
  token: localStorage.getItem("swiToken"),
  user: JSON.parse(localStorage.getItem("swiUser") || "null"),
  location: null,
  selectedFiles: [],
  shareContext: null,
  wakeLock: null,
  installPrompt: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MAX_UPLOAD_BYTES = 28 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;
const MAX_PHOTO_EDGE = 1600;
const PHOTO_QUALITY = 0.75;
const ADMIN_ROLES = new Set(["super_admin", "admin", "ceo", "team_head"]);
const ROLE_LABELS = {
  super_admin: "Super Admin",
  ceo: "CEO",
  team_head: "Team Head",
  admin: "Admin",
  field: "Field team"
};
const ROLE_OPTIONS = Object.entries(ROLE_LABELS)
  .map(([value, label]) => `<option value="${value}">${label}</option>`)
  .join("");

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const message = payload.error || payload.message || `Request failed with status ${response.status}`;
    throw new Error(message.includes(String(response.status)) ? message : `${message} (${response.status})`);
  }
  return payload;
}

function today() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function showSignedIn() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#logoutButton").classList.remove("hidden");
  $("#personName").value = state.user.name;
  $("#reportDate").value = today();
  $("#adminTab").classList.toggle("hidden", !ADMIN_ROLES.has(state.user.role));
  updateInstallPrompt();
}

function showSignedOut() {
  $("#loginView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
  $("#logoutButton").classList.add("hidden");
  $("#installPrompt").classList.add("hidden");
}

async function bootstrap() {
  if (!state.token) return showSignedOut();
  try {
    state.user = await api("/api/me");
    localStorage.setItem("swiUser", JSON.stringify(state.user));
    showSignedIn();
    await loadVillages();
    if (navigator.onLine) await loadReports();
    restoreDraft();
    await flushQueue();
    if (ADMIN_ROLES.has(state.user.role)) await loadAdmin();
  } catch (error) {
    if (!navigator.onLine && state.user) {
      showSignedIn();
      await loadVillages();
      restoreDraft();
      await updateConnection();
      return;
    }
    console.warn("Unable to restore session:", error.message);
    logout();
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("swiToken");
  localStorage.removeItem("swiUser");
  showSignedOut();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("swiToken", state.token);
    localStorage.setItem("swiUser", JSON.stringify(state.user));
    showSignedIn();
    await Promise.all([loadVillages(), loadReports()]);
    if (ADMIN_ROLES.has(state.user.role)) await loadAdmin();
  } catch (error) {
    alert(error.message);
  }
});

$("#logoutButton").addEventListener("click", logout);

function updateInstallPrompt() {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("#installPrompt").classList.toggle("hidden", !state.user || isStandalone);
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  updateInstallPrompt();
});

$("#installButton").addEventListener("click", async () => {
  if (!state.installPrompt) {
    alert("To install: open your browser menu and choose 'Add to Home screen' or 'Install app'. On iPhone, use Share > Add to Home Screen.");
    return;
  }
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  updateInstallPrompt();
});

window.addEventListener("appinstalled", () => {
  state.installPrompt = null;
  updateInstallPrompt();
});

$$(".tabs button").forEach((button) => button.addEventListener("click", () => {
  $$(".tabs button").forEach((item) => item.classList.toggle("active", item === button));
  ["new", "history", "admin"].forEach((view) => {
    $(`#${view}View`).classList.toggle("hidden", view !== button.dataset.view);
  });
  if (button.dataset.view === "history") loadReports().catch((error) => alert(error.message));
  if (button.dataset.view === "admin") loadAdmin().catch((error) => alert(error.message));
}));

async function loadVillages() {
  let villages;
  try {
    villages = await api("/api/villages");
    localStorage.setItem("swiVillages", JSON.stringify(villages));
  } catch (error) {
    villages = JSON.parse(localStorage.getItem("swiVillages") || "[]");
    if (!villages.length) throw error;
  }
  $("#villageSelect").innerHTML = '<option value="">Select a village</option>' +
    villages.map((village) => `<option value="${village.id}">${escapeHtml(village.name)}</option>`).join("");
}

$("#reportText").addEventListener("input", (event) => {
  $("#characterCount").textContent = `${event.target.value.length.toLocaleString()} / 3,000`;
  saveDraft();
});

$("#villageSelect").addEventListener("change", saveDraft);
$("#reportTypeSelect").addEventListener("change", saveDraft);
$("#reportDate").addEventListener("change", saveDraft);

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function selectedUploadSize(files = state.selectedFiles) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not prepare ${file.name}.`));
    };
    image.src = url;
  });
}

async function compressPhoto(file) {
  if (!file.type.startsWith("image/") || file.size <= 900 * 1024) return file;
  try {
    const image = await imageFromFile(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch (error) {
    console.warn("Photo compression failed:", error.message);
    return file;
  }
}

async function addSelectedFiles(files) {
  $("#formMessage").classList.remove("success");
  $("#formMessage").textContent = files.length ? "Preparing selected files..." : "";
  const prepared = [];
  for (const file of files) prepared.push(await compressPhoto(file));

  const combined = [...state.selectedFiles, ...prepared];
  state.selectedFiles = combined.slice(0, 50);
  if (combined.length > 50) alert("Only 50 files can be attached to one report.");
  renderMediaPreview();
  const total = selectedUploadSize();
  $("#formMessage").textContent = state.selectedFiles.length
    ? `Selected ${state.selectedFiles.length} file${state.selectedFiles.length === 1 ? "" : "s"} (${formatFileSize(total)}). Large videos will upload in parts.`
    : "";
}

$("#mediaInput").addEventListener("change", (event) => {
  addSelectedFiles([...event.target.files]).catch((error) => ($("#formMessage").textContent = error.message));
  event.target.value = "";
});
$("#cameraInput").addEventListener("change", (event) => {
  addSelectedFiles([...event.target.files]).catch((error) => ($("#formMessage").textContent = error.message));
  event.target.value = "";
});

function renderMediaPreview() {
  $("#mediaPreview").innerHTML = state.selectedFiles.map((file) => {
    const url = URL.createObjectURL(file);
    const preview = file.type.startsWith("image/")
      ? `<img src="${url}" alt="">`
      : `<video src="${url}" muted></video>`;
    return `<div class="media-chip">${preview}<span>${escapeHtml(file.name)}</span></div>`;
  }).join("");
}

$("#locationButton").addEventListener("click", () => {
  if (!navigator.geolocation) return ($("#locationStatus").textContent = "GPS is not supported.");
  $("#locationStatus").textContent = "Finding location…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
      $("#locationStatus").textContent =
        `${state.location.latitude.toFixed(6)}, ${state.location.longitude.toFixed(6)}`;
      saveDraft();
    },
    (error) => { $("#locationStatus").textContent = `Location unavailable: ${error.message}`; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

$("#reportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#submitButton");
  button.disabled = true;
  button.textContent = navigator.onLine ? "Uploading…" : "Saving offline…";
  $("#formMessage").textContent = "";
  try {
    if (!navigator.onLine) {
      await queueCurrentReport(form);
      resetReportForm(form);
      $("#formMessage").textContent = "Saved offline. It will upload automatically when this app is online.";
      $("#formMessage").classList.add("success");
      await updateConnection();
      return;
    }
    const shareContext = {
      personName: state.user.name,
      villageName: $("#villageSelect").selectedOptions[0]?.textContent || "",
      reportType: form.elements.reportType.value,
      reportDate: form.elements.date.value
    };
    await requestUploadWakeLock();
    const result = await submitReportValues(reportValuesFromForm(form), (message) => ($("#formMessage").textContent = message));
    openShare(result.shareUrl, shareContext);
    resetReportForm(form);
    await loadReports();
  } catch (error) {
    $("#formMessage").textContent = error.message;
  } finally {
    await releaseUploadWakeLock();
    button.disabled = false;
    button.textContent = "Submit report";
  }
});

function reportValuesFromForm(form) {
  return {
    villageId: form.elements.villageId.value,
    reportType: form.elements.reportType.value,
    date: form.elements.date.value,
    report: form.elements.report.value,
    latitude: state.location?.latitude,
    longitude: state.location?.longitude,
    files: state.selectedFiles
  };
}

function splitUploadFiles(files) {
  const directFiles = [];
  const chunkedFiles = [];
  let directBytes = 0;
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES || directBytes + file.size > MAX_UPLOAD_BYTES) {
      chunkedFiles.push(file);
    } else {
      directFiles.push(file);
      directBytes += file.size;
    }
  }
  return { directFiles, chunkedFiles };
}

function makeReportFormData(form, queued, filesOverride = null) {
  const data = new FormData();
  const values = queued || {
    villageId: form.elements.villageId.value,
    reportType: form.elements.reportType.value,
    date: form.elements.date.value,
    report: form.elements.report.value,
    latitude: state.location?.latitude,
    longitude: state.location?.longitude,
    files: state.selectedFiles
  };
  const files = filesOverride || values.files;
  data.set("villageId", values.villageId);
  data.set("reportType", values.reportType || "General Visit");
  data.set("date", values.date);
  data.set("report", values.report);
  if (values.latitude != null) data.set("latitude", values.latitude);
  if (values.longitude != null) data.set("longitude", values.longitude);
  data.set("mediaDates", JSON.stringify(files.map((file) => file.lastModified)));
  files.forEach((file) => data.append("media", file, file.name));
  return data;
}

async function submitReportValues(values, onProgress = () => {}) {
  const { directFiles, chunkedFiles } = splitUploadFiles(values.files);
  if (chunkedFiles.length) {
    onProgress(`Creating report. ${chunkedFiles.length} large file${chunkedFiles.length === 1 ? "" : "s"} will upload in parts...`);
  }
  const result = await api("/api/reports", {
    method: "POST",
    body: makeReportFormData(null, values, directFiles)
  });
  for (let index = 0; index < chunkedFiles.length; index++) {
    await uploadLargeFile(result.id, chunkedFiles[index], index + 1, chunkedFiles.length, onProgress);
  }
  return result;
}

async function requestUploadWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.warn("Screen wake lock unavailable:", error.message);
  }
}

async function releaseUploadWakeLock() {
  if (!state.wakeLock) return;
  try {
    await state.wakeLock.release();
  } catch {}
  state.wakeLock = null;
}

async function uploadLargeFile(reportId, file, number, totalFiles, onProgress) {
  const init = await api(`/api/reports/${reportId}/media/init`, {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified
    })
  });
  const chunkSize = init.chunkSize || DEFAULT_CHUNK_BYTES;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size) - 1;
    const chunk = file.slice(offset, end + 1);
    const payload = await uploadChunkWithRetry(init.uploadId, chunk, offset, end, file.size, (attempt) => {
      onProgress(`Network issue. Retrying ${file.name} part ${attempt}/${MAX_CHUNK_RETRIES}...`);
    });
    offset = payload.uploadedBytes || end + 1;
    const percent = Math.min(100, Math.round((offset / file.size) * 100));
    onProgress(`Uploading large file ${number}/${totalFiles}: ${file.name} (${percent}%)`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadChunkWithRetry(uploadId, chunk, start, end, total, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      const response = await fetch(`/api/uploads/${uploadId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${state.token}`,
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${total}`
        },
        body: chunk
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { error: text.slice(0, 250) };
      }
      if (!response.ok) {
        const error = new Error(payload.error || `Upload failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      if (attempt === MAX_CHUNK_RETRIES) break;
      onRetry(attempt + 1);
      await wait(1200 * attempt);
    }
  }
  throw new Error(`Network problem while uploading video. Please keep the app open and retry. Last error: ${lastError?.message || "upload failed"}`);
}

function resetReportForm(form) {
  form.reset();
  $("#personName").value = state.user.name;
  $("#reportDate").value = today();
  $("#reportTypeSelect").value = "";
  $("#characterCount").textContent = "0 / 3,000";
  state.location = null;
  state.selectedFiles = [];
  $("#mediaPreview").innerHTML = "";
  $("#locationStatus").textContent = "Location not captured";
  $("#formMessage").classList.remove("success");
  localStorage.removeItem("swiReportDraft");
}

function saveDraft() {
  localStorage.setItem("swiReportDraft", JSON.stringify({
    villageId: $("#villageSelect").value,
    reportType: $("#reportTypeSelect").value,
    date: $("#reportDate").value,
    report: $("#reportText").value,
    location: state.location
  }));
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem("swiReportDraft"));
    if (!draft) return;
    $("#villageSelect").value = draft.villageId || "";
    $("#reportTypeSelect").value = draft.reportType || "";
    $("#reportDate").value = draft.date || today();
    $("#reportText").value = draft.report || "";
    $("#characterCount").textContent = `${$("#reportText").value.length.toLocaleString()} / 3,000`;
    state.location = draft.location || null;
    if (state.location) {
      $("#locationStatus").textContent =
        `${state.location.latitude.toFixed(6)}, ${state.location.longitude.toFixed(6)}`;
    }
  } catch {
    localStorage.removeItem("swiReportDraft");
  }
}

function queueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("swi-reports", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("queue", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueOperation(mode, operation) {
  const db = await queueDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("queue", mode);
    const result = operation(transaction.objectStore("queue"));
    result.onsuccess = () => resolve(result.result);
    result.onerror = () => reject(result.error);
  });
}

async function queueCurrentReport(form) {
  await queueOperation("readwrite", (store) => store.put({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    villageId: form.elements.villageId.value,
    reportType: form.elements.reportType.value,
    date: form.elements.date.value,
    report: form.elements.report.value,
    latitude: state.location?.latitude,
    longitude: state.location?.longitude,
    files: state.selectedFiles
  }));
}

async function getQueuedReports() {
  return queueOperation("readonly", (store) => store.getAll());
}

async function flushQueue() {
  if (!navigator.onLine || !state.token) return;
  const queued = await getQueuedReports();
  if (queued.length) await requestUploadWakeLock();
  try {
    for (const report of queued.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        await submitReportValues(report);
        await queueOperation("readwrite", (store) => store.delete(report.id));
      } catch (error) {
        console.warn("Queued report remains pending:", error.message);
        break;
      }
    }
    if (queued.length) await loadReports();
    await updateConnection();
  } finally {
    await releaseUploadWakeLock();
  }
}

async function loadReports() {
  let reports;
  try {
    reports = await api("/api/reports");
  } catch (error) {
    if (!navigator.onLine) {
      $("#reportList").innerHTML = "<p>Report history is unavailable offline. New reports can still be saved offline.</p>";
      return;
    }
    throw error;
  }

  $("#reportList").innerHTML = reports.length ? reports.map((report) => `
    <article class="list-item">
      <div>
        <strong>${escapeHtml(report.village_name)} · ${escapeHtml(report.report_date)}</strong>
        <p>${escapeHtml(report.report_type || "General Visit")} · ${escapeHtml(report.person_name)} · ${report.media_count} attachment${report.media_count === 1 ? "" : "s"}</p>
      </div>
      <button
        data-share="${escapeHtml(report.shareUrl)}"
        data-person="${escapeHtml(report.person_name)}"
        data-village="${escapeHtml(report.village_name)}"
        data-type="${escapeHtml(report.report_type || "General Visit")}"
        data-date="${escapeHtml(report.report_date)}"
      >Share</button>
    </article>
  `).join("") : "<p>No reports submitted yet.</p>";
  $$("[data-share]").forEach((button) => button.addEventListener("click", () => openShare(button.dataset.share, {
    personName: button.dataset.person,
    villageName: button.dataset.village,
    reportType: button.dataset.type,
    reportDate: button.dataset.date
  })));
}

function openShare(url, context = null) {
  $("#shareUrl").value = url;
  state.shareContext = context;
  $("#shareDialog").classList.remove("hidden");
}

$("#closeDialogButton").addEventListener("click", () => $("#shareDialog").classList.add("hidden"));
$("#copyButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#shareUrl").value);
  $("#copyButton").textContent = "Copied";
  setTimeout(() => ($("#copyButton").textContent = "Copy link"), 1500);
});
$("#whatsappButton").addEventListener("click", () => {
  const url = $("#shareUrl").value;
  const context = state.shareContext || {};
  const details = [
    context.personName ? `Field representative: ${context.personName}` : "",
    context.villageName ? `Village: ${context.villageName}` : "",
    context.reportType ? `Report type: ${context.reportType}` : "",
    context.reportDate ? `Report date: ${context.reportDate}` : ""
  ].filter(Boolean).join("\n");
  const message = `SWI Daily Field Report\n${details ? `\n${details}\n` : ""}\nView the report, photos and videos:\n${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener");
});

async function loadAdmin() {
  $("#teamUsersCard").classList.toggle("hidden", state.user.role !== "super_admin");
  const tasks = [loadGoogleStatus()];
  if (state.user.role === "super_admin") tasks.push(loadAdminUsers());
  await Promise.all(tasks);
}

async function loadGoogleStatus() {
  const status = await api("/api/admin/google/status");
  $("#googleStatus").textContent = status.connected
    ? `Connected to ${status.email}`
    : status.email
      ? `Google Drive authorization needs reconnecting for ${status.email}.`
      : "Google Drive is not connected.";
  $("#disconnectGoogleButton").classList.toggle("hidden", !status.connected && !status.email);
}

$("#connectGoogleButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/admin/google/connect");
    window.location.href = result.url;
  } catch (error) {
    alert(error.message);
  }
});

$("#disconnectGoogleButton").addEventListener("click", async () => {
  if (!confirm("Disconnect Google Drive? New reports cannot be submitted until another account is connected.")) return;
  try {
    await api("/api/admin/google/disconnect", { method: "POST" });
    await loadGoogleStatus();
  } catch (error) {
    alert(error.message);
  }
});

async function loadAdminVillages() {
  $("#villageMessage").textContent = "";
}

$("#villageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api("/api/admin/villages", { method: "POST", body: JSON.stringify(data) });
    form.reset();
    $("#villageMessage").textContent = "Village added.";
    $("#villageMessage").classList.add("success");
    await loadVillages();
  } catch (error) { alert(error.message); }
});

async function loadAdminUsers() {
  const users = await api("/api/admin/users");
  $("#adminUserList").innerHTML = users.map((user) => `
    <div class="list-item">
      <div><strong>${escapeHtml(user.name)}</strong><p>${escapeHtml(user.email)} · ${user.role}</p></div>
      <button class="${user.active ? "danger" : "secondary"}" data-user-id="${user.id}" data-active="${user.active ? "0" : "1"}">
        ${user.active ? "Disable" : "Enable"}
      </button>
    </div>
  `).join("");
  $$("[data-user-id]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/admin/users/${button.dataset.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ active: button.dataset.active === "1" })
    });
    await loadAdminUsers();
  }));
}

async function loadAdminUsers() {
  const users = await api("/api/admin/users");
  $("#adminUserList").innerHTML = users.map((user) => `
    <div class="list-item">
      <div>
        <strong>${escapeHtml(user.name)}</strong>
        <p>${escapeHtml(user.email)} · ${escapeHtml(ROLE_LABELS[user.role] || user.role)} · ${user.active ? "Active" : "Inactive"}</p>
      </div>
      <div class="item-actions">
        <select data-user-role="${user.id}">
          ${ROLE_OPTIONS.replace(`value="${user.role}"`, `value="${user.role}" selected`)}
        </select>
        <button class="${user.active ? "danger" : "secondary"}" data-user-active-id="${user.id}" data-active="${user.active ? "0" : "1"}">
          ${user.active ? "Disable" : "Enable"}
        </button>
        <button class="danger" data-user-delete-id="${user.id}">Delete</button>
      </div>
    </div>
  `).join("");
  $$("[data-user-role]").forEach((select) => select.addEventListener("change", async () => {
    await api(`/api/admin/users/${select.dataset.userRole}`, {
      method: "PATCH",
      body: JSON.stringify({ role: select.value })
    });
    await loadAdminUsers();
  }));
  $$("[data-user-active-id]").forEach((button) => button.addEventListener("click", async () => {
    await api(`/api/admin/users/${button.dataset.userActiveId}`, {
      method: "PATCH",
      body: JSON.stringify({ active: button.dataset.active === "1" })
    });
    await loadAdminUsers();
  }));
  $$("[data-user-delete-id]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this team member? If they have submitted reports, the account will be deactivated to keep old reports safe.")) return;
    await api(`/api/admin/users/${button.dataset.userDeleteId}`, { method: "DELETE" });
    await loadAdminUsers();
  }));
}

$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify(data) });
    form.reset();
    await loadAdminUsers();
  } catch (error) { alert(error.message); }
});

$("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#passwordMessage");
  message.textContent = "";
  message.classList.remove("success");
  const data = Object.fromEntries(new FormData(form));
  try {
    await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(data) });
    form.reset();
    message.textContent = "Password updated.";
    message.classList.add("success");
  } catch (error) {
    message.textContent = error.message;
  }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

async function updateConnection() {
  const online = navigator.onLine;
  let pending = 0;
  try { pending = (await getQueuedReports()).length; } catch {}
  $("#connectionBadge").textContent = `${online ? "Online" : "Offline"}${pending ? ` · ${pending} pending` : ""}`;
  $("#connectionBadge").classList.toggle("offline", !online);
}
window.addEventListener("online", () => flushQueue());
window.addEventListener("offline", updateConnection);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.wakeLock?.released) {
    requestUploadWakeLock();
  }
});
updateConnection();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js");
bootstrap();
