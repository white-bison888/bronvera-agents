const fs = require("fs");
const path = require("path");
const { norm, buildDirectory } = require("./model-directory");
const { DIRECTORY, MAKE_ALIASES } = require("./model-directory-data");

/*
 * Заявки на модели (10.10.2026, решение Mikita): справочник покрывает ≈300 самых частых линеек, остальные добавляем, когда
 * ими интересуются пользователи. Человек вводит модель, которой нет, — получает «сообщим, как только появится информация»,
 * а заявка уходит администраторам (сообщение в Telegram и очередь в файле data/rare/model-requests.json). Администратор
 * добавляет модель в data/rare/model-directory-extra.json и закрывает заявку — тогда человеку можно сообщить.
 * Одна и та же заявка от разных людей не дублируется: растёт счётчик и список контактов.
 */

const MAX_QUERY = 120;
const MIN_QUERY = 3;

const writeAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};

/* Уже ли справочник знает эту модель: марка названа в запросе и подходит какая-то линейка этой марки. */
const findInDirectory = (query, extra = []) => {
  const text = ` ${norm(query)} `;
  const directory = buildDirectory(DIRECTORY, extra);
  for (const [key, entry] of directory) {
    const named = text.includes(` ${norm(entry.make)} `) || text.includes(` ${key} `)
      || Object.values(MAKE_ALIASES).some(target => target.make === entry.make && text.includes(` ${norm(target.prefix || target.make)} `));
    if (!named)
      continue;
    const family = entry.families.find(item => item.match.test(text.trim()) && !(item.exclude && item.exclude.test(text.trim())));
    if (family)
      return { make: entry.make, family: family.name };
  }
  return null;
};

class ModelRequests {
  constructor({ file, notify = null, now = () => Date.now(), extraDirectory = () => [], log = () => {} } = {}) {
    Object.assign(this, { file, notify, now, extraDirectory, log });
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(data.requests) ? data : { requests: [] };
    }
    catch {
      return { requests: [] };
    }
  }

  list({ status = null } = {}) {
    return this.read().requests.filter(item => !status || item.status === status).sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  /* contact — { channel: "telegram"|"email", value }, необязателен: без него сообщить будет некому, но спрос мы всё равно считаем. */
  async add({ query, contact = null }) {
    const text = String(query || "").replace(/\s+/g, " ").trim();
    if (text.length < MIN_QUERY || text.length > MAX_QUERY)
      return { ok: false, code: "bad_query", message: `Название модели: от ${MIN_QUERY} до ${MAX_QUERY} знаков.` };

    const known = findInDirectory(text, this.extraDirectory());
    if (known)
      return { ok: true, code: "known", known, message: `Эта модель уже есть: ${known.make} ${known.family}.` };

    const data = this.read();
    const key = norm(text);
    const stamp = new Date(this.now()).toISOString();
    let item = data.requests.find(entry => entry.key === key && entry.status === "new");
    const fresh = !item;
    if (fresh) {
      item = { id: `mr-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, key, query: text, status: "new", count: 0, firstAt: stamp, lastAt: stamp, contacts: [], note: null };
      data.requests.push(item);
    }
    item.count += 1;
    item.lastAt = stamp;
    const value = contact && String(contact.value || "").trim();
    if (value && !item.contacts.some(entry => entry.value === value))
      item.contacts.push({ channel: contact.channel === "email" ? "email" : "telegram", value: value.slice(0, 120), notified: false });
    writeAtomic(this.file, data);

    if (fresh && this.notify)
      await Promise.resolve(this.notify(`Заявка на модель: «${text}». Добавьте её в справочник (data/rare/model-directory-extra.json) и закройте заявку.`)).catch(error => this.log(`BRONVERA Rare: не отправил оповещение о заявке на модель: ${error.message}`));

    return { ok: true, code: fresh ? "created" : "counted", id: item.id, message: "Пока этой модели нет в справочнике. Мы сообщим, как только появится информация: запрос передан администраторам." };
  }

  /* status: "added" (модель добавлена) или "rejected"; note — пояснение. Возвращает заявку с контактами, которым пора написать. */
  close(id, { status = "added", note = null } = {}) {
    const data = this.read();
    const item = data.requests.find(entry => entry.id === id);
    if (!item)
      return null;
    item.status = status === "rejected" ? "rejected" : "added";
    item.note = note;
    item.closedAt = new Date(this.now()).toISOString();
    writeAtomic(this.file, data);
    return item;
  }
}

module.exports = { ModelRequests, findInDirectory };
