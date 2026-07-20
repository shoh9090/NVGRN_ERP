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
function normalizeBarcode(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return String(v[0] || '');
  let str = String(v).trim();
  if (str.startsWith('[')) {
    try { const arr = JSON.parse(str); if (Array.isArray(arr)) return String(arr[0] || ''); } catch (e) {}
  }
  return str;
}

// Гибкое извлечение вложенного справочника из ответа SD: поле может называться по-разному
function pickRef(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      return { sdId: String(v.SD_id || v.sd_id || ''), name: String(v.name || '').trim() };
    }
    if (typeof v === 'string' && v.trim()) {
      return { sdId: '', name: v.trim() };
    }
  }
  return { sdId: '', name: '' };
}

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


// Постраничная выгрузка любого GET-метода SD
async function sdGetAll(cfg, auth, method, resultKey, extraParams = {}) {
  const out = [];
  let page = 1;
  const limit = 500;
  for (;;) {
    const data = await sdRequest(cfg.url, {
      method,
      auth: { userId: auth.userId, token: auth.token },
      params: { limit, page, ...extraParams },
    });
    const items = (data.result && data.result[resultKey]) || [];
    out.push(...items);
    const total = data.pagination ? data.pagination.total : 0;
    if (!items.length || page * limit >= total || items.length < limit) break;
    page++;
  }
  return out;
}

// Синхронизация категорий и групп товаров SD → ref_categories
// Возвращает карты sd_sd_id → наш id
async function syncCatalogStructure(cfg, auth, userIdLocal) {
  const maps = { category: {}, group: {}, categoryByName: {}, groupByName: {}, unit: {}, tradeName: {} };

  async function upsertKind(items, kind, map) {
    for (const it of items) {
      const sdId = String(it.SD_id || '');
      const name = String(it.name || '').trim();
      if (!name) continue;
      const status = it.active === 'N' ? 'archived' : 'active';
      let r = sdId
        ? await db.pool.query("SELECT id FROM ref_categories WHERE sd_sd_id = $1 AND kind = $2 LIMIT 1", [sdId, kind])
        : { rows: [] };
      if (!r.rows.length) {
        r = await db.pool.query("SELECT id FROM ref_categories WHERE lower(name) = lower($1) AND kind = $2 LIMIT 1", [name, kind]);
      }
      if (r.rows.length) {
        await db.pool.query(
          `UPDATE ref_categories SET name = $1, sd_sd_id = $2, sd_cs_id = $3,
             code_1c = COALESCE(NULLIF($4,''), code_1c), status = $5,
             sync_status = 'synced', last_sync_at = now(), updated_at = now(), updated_by = $6
           WHERE id = $7`,
          [name, sdId, String(it.CS_id || ''), String(it.code_1C || ''), status, userIdLocal, r.rows[0].id]
        );
        map[sdId] = r.rows[0].id;
        maps[kind === 'категория' ? 'categoryByName' : 'groupByName'][name.toLowerCase()] = r.rows[0].id;
      } else {
        const ins = await db.pool.query(
          `INSERT INTO ref_categories (name, kind, sd_sd_id, sd_cs_id, code_1c, status, sync_status, last_sync_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'synced',now(),$7,$7) RETURNING id`,
          [name, kind, sdId, String(it.CS_id || ''), String(it.code_1C || ''), status, userIdLocal]
        );
        map[sdId] = ins.rows[0].id;
        maps[kind === 'категория' ? 'categoryByName' : 'groupByName'][name.toLowerCase()] = ins.rows[0].id;
      }
    }
  }

  try {
    const cats = await sdGetAll(cfg, auth, 'getProductCategory', 'productCategory');
    await upsertKind(cats, 'категория', maps.category);
  } catch (e) { console.error('getProductCategory:', e.message); }
  try {
    const groups = await sdGetAll(cfg, auth, 'getProductGroup', 'productGroup');
    await upsertKind(groups, 'группа', maps.group);
  } catch (e) { console.error('getProductGroup:', e.message); }

  // Единицы измерения SD → ref_units (привязка товаров идёт по SD_id)
  try {
    const units = await sdGetAll(cfg, auth, 'getUnit', 'unit');
    for (const u of units) {
      const sdId = String(u.SD_id || '');
      const name = String(u.name || '').trim();
      if (!name) continue;
      const { normalizeUnit } = require('./units-util');
      const short = normalizeUnit(u.title || u.short_name || name) || String(u.title || name).trim().toLowerCase();
      let r = sdId
        ? await db.pool.query('SELECT id FROM ref_units WHERE sd_sd_id = $1 LIMIT 1', [sdId])
        : { rows: [] };
      if (!r.rows.length) {
        r = await db.pool.query('SELECT id FROM ref_units WHERE lower(short_name) = $1 OR lower(name) = lower($2) LIMIT 1', [short, name]);
      }
      if (r.rows.length) {
        await db.pool.query(
          `UPDATE ref_units SET name=$1, short_name=$2, sd_sd_id=$3, sync_status='synced', last_sync_at=now(), updated_at=now() WHERE id=$4`,
          [name, short, sdId, r.rows[0].id]
        );
        maps.unit[sdId] = r.rows[0].id;
      } else {
        const ins = await db.pool.query(
          `INSERT INTO ref_units (name, short_name, sd_sd_id, sync_status, last_sync_at, created_by, updated_by)
           VALUES ($1,$2,$3,'synced',now(),$4,$4) RETURNING id`,
          [name, short, sdId, userIdLocal]
        );
        maps.unit[sdId] = ins.rows[0].id;
      }
    }
  } catch (e) { console.error('getUnit:', e.message); }

  // Направления торговли SD → карта названий
  for (const [method, key] of [['getTradeDirection', 'tradeDirection'], ['getTrade', 'trade']]) {
    try {
      const dirs = await sdGetAll(cfg, auth, method, key);
      for (const d of dirs) {
        if (d && d.SD_id != null) maps.tradeName[String(d.SD_id)] = String(d.name || '').trim();
      }
      if (Object.keys(maps.tradeName).length) break;
    } catch (e) { /* пробуем следующий вариант метода */ }
  }

  return maps;
}

// Синхронизация готовой продукции: SD getProduct → ref_finished_goods
async function syncFinishedGoods(userIdLocal) {
  const cfg = await getSdConfig();
  const auth = await sdLogin(cfg);

  // сначала тянем категории и группы, чтобы привязать товары
  const maps = await syncCatalogStructure(cfg, auth, userIdLocal);

  let page = 1;
  const limit = 500;
  let created = 0;
  let updated = 0;
  let archivedCnt = 0;
  let totalSeen = 0;

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
        code: String(p.part_number || p.code_1C || ''),
        code_1c: String(p.code_1C || ''),
        sd_cs_id: String(p.CS_id || ''),
        sd_sd_id: sdId,
        barcode: normalizeBarcode(p.barCode),
        qty_per_box: p.packQuantity != null ? Number(p.packQuantity) : null,
        status: p.active === 'N' ? 'archived' : 'active',
        unit_id: null,
      };
      const catRef = pickRef(p, ['category', 'productCategory']);
      values.category_id =
        (catRef.sdId && maps.category[catRef.sdId]) ||
        (catRef.name && maps.categoryByName[catRef.name.toLowerCase()]) || null;
      const grpRef = pickRef(p, ['group', 'productGroup']);
      values.group_id =
        (grpRef.sdId && maps.group[grpRef.sdId]) ||
        (grpRef.name && maps.groupByName[grpRef.name.toLowerCase()]) || null;
      const tradeSd = p.trade && p.trade.SD_id != null ? String(p.trade.SD_id) : '';
      values.trade_direction = (tradeSd && maps.tradeName[tradeSd]) || '';
      values.ikpu = String(p.ikpu || '');
      values.net_weight = p.weight != null && p.weight !== '' ? Math.round(Number(p.weight) * 1000) : null;
      if (p.unit && p.unit.SD_id != null && maps.unit[String(p.unit.SD_id)]) {
        values.unit_id = maps.unit[String(p.unit.SD_id)];
      }

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
             category_id = COALESCE($9, category_id), group_id = COALESCE($10, group_id),
             trade_direction = COALESCE(NULLIF($11,''), trade_direction),
             ikpu = COALESCE(NULLIF($12,''), ikpu), net_weight = COALESCE($13, net_weight),
             status = $14, sync_status = 'synced', last_sync_at = now(), updated_at = now(), updated_by = $15
           WHERE id = $16`,
          [values.name, values.code, values.code_1c, values.sd_cs_id, values.sd_sd_id,
           values.barcode, values.qty_per_box, values.unit_id, values.category_id, values.group_id,
           values.trade_direction, values.ikpu, values.net_weight, values.status, userIdLocal, existing.id]
        );
        if (values.status === 'archived' && existing.status !== 'archived') archivedCnt++;
        else updated++;
      } else {
        await db.pool.query(
          `INSERT INTO ref_finished_goods
             (name, code, code_1c, sd_cs_id, sd_sd_id, barcode, qty_per_box, unit_id,
              category_id, group_id, trade_direction, ikpu, net_weight, status, sync_status, last_sync_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'synced',now(),$15,$15)`,
          [values.name, values.code, values.code_1c, values.sd_cs_id, values.sd_sd_id,
           values.barcode, values.qty_per_box, values.unit_id, values.category_id, values.group_id,
           values.trade_direction, values.ikpu, values.net_weight, values.status, userIdLocal]
        );
        created++;
      }
    }

    const total = data.pagination ? data.pagination.total : 0;
    if (page * limit >= total || products.length < limit) break;
    page++;
  }

  const summary = `создано ${created}, обновлено ${updated}, в архив ${archivedCnt}, всего из SD: ${totalSeen}; категорий: ${Object.keys(maps.category).length}, групп: ${Object.keys(maps.group).length}, единиц: ${Object.keys(maps.unit).length}, направлений: ${Object.keys(maps.tradeName).length}`;
  await db.setSetting('sd_last_sync', `${new Date().toISOString()} — ${summary}`);
  await db.log(userIdLocal, 'sd_sync_finished_goods', summary);
  return { created, updated, archived: archivedCnt, total: totalSeen, summary };
}


// Синхронизация отпускных цен: getPriceType + getPrice → ref_price_types + ref_prices
async function syncPrices(userIdLocal) {
  const cfg = await getSdConfig();
  const auth = await sdLogin(cfg);

  // названия способов оплаты (чтобы не показывать сырые коды)
  const paymentNames = {};
  try {
    const pts = await sdGetAll(cfg, auth, 'getPaymentType', 'paymentType');
    for (const pt of pts) paymentNames[String(pt.SD_id || '')] = String(pt.name || '');
  } catch (e) { console.error('getPaymentType:', e.message); }

  const types = await sdGetAll(cfg, auth, 'getPriceType', 'priceType');
  let typesUpserted = 0;
  let pricesUpserted = 0;
  const typeMap = {}; // sd_sd_id → наш id

  for (const t of types) {
    if (t.type && t.type !== 'sale') continue; // «Отпускные цены» — только продажные прайсы
    const sdId = String(t.SD_id || '');
    const name = String(t.name || '').trim();
    if (!name) continue;
    const status = t.active === 'N' ? 'archived' : 'active';
    const ptSd = t.paymentType ? String(t.paymentType.SD_id || '') : '';
    const payment = (ptSd && paymentNames[ptSd]) || (t.paymentType ? String(t.paymentType.code_1C || '') : '') || '';
    const valyuta = t.valyutaType ? String(t.valyutaType.code_1C || '') : '';

    let r = sdId
      ? await db.pool.query('SELECT id FROM ref_price_types WHERE sd_sd_id = $1 LIMIT 1', [sdId])
      : { rows: [] };
    if (!r.rows.length) {
      r = await db.pool.query('SELECT id FROM ref_price_types WHERE lower(name) = lower($1) LIMIT 1', [name]);
    }
    if (r.rows.length) {
      await db.pool.query(
        `UPDATE ref_price_types SET name=$1, sd_sd_id=$2, sd_cs_id=$3, code_1c=COALESCE(NULLIF($4,''), code_1c),
           payment_type=$5, valyuta=$6, status=$7, sync_status='synced', last_sync_at=now(), updated_at=now(), updated_by=$8
         WHERE id=$9`,
        [name, sdId, String(t.CS_id || ''), String(t.code_1C || ''), payment, valyuta, status, userIdLocal, r.rows[0].id]
      );
      typeMap[sdId] = r.rows[0].id;
    } else {
      const ins = await db.pool.query(
        `INSERT INTO ref_price_types (name, sd_sd_id, sd_cs_id, code_1c, payment_type, valyuta, status, sync_status, last_sync_at, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'synced',now(),$8,$8) RETURNING id`,
        [name, sdId, String(t.CS_id || ''), String(t.code_1C || ''), payment, valyuta, status, userIdLocal]
      );
      typeMap[sdId] = ins.rows[0].id;
    }
    typesUpserted++;
  }

  // карта товаров: sd_sd_id → наш id
  const prods = await db.pool.query("SELECT id, sd_sd_id FROM ref_finished_goods WHERE sd_sd_id <> ''");
  const prodMap = {};
  for (const p of prods.rows) prodMap[p.sd_sd_id] = p.id;

  for (const [sdTypeId, localTypeId] of Object.entries(typeMap)) {
    let rows = [];
    try {
      const data = await sdRequest(cfg.url, {
        method: 'getPrice',
        auth: { userId: auth.userId, token: auth.token },
        params: { priceType: { SD_id: sdTypeId } },
      });
      rows = Array.isArray(data.result) ? data.result : (data.result && data.result.price) || [];
    } catch (e) {
      console.error('getPrice', sdTypeId, e.message);
      continue;
    }
    for (const row of rows) {
      const prodSd = row.product ? String(row.product.SD_id || '') : '';
      const localProd = prodMap[prodSd];
      if (!localProd) continue;
      const price = Number(row.price) || 0;
      await db.pool.query(
        `INSERT INTO ref_prices (price_type_id, product_id, price, last_sync_at, updated_at)
         VALUES ($1,$2,$3,now(),now())
         ON CONFLICT (price_type_id, product_id) DO UPDATE SET price = $3, last_sync_at = now(), updated_at = now()`,
        [localTypeId, localProd, price]
      );
      pricesUpserted++;
    }
  }

  const summary = `прайс-листов: ${typesUpserted}, цен загружено: ${pricesUpserted}`;
  await db.setSetting('sd_last_price_sync', `${new Date().toISOString()} — ${summary}`);
  await db.log(userIdLocal, 'sd_sync_prices', summary);
  return { types: typesUpserted, prices: pricesUpserted, summary };
}


// Диагностика: сырые ответы SD для сверки имён полей
async function diagSD() {
  const cfg = await getSdConfig();
  const auth = await sdLogin(cfg);
  const out = {};
  for (const [method, key] of [
    ['getProduct', 'product'],
    ['getProductCategory', 'productCategory'],
    ['getProductGroup', 'productGroup'],
    ['getPriceType', 'priceType'],
  ]) {
    try {
      const data = await sdRequest(cfg.url, {
        method,
        auth: { userId: auth.userId, token: auth.token },
        params: { limit: 2, page: 1 },
      });
      out[method] = data.result;
    } catch (e) {
      out[method] = 'ОШИБКА: ' + e.message;
    }
  }
  return out;
}

// --- Для Telegram-бота: список активных HoReCa-точек (только чтение) ---
async function getHorecaPoints() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) {
    throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  }
  const auth = await sdLogin(cfg);
  const cats = await sdGetAll(cfg, auth, 'getClientCategory', 'clientCategory', { filter: { include: 'all' } });
  const horeca = cats.find((c) => String(c.name || '').trim().toLowerCase() === 'horeca');
  if (!horeca) throw new Error('В SalesDoctor не найдена категория «Horeca».');
  const clients = await sdGetAll(cfg, auth, 'getClient', 'client', {});
  return clients.filter((c) => c.active === 'Y' && c.category && c.category.SD_id === horeca.SD_id);
}

// --- Аналитика для РОПа: покрытие АКБ/ОКБ по торговым агентам ---
async function getAgentCoverage(days = 14) {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) {
    throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  }
  const auth = await sdLogin(cfg);
  const cats = await sdGetAll(cfg, auth, 'getClientCategory', 'clientCategory', { filter: { include: 'all' } });
  const horeca = cats.find((c) => String(c.name || '').trim().toLowerCase() === 'horeca');
  if (!horeca) throw new Error('В SalesDoctor не найдена категория «Horeca».');

  const clients = (await sdGetAll(cfg, auth, 'getClient', 'client', {}))
    .filter((c) => c.active === 'Y' && c.category && c.category.SD_id === horeca.SD_id);

  let agentsList = [];
  try { agentsList = await sdGetAll(cfg, auth, 'getAgent', 'agent', {}); } catch (e) { agentsList = []; }
  const agentName = {};
  for (const a of agentsList) {
    if (a.SD_id) agentName[a.SD_id] = a.name || a.SD_id;
    if (a.code_1C) agentName['c:' + a.code_1C] = a.name || a.code_1C;
  }

  const TZ = 5 * 3600 * 1000; // Ташкент
  const to = new Date(Date.now() + TZ).toISOString().slice(0, 10);
  const from = new Date(Date.now() + TZ - days * 86400000).toISOString().slice(0, 10);
  const orders = await sdGetAll(cfg, auth, 'getOrder', 'order', { filter: { period: { date: { from, to } }, status: [1, 2, 3, 4] } });
  const orderedClient = new Set(orders.map((o) => o.client && o.client.SD_id).filter(Boolean));

  const byAgent = {};
  for (const c of clients) {
    const ags = (c.agents && c.agents.length) ? c.agents : [{ id: '—', code: '' }];
    for (const ag of ags) {
      const id = ag.id || '—';
      const name = agentName[id] || agentName['c:' + (ag.code || '')] || id;
      byAgent[id] = byAgent[id] || { agentId: id, name, okb: 0, akb: 0, inactive: [] };
      byAgent[id].okb++;
      if (orderedClient.has(c.SD_id)) byAgent[id].akb++;
      else byAgent[id].inactive.push({ name: c.name || c.SD_id, sd_id: c.SD_id, tel: c.tel || '' });
    }
  }
  const rows = Object.values(byAgent)
    .map((r) => ({ ...r, pct: r.okb ? Math.round((r.akb * 100) / r.okb) : 0 }))
    .sort((a, b) => b.okb - a.okb || a.name.localeCompare(b.name));
  const totals = rows.reduce((t, r) => ({ okb: t.okb + r.okb, akb: t.akb + r.akb }), { okb: 0, akb: 0 });
  totals.pct = totals.okb ? Math.round((totals.akb * 100) / totals.okb) : 0;
  return { from, to, days, rows, totals };
}

// --- Бандл 1: синхронизация агентов и клиентов из SalesDoctor ---
async function syncCrmAgents() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  const auth = await sdLogin(cfg);
  const agents = await sdGetAll(cfg, auth, 'getAgent', 'agent', {});
  let n = 0;
  for (const a of agents) {
    if (!a.SD_id) continue;
    await db.pool.query(
      `INSERT INTO tgbot.crm_agents (sd_agent_id, sd_agent_code, sd_agent_name, is_active, last_synced_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (sd_agent_id) DO UPDATE SET sd_agent_code=$2, sd_agent_name=$3, is_active=$4, last_synced_at=now()`,
      [a.SD_id, a.code_1C || null, a.name || a.SD_id, a.active !== 'N']);
    n++;
  }
  await db.pool.query(`INSERT INTO tgbot.salesdoctor_sync_log (sync_type, created, updated) VALUES ('agents', 0, $1)`, [n]).catch(() => {});
  return n;
}

// Экспедиторы (водители) из SD — как агенты, но с телефоном (для роли expeditor).
async function syncCrmExpeditors() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  const auth = await sdLogin(cfg);
  await db.pool.query(`CREATE TABLE IF NOT EXISTS tgbot.crm_expeditors (sd_id TEXT PRIMARY KEY, code TEXT, name TEXT, phone_normalized TEXT, is_active BOOLEAN NOT NULL DEFAULT true, last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => {});
  const exps = await sdGetAll(cfg, auth, 'getExpeditor', 'expeditor', {});
  const norm = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length > 9 ? d.slice(-9) : d; };
  let n = 0;
  for (const e of exps) {
    if (!e.SD_id) continue;
    await db.pool.query(
      `INSERT INTO tgbot.crm_expeditors (sd_id, code, name, phone_normalized, is_active, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (sd_id) DO UPDATE SET code=$2, name=$3, phone_normalized=$4, is_active=$5, last_synced_at=now()`,
      [e.SD_id, e.code_1C || null, e.name || e.SD_id, norm(e.tel), e.active === 'Y']);
    n++;
  }
  return n;
}

// Карта «торговая точка → контрагент (юрлицо, ИНН)» из getContragent (двухуровневая модель SD).
// На «обычном» сервере getContragent даёт 400 «Contragent mode is not enabled» → вернём null (фоллбэк).
async function getContragentMap(cfg, auth) {
  let list;
  try { list = await sdGetAll(cfg, auth, 'getContragent', 'contragent', {}); }
  catch (e) { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const bySalepoint = {}, byInn = {};
  for (const k of list) {
    const firm = String(k.firmName || k.shortName || k.name || '').trim() || null;
    const inn = String(k.inn || '').trim() || null;
    const rec = { contragent_sd_id: String(k.SD_id || ''), firm, inn };
    if (inn) byInn[inn] = rec;
    const sps = k.salepoints || k.salePoints || k.clients || [];
    for (const sp of (Array.isArray(sps) ? sps : [])) { const spid = String(sp.SD_id || sp.sd_id || ''); if (spid) bySalepoint[spid] = rec; }
  }
  return { bySalepoint, byInn, count: list.length };
}

// Проба: включён ли режim контрагента и что отдаёт getContragent (для админ-диагностики, без изменений данных).
async function probeContragent() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor.');
  const auth = await sdLogin(cfg);
  try {
    const data = await sdRequest(cfg.url, { method: 'getContragent', auth: { userId: auth.userId, token: auth.token }, params: { limit: 3, page: 1 } });
    const list = (data.result && (data.result.contragent || data.result.data && data.result.data.contragent)) || data.result || [];
    return { enabled: true, sample: Array.isArray(list) ? list.slice(0, 3) : list };
  } catch (e) {
    return { enabled: false, error: e.message };
  }
}

async function syncClientsToContacts() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  const auth = await sdLogin(cfg);
  const cats = await sdGetAll(cfg, auth, 'getClientCategory', 'clientCategory', { filter: { include: 'all' } });
  const horeca = cats.find((c) => String(c.name || '').trim().toLowerCase() === 'horeca');
  if (!horeca) throw new Error('В SalesDoctor не найдена категория «Horeca».');
  const clients = (await sdGetAll(cfg, auth, 'getClient', 'client', {}))
    .filter((c) => c.active === 'Y' && c.category && c.category.SD_id === horeca.SD_id);
  // Юрлицо (firmName/ИНН) берём из контрагента точки (getClient.firmName у SD пустой). Фоллбэк — поля клиента.
  const cmap = await getContragentMap(cfg, auth).catch(() => null);
  let n = 0;
  for (const c of clients) {
    if (!c.SD_id) continue;
    const agent = (c.agents && c.agents[0] && c.agents[0].id) || null;
    const con = cmap && cmap.bySalepoint[String(c.SD_id)];
    const firm = (con && con.firm) || c.firmName || null;
    const inn = (con && con.inn) || c.inn || null;
    await db.pool.query(
      `INSERT INTO tgbot.point_contacts (sd_id, point_name, firm_name, inn, zavsklad_phone, agent_sd_id, active, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),'sd_sync')
       ON CONFLICT (sd_id) DO UPDATE SET point_name=$2, firm_name=$3, inn=$4, zavsklad_phone=$5, agent_sd_id=$6, active=$7, updated_at=now(), updated_by='sd_sync'`,
      [c.SD_id, c.name || c.SD_id, firm, inn, c.tel || null, agent, c.active || 'Y']);
    n++;
  }
  await db.pool.query(`INSERT INTO tgbot.salesdoctor_sync_log (sync_type, created, updated) VALUES ('manual', 0, $1)`, [n]).catch(() => {});
  return n;
}

// --- Бандл 3: список товаров для замен (кэш 10 мин) ---
let _prodCache = null, _prodAt = 0;
async function getSdProducts() {
  if (_prodCache && Date.now() - _prodAt < 600000) return _prodCache;
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor.');
  const auth = await sdLogin(cfg);
  const prods = await sdGetAll(cfg, auth, 'getProduct', 'product', {});
  const out = prods.filter((p) => p.SD_id && p.name).map((p) => ({ SD_id: String(p.SD_id), name: String(p.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  _prodCache = out; _prodAt = Date.now();
  return out;
}

// Синхронизация клиентов SalesDoctor → контрагенты Кассы (роль «client») по ИНН. Для привязки приходов.
async function syncCashClients() {
  const cfg = await getSdConfig();
  if (!cfg.url || !cfg.login || !cfg.password) throw new Error('Сначала заполните доступ к SalesDoctor в разделе «Интеграции».');
  const auth = await sdLogin(cfg);
  await db.pool.query("ALTER TABLE cash_counterparties ADD COLUMN IF NOT EXISTS cp_role TEXT").catch(() => {});
  await db.pool.query("ALTER TABLE cash_counterparties ADD COLUMN IF NOT EXISTS firm_name TEXT").catch(() => {});
  const clients = (await sdGetAll(cfg, auth, 'getClient', 'client', {})).filter((c) => c.active === 'Y' && c.inn);
  const cmap = await getContragentMap(cfg, auth).catch(() => null);
  const existing = {};
  (await db.pool.query("SELECT id, inn FROM cash_counterparties WHERE cp_role='client'")).rows.forEach((r) => { existing[String(r.inn).trim()] = r.id; });
  let created = 0, updated = 0;
  for (const c of clients) {
    const inn = String(c.inn).trim(); if (!inn) continue;
    const con = cmap && (cmap.bySalepoint[String(c.SD_id)] || cmap.byInn[inn]);
    const firm = (con && con.firm) || c.firmName || null;
    const name = c.name || firm || inn;
    if (existing[inn]) { await db.pool.query("UPDATE cash_counterparties SET name=$1, firm_name=COALESCE($3, firm_name), status='active' WHERE id=$2", [name, existing[inn], firm]); updated++; }
    else { const r = await db.pool.query("INSERT INTO cash_counterparties (name, inn, firm_name, cp_role, status) VALUES ($1,$2,$3,'client','active') RETURNING id", [name, inn, firm]); existing[inn] = r.rows[0].id; created++; }
  }
  return { created, updated, total: created + updated };
}

module.exports = { getSdConfig, saveSdConfig, testConnection, syncFinishedGoods, syncPrices, diagSD, getHorecaPoints, getAgentCoverage, syncCrmAgents, syncCrmExpeditors, syncClientsToContacts, getSdProducts, syncCashClients, probeContragent };
