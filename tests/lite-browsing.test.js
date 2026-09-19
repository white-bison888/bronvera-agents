const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyLiteBrowsing, shouldSkip } = require('../src/providers/lite-browsing');

// Поддельный контекст браузера: запоминает обработчик и прогоняет через него запросы.
const fakeContext = () => {
  const context = { handler: null, route: async (_pattern, handler) => { context.handler = handler; } };

  context.request = (resourceType) => {
    const calls = [];

    context.handler({
      request: () => ({ resourceType: () => resourceType }),
      abort: () => calls.push('abort'),
      continue: () => calls.push('continue'),
    });

    return calls[0];
  };

  return context;
};

test('photos, video and fonts are not downloaded, everything else is', async () => {
  assert.equal(shouldSkip('image'), true);
  assert.equal(shouldSkip('media'), true);
  assert.equal(shouldSkip('font'), true);
  assert.equal(shouldSkip('document'), false);
  assert.equal(shouldSkip('xhr'), false);
  assert.equal(shouldSkip('script'), false);
  assert.equal(shouldSkip(undefined), false);

  const context = await applyLiteBrowsing(fakeContext());

  assert.equal(context.request('image'), 'abort');
  assert.equal(context.request('font'), 'abort');
  // Ставка приходит в разметке и запросах страницы — их пропускаем.
  assert.equal(context.request('document'), 'continue');
  assert.equal(context.request('xhr'), 'continue');
  assert.equal(context.request('fetch'), 'continue');
  assert.equal(context.request('stylesheet'), 'continue');
});
