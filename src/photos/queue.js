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

    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (error) {
    console.error("Photo queue read error:", error.message);

    return { items: [] };
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

    if (!key || known.has(key))
      continue;

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

const markDone = (lotNumber, photoCount) => {
  const state = read();
  const target = String(lotNumber);

  state.items = state.items.filter(
    item => String(item.lotNumber) !== target,
  );

  write(state);

  return photoCount;
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

  write(state);
};

const stats = (runId = null) => {
  const state = read();

  const items = runId
    ? state.items.filter(item => item.runId === runId)
    : state.items;

  return {
    pending: items.length,
    totalPending: state.items.length,
    items: items.map(item => ({
      lotNumber: item.lotNumber,
      attempts: item.attempts,
      lastError: item.lastError,
    })),
  };
};

module.exports = {
  QUEUE_FILE,
  enqueue,
  nextPending,
  markDone,
  markFailed,
  stats,
  read,
};
