#!/usr/bin/env tsx
/**
 * The channels a token can see.
 *
 *   SYNCHRA_TOKEN=… npx tsx examples/01-list-channels.ts
 *
 * Tokens come from the Synchra dashboard; there is no endpoint to get one from. A token carries a
 * fixed scope set *and* a fixed set of channels — a full-access token still answers 403 on a
 * channel it was not granted on, which is the single most expensive thing to learn about this API.
 */
import { AuthenticationError, AuthorizationError, Synchra } from '../src/index.js';

const synchra = Synchra.fromEnvironment();

try {
  // Cursor-paged, like most list endpoints: `records` plus the cursor for the next page. See
  // examples/02 for walking all of them.
  const page = await synchra.channel.getChannels();

  if (page.records.length === 0) {
    console.log('This token can see no channels.');
  }

  for (const channel of page.records) {
    console.log(`${channel.display_name}  ${channel.id}`);
  }
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('No token, or one the service does not accept. Set SYNCHRA_TOKEN.');
    process.exitCode = 1;
  } else if (error instanceof AuthorizationError) {
    console.error('The token is accepted but not granted on this resource.');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
