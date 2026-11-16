import 'dotenv/config';
import * as platform from '../backend/library/platformRepo.js';
import * as results from '../backend/library/resultsRepo.js';

/**
 * Writes the result digest (backend/library/resultDigest.js) of every published result set that
 * does not have one yet: sets published before digests existed. Optional: the class page makes a
 * missing digest itself, but on a table with little capacity a first visit that has to make many
 * at once can be throttled. This makes them one at a time instead. Safe to run again.
 *
 *   npm run digests:backfill -- [school_id]
 */
const schoolId = process.argv[2] || 'sch_saint_innocent';
let sets = 0;
for (const term of await platform.listTerms(schoolId)) {
  for (const set of await results.listSetsForTerm(schoolId, term.term_id)) {
    if (set.status !== results.STATUS.PUBLISHED || !set.calculation_id) continue;
    await results.publishedRows(schoolId, [set]); // reads the digest, or makes and stores it
    sets++;
    console.log(`digest ready: ${term.name} ${set.class_id} ${set.checkpoint}`);
  }
}
console.log(`\n${sets} published result sets have a digest`);
