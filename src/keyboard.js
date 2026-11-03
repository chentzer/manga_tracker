// Keeps what you're typing in above the on-screen keyboard.
//
// The app draws edge to edge (Expo SDK 57), so Android no longer shrinks
// the screen when the keyboard opens: it just covers the bottom of it —
// the sheets' fields and buttons, the Notepad. KeyboardPad pads its own
// bottom by however much of it the keyboard covers, so what's inside
// moves up above the keyboard (a bottom sheet rides up with it, a
// ScrollView inside gets shorter and keeps the focused field in view).
// It measures itself, so where the system already makes room (iOS
// modals, a window that does resize) it adds nothing.
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';

const SHOW = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
const HIDE = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

// Whether the keyboard is open (App.js hides the bottom tabs meanwhile).
export function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(SHOW, () => setOpen(true));
    const hide = Keyboard.addListener(HIDE, () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

export function KeyboardPad({ style, children, ...rest }) {
  const ref = useRef(null);
  const [pad, setPad] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(SHOW, (e) => {
      const keyboardTop = e.endCoordinates.screenY;
      const node = ref.current;
      if (!node || !node.measureInWindow) {
        setPad(e.endCoordinates.height);
        return;
      }
      // The padding is inside the box, so its bottom edge stays put.
      node.measureInWindow((x, y, width, height) => {
        setPad(Math.max(0, Math.round(y + height - keyboardTop)));
      });
    });
    const hide = Keyboard.addListener(HIDE, () => setPad(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return (
    <View ref={ref} collapsable={false} style={[style, pad > 0 && { paddingBottom: pad }]} {...rest}>
      {children}
    </View>
  );
}
