import type { Alliance, SeatId } from '../core';

export const SEAT_INFO: Record<SeatId, { name: string; alliance: Alliance; color: string }> = {
  germany: { name: '德国', alliance: 'axis', color: '#82919a' },
  united_kingdom: { name: '英国', alliance: 'allies', color: '#cbb17a' },
  japan: { name: '日本', alliance: 'axis', color: '#cf8c79' },
  soviet_union: { name: '苏联', alliance: 'allies', color: '#b77774' },
  italy: { name: '意大利', alliance: 'axis', color: '#9d8daf' },
  united_states: { name: '美国', alliance: 'allies', color: '#90ab85' },
};
