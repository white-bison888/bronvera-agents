function normalizeMarketReference(body) {
  const result = {};
  for (const field of ['polandPriceUsd', 'belarusPriceUsd']) {
    if (body[field] === undefined) continue;
    const price = Number(body[field]);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Цена должна быть положительным числом');
    result[field] = price;
  }
  if (body.polandSourceUrl !== undefined || body.polandObservedOn !== undefined) {
    const source = String(body.polandSourceUrl || '').trim();
    const date = String(body.polandObservedOn || '').trim();
    if (!source && !date) {
      result.polandSourceUrl = null;
      result.polandObservedOn = null;
    } else {
      let url;
      try { url = new URL(source); } catch { throw new Error('Укажите полную ссылку на источник цены'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || source.length > 2048)
        throw new Error('Источник должен быть обычной ссылкой HTTP или HTTPS без пароля');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
          || new Date(date).toISOString().slice(0, 10) !== date)
        throw new Error('Укажите действительную дату наблюдения цены');
      result.polandSourceUrl = url.href;
      result.polandObservedOn = date;
    }
  }
  if (!Object.keys(result).length) throw new Error('Укажите цену или её источник');
  return result;
}

module.exports = { normalizeMarketReference };
