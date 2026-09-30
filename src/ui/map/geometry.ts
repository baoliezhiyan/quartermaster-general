import traced from './traced-geometry.json';

export const MAP_WIDTH = 1743;
export const MAP_HEIGHT = 902;
// One map-space size for Europe and the rest of the world.
export const TOKEN_DIAMETER = 36;
export interface RegionShape {
  key: string;
  regionId: string;
  path: string;
  label: readonly number[];
  tokenAnchor?: readonly number[];
  tokenSlots?: readonly (readonly number[])[];
  fragment?: boolean;
  fragmentSide?: string;
}
export const MAP_SHAPES: readonly RegionShape[] = traced;
export const LAND_SHAPES = MAP_SHAPES.filter(s => !s.regionId.startsWith('sea_'));
export const SEA_SHAPES = MAP_SHAPES.filter(s => s.regionId.startsWith('sea_'));
export const INLAND_SEA_SHAPES: readonly RegionShape[] = [];
