// integrations.js — интеграция с SalesDoctor (API V2)
// Креды хранятся в settings, пароль — в зашифрованном виде (AES-256-GCM, ключ из JWT_SECRET).
const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'change-me-in-railway-variables';
const KEY = crypto.scryptSync(SECRET, 'hub-integrations-salt', 32);

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(payload) {
  if (!payload) return '';
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function getSdConfig() {
  const s = await db.getSettings();
  return {
    url: s.sd_url || '',
    login: s.sd_login || '',
    hasPassword: !!s.sd_password_enc,
    password: s.sd_password_enc ? decrypt(s.sd_password_enc) : '',
    lastTest: s.sd_last_test || '',
    lastSync: s.sd_last_sync || '',
  };
}

async function saveSdConfig({ url, login, password }) {
  if (url !== undefined) {
    let clean = String(url).trim().replace(/\/+$/, '');
    if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
    await db.setSetting('sd_url', clean);
  }
  if (login !== undefined) await db.setSetting('sd_login', String(login).trim());
  if (password) await db.setSetting('sd_password_enc', encrypt(password));
}

// Единый вызов SalesDoc API: POST {url}/api/v2, метод в теле
async function sdRequest(baseUrl, body) {
  const res = await fetch(baseUrl + '/api/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`SalesDoctor вернул не-JSON ответ (HTTP ${res.status})`);
  }
  if (data.status !== true) {
    const msg = (data.error && data.error.message) || 'неизвестная ошибка';
    const code = (data.error && data.error.code) || res.status;
    throw new Error(`SalesDoctor: ошибка ${code} — ${msg}`);
  }
  return data;
}

// Логин: возвращает { userId, token }
async function sdLogin(cfg) {
  if (!cfg.url || !cfg.login || !cfg.password) {
    throw new Error('Заполните адрес, логин и пароль SalesDoctor в разделе «Интеграции»');
  }
  const data = await sdRequest(cfg.url, {
    method: 'login',
    auth: { login: cfg.login, password: cfg.password },
  });
  if (!data.result || !data.result.token) throw new Error('SalesDoctor не вернул токен');
  return { userId: data.result.userId, token: data.result.token };
}

// Проверка подключения
async function testConnection() {
  const cfg = await getSdConfig();
  const auth = await sdLogin(cfg);
  await db.setSetting('sd_last_test', `OK ${new Date().toISOString()} (userId: ${auth.userId})`);
  return auth;
}

// Синхронизация готовой продукции: SD getProduct → ref_finished_goods
async function syncFinishedGoods(userIdLocal) {
  const cfg = await getSdConfig();
  const auth = await sdLogin(cfg);

  let page = 1;
  const limit = 500;
  let created = 0;
  let updated = 0;
  let archivedCnt = 0;
  let totalSeen = 0;

  // карта единиц SD → наши единицы (по короткому имени из code_1C единицы)
  const unitsLocal = await db.pool.query('SELECT id, lower(short_name) AS sn, lower(name) AS n FROM ref_units');
  const unitByKey = {};
  for (const u of unitsLocal.rows) {
    unitByKey[u.sn] = u.id;
    unitByKey[u.n] = u.id;
  }

  for (;;) {
    const data = await sdRequest(cfg.url, {
      method: 'getProduct',
      auth: { userId: auth.userId, token: auth.token },
      params: { limit, page },
    });
    const products = (data.result && data.result.product) || [];
    if (!products.length) break;

    for (const p of products) {
      totalSeen++;
      const sdId = String(p.SD_id || '');
      const name = String(p.name || '').trim();
      if (!name) continue;
      const values = {
        name,
        code: String(p.part_number || ''),
        code_1c: String(p.code_1C || ''),
        sd_cs_id: String(p.CS_id || ''),
        sd_sd_id: sdId,
        barcode: String(p.barCode || ''),
        qty_per_box: p.packQuantity != null ? Number(p.packQuantity) : null,
        status: p.active === 'N' ? 'archived' : 'active',
        unit_id: null,
      };
      const unitKey = p.unit && p.unit.code_1C ? String(p.unit.code_1C).toLowerCase() : '';
      if (unitKey && unitByKey[unitKey]) values.unit_id = unitByKey[unitKey];

      // ищем существующую запись: по SD_id → по штрихкоду → по имени
      let existing = null;
      if (sdId) {
        const r = await db.pool.query('SELECT id, status FROM ref_finished_goods WHERE sd_sd_id = $1 LIMIT 1', [sdId]);
        existing = r.rows[0] || null;
      }
      if (!existing && values.barcode) {
        const r = await db.pool.query(
          "SELECT id, status FROM ref_finished_goods WHERE barcode = $1 AND barcode <> '' LIMIT 1",
          [values.barcode]
        );
        existing = r.rows[0] || null;
      }
      if (!existing) {
        const r = await db.pool.query('SELECT id, status FROM ref_finished_goods WHERE lower(name) = lower($1) LIMIT 1', [name]);
        existing = r.rows[0] || null;
      }

      if (existing) {
        await db.pool.query(
          `UPDATE ref_finished_goods SET
             name = $1, code = COALESCE(NULLIF($2,''), code), code_1c = COALESCE(NULLIF($3,''), code_1c),
             sd_cs_id = $4, sd_sd_id = $5, barcode = COALESCE(NULLIF($6,''), barcode),
             qty_per_box = COALESCE($7, qty_per_box), unit_id = COALESCE($8, unit_id),
             status = $9, sync_status = 'synced', last_sync_at = now(), updated_at = now(), updated_by = $10
           WHERE id = $11`,
          [values.name, values.code, values.code_1c, values.sd_cs_id, values.sd_sd_id,
           values.barcode, values.qty_per_box, values.unit_id, values.status, userIdLocal, existing.id]
        );
        if (values.status === 'archived' && existing.status !== 'archived') archivedCnt++;
        else updated++;
      } else {
        await db.pool.query(
          `INSERT INTO ref_finished_goods
             (name, code, code_1c, sd_cs_id, sd_sd_id, barcode, qty_per_box, unit_id, status,
              sync_status, last_sync_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'synced',now(),$10,$10)`,
          [values.name, values.code, values.code_1c, values.sd_cs_id, values.sd_sd_id,
           values.barcode, values.qty_per_box, values.unit_id, values.status, userIdLocal]
        );
        created++;
      }
    }

    const total = data.pagination ? data.pagination.total : 0;
    if (page * limit >= total || products.length < limit) break;
    page++;
  }

  const summary = `создано ${created}, обновлено ${updated}, в архив ${archivedCnt}, всего из SD: ${totalSeen}`;
  await db.setSetting('sd_last_sync', `${new Date().toISOString()} — ${summary}`);
  await db.log(userIdLocal, 'sd_sync_finished_goods', summary);
  return { created, updated, archived: archivedCnt, total: totalSeen, summary };
}

module.exports = { getSdConfig, saveSdConfig, testConnection, syncFinishedGoods };
