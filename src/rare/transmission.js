/*
 * «Five-Speed Manual Transmission», «5-Speed Manual» — у источников Rare
 * формулировки короче или длиннее, но форма всегда одна: число ступеней
 * (словом или цифрой) + тип. Общее для всех площадок — чтобы на сайте
 * коробка выглядела одинаково независимо от того, с BaT лот или с
 * PCARMARKET.
 */
const SPEED_NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const describeTransmission = (raw) => {
  if (!raw)
    return null;

  const speedMatch = raw.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-]*speed/i);
  const speed = speedMatch ? (SPEED_NUMBER_WORDS[speedMatch[1].toLowerCase()] ?? Number(speedMatch[1])) : null;
  const isDualClutch = /dual-clutch/i.test(raw);
  const isAutomatic = !isDualClutch && /automatic/i.test(raw);
  const isManual = /manual/i.test(raw);

  if (isDualClutch)
    return speed ? `${speed}-ступенчатый робот (DCT)` : "Робот (DCT)";
  if (isAutomatic)
    return speed ? `${speed}-ступенчатый автомат` : "Автомат";
  if (isManual)
    return speed ? `${speed}-ступенчатая механика` : "Механика";

  return raw; // тип не распознали — показываем как есть, не выдумываем
};

module.exports = { describeTransmission };
