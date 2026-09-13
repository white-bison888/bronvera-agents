const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PhotoAssessor = require('../src/vision/photo-assessor');

test('cache changes with photo content and model; concurrency is bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-cache-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const photo = path.join(dir, 'photo.jpg');
    fs.writeFileSync(photo, 'first-photo');
    const options = { apiKey: 'test', cacheFile: path.join(dir, 'cache.json') };
    const assessor = new PhotoAssessor(options);
    let calls = 0, active = 0, peak = 0;
    assessor.assessOne = async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { available: true, repairCostMin: 100, repairCostMax: 200 };
    };
    const lots = [1, 2, 3].map(lotNumber => ({ lotNumber }));
    const photos = { 1: [photo], 2: [photo], 3: [photo] };
    await assessor.assess(lots, photos);
    assert.equal(calls, 3);
    assert.ok(peak <= 2);
    await assessor.assess(lots, photos);
    assert.equal(calls, 3);
    fs.writeFileSync(photo, 'changed-photo');
    await assessor.assess(lots, photos);
    assert.equal(calls, 6);
    assert.ok(assessor.getCached(1));
    const changedModel = new PhotoAssessor({ ...options, model: 'different' });
    assert.equal(changedModel.getCached(1), null);
  } finally { process.chdir(previousCwd); fs.rmSync(dir, { recursive: true, force: true }); }
});
