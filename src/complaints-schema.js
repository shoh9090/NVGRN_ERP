// complaints-schema.js — ЕДИНЫЙ источник схемы и справочника претензий.
// Вызывается и из плитки «Бот HoReCa» (tgbot.js), и из модуля «Претензии» (complaints.js),
// и из самого Telegram-бота (Этап 3). Идемпотентно: повтор не плодит дубли и не ломает данные.

let _ready = false;

async function ensureComplaintSchema(pool) {
  if (_ready) return;
  await pool.query('CREATE SCHEMA IF NOT EXISTS tgbot');

  // Справочник: типы жалоб (со «звеном»), степени, решения, категории, звенья.
  await pool.query(`CREATE TABLE IF NOT EXISTS tgbot.complaint_dicts (
    id         SERIAL PRIMARY KEY,
    kind       TEXT NOT NULL,           -- type | severity | resolution | category | link
    code       TEXT NOT NULL,           -- стабильный код (для логики и привязок)
    label_ru   TEXT NOT NULL,           -- как показываем человеку
    link_code  TEXT,                    -- для kind='type': звено (field|production|packing|fulfillment)
    sort_order INT NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (kind, code)
  )`);

  // Сами претензии. Поля разнесены по фазам: клиент / реакция агента / обработка в вебе.
  await pool.query(`CREATE TABLE IF NOT EXISTS tgbot.complaints (
    id               BIGSERIAL PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    source           TEXT NOT NULL DEFAULT 'client_bot',   -- client_bot | web | import
    sd_id            TEXT,
    point_name       TEXT,
    firm_name        TEXT,
    agent_sd_id      TEXT,
    agent_name       TEXT,
    reporter_tg_id   BIGINT,
    reporter_phone   TEXT,
    order_code       TEXT,
    ship_date        DATE,
    volume_text      TEXT,
    product_sd_id    TEXT,
    product_name     TEXT,
    product_category TEXT,
    complaint_type   TEXT,
    link_code        TEXT,
    client_comment   TEXT,
    storage_place    TEXT,
    storage_temp     NUMERIC,
    open_hours       NUMERIC,
    agent_reacted_at TIMESTAMPTZ,
    agent_resolution TEXT,
    agent_comment    TEXT,
    agent_tg_id      BIGINT,
    severity         TEXT,
    resolution       TEXT,
    internal_note    TEXT,
    status           TEXT NOT NULL DEFAULT 'new',          -- new | agent_reacted | in_review | resolved
    resolved_at      TIMESTAMPTZ,
    resolved_by      TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_created ON tgbot.complaints (created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_status  ON tgbot.complaints (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_agent   ON tgbot.complaints (agent_sd_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_product ON tgbot.complaints (product_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_source  ON tgbot.complaints (source)`);

  // Назначение продукта (для чего клиент использует продукт) — код из справочника kind='usage'.
  await pool.query(`ALTER TABLE tgbot.complaints ADD COLUMN IF NOT EXISTS product_usage TEXT`);

  // Медиа претензии. Байты лежат в public.files (Hub отдаёт через /file/:id).
  await pool.query(`CREATE TABLE IF NOT EXISTS tgbot.complaint_files (
    id           BIGSERIAL PRIMARY KEY,
    complaint_id BIGINT NOT NULL REFERENCES tgbot.complaints(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'photo',            -- photo | video | video_note
    file_ref     INT,
    tg_file_id   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaint_files_cid ON tgbot.complaint_files (complaint_id)`);

  // ----- Сидирование справочника (идемпотентно) -----
  const LINKS = [
    ['field',       'Поле · сырьё',             1],
    ['production',  'Производство · сушка',     2],
    ['packing',     'Фасовка',                  3],
    ['fulfillment', 'Комплектация · логистика', 4],
  ];
  const TYPES = [
    ['zhivnost',               'живность',                       'field',        1],
    ['gryaz',                  'Грязь (глина и инородные вещи)',  'field',        2],
    ['pererosshiy',            'Переросший',                     'field',        3],
    ['kurchavost',             'Курчавость или скрученность',      'field',        4],
    ['neodnorodnyy_kalibr',    'Неоднородный калибр',             'field',        5],
    ['izmenenie_cveta',        'Изменение цвета',                 'field',        6],
    ['izbytochnaya_vlazhnost', 'Избыточная влажность',            'production',   7],
    ['zavyadanie',             'Завядание',                       'production',   8],
    ['pozheltenie',            'Пожелтение',                      'production',   9],
    ['potemnenie',             'Потемнение',                      'production',  10],
    ['zapah',                  'Запах',                           'production',  11],
    ['polomannye_listya',      'Поломанные листья',               'packing',     12],
    ['narushenie_vakuuma',     'Нарушение вакуума',               'packing',     13],
    ['net_tm',                 'Нет ТМ',                          'packing',     14],
    ['lishnie_stebli',         'Лишние стебли',                   'packing',     15],
    ['nepolozhili',            'Неположили',                      'fulfillment', 16],
    ['narushenie_vesa',        'Нарушение веса',                  'fulfillment', 17],
    ['peresort',               'Пересорт',                        'fulfillment', 18],
    ['problema_so_srokom',     'Проблема со сроком',              'fulfillment', 19],
  ];
  const SEVERITIES = [
    ['minor',    'Незначительная',               1],
    ['medium',   'Средняя',                      2],
    ['critical', 'Критическая (возврат партии)', 3],
  ];
  const RESOLUTIONS = [
    ['replace',  'Замена',                              1],
    ['discount', 'Скидка',                              2],
    ['reject',   'Отказ',                               3],
    ['warning',  'Предупреждение о нарушении хранения', 4],
  ];
  const CATEGORIES = [
    ['premium', 'premium', 1],
    ['eco',     'eco',     2],
    ['retail',  'retail',  3],
  ];
  const seed = async (kind, code, label, sort, link) => {
    await pool.query(
      `INSERT INTO tgbot.complaint_dicts (kind, code, label_ru, link_code, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (kind, code)
       DO UPDATE SET label_ru = EXCLUDED.label_ru, link_code = EXCLUDED.link_code, sort_order = EXCLUDED.sort_order`,
      [kind, code, label, link || null, sort]
    );
  };
  for (const [code, label, sort] of LINKS)       await seed('link', code, label, sort, null);
  for (const [code, label, link, sort] of TYPES) await seed('type', code, label, sort, link);
  for (const [code, label, sort] of SEVERITIES)  await seed('severity', code, label, sort, null);
  for (const [code, label, sort] of RESOLUTIONS) await seed('resolution', code, label, sort, null);
  for (const [code, label, sort] of CATEGORIES)  await seed('category', code, label, sort, null);

  _ready = true;
}

module.exports = { ensureComplaintSchema };
