// 扩展页共享存储：capture.html 截图后存这里，editor.html 读出来编辑。
// 为什么用 IndexedDB 而不是 chrome.storage：长图 base64 后动辄几 MB，
// chrome.storage.local 有配额；IndexedDB 存 Blob 无实际上限，且扩展页同源可直接读。

const ASC_DB = 'asc-images';
const ASC_STORE = 'shots';

function ascDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(ASC_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ASC_STORE)) db.createObjectStore(ASC_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function ascPut(blob, meta = {}) {
  const db = await ascDB();
  const key = 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await new Promise((res, rej) => {
    const tx = db.transaction(ASC_STORE, 'readwrite');
    tx.objectStore(ASC_STORE).put({ blob, meta, at: Date.now() }, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  return key;
}

async function ascGet(key) {
  const db = await ascDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction(ASC_STORE, 'readonly');
    const q = tx.objectStore(ASC_STORE).get(key);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}

async function ascDel(key) {
  try {
    const db = await ascDB();
    await new Promise((res) => {
      const tx = db.transaction(ASC_STORE, 'readwrite');
      tx.objectStore(ASC_STORE).delete(key);
      tx.oncomplete = res;
      tx.onerror = () => res();
    });
  } catch (_) {}
}

// 清掉 2 小时前的残留（用户取消编辑留下的）
async function ascSweep() {
  try {
    const db = await ascDB();
    const tx = db.transaction(ASC_STORE, 'readwrite');
    const st = tx.objectStore(ASC_STORE);
    const q = st.openCursor();
    const cut = Date.now() - 2 * 3600 * 1000;
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return;
      if ((c.value && c.value.at) < cut) c.delete();
      c.continue();
    };
  } catch (_) {}
}
