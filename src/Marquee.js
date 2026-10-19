import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

// One line of text that, when it's too long for its space, scrolls slowly
// sideways to show the rest, waits, and starts over (a marquee). Short
// text just sits still. style is the Text's style; containerStyle sizes
// the space (e.g. { flex: 1 }).
const SPEED = 35; // pixels a second
const PAUSE = 1400; // ms still at each end

export default function Marquee({ children, style, containerStyle }) {
  const [boxWidth, setBoxWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const overflow = textWidth - boxWidth;
  // The text's own size, not stretched: a flex in its style (e.g. a title
  // style made to fill a row) would make it as wide as the row below.
  const { flex, flexGrow, flexBasis, width, maxWidth, ...textStyle } = StyleSheet.flatten(style) || {};

  useEffect(() => {
    x.setValue(0);
    if (!boxWidth || overflow <= 2) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(PAUSE),
        Animated.timing(x, {
          toValue: -overflow,
          duration: (overflow / SPEED) * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(PAUSE),
        Animated.timing(x, { toValue: 0, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [x, boxWidth, overflow, children]);

  return (
    <View
      style={[{ overflow: 'hidden', flexShrink: 1 }, containerStyle]}
      onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}
    >
      {/* A wide row, so the text is laid out at its full width (never cut
          off with "…"); the box above shows the part that fits. */}
      <Animated.View style={{ flexDirection: 'row', width: 6000, transform: [{ translateX: x }] }}>
        <Text style={textStyle} numberOfLines={1} onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}>
          {children}
        </Text>
      </Animated.View>
    </View>
  );
}
