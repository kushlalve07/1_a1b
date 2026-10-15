'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('API and frontend JavaScript parse without syntax errors', () => {
  for (const file of ['api/server.js', 'web/assets/app.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('all assignment screens exist in the HTML shell', () => {
  const html = read('web/index.html');
  for (const view of ['overview', 'browse', 'booking', 'audit', 'analytics', 'map', 'reviews']) {
    assert.match(html, new RegExp(`id="view-${view}"`), `missing ${view} view`);
  }
});

test('API exposes all four required workflows and health route', () => {
  const api = read('api/server.js');
  for (const route of [
    "app.get('/api/health'", "app.post('/api/trips'", "app.get('/api/analytics/moving-average'",
    "app.get('/api/analytics/rankings'", "app.get('/api/vehicles/nearby'", "app.get('/api/reviews/stats'",
    "app.get('/api/riders/:id/audit'", "app.post('/api/analytics/vehicle-stats/refresh'",
  ]) assert.ok(api.includes(route), `missing route ${route}`);
  assert.match(api, /\$geoNear/);
  assert.match(api, /\$facet/);
  assert.match(api, /CALL book_trip/);
  assert.match(api, /DENSE_RANK/);
});

test('design includes responsive breakpoints and keyboard focus styling', () => {
  const css = read('web/assets/styles.css');
  assert.match(css, /@media\(max-width:620px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  for (const color of ['#172b35', '#f6f5f0', '#b88c50', '#2e746d']) assert.ok(css.includes(color));
});

test('refresh timestamp migration is safe to reapply', () => {
  const sql = read('sql/07_assignment2_refresh_timestamp.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mv_vehicle_trip_stats_refresh/);
  assert.match(sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(sql, /REFRESH MATERIALIZED VIEW CONCURRENTLY/);
});

test('Mongo setup checks for collections before creating them', () => {
  const js = read('mongo/01_collections_and_indexes.js');
  assert.match(js, /getCollectionNames\(\)\.includes\(name\)/);
  assert.match(js, /2dsphere/);
  assert.match(js, /expireAfterSeconds: 7200/);
});
