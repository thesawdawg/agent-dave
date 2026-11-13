import test from 'node:test';
import assert from 'node:assert/strict';
import {isLoopback} from '../.pi/lib/android-permissions.ts';

test('isLoopback: only localhost, 127.0.0.0/8 and ::1 count as on this phone', () => {
  for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://127.1.2.3/v1', 'http://[::1]:8080/v1']) {
    assert.equal(isLoopback(url), true, url);
  }
  for (const url of ['http://192.168.1.5:8080/v1', 'https://example.org/v1', 'not a url']) {
    assert.equal(isLoopback(url), false, url);
  }
});
