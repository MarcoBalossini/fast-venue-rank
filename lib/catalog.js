// Catalog updates: newer ranking tables published by the monthly GitHub Actions run on the `catalog`
// branch of the repository. Only data is downloaded (never code); every file is checked against the
// SHA-256 in index.json and validated before it replaces the bundled copy.
// Classic script: exposes a global `Catalog`; CommonJS-exported for node tests.

const Catalog = (() => {
  // Where the workflow publishes the tables (raw.githubusercontent.com sends CORS `*`, so no host permission).
  const DEFAULT_URL = 'https://raw.githubusercontent.com/MarcoBalossini/fast-venue-rank/catalog/';
  const SCHEMA = 1;                    // must match DATA_SCHEMA in scripts/build_data.py
  const TABLES = ['sjr', 'core', 'lists'];
  const MIN_ROWS = { sjr: 10000, core: 500, lists: 1000 };

  const isRowArray = (a, min) => Array.isArray(a) && a.length >= min && a.every(Array.isArray);

  // Throws when `json` cannot be a table `name` the extension understands.
  function validate(name, json) {
    if (!json || typeof json !== 'object') throw new Error(`${name}: not an object`);
    if (name === 'sjr') {
      if (!isRowArray(json.journals, MIN_ROWS.sjr)) throw new Error('sjr: journals missing or too short');
      if (!json.journals.every((r) => typeof r[0] === 'string' && Array.isArray(r[1]))) throw new Error('sjr: bad row');
    } else if (name === 'core') {
      if (!isRowArray(json.confs, MIN_ROWS.core)) throw new Error('core: confs missing or too short');
      if (!json.confs.every((r) => typeof r[0] === 'string' && typeof r[2] === 'string')) throw new Error('core: bad row');
    } else if (name === 'lists') {
      if (!json.lists || typeof json.lists !== 'object') throw new Error('lists: metadata missing');
      if (!isRowArray(json.journals, MIN_ROWS.lists)) throw new Error('lists: journals missing or too short');
      if (!json.journals.every((r) => typeof r[0] === 'string' && Array.isArray(r[1]) && r[2] && typeof r[2] === 'object')) throw new Error('lists: bad row');
      if (!Array.isArray(json.ccf)) throw new Error('lists: ccf missing');
    } else {
      throw new Error(`unknown table ${name}`);
    }
    return true;
  }

  function validateIndex(index) {
    if (!index || index.schema !== SCHEMA) throw new Error(`catalog schema ${index && index.schema} not supported (need ${SCHEMA})`);
    for (const name of TABLES) {
      const f = index.files && index.files[name];
      if (!f || !/^[0-9a-f]{64}$/.test(f.sha256 || '') || !Number.isFinite(f.bytes) || typeof f.built !== 'string') {
        throw new Error(`catalog index: bad entry for ${name}`);
      }
    }
    return true;
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------ IndexedDB store: name -> {name, built, sha256, text}

  const DB_NAME = 'catalog';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('tables', { keyPath: 'name' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction('tables', mode);
      const req = fn(t.objectStore('tables'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const getStored = (name) => tx('readonly', (s) => s.get(name)).catch(() => null);
  const putStored = (rec) => tx('readwrite', (s) => s.put(rec));
  const deleteStored = (name) => tx('readwrite', (s) => s.delete(name)).catch(() => {});

  return { DEFAULT_URL, SCHEMA, TABLES, validate, validateIndex, sha256Hex, getStored, putStored, deleteStored };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Catalog;
