const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAttachmentInput } = require('../lib/nativeAttachments');
const id = '00000000-0000-4000-8000-000000000001';
const text = { id, name: 'guide.txt', mime: 'text/plain', kind: 'text', base64: Buffer.from('Keep the red button.').toString('base64') };
const png = { id, name: 'preview.png', mime: 'image/png', kind: 'image', base64: 'iVBORw0KGgo=', preview: { route: '/tasks', marks: [{ note: 'This card' }] } };
test('native turn receives image bytes and annotation notes, never arbitrary URLs or paths', () => {
  const input = buildAttachmentInput([png]);
  assert.equal(input[1].type, 'image'); assert.equal(input[1].url, 'data:image/png;base64,iVBORw0KGgo=');
  assert.match(input[0].text, /This card/); assert.match(input[0].text, /tasks/);
  assert.equal(input[1].path, undefined);
});
test('native file input includes the exact reference content', () => {
  assert.match(buildAttachmentInput([text])[0].text, /Keep the red button/);
});
test('reject malformed, duplicate, unsupported, remote and excessive inputs', () => {
  for (const input of [[{ ...png, mime: 'image/svg+xml' }], [{ ...text, name: '../escape' }],
    [{ ...png, base64: 'https://example.test/file' }], [text, text], Array(6).fill(text), [{ ...text, base64: '/w==' }]])
    assert.throws(() => buildAttachmentInput(input));
  assert.deepEqual(buildAttachmentInput(), []);
});
