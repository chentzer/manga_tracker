// The phone's Remove animations setting, for what would otherwise move on its
// own (Marquee.js, the tab bars sliding in App.js).
import { AccessibilityInfo } from 'react-native';

let on = false;
AccessibilityInfo.isReduceMotionEnabled()
  .then((value) => {
    on = value;
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
  on = value;
});

export function reduceMotion() {
  return on;
}
