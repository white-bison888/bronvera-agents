const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ModelRequests, findInDirectory } = require("../src/rare/model-requests");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-model-requests-")), "model-requests.json");

test("a model the directory already knows is not queued, and the person is told which one it is", async () => {
  const queue = new ModelRequests({ file: tmpFile() });
  const result = await queue.add({ query: "Porsche 911 Carrera 4S" });
  assert.equal(result.code, "known");
  assert.deepEqual(result.known, { make: "Porsche", family: "911" });
  assert.equal(queue.list().length, 0);
  assert.deepEqual(findInDirectory("range rover sport"), { make: "Land Rover", family: "Range Rover" });
});

test("an unknown model is queued once, an admin is notified, and the same request from another person only counts and adds a contact", async () => {
  const sent = [];
  const queue = new ModelRequests({ file: tmpFile(), notify: async text => sent.push(text) });

  const first = await queue.add({ query: "Lancia Thema 8.32", contact: { channel: "telegram", value: "@anna" } });
  assert.equal(first.code, "created");
  assert.match(first.message, /Мы сообщим, как только появится информация/);
  assert.equal(sent.length, 1);

  const second = await queue.add({ query: "  lancia   thema 8.32 ", contact: { channel: "email", value: "bob@example.com" } });
  assert.equal(second.code, "counted");
  assert.equal(sent.length, 1); // повторная заявка администраторов не беспокоит
  const [item] = queue.list({ status: "new" });
  assert.equal(item.count, 2);
  assert.deepEqual(item.contacts.map(c => c.value), ["@anna", "bob@example.com"]);
});

test("a too short or too long request is refused, and closing a request marks it added with the people to tell", async () => {
  const queue = new ModelRequests({ file: tmpFile() });
  assert.equal((await queue.add({ query: "ab" })).code, "bad_query");
  assert.equal((await queue.add({ query: "x".repeat(200) })).code, "bad_query");

  const created = await queue.add({ query: "Packard Twelve", contact: { channel: "telegram", value: "@carl" } });
  const closed = queue.close(created.id, { status: "added", note: "добавлена линейка Twelve" });
  assert.equal(closed.status, "added");
  assert.equal(closed.contacts[0].value, "@carl");
  assert.equal(queue.list({ status: "new" }).length, 0);
  assert.equal(queue.close("nope"), null);
});

test("a model added by an administrator stops being a request", async () => {
  const extra = [{ make: "Packard", families: [{ name: "Twelve", match: "\\btwelve\\b" }] }];
  const queue = new ModelRequests({ file: tmpFile(), extraDirectory: () => extra });
  assert.equal((await queue.add({ query: "Packard Twelve Sport Phaeton" })).code, "known");
});
