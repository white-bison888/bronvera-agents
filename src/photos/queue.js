const fs = require("fs");
const path = require("path");

const QUEUE_FILE = path.join(process.cwd(), "data", "photo-queue.json");

/*
 * Очередь лежит в файле, а не в памяти: сбор растянут на часы, и
 * перезапуск сервера не должен терять накопленное или собирать заново.
 *
 * Запись выбывает из очереди только когда снимки действительно получены.
 * Отказ Bid.Cars или обрыв связи лишь отодвигают следующую попытку.
 */
const read = () => {
  try {
    if (!fs.existsSync(QUEUE_FILE))
      return { items: [] };

    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));

    if (!Array.isArray(parsed.items))
      throw new Error("Invalid queue format");
    return { items: parsed.items };
  } catch (error) {
    console.error("Photo queue read error:", error.message);

    throw error;
  }
};

const write = (state) => {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });

  const tempFile = `${QUEUE_FILE}.tmp`;

  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, QUEUE_FILE);
};

const enqueue = (lots = [], runId = null) => {
  const state = read();
  const known = new Set(state.items.map(item => String(item.lotNumber)));

  let added = 0;

  for (const lot of lots) {
    const key = String(lot.lotNumber || lot);

    if (!key)
      continue;
    if (known.has(key)) {
      const existing = state.items.find(item => String(item.lotNumber) === key);
      if (existing.status === "failed") {
        existing.status = "pending";
        existing.attempts = 0;
        existing.lastAttemptAt = null;
        existing.lastError = null;
        existing.runId = runId;
        added += 1;
      }
      continue;
    }

    state.items.push({
      lotNumber: key,
      runId,
      addedAt: new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    });

    known.add(key);
    added += 1;
  }

  if (added > 0)
    write(state);

  return added;
};

/*
 * Следующим берём лот, который дольше всех ждёт и по которому истекла
 * пауза после прошлой неудачи. Пауза растёт с каждой попыткой, чтобы
 * не долбить источник, когда он нас блокирует.
 */
const nextPending = (backoffBaseMs = 60000) => {
  const state = read();
  const now = Date.now();

  const ready = state.items
    .filter(item => item.status === "pending")
    // Лот, отложенный до обновления суточного лимита, трогать рано.
    .filter(item => !item.deferredUntil || now >= new Date(item.deferredUntil).getTime())
    .filter((item) => {
      if (!item.lastAttemptAt)
        return true;

      const wait = Math.min(
        backoffBaseMs * 2 ** Math.min(item.attempts, 5),
        30 * 60 * 1000,
      );

      return now - new Date(item.lastAttemptAt).getTime() >= wait;
    });

  if (ready.length === 0)
    return null;

  ready.sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));

  return ready[0];
};

/*
 * Лот, у которого торги прошли, из очереди убираем: снимки ему уже незачем,
 * а «неудачных» записей за неделю накопилось пять — все по лотам, проданным
 * 13–14 сентября. Возвращаем номера убранных, чтобы это было видно в логе.
 */
const dropFinished = (isOver) => {
  const state = read();
  const dropped = [];

  state.items = state.items.filter((item) => {
    if (!isOver(String(item.lotNumber)))
      return true;

    dropped.push(String(item.lotNumber));
    return false;
  });

  if (dropped.length)
    write(state);

  return dropped;
};

const markDone = (lotNumber, photoCount) => {
  const state = read();
  const target = String(lotNumber);

  state.items = state.items.filter(
    item => String(item.lotNumber) !== target,
  );

  write(state);

  return photoCount;
};

/*
 * Исчерпанный суточный лимит — не отказ. Счётчик попыток не трогаем:
 * иначе лот, отложенный утром, за час выберет все пять попыток и будет
 * похоронен со статусом failed, так и не дождавшись обновления лимита.
 */
const markDeferred = (lotNumber, reason) => {
  const state = read();
  const target = String(lotNumber);

  const item = state.items.find(
    entry => String(entry.lotNumber) === target,
  );

  if (!item)
    return;

  const tomorrow = new Date();
  tomorrow.setHours(24, 5, 0, 0);

  item.lastError = reason;
  item.deferredUntil = tomorrow.toISOString();

  write(state);

  return item.deferredUntil;
};

const markFailed = (lotNumber, reason) => {
  const state = read();
  const target = String(lotNumber);

  const item = state.items.find(
    entry => String(entry.lotNumber) === target,
  );

  if (!item)
    return;

  item.attempts += 1;
  item.lastAttemptAt = new Date().toISOString();
  item.lastError = reason;
  if (item.attempts >= 5)
    item.status = "failed";

  write(state);
};

const stats = (runId = null) => {
  const state = read();

  const items = runId
    ? state.items.filter(item => item.runId === runId)
    : state.items;

  return {
    pending: items.filter(item => item.status === "pending").length,
    totalPending: state.items.filter(item => item.status === "pending").length,
    failed: items.filter(item => item.status === "failed").length,
    items: items.map(item => ({
      lotNumber: item.lotNumber,
      status: item.status,
      attempts: item.attempts,
      lastError: item.lastError,
    })),
  };
};

/*
 * Полная очистка очереди. Сбор идёт по одному лоту в четыре минуты,
 * поэтому случайно набранная очередь из сотен лотов занимает сутки —
 * и её нужно уметь сбросить одним движением.
 */
const clear = () => {
  const state = read();
  const removed = state.items.length;

  state.items = [];
  write(state);

  return removed;
};

module.exports = {
  QUEUE_FILE,
  enqueue,
  clear,
  dropFinished,
  nextPending,
  markDone,
  markDeferred,
  markFailed,
  stats,
  read,
};
