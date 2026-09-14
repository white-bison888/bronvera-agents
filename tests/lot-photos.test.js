const { test } = require('node:test');
const assert = require('node:assert/strict');
const LotPhotoCollector = require('../src/providers/lot-photos');

const collector = new LotPhotoCollector({ photoDir: '/nonexistent', cacheFile: '/nonexistent/cache.json' });

test('archived lot photos are found on the new hosts, without similar lots', () => {
  const html = [
    'https://mercury.bid.cars/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-1.jpg',
    'https://pluto.bid.car/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-1.jpg',
    'https://pluto.bid.car/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-2.jpg',
    'https://pluto.bid.car/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-2.jpg',
    'https://pluto.bid.car/1-59999999/2023-Tesla-MODEL-Y-OTHER-1.jpg',
  ].map(src => `<img src="${src}">`).join('');

  assert.deepEqual(collector.extractPhotoUrls(html, '1-66239746'), [
    'https://pluto.bid.car/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-1.jpg',
    'https://pluto.bid.car/1-66239746/2023-Tesla-MODEL-Y-7SAYGDEF7PF846739-2.jpg',
  ]);
});

test('live lot photos keep coming from images.bid.cars, previews only as a last resort', () => {
  const live = '"https://images.bid.cars/046009893_6aa122ce2bc23/2013-Tesla-Model-S-5YJSA1CN1DFP25780-1.jpg" '
    + '"https://mercury.bid.cars/0-46009893/2013-Tesla-Model-S-5YJSA1CN1DFP25780-1.jpg"';
  assert.deepEqual(collector.extractPhotoUrls(live, '0-46009893'), [
    'https://images.bid.cars/046009893_6aa122ce2bc23/2013-Tesla-Model-S-5YJSA1CN1DFP25780-1.jpg',
  ]);

  const previewsOnly = '"https://mercury.bid.cars/0-46009893/2013-Tesla-Model-S-5YJSA1CN1DFP25780-3.jpg"';
  assert.equal(collector.extractPhotoUrls(previewsOnly, '0-46009893').length, 1);
  assert.deepEqual(collector.extractPhotoUrls('<img src="https://bid.cars/img/logo.jpg">', '0-46009893'), []);
});
