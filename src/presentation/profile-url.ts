/**
 * Where a viewer's public profile lives on the platform they wrote from.
 *
 * Synchra identifies a viewer by the provider's own handle and id and carries no public url,
 * because the url is a property of the platform rather than of the API — so building one is left to
 * whoever renders. This is that mapping, in one place, so a chat log can turn a name into a link
 * without every caller rediscovering that YouTube goes by channel id while everyone else goes by
 * handle.
 *
 * ```ts
 * const href = profileUrl(message);   // undefined where the platform has no public profile page
 * ```
 */
import type { ChatMessage } from '../generated/models.js';

/**
 * Templates taking the viewer's handle.
 *
 * Deliberately not every provider the API knows: most are integrations — emote hosts, TTS voices,
 * alert services — with no viewer profiles at all. One of those returns undefined rather than a
 * guess.
 */
const BY_HANDLE: Readonly<Record<string, (handle: string) => string>> = {
  twitch: (handle) => `https://www.twitch.tv/${handle}`,
  tiktok: (handle) => `https://www.tiktok.com/@${handle}`,
  kick: (handle) => `https://kick.com/${handle}`,
  rumble: (handle) => `https://rumble.com/user/${handle}`,
  x: (handle) => `https://x.com/${handle}`,
};

/**
 * Providers addressed by the provider's own id instead of the handle.
 *
 * YouTube's canonical profile url is the channel id. The handle form exists, but it is not what the
 * API gives us.
 */
const BY_ID: Readonly<Record<string, (id: string) => string>> = {
  youtube: (id) => `https://www.youtube.com/channel/${id}`,
};

export interface ProfileSubject {
  readonly provider: string;
  /** The provider's handle or login for the viewer. */
  readonly viewer_name: string;
  /** The provider's own id, which is what YouTube's url needs. */
  readonly provider_viewer_id?: string | null | undefined;
}

/** The profile url of whoever wrote this message, or undefined where there is no public one. */
export function profileUrl(subject: ProfileSubject | ChatMessage): string | undefined {
  const byId = BY_ID[subject.provider];

  if (byId !== undefined) {
    const id = subject.provider_viewer_id ?? '';

    return id === '' ? undefined : byId(encodeURIComponent(id));
  }

  const byHandle = BY_HANDLE[subject.provider];

  if (byHandle === undefined || subject.viewer_name === '') {
    return undefined;
  }

  return byHandle(encodeURIComponent(subject.viewer_name));
}
