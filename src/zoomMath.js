// The sums behind zooming a picture (ZoomableImage.js). The picture fills the
// screen and is moved by { scale, x, y } from the screen's centre. Pure, so
// they can be tested on their own.
export const MAX_ZOOM = 6;

// The zoom keeps the picture on the screen: it can't go past either edge.
export function clampPan({ scale, x, y }, width, height) {
  const maxX = (width * (scale - 1)) / 2;
  const maxY = (height * (scale - 1)) / 2;
  return { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
}

// Zoomed from `start` by `ratio` with the fingers' midpoint moved from `from`
// to `to` (from the screen's centre): what was under the fingers stays there.
export function zoomAround(start, ratio, from, to, width, height) {
  const scale = Math.max(1, Math.min(MAX_ZOOM, start.scale * ratio));
  const grew = scale / start.scale;
  return clampPan(
    { scale, x: to.x - (from.x - start.x) * grew, y: to.y - (from.y - start.y) * grew },
    width,
    height
  );
}
