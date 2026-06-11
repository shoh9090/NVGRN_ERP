// units-util.js — нормализация единиц измерения: «Штука», «штук», «шт.» → одна единица «шт»
const ALIASES = {
  'шт': 'шт', 'шт.': 'шт', 'штук': 'шт', 'штука': 'шт', 'штуки': 'шт',
  'кг': 'кг', 'килограмм': 'кг', 'кг.': 'кг',
  'г': 'г', 'гр': 'г', 'гр.': 'г', 'грамм': 'г',
  'л': 'л', 'л.': 'л', 'литр': 'л',
  'упак': 'упак', 'упак.': 'упак', 'упаковка': 'упак',
  'короб': 'короб', 'коробка': 'короб',
  'рулон': 'рулон',
  'пучок': 'пучок', 'пуч': 'пучок',
};

function normalizeUnit(raw) {
  if (!raw) return '';
  let v = String(raw).trim().toLowerCase().replace(/ё/g, 'е');
  v = v.replace(/\.+$/, '');
  return ALIASES[v] || ALIASES[v + '.'] || v;
}

// Каноничное короткое имя для отображения
function canonicalShort(raw) {
  return normalizeUnit(raw);
}

module.exports = { normalizeUnit, canonicalShort };
