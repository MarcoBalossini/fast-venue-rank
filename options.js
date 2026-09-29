const DEFAULTS = { ext_on: true, SJR: true, CORE: true, hiddenLists: [], crossrefMailto: '', s2ApiKey: '', catalogAuto: true, catalogUrl: '' };
const CUSTOM_KEY = 'customRanking';
const ORIGINS = ['https://api.semanticscholar.org/*', 'https://api.crossref.org/*'];
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
  for (const k of ['ext_on', 'SJR', 'CORE']) $(k).checked = !!s[k];
  $('crossrefMailto').value = s.crossrefMailto || '';
  $('s2ApiKey').value = s.s2ApiKey || '';
  $('catalogAuto').checked = !!s.catalogAuto;
  $('catalogUrl').value = s.catalogUrl || '';
  $('catalogUrl').placeholder = `default: ${Catalog.DEFAULT_URL}`;
  hiddenLists = s.hiddenLists || [];
  const custom = (await api.storage.local.get(CUSTOM_KEY))[CUSTOM_KEY];
  $('customLabel').value = (custom && custom.label) || '';
  customStatus(custom ? `${custom.entries.length} entries imported` : 'none imported');
  refreshMeta();
  refreshCatalog();
  checkPermissions();
}

async function save() {
  await api.storage.sync.set({
    ext_on: $('ext_on').checked,
    SJR: $('SJR').checked,
    CORE: $('CORE').checked,
    hiddenLists: listHidden(),
    crossrefMailto: $('crossrefMailto').value.trim(),
    s2ApiKey: $('s2ApiKey').value.trim(),
    catalogAuto: $('catalogAuto').checked,
    catalogUrl: $('catalogUrl').value.trim(),
  });
  flash('Saved');
}

function flash(text) {
  $('status').textContent = text;
  setTimeout(() => { $('status').textContent = ''; }, 2000);
}

let hiddenLists = [];

// Unchecked lists; the stored value is kept when the checkboxes could not be rendered.
function listHidden() {
  const boxes = [...document.querySelectorAll('#lists input[data-list]')];
  return boxes.length ? boxes.filter((c) => !c.checked).map((c) => c.dataset.list) : hiddenLists;
}

// One checkbox per bundled list (plus the custom one), labels from data/lists.json.
function renderLists(lists) {
  const box = $('lists');
  box.replaceChildren();
  for (const [id, m] of Object.entries(lists || {})) {
    const label = document.createElement('label');
    label.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.list = id;
    cb.checked = !hiddenLists.includes(id);
    const info = document.createElement('span');
    info.className = 'muted';
    info.textContent = [m.edition, m.source].filter(Boolean).join(' · ');
    label.append(cb, ` Show ${m.label} — ${m.name} `, info);
    box.append(label);
  }
}

async function refreshMeta() {
  try {
    const m = await api.runtime.sendMessage({ type: 'meta' });
    renderLists(m.lists);
    $('listsBuilt').textContent = m.listsBuilt ? `${Object.keys(m.lists || {}).length} lists (built ${m.listsBuilt})` : 'n/a';
    $('sjrEdition').textContent = m.sjrEdition ? `${m.sjrEdition} (built ${m.sjrBuilt})` : 'n/a';
    $('coreSource').textContent = m.coreSource ? `${m.coreSource} (built ${m.coreBuilt})` : 'n/a';
    $('cacheEntries').textContent = String(m.cacheEntries ?? 0);
  } catch (e) {
    $('sjrEdition').textContent = `error: ${e.message}`;
  }
}

async function checkPermissions() {
  if (!api.permissions || !api.permissions.contains) return;
  try {
    const ok = await api.permissions.contains({ origins: ORIGINS });
    $('permBox').hidden = ok;
  } catch { /* not supported */ }
}

function customStatus(text, err = false) {
  $('customStatus').textContent = text;
  $('customStatus').className = err ? 'err' : 'muted';
}

async function importCustom() {
  try {
    const file = $('customFile').files[0];
    const text = file ? await file.text() : $('customText').value;
    const entries = CustomList.parse(text, file ? file.name : '');
    const label = $('customLabel').value.trim() || 'Custom';
    await api.storage.local.set({ [CUSTOM_KEY]: { label, entries } });
    customStatus(`${entries.length} entries imported`);
    $('customFile').value = '';
    $('customText').value = '';
    setTimeout(refreshMeta, 200);   // the background rebuilds its index from storage.onChanged
  } catch (e) {
    customStatus(e.message, true);
  }
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString() : 'never');

function renderCatalog(st, extra = '') {
  for (const [name, t] of Object.entries(st.tables || {})) {
    const el = $(`tbl-${name}`);
    if (el) el.textContent = t.built ? `${t.from}, built ${t.built}` : t.from;
  }
  const parts = [`last check: ${fmtTime(st.checkedAt)}`];
  if (st.updatedAt) parts.push(`last update: ${fmtTime(st.updatedAt)}`);
  if (st.error) parts.push(`error: ${st.error}`);
  if (extra) parts.unshift(extra);
  $('catalogStatus').textContent = parts.join(' · ');
  $('catalogStatus').className = st.error ? 'err' : 'muted';
}

async function refreshCatalog() {
  try { renderCatalog(await api.runtime.sendMessage({ type: 'catalogStatus' })); } catch (e) { $('catalogStatus').textContent = e.message; }
}

$('checkCatalog').addEventListener('click', async () => {
  $('catalogStatus').textContent = 'checking…';
  await save();   // use the URL currently in the field
  try {
    const st = await api.runtime.sendMessage({ type: 'updateCatalog' });
    renderCatalog(st, st.updated && st.updated.length ? `updated: ${st.updated.join(', ')}` : (st.error ? '' : 'up to date'));
    refreshMeta();
  } catch (e) {
    $('catalogStatus').textContent = e.message;
  }
});

$('customImport').addEventListener('click', importCustom);
$('customClear').addEventListener('click', async () => {
  if (!confirm('Remove the imported custom ranking?')) return;
  await api.storage.local.remove(CUSTOM_KEY);
  customStatus('none imported');
  setTimeout(refreshMeta, 200);
});
$('save').addEventListener('click', save);
$('clearCache').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'clearCache' });
  flash('Cache cleared');
  refreshMeta();
});
$('grantPerms').addEventListener('click', async () => {
  try {
    const ok = await api.permissions.request({ origins: ORIGINS });
    if (ok) $('permBox').hidden = true;
  } catch (e) { flash(e.message); }
});

load();
