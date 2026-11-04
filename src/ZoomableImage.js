import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import Icon from './Icon';
import { clampPan, zoomAround } from './zoomMath';

const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_ZOOM = 2.5;
const TAP_SLOP = 8; // moved less than this, a touch is a tap

// A picture on the whole screen: pinch to zoom, drag to move it when zoomed,
// double-tap to zoom in or back out. A tap closes it when it isn't zoomed, and
// so does the close button or the phone's Back.
export default function ZoomableImage({ uri, onClose }) {
  const { width, height } = useWindowDimensions();
  const size = useRef({ width, height });
  size.current = { width, height };
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const scale = useRef(new Animated.Value(1)).current;
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;

  const responder = useMemo(() => {
    let view = { scale: 1, x: 0, y: 0 };
    let gesture = null; // what the fingers are doing now, and where it began
    let moved = false;
    let lastTap = 0;
    let tapTimer = null;

    const show = (next) => {
      view = next;
      scale.setValue(next.scale);
      x.setValue(next.x);
      y.setValue(next.y);
    };
    const fromCentre = (touch) => ({
      x: touch.pageX - size.current.width / 2,
      y: touch.pageY - size.current.height / 2,
    });
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    const onTap = (point) => {
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        clearTimeout(tapTimer);
        lastTap = 0;
        show(
          view.scale > 1
            ? { scale: 1, x: 0, y: 0 }
            : zoomAround(view, DOUBLE_TAP_ZOOM, point, point, size.current.width, size.current.height)
        );
        return;
      }
      lastTap = now;
      if (view.scale === 1) tapTimer = setTimeout(() => closeRef.current(), DOUBLE_TAP_MS);
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        gesture = null;
        moved = false;
      },
      onPanResponderMove: (e, { dx, dy }) => {
        if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) moved = true;
        const touches = e.nativeEvent.touches.map(fromCentre);
        if (touches.length >= 2) {
          moved = true;
          const [a, b] = touches;
          if (!gesture || gesture.kind !== 'pinch') {
            gesture = { kind: 'pinch', view, from: midpoint(a, b), distance: distance(a, b) || 1 };
          }
          const ratio = distance(a, b) / gesture.distance;
          show(zoomAround(gesture.view, ratio, gesture.from, midpoint(a, b), size.current.width, size.current.height));
        } else if (touches.length === 1 && view.scale > 1) {
          // Also after lifting one finger of a pinch: starts again from here.
          if (!gesture || gesture.kind !== 'drag') gesture = { kind: 'drag', view, from: touches[0] };
          show(
            clampPan(
              {
                scale: view.scale,
                x: gesture.view.x + touches[0].x - gesture.from.x,
                y: gesture.view.y + touches[0].y - gesture.from.y,
              },
              size.current.width,
              size.current.height
            )
          );
        }
      },
      onPanResponderRelease: (e) => {
        if (!moved) onTap(fromCentre(e.nativeEvent));
        // Pinched back to about its own size: exactly its own size.
        if (view.scale < 1.02) show({ scale: 1, x: 0, y: 0 });
      },
    });
  }, [scale, x, y]);

  return (
    <View style={styles.overlay} {...responder.panHandlers}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={[styles.image, { transform: [{ translateX: x }, { translateY: y }, { scale }] }]}
        accessibilityLabel="Cover. Pinch to zoom, double-tap to zoom in or out."
      />
      <TouchableOpacity style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
        <Icon name="close" size={24} color="#ffffff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
  image: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
