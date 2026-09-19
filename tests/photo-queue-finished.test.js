const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('lots whose auction is over leave the photo queue', () => {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-queue-'));
  process.chdir(dir);

  try {
    delete require.cache[require.resolve('../src/photos/queue')];
    const queue = require('../src/photos/queue');

    queue.enqueue([{ lotNumber: 'PAST' }, { lotNumber: 'SOON' }], 'run-1');
    queue.markFailed('PAST', 'Снимки недоступны');

    // Так очередь и копила мусор: «неудачный» лот не берут заново, и он висит вечно.
    assert.equal(queue.read().items.length, 2);

    const dropped = queue.dropFinished(lot => lot === 'PAST');

    assert.deepEqual(dropped, ['PAST']);
    assert.deepEqual(queue.read().items.map(item => item.lotNumber), ['SOON']);
    // Второй проход ничего не трогает.
    assert.deepEqual(queue.dropFinished(() => false), []);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
