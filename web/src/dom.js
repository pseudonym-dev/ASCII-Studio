/**
 * Element lookup for the single-page UI. Elements are known to exist in template.html,
 * and are used as inputs, buttons or progress bars, so they are typed loosely on purpose.
 * @param {string} id
 * @returns {any}
 */
export const $ = (id) => document.getElementById(id);

/** @param {Element} el */
export const isPressed = (el) => el.getAttribute("aria-pressed") === "true";

/** @param {Element} el @param {boolean} on */
export const setPressed = (el, on) => el.setAttribute("aria-pressed", String(on));
