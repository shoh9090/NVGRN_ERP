// src/tgbot.js — плитка «Бот HoReCa»: контакты точек и менеджеров для Telegram-бота.
// 4a: страница + экспорт готовой формы (только чтение). Импорт добавим в 4b.

const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const integrations = require('./integrations');

const router = express.Router();

// Доступ: администратор или роль «Руководитель продаж».
function requireSalesAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  const roles = req.user.roles || [];
  if (req.user.isAdmin || roles.includes('Руководитель продаж')) return next();
  return res.status(403).send('Доступ к этому разделу только у администратора и руководителя продаж.');
}
router.use(requireSalesAccess);

// Страница плитки.
router.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('tgbot', { settings, user: req.user });
});

// Экспорт готовой формы: все активные HoReCa-точки + два пустых столбца для номеров.
router.get('/export', async (req, res) => {
  try {
    const points = await integrations.getHorecaPoints();
    const rows = points.map((p) => ({
      SD_id: p.SD_id,
      'Название точки': p.name || '',
      'Контрагент (юр. название)': p.firmName || '',
      'ИНН': p.inn || '',
      'Телефон завсклада (для бота)': p.tel || '',
      'Телефон менеджера сети': '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        'SD_id',
        'Название точки',
        'Контрагент (юр. название)',
        'ИНН',
        'Телефон завсклада (для бота)',
        'Телефон менеджера сети',
      ],
    });
    ws['!cols'] = [
      { wch: 10 }, { wch: 28 }, { wch: 26 }, { wch: 14 }, { wch: 24 }, { wch: 24 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'HoReCa');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="horeca_form_${today}.xlsx"`);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    await db.log(req.user.id, 'tgbot_export_form', String(points.length));
  } catch (e) {
    res.status(500).send('Не удалось выгрузить форму: ' + e.message);
  }
});

module.exports = router;
