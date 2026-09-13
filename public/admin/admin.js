// NOTE: this panel is only reachable behind the session-gated /admin route,
// but the endpoints it calls still enforce auth server-side independently.

const actionStatus = document.getElementById('actionStatus');
const updateStatus = document.getElementById('updateStatus');
const rollbackStatus = document.getElementById('rollbackStatus');

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = 'status-msg' + (kind ? ` ${kind}` : '');
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

// ---- Server actions (reuse existing /api/* admin endpoints; the session
// cookie satisfies requireAdmin the same way the X-Admin-Secret header does) ----
async function callAdminApi(path, confirmMsg) {
  if (confirmMsg && !window.confirm(confirmMsg)) return;
  setStatus(actionStatus, 'Working…');
  try {
    const res = await fetch(path, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    setStatus(actionStatus, JSON.stringify(data), 'ok');
  } catch (err) {
    setStatus(actionStatus, err.message, 'err');
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => callAdminApi('/api/refresh'));
document.getElementById('backupBtn').addEventListener('click', () => callAdminApi('/api/backup'));
document.getElementById('resetBtn').addEventListener('click', () =>
  callAdminApi('/api/reset', 'This wipes all leaderboard data (a backup is taken first). Continue?'));
document.getElementById('nukeBtn').addEventListener('click', () =>
  callAdminApi('/api/nuke', 'This deletes and rebuilds the database from scratch. Continue?'));

// ---- Update upload/apply flow ----
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const uploadResult = document.getElementById('uploadResult');
const fileList = document.getElementById('fileList');
const fileCountSummary = document.getElementById('fileCountSummary');
const packageKind = document.getElementById('packageKind');
let currentUploadId = null;

document.getElementById('chooseFileBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadPackage(fileInput.files[0]); });

['dragover', 'dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, e => e.preventDefault());
});
dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) uploadPackage(file);
});

async function uploadPackage(file) {
  setStatus(updateStatus, 'Uploading and validating…');
  uploadResult.hidden = true;
  const form = new FormData();
  form.append('package', file);
  try {
    const res = await fetch('/admin/update/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload rejected');

    currentUploadId = data.uploadId;
    packageKind.textContent = data.looksFullPackage ? 'full package' : 'partial / changed files';
    fileList.innerHTML = data.files.map(f => `${f.path} <span style="color:#666">(${f.size}B)</span>`).join('<br>');
    fileCountSummary.textContent = `${data.count} file(s), ${data.totalBytes} bytes total`;
    uploadResult.hidden = false;
    setStatus(updateStatus, 'Staged — review the files below, then confirm your password to apply.', 'ok');
  } catch (err) {
    setStatus(updateStatus, err.message, 'err');
  }
}

document.getElementById('cancelUploadBtn').addEventListener('click', () => {
  currentUploadId = null;
  uploadResult.hidden = true;
  fileInput.value = '';
  setStatus(updateStatus, 'Cancelled.');
});

document.getElementById('applyBtn').addEventListener('click', async () => {
  const password = document.getElementById('applyPassword').value;
  if (!password) { setStatus(updateStatus, 'Enter the admin password to apply.', 'err'); return; }
  if (!currentUploadId) { setStatus(updateStatus, 'No package staged.', 'err'); return; }
  if (!window.confirm('Apply this update? The server will validate it and restart automatically if it passes.')) return;

  setStatus(updateStatus, 'Backing up, applying, and validating (this can take up to ~30s)…');
  try {
    const res = await fetch('/admin/update/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: currentUploadId, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    setStatus(updateStatus, `${data.message}\nBackups: code=${data.codeBackup}, db=${data.dbBackup}`, 'ok');
    uploadResult.hidden = true;
    currentUploadId = null;
    document.getElementById('applyPassword').value = '';
  } catch (err) {
    setStatus(updateStatus, err.message, 'err');
  }
});

// ---- Manual rollback ----
async function loadBackups() {
  const sel = document.getElementById('backupSelect');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const res = await fetch('/admin/backups/code');
    const data = await res.json();
    sel.innerHTML = data.backups.length
      ? data.backups.map(b => `<option value="${b}">${b}</option>`).join('')
      : '<option value="">No backups available</option>';
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}
document.getElementById('loadBackupsBtn').addEventListener('click', loadBackups);
loadBackups();

document.getElementById('rollbackBtn').addEventListener('click', async () => {
  const backupFile = document.getElementById('backupSelect').value;
  const password = document.getElementById('rollbackPassword').value;
  if (!backupFile) { setStatus(rollbackStatus, 'Select a backup first.', 'err'); return; }
  if (!password) { setStatus(rollbackStatus, 'Enter the admin password.', 'err'); return; }
  if (!window.confirm(`Roll back to ${backupFile}? The server will restart.`)) return;

  setStatus(rollbackStatus, 'Rolling back…');
  try {
    const res = await fetch('/admin/update/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupFile, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rollback failed');
    setStatus(rollbackStatus, data.message, 'ok');
    document.getElementById('rollbackPassword').value = '';
  } catch (err) {
    setStatus(rollbackStatus, err.message, 'err');
  }
});
