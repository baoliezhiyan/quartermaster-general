import { expect, it } from 'vitest';
import { createGame } from '../src/core';
import { choiceCard } from '../src/ui/CardFace';

it('shows a labelled card choice but does not reveal an anonymous hidden choice by its instance ID', () => {
  const state = createGame('card-visibility', 1940);
  const card = state.decks.germany.hand[0];
  expect(choiceCard(state, { id: card.id, label: card.definitionId })).toEqual(card);
  expect(choiceCard(state, { id: card.id, label: '暗置卡牌 1' })).toBeUndefined();
  expect(choiceCard(state, { id: card.id, label: '选择一个地区' })).toBeUndefined();
});
