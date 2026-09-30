import { describe, expect, it } from 'vitest';
import { createGame, SEATS, transition } from '../src/core';
import type { Command } from '../src/core';

describe('project skeleton core', () => {
  it('creates deterministic, serializable setup with six independent decks', () => {
    const state = createGame('test-game', 1940);
    expect(state).toEqual(createGame('test-game', 1940));
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(Object.keys(state.decks)).toEqual([...SEATS]);
    expect(state.decks.germany).not.toBe(state.decks.japan);
    expect(state.settings.ignoreOtherPlayerInterrupts).toBe(true);
    expect(state.phase).toBe('SETUP');
    expect(state.units).toHaveLength(8);
    expect(state.round).toBe(0);
  });
  it('switches perspective without advancing the turn or mutating the input', () => {
    const previous = createGame('test-game', 1940);
    const result = transition(previous, { type: 'SET_VIEW', seat: 'japan', expectedRevision: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.viewSeat).toBe('japan');
    expect(result.state.operatorSeat).toBe('japan');
    expect(result.state.activeSeat).toBe('germany');
    expect(result.state.revision).toBe(1);
    expect(previous.viewSeat).toBe('germany');
    expect(previous.events).toHaveLength(1);
  });
  it('rejects missing sessions, stale commands and unsupported actions', () => {
    expect(transition(null, { type: 'SET_VIEW', seat: 'japan', expectedRevision: 0 })).toEqual({ ok: false, error: 'GAME_NOT_CREATED' });
    expect(transition(createGame('g', 1), { type: 'SET_VIEW', seat: 'japan', expectedRevision: 5 })).toEqual({ ok: false, error: 'STALE_REVISION' });
    expect(transition(null, { type: 'ADVANCE_TURN' } as unknown as Command)).toEqual({ ok: false, error: 'INVALID_COMMAND' });
  });
  it.each([-1, 1.5, NaN, Infinity, 4294967296])('rejects invalid seed %s', seed => {
    expect(transition(null, { type: 'CREATE_GAME', gameId: 'g', seed }).ok).toBe(false);
  });
});
