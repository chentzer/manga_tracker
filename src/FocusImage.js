import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Image, PanResponder } from 'react-native';

// A picture cropped to fill its box (like resizeMode "cover"), but centred
// on a chosen point instead of the middle. focus = { x, y, zoom }: x and y
// each 0–1 across the picture (0.5, 0.5 = middle; y 0 = keep the top),
// zoom 1 = just fills the box, 2 = twice as close. Used for the Library's
// artist pictures, whose faces are often cut off by a middle crop.

const sizeCache = new Map(); // uri -> { width, height }

function usePictureSize(uri) {
  const [size, setSize] = useState(() => sizeCache.get(uri) || null);
  useEffect(() => {
    if (!uri) return undefined;
    const cached = sizeCache.get(uri);
    if (cached) {
      setSize(cached);
      return undefined;
    }
    let alive = true;
    Image.getSize(
      uri,
      (width, height) => {
        sizeCache.set(uri, { width, height });
        if (alive) setSize({ width, height });
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [uri]);
  return size;
}

// Where to draw the picture so `focus` sits as close to the box's centre
// as the picture allows (it always still fills the box).
export function placePicture(box, picture, focus) {
  const scale = Math.max(box.width / picture.width, box.height / picture.height) * (focus.zoom || 1);
  const width = picture.width * scale;
  const height = picture.height * scale;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const left = clamp(box.width / 2 - focus.x * width, box.width - width, 0);
  const top = clamp(box.height / 2 - focus.y * height, box.height - height, 0);
  return { left, top, width, height };
}

const CENTRE = { x: 0.5, y: 0.5 };

export default function FocusImage({ uri, style, focus, onPanFocus }) {
  const picture = usePictureSize(uri);
  const [box, setBox] = useState(null);
  const f = focus || CENTRE;
  const placed = picture && box ? placePicture(box, picture, f) : null;

  // Dragging (only when onPanFocus is given) moves the picture under your
  // finger and reports the new focus point.
  const latest = useRef({ f, placed, box });
  latest.current = { f, placed, box };
  const start = useRef(f);
  const pan = useMemo(
    () =>
      onPanFocus
        ? PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
              start.current = latest.current.f;
            },
            onPanResponderMove: (_e, g) => {
              const { placed: p, box: b } = latest.current;
              if (!p || !b) return;
              // Only as far as the picture can actually move, so dragging
              // back responds straight away.
              const limit = (v, boxSize, size) => {
                const half = Math.min(0.5, boxSize / (2 * size));
                return Math.min(1 - half, Math.max(half, v));
              };
              onPanFocus({
                ...start.current,
                x: limit(start.current.x - g.dx / p.width, b.width, p.width),
                y: limit(start.current.y - g.dy / p.height, b.height, p.height),
              });
            },
            onPanResponderTerminationRequest: () => false,
          })
        : null,
    [onPanFocus]
  );

  return (
    <View
      style={[style, { overflow: 'hidden' }]}
      onLayout={(e) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      {...(pan ? pan.panHandlers : {})}
    >
      {placed ? (
        <Image
          source={{ uri }}
          resizeMethod="resize"
          style={{ position: 'absolute', left: placed.left, top: placed.top, width: placed.width, height: placed.height }}
        />
      ) : (
        <Image source={{ uri }} resizeMethod="resize" style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      )}
    </View>
  );
}
