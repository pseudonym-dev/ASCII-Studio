/** @param {number} x @param {number} a @param {number} b */
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Rec. 709 luma of an RGB triple, same scale as the inputs. @param {number} r @param {number} g @param {number} b */
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
