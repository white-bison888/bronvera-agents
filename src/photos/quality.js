const fs = require("fs");

/*
 * ПРОВЕРКА ПРИГОДНОСТИ СНИМКА
 *
 * Запасной способ сбора — снять картинку с экрана браузера. Если кадр
 * ещё не отрисовался, снимается пустой белый прямоугольник: файл есть,
 * размер правильный, а смотреть не на что. Дальше по цепочке такой
 * файл считался фотографией, модель писала «ничего не видно», а система
 * всё равно выдавала заключение.
 *
 * Поэтому кадр проверяется дважды: сразу при сохранении и ещё раз
 * перед оценкой — на диск снимки могли попасть и раньше, до этой
 * проверки.
 */

// Пустой скриншот весил 2.5 КБ. Настоящий кадр аукциона — сотни
// килобайт, даже сильно сжатая миниатюра не бывает меньше восьми.
const MIN_FILE_BYTES = 8 * 1024;

/*
 * Однотонный кадр выдаёт себя разбросом яркости: у белого прямоугольника
 * стандартное отклонение по всем каналам около нуля. У любой реальной
 * фотографии — десятки единиц.
 */
const MIN_CHANNEL_STDDEV = 6;

let sharp = null;
let sharpChecked = false;

const loadSharp = () => {
  if (sharpChecked)
    return sharp;

  sharpChecked = true;

  try {
    sharp = require("sharp");
  } catch {
    // Без sharp остаётся проверка по размеру файла — она ловит
    // те самые пустые скриншоты, просто менее строго.
    sharp = null;
  }

  return sharp;
};

/*
 * Возвращает причину непригодности или null, если кадр нормальный.
 */
const inspectPhoto = async (file) => {
  let size;

  try {
    size = fs.statSync(file).size;
  } catch {
    return "файл недоступен";
  }

  if (size < MIN_FILE_BYTES)
    return `слишком маленький файл (${Math.round(size / 1024)} КБ)`;

  const lib = loadSharp();

  if (!lib)
    return null;

  try {
    const { channels } = await lib(file).stats();

    if (!channels || channels.length === 0)
      return "не удалось прочитать изображение";

    const flat = channels.every(
      channel => channel.stdev < MIN_CHANNEL_STDDEV
    );

    if (flat) {
      const mean = Math.round(channels[0].mean);

      return mean > 200
        ? "пустой белый кадр — снимок сделан до отрисовки"
        : "однотонный кадр без содержимого";
    }

    return null;
  } catch (error) {
    return `изображение не читается: ${error.message}`;
  }
};

const isUsablePhoto = async file => (await inspectPhoto(file)) === null;

/*
 * Делит список файлов на пригодные и брак. Брак не удаляем молча:
 * список причин уходит в ответ, чтобы в интерфейсе было видно,
 * почему у лота «шесть фото», но оценки нет.
 */
const filterUsablePhotos = async (files) => {
  const usable = [];
  const rejected = [];

  for (const file of files) {
    const reason = await inspectPhoto(file);

    if (reason === null)
      usable.push(file);
    else
      rejected.push({ file, reason });
  }

  return { usable, rejected };
};

module.exports = {
  MIN_FILE_BYTES,
  inspectPhoto,
  isUsablePhoto,
  filterUsablePhotos,
};
