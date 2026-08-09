// Правило наследования общих условий группы калькуляции.
// Вынесено отдельно, чтобы веб, будущие снимки и Telegram-бот использовали
// одинаковый приоритет данных без дублирования.
const num = (value) => (value === undefined || value === null || value === '' || Number.isNaN(Number(value)) ? 0 : Number(value));

function commercialForGroup(group, requested = {}, mode = 'standard') {
  const input = requested && typeof requested === 'object' ? requested : {};
  if (!group) return { ...input };
  const common = {
    price_includes_vat: group.price_includes_vat !== false,
    vat_rate: num(group.vat_rate),
    retro_rate: num(group.retro_rate),
    profit_tax_rate: num(group.profit_tax_rate),
    waste_reserve_rate: num(group.waste_reserve_rate),
    target_margin_rate: null,
    price_round_step: 0,
  };
  // В модели общие значения можно временно переопределить. В обычной
  // калькуляции группа сильнее запроса; из изделия берётся только его цена.
  return mode === 'model'
    ? { ...common, ...input }
    : { ...input, ...common, price: input.price };
}

function packagingForBatch(rows, batchOutputQty) {
  const batch = num(batchOutputQty) || 1;
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    item_kind: 'packaging',
    item_id: row.item_id,
    qty_net: num(row.qty) * batch,
    loss_rate: 0,
    comment: row.comment || '',
    inherited_from_group: true,
  }));
}

module.exports = { commercialForGroup, packagingForBatch };
