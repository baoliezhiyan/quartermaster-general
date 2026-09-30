import { describe, expect, it } from 'vitest';
import { LocalGameController } from '../src/controller/LocalGameController';

describe('local controller', () => {
  it('publishes stable immutable snapshots and supports unsubscribe', async () => {
    const controller = new LocalGameController();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => notifications++);
    expect(controller.getSnapshot()).toBeNull();
    await controller.dispatch({ type: 'CREATE_GAME', gameId: 'g', seed: 1 });
    const snapshot = controller.getSnapshot()!;
    expect(snapshot).toBe(controller.getSnapshot());
    expect(Object.isFrozen(snapshot.decks.germany.hand)).toBe(true);
    expect(() => { snapshot.scores.germany = 100; }).toThrow();
    unsubscribe();
    await controller.dispatch({ type: 'SET_VIEW', seat: 'japan', expectedRevision: 0 });
    expect(notifications).toBe(1);
    expect(snapshot.viewSeat).toBe('germany');
  });
  it('serializes commands and rejects the second outdated revision', async () => {
    const controller = new LocalGameController();
    await controller.dispatch({ type: 'CREATE_GAME', gameId: 'g', seed: 1 });
    const results = await Promise.all([
      controller.dispatch({ type: 'SET_VIEW', seat: 'japan', expectedRevision: 0 }),
      controller.dispatch({ type: 'SET_VIEW', seat: 'italy', expectedRevision: 0 }),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: false, error: 'STALE_REVISION' }]);
    expect(controller.getSnapshot()?.viewSeat).toBe('japan');
  });
  it('creates a clean replacement game', async () => {
    const controller = new LocalGameController();
    await controller.dispatch({ type: 'CREATE_GAME', gameId: 'old', seed: 1 });
    await controller.dispatch({ type: 'SET_VIEW', seat: 'japan', expectedRevision: 0 });
    await controller.dispatch({ type: 'CREATE_GAME', gameId: 'new', seed: 2 });
    expect(controller.getSnapshot()).toMatchObject({ gameId: 'new', seed: 2, revision: 0, viewSeat: 'germany' });
    expect(controller.getSnapshot()?.events).toHaveLength(1);
  });
});
