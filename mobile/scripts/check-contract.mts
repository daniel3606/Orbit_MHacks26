/**
 * Fails if the app's option values drift from the module's validation lists.
 * Run: npm run check:contract
 */
import * as app from '../src/features/onboarding/options.ts';
import * as server from '../../spacetime/spacetimedb/src/preferences.ts';

const pairs: Array<[string, { value: string }[], readonly string[]]> = [
  ['risk tolerance', app.RISK_TOLERANCE, server.RISK_TOLERANCE],
  ['investment horizon', app.INVESTMENT_HORIZON, server.INVESTMENT_HORIZON],
  ['investment style', app.INVESTMENT_STYLE, server.INVESTMENT_STYLE],
  ['experience level', app.EXPERIENCE_LEVEL, server.EXPERIENCE_LEVEL],
  ['primary goal', app.PRIMARY_GOAL, server.PRIMARY_GOAL],
  ['sectors', app.SECTORS, server.SECTORS],
  ['zodiac signs', app.ZODIAC_SIGNS, server.ZODIAC_SIGNS],
];

let failed = false;
for (const [name, appOptions, serverValues] of pairs) {
  const a = appOptions.map(o => o.value).join(',');
  const s = [...serverValues].join(',');
  if (a !== s) {
    failed = true;
    console.error(`✗ ${name}\n  app:    ${a}\n  server: ${s}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
if (app.MAX_SECTORS !== server.MAX_SECTORS) {
  failed = true;
  console.error(`✗ max sectors app=${app.MAX_SECTORS} server=${server.MAX_SECTORS}`);
} else {
  console.log('✓ max sectors');
}
process.exit(failed ? 1 : 0);
