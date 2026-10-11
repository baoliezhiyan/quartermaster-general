import {describe,it,expect} from 'vitest';
import {PpoTrainingArena} from '../src/training/ppoArena';

const options={mode:'A' as const,cardSet:'signals' as const,buildFingerprint:'f'.repeat(64)};

describe('off-policy future random fork',()=>{
  it('preserves the current decision and isolates paired future streams',()=>{
    const original=new PpoTrainingArena(8123,'review-root',options);
    const root=original.exportSnapshot();
    const left=PpoTrainingArena.fromSnapshot(root,options);
    const right=PpoTrainingArena.fromSnapshot(root,options);
    const other=PpoTrainingArena.fromSnapshot(root,options);
    const visible=original.observe();
    left.forkFutureRandom(4488);right.forkFutureRandom(4488);
    other.forkFutureRandom(4489);
    expect(left.observe()).toEqual(visible);
    expect(right.observe()).toEqual(visible);
    expect(left.exportSnapshot().state).toEqual(right.exportSnapshot().state);
    expect(left.exportSnapshot().state.trainingCourse?.discardRandomState)
      .not.toBe(other.exportSnapshot().state.trainingCourse?.discardRandomState);
    expect(original.exportSnapshot()).toEqual(root);
    const action=visible!.candidates[0];
    const decision={...visible!.decision,actionId:action.id};
    left.step(decision);right.step(decision);
    expect(left.exportSnapshot().state).toEqual(right.exportSnapshot().state);
  });
});
