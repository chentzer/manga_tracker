// Tap areas (Material Design: at least 48×48 dp). A text link or a small
// icon is about 20 dp tall, so TAP_SLOP's 14 dp on each side makes its
// tappable area reach 48 without changing how it looks. Use it on
// touchables with no padding of their own and nothing else within 14 dp;
// give anything bigger or crowded a minWidth / minHeight instead.
export const TAP_SLOP = { top: 14, bottom: 14, left: 14, right: 14 };
