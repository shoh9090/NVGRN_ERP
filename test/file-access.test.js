// Тест правил доступа к /file/:id (P0.1). Запуск: node --test
const { test } = require('node:test');
const assert = require('node:assert');
const { decideFileAccess } = require('../src/file-access');

test('логотип/фон доступны анониму (страница логина)', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: true, hasUser: false }), 'serve');
});

test('обычный файл: аноним не получает', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: false }), 'deny');
});

test('обычный файл: авторизованный получает', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: true, isComplaintMedia: false }), 'serve');
});

test('медиа претензии: аноним — отказ', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: false, isComplaintMedia: true }), 'deny');
});

test('медиа претензии: вошёл, но нет доступа к плитке — отказ', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: true, isComplaintMedia: true, isAdmin: false, hasComplaintsTile: false }), 'deny');
});

test('медиа претензии: есть доступ к плитке — можно', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: true, isComplaintMedia: true, isAdmin: false, hasComplaintsTile: true }), 'serve');
});

test('медиа претензии: админ — можно', () => {
  assert.strictEqual(decideFileAccess({ isPublicAsset: false, hasUser: true, isComplaintMedia: true, isAdmin: true, hasComplaintsTile: false }), 'serve');
});
