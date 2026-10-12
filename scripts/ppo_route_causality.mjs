// Training-only replay metadata. Raw engine IDs are used solely as local joins;
// published tokens follow the event/frame ancestry and per-parent occurrence.
import {createHash} from 'node:crypto';

const token = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition = id => id?.split(':')[1] ?? null;

export class RouteCausality {
  constructor(saved = null) {
    this.epoch = saved?.epoch ?? 0;
    this.lastResolution = saved?.lastResolution ?? null;
    this.lifecycle = saved?.lifecycle ?? {};
    this.current = null;
  }

  ingest(state) {
    const r = state.resolution;
    if (!r?.running) {
      for (const [id, status] of Object.entries(this.lifecycle))
        if (status === 'open') this.lifecycle[id] = 'invalidated';
      this.epoch = state.balanceResolutionSerial ?? this.epoch;
      this.lastResolution = null;
      this.current = {version: 'route-causality-v1', epoch: this.epoch,
        token: null, origin: null,
        lifecycle: {...this.lifecycle}};
      return this.current;
    }
    // Resolution objects are replaced for a new card/action, while one
    // resolution retains all its closed windows and terminal events.
    // The command boundary clones GameState on every transition. Object
    // identity would therefore count one resolution several times.
    const incomingEpoch = state.balanceResolutionSerial ?? 0;
    if (incomingEpoch !== this.epoch) this.lifecycle = {};
    this.epoch = incomingEpoch;
    this.lastResolution = this.epoch;
    const frameById = new Map(r.frames.map(f => [f.id, f]));
    const eventById = new Map(r.events.map(e => [e.id, e]));
    const windowById = new Map(r.windows.map(w => [w.id, w]));
    const frameTokens = new Map(), eventTokens = new Map(), windowTokens = new Map();
    const frameToken = id => {
      if (frameTokens.has(id)) return frameTokens.get(id);
      const frame = frameById.get(id);
      if (!frame) return null;
      const parent = frame.parentEventId ? eventToken(frame.parentEventId) :
        `resolution:${this.epoch}`;
      if (!parent) return null;
      const key = JSON.stringify([parent, frame.owner, definition(frame.cardId), frame.source]);
      // Assign siblings in creation order, including already completed frames.
      const siblings = r.frames.filter(f =>
        (f.parentEventId ?? null) === (frame.parentEventId ?? null) &&
        f.owner === frame.owner && definition(f.cardId) === definition(frame.cardId) &&
        f.source === frame.source);
      const index = siblings.findIndex(f => f.id === id) + 1;
      const result = token(['frame', parent, key, index]);
      frameTokens.set(id, result);
      return result;
    };
    const eventToken = id => {
      if (eventTokens.has(id)) return eventTokens.get(id);
      const event = eventById.get(id);
      if (!event) return null;
      const parent = frameToken(event.frameId);
      if (!parent) return null;
      const effectIndex = event.effectIndex ??
        r.events.filter(e => e.frameId === event.frameId).findIndex(e => e.id === id);
      const peers = r.events.filter(e => e.frameId === event.frameId &&
        (e.effectIndex ?? r.events.filter(x => x.frameId === e.frameId)
          .findIndex(x => x.id === e.id)) === effectIndex);
      const index = peers.findIndex(e => e.id === id) + 1;
      const effect = event.effect;
      const result = token(['event', parent, effectIndex, index,
        effect?.kind ?? null, effect?.action ?? null, effect?.country ?? null,
        effect?.option?.regionId ?? effect?.selection?.regionId ?? null,
        effect?.option?.defenderCountry ?? null,
        effect?.option?.mode ?? null, !!effect?.option?.intercept]);
      eventTokens.set(id, result);
      return result;
    };
    const windowToken = id => {
      if (windowTokens.has(id)) return windowTokens.get(id);
      const window = windowById.get(id);
      if (!window) return null;
      const parent = eventToken(window.originEventId);
      if (!parent) return null;
      const peers = r.windows.filter(w => w.originEventId === window.originEventId &&
        w.timing === window.timing && w.lane === window.lane);
      const index = peers.findIndex(w => w.id === id) + 1;
      const result = token(['window', parent, window.timing, window.lane ?? null, index]);
      windowTokens.set(id, result);
      const sourceCancelled = !!eventById.get(window.originEventId)?.cancelled;
      this.lifecycle[result] = sourceCancelled ? 'cancelled' : window.closed ?
        (window.closeReason ?? 'closed') : 'open';
      return result;
    };
    for (const frame of r.frames) frameToken(frame.id);
    for (const event of r.events) eventToken(event.id);
    for (const window of r.windows) windowToken(window.id);
    const choice = r.choice;
    const origin = choice?.windowId ? windowToken(choice.windowId) :
      choice?.frameId ? frameToken(choice.frameId) : null;
    const current = choice ? token(['choice', origin, choice.kind,
      choice.field ?? null, choice.seat,
      choice.frameId ? frameById.get(choice.frameId)?.nextEffectIndex : null]) : null;
    this.current = {version: 'route-causality-v1', epoch: this.epoch, token: current,
      origin, lifecycle: {...this.lifecycle}};
    return this.current;
  }

  snapshot() { return {epoch: this.epoch, lifecycle: {...this.lifecycle}}; }
}
