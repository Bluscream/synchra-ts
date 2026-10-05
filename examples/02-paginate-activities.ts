#!/usr/bin/env tsx
/**
 * Every activity on a channel, across every page.
 *
 *   SYNCHRA_TOKEN=… npx tsx examples/02-paginate-activities.ts <channel-id>
 *
 * `paginate` walks the cursor for you and is lazy — it fetches the next page only when the loop asks
 * for it — so `maxRecords` here means one request, not a full history download.
 *
 * A 403 on this endpoint usually means the token is not granted on *that channel* rather than that a
 * scope is missing.
 */
import { AuthorizationError, Synchra, paginate } from '../src/index.js';

const channel_id = process.argv[2];

if (channel_id === undefined) {
  console.error('Usage: npx tsx examples/02-paginate-activities.ts <channel-id>');
  process.exit(1);
}

const synchra = Synchra.fromEnvironment();

try {
  for await (const activity of paginate(
    (cursor) => synchra.channelActivity.getActivities({ channel_id, cursor, per_page: 100 }),
    { maxRecords: 50 },
  )) {
    console.log(
      [
        activity.created_at,
        activity.provider.padEnd(8),
        activity.type_display_name.padEnd(20),
        activity.viewer_display_name,
      ].join('  '),
    );
  }
} catch (error) {
  if (error instanceof AuthorizationError) {
    console.error(
      'Answered 403. The token is valid but probably not granted on this channel — check which\n' +
        'channels it covers before widening its scopes.',
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
