import type { LayerType } from '../api/types';

/**
 * Layer colours encode the layer type: helical layers step through a blue
 * ramp, hoop layers through an orange ramp, so neighbouring layers of the
 * same type stay distinguishable by lightness while the hue carries type.
 */
const HELICAL = ['#2a78d6', '#5598e7', '#1c5cab', '#86b6ef', '#256abf', '#104281'];
const HOOP = ['#eb6834', '#f2935f', '#c24c1c', '#f7b48a', '#d95926', '#9e3a12'];

export function layerColor(type: LayerType, indexOfType: number): string {
  const ramp = type === 'hoop' ? HOOP : HELICAL;
  return ramp[indexOfType % ramp.length];
}

/** Colour per layer id following the order of layers in the project. */
export function layerColors(layers: { id: string; type: LayerType }[]): Map<string, string> {
  const m = new Map<string, string>();
  let h = 0;
  let x = 0;
  for (const l of layers) m.set(l.id, layerColor(l.type, l.type === 'hoop' ? h++ : x++));
  return m;
}
