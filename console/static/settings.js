const $ = (sel) => document.querySelector(sel);

const API_BASE = `${location.protocol}//${location.host}`;

let pendingAvatar = '';

function toast(message, isError = false) {
  const el = $('#mh-toast');
  if (!el) return;
  const icon = $('#mh-toast-icon');
  const text = $('#mh-toast-text');
  if (icon) icon.textContent = isError ? '!' : '✓';
  if (text) text.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

async function api(path, options = {}) {
  const resp = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const detail = data && data.detail ? data.detail : data;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

function setInitial(name) {
  const el = $('#avatar-initial');
  if (el) el.textContent = (name || 'M').charAt(0).toUpperCase();
}

function showPreview(url) {
  const img = $('#avatar-img');
  const initial = $('#avatar-initial');
  if (!url) {
    img.hidden = true;
    if (initial) initial.hidden = false;
    return;
  }
  img.src = url;
  img.hidden = false;
  if (initial) initial.hidden = true;
}

async function loadAccount() {
  try {
    const data = await api('/api/settings/account');
    $('#acc-user').value = data.username || '';
    setInitial(data.username);
  } catch {
    /* 未登录时中间件已跳转，这里忽略 */
  }
}

async function loadAvatar() {
  try {
    const resp = await fetch(`${API_BASE}/api/avatar`, { cache: 'no-store' });
    if (!resp.ok) return;
    showPreview(URL.createObjectURL(await resp.blob()));
  } catch {
    /* 没有头像时保持首字母 */
  }
}

const crop = {
  imgEl: null,
  naturalW: 0,
  naturalH: 0,
  baseK: 1,
  k: 1,
  left: 0,
  top: 0,
  dragging: false,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startTop: 0,
};

function cropBoxSize() {
  return $('#crop-box').clientWidth;
}

function clampCrop() {
  const box = cropBoxSize();
  const width = crop.naturalW * crop.k;
  const height = crop.naturalH * crop.k;
  crop.left = Math.min(0, Math.max(box - width, crop.left));
  crop.top = Math.min(0, Math.max(box - height, crop.top));
}

function layoutCrop() {
  const width = crop.naturalW * crop.k;
  const height = crop.naturalH * crop.k;
  crop.imgEl.style.width = `${width}px`;
  crop.imgEl.style.height = `${height}px`;
  clampCrop();
  crop.imgEl.style.left = `${crop.left}px`;
  crop.imgEl.style.top = `${crop.top}px`;
}

function openCrop(dataUrl) {
  const modal = $('#crop-modal');
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');

  const probe = new Image();
  probe.onload = () => {
    crop.naturalW = probe.naturalWidth;
    crop.naturalH = probe.naturalHeight;
    crop.imgEl = $('#crop-img');
    crop.imgEl.src = dataUrl;

    const box = cropBoxSize();
    crop.baseK = Math.max(box / crop.naturalW, box / crop.naturalH);
    crop.k = crop.baseK;
    crop.left = (box - crop.naturalW * crop.k) / 2;
    crop.top = (box - crop.naturalH * crop.k) / 2;
    $('#crop-zoom').value = '1';
    layoutCrop();
    $('#crop-confirm').focus();
  };
  probe.src = dataUrl;
}

function closeCrop() {
  const modal = $('#crop-modal');
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  crop.dragging = false;
  $('#avatar-file').value = '';
}

function confirmCrop() {
  if (!crop.imgEl || !crop.naturalW) return;
  const box = cropBoxSize();
  const srcW = box / crop.k;
  const srcH = box / crop.k;
  const sx = Math.min(Math.max(0, -crop.left / crop.k), crop.naturalW - srcW);
  const sy = Math.min(Math.max(0, -crop.top / crop.k), crop.naturalH - srcH);

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.getContext('2d').drawImage(crop.imgEl, sx, sy, srcW, srcH, 0, 0, 256, 256);

  pendingAvatar = canvas.toDataURL('image/png');
  showPreview(pendingAvatar);
  $('#avatar-save').disabled = false;
  closeCrop();
}

$('#avatar-file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => openCrop(String(reader.result || ''));
  reader.readAsDataURL(file);
});

$('#crop-zoom').addEventListener('input', (event) => {
  if (!crop.imgEl || !crop.naturalW) return;
  const box = cropBoxSize();
  const zoom = Number(event.target.value) || 1;
  // 以裁剪框中心为锚点缩放
  const centerX = (box / 2 - crop.left) / crop.k;
  const centerY = (box / 2 - crop.top) / crop.k;
  crop.k = crop.baseK * zoom;
  crop.left = box / 2 - centerX * crop.k;
  crop.top = box / 2 - centerY * crop.k;
  layoutCrop();
});

const cropBox = $('#crop-box');
cropBox.addEventListener('pointerdown', (event) => {
  if (!crop.imgEl) return;
  crop.dragging = true;
  crop.startX = event.clientX;
  crop.startY = event.clientY;
  crop.startLeft = crop.left;
  crop.startTop = crop.top;
  cropBox.setPointerCapture(event.pointerId);
});
cropBox.addEventListener('pointermove', (event) => {
  if (!crop.dragging) return;
  crop.left = crop.startLeft + (event.clientX - crop.startX);
  crop.top = crop.startTop + (event.clientY - crop.startY);
  clampCrop();
  crop.imgEl.style.left = `${crop.left}px`;
  crop.imgEl.style.top = `${crop.top}px`;
});
cropBox.addEventListener('pointerup', () => {
  crop.dragging = false;
});
cropBox.addEventListener('pointercancel', () => {
  crop.dragging = false;
});

$('#crop-confirm').addEventListener('click', confirmCrop);
$('#crop-cancel').addEventListener('click', closeCrop);
$('#crop-close').addEventListener('click', closeCrop);
$('#crop-scrim').addEventListener('click', closeCrop);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#crop-modal').classList.contains('is-open')) closeCrop();
});

$('#avatar-save').addEventListener('click', async () => {
  if (!pendingAvatar) return;
  const btn = $('#avatar-save');
  btn.disabled = true;
  try {
    await api('/api/avatar', {
      method: 'POST',
      body: JSON.stringify({ data: pendingAvatar }),
    });
    toast('头像已更新');
    pendingAvatar = '';
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  } finally {
    btn.disabled = !pendingAvatar;
  }
});

$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#acc-user').value.trim();
  const current = $('#acc-current').value;
  const password = $('#acc-pass').value;
  const confirm = $('#acc-pass2').value;
  if (password && password !== confirm) {
    toast('两次输入的新密码不一致', true);
    return;
  }

  const btn = $('#account-save');
  btn.disabled = true;
  try {
    const data = await api('/api/settings/account', {
      method: 'POST',
      body: JSON.stringify({ current_password: current, username, password }),
    });
    toast('账号已更新');
    $('#acc-current').value = '';
    $('#acc-pass').value = '';
    $('#acc-pass2').value = '';
    $('#acc-user').value = data.username || username;
    setInitial(data.username || username);
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

loadAccount();
loadAvatar();
