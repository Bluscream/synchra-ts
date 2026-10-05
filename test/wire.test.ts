import { describe, expect, it } from 'vitest';

import { buildQuery, cleanHeaders, expandPath } from '../src/wire.js';
import {
  camel,
  operationMethod,
  pascal,
  propertyAccess,
  tagClass,
} from '../tools/generator/names.js';

describe('expandPath', () => {
  it('substitutes every placeholder', () => {
    expect(
      expandPath('/channels/{channel_id}/activities/{activity_id}', {
        channel_id: 'a',
        activity_id: 'b',
      }),
    ).toBe('/channels/a/activities/b');
  });

  it('percent-encodes a value so it cannot escape its segment', () => {
    // Without this, an id containing a slash would reach a different route entirely.
    expect(expandPath('/channels/{id}/x', { id: '../../admin' })).toBe(
      '/channels/..%2F..%2Fadmin/x',
    );
    expect(expandPath('/q/{id}', { id: 'a b&c' })).toBe('/q/a%20b%26c');
  });

  it('accepts a number', () => {
    expect(expandPath('/page/{n}', { n: 3 })).toBe('/page/3');
  });

  it('refuses to build a path with a placeholder left unfilled', () => {
    expect(() => expandPath('/channels/{channel_id}', {})).toThrow(TypeError);
  });
});

describe('buildQuery', () => {
  it('returns an empty string for nothing to send', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined, b: null })).toBe('');
  });

  it('omits undefined and null but keeps false and zero', () => {
    expect(buildQuery({ example: false, count: 0, missing: undefined })).toBe(
      '?count=0&example=false',
    );
  });

  it('repeats the key for an array, which is what FastAPI reads as a list', () => {
    expect(buildQuery({ type: ['sub', 'raid'] })).toBe('?type=sub&type=raid');
  });

  it('skips the unset entries of an array', () => {
    expect(buildQuery({ type: ['sub', undefined, null, 'raid'] })).toBe('?type=sub&type=raid');
  });

  it('sorts the keys, so the same filters always produce the same url', () => {
    expect(buildQuery({ z: 1, a: 2 })).toBe('?a=2&z=1');
  });

  it('escapes values', () => {
    expect(buildQuery({ search: 'a b&c=d' })).toBe('?search=a+b%26c%3Dd');
  });
});

describe('cleanHeaders', () => {
  it('lowercases names so later sources override earlier ones', () => {
    expect(cleanHeaders({ 'X-Trace': 'a' }, { 'x-trace': 'b' })).toEqual({ 'x-trace': 'b' });
  });

  it('drops the headers a caller left unset', () => {
    expect(cleanHeaders({ a: 'x', b: undefined, c: null })).toEqual({ a: 'x' });
  });

  it('stringifies a non-string value', () => {
    expect(cleanHeaders({ 'content-length': 12 })).toEqual({ 'content-length': '12' });
  });
});

describe('name mapping', () => {
  it('title-cases words and keeps meaningful inner capitals', () => {
    expect(pascal('chat_message')).toBe('ChatMessage');
    expect(pascal('Admin HTTP Proxies')).toBe('AdminHttpProxies');
    expect(pascal('')).toBe('Unnamed');
    expect(pascal('2fa')).toBe('N2fa');
  });

  it('escapes a reserved word so it can be an identifier', () => {
    expect(camel('Delete')).toBe('delete_');
    expect(camel('Get Channel')).toBe('getChannel');
  });

  it('applies the tag overrides, which mirror synchra-php’s', () => {
    expect(tagClass('WebSocket')).toBe('Gateway');
    expect(tagClass('Ko-fi')).toBe('KoFi');
    expect(tagClass('Channel Activity')).toBe('ChannelActivity');
  });

  it('drops the Route suffix FastAPI puts in a generated summary', () => {
    expect(operationMethod('GET', '/x', 'Get Channels Route')).toBe('getChannels');
  });

  it('uses the override where a summary is not unique inside its tag', () => {
    // Every Twitch and YouTube moderator endpoint is summarised "Ban User".
    expect(
      operationMethod(
        'POST',
        '/api/2/channels/{channel_id}/twitch/{channel_provider_id}/moderators',
        'Ban User',
      ),
    ).toBe('addModerator');
  });

  it('reads a property with a dot where the wire name allows one', () => {
    expect(propertyAccess('params', 'channel_id')).toBe('params.channel_id');
    expect(propertyAccess('params', 'x-kv-token')).toBe('params["x-kv-token"]');
  });
});
