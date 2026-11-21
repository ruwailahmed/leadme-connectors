import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCriteria, heuristic } from './classifier.ts';

const c = buildCriteria('people requesting LinkedIn account rentals for outbound that are US ID verified');

test('matches an explicit, fully-qualified request', () => {
  assert.equal(heuristic(c, 'Anyone have LinkedIn accounts for rent? Need US ID verified ones for outbound').match, true);
});
test('fails when the qualifier is missing (the video example)', () => {
  const v = heuristic(c, 'Asking for LinkedIn profiles for rent in the UK, any leads?');
  assert.equal(v.match, false);
});
test('ignores opinion posts that are not requests', () => {
  assert.equal(heuristic(c, 'We just wrote a post about why renting LinkedIn accounts is risky, US ID verified or not').match, false);
});
test('ignores unrelated chatter', () => {
  assert.equal(heuristic(c, 'Happy Friday everyone!').match, false);
});
test('any-mention mode is looser', () => {
  const loose = buildCriteria('email infrastructure interest', { strict: false });
  assert.equal(heuristic(loose, 'we moved our email infrastructure last week').match, true);
});
