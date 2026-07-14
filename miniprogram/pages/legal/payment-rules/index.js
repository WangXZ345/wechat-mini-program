const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad() {
    initOrientation(this);
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
