/** Starting look: the sidebar shows these values on the empty home screen and after New. */
export const DEFAULT_LOOK = {
  density: 158,
  zoom: 85,
  edges: 110,
  mono: false,
  glow: true,
  sep: true,
};

/** @param {number} cols */
export const densityLabel = (cols) => `${cols} columns`;

/** @param {number} percent */
export const zoomLabel = (percent) => `${percent}%`;

/** @param {number} slider  raw range value, 100 = 1.00× */
export const edgesLabel = (slider) => `${(slider / 100).toFixed(2)}×`;
