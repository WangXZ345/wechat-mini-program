function getWindowSizeFromSystemInfo(systemInfo = {}) {
  const windowWidth = Number(systemInfo.windowWidth || systemInfo.screenWidth || 375);
  const windowHeight = Number(systemInfo.windowHeight || systemInfo.screenHeight || 667);
  return { windowWidth, windowHeight };
}

function normalizeScreenInfo(info = {}) {
  const { windowWidth, windowHeight } = getWindowSizeFromSystemInfo(info);
  return {
    windowWidth,
    windowHeight,
    screenWidth: windowWidth,
    screenHeight: windowHeight,
    isLandscape: windowWidth > windowHeight,
    isWideScreen: windowWidth >= 700,
    pixelRatio: info.pixelRatio || 2,
    safeArea: info.safeArea || null
  };
}

function getScreenInfo() {
  try {
    return normalizeScreenInfo(wx.getSystemInfoSync());
  } catch (error) {
    console.warn("[orientation] getScreenInfo failed", error);
    return normalizeScreenInfo();
  }
}

function applyOrientationClass(page, info) {
  if (!page || typeof page.setData !== "function") return;
  const screenInfo = info ? normalizeScreenInfo(info) : getScreenInfo();
  page.setData({
    screenWidth: screenInfo.windowWidth,
    screenHeight: screenInfo.windowHeight,
    isLandscape: screenInfo.isLandscape,
    isWideScreen: screenInfo.isWideScreen
  });
}

function watchOrientation(page) {
  if (!page || typeof page.setData !== "function") return;
  unwatchOrientation(page);

  const onResize = (res = {}) => {
    applyOrientationClass(page, res.size || res);
  };

  page._orientationResizeCallback = onResize;
  applyOrientationClass(page);

  if (wx.onWindowResize) {
    wx.onWindowResize(onResize);
  }
}

function unwatchOrientation(page) {
  if (!page || !page._orientationResizeCallback) return;

  if (wx.offWindowResize) {
    try {
      wx.offWindowResize(page._orientationResizeCallback);
    } catch (error) {
      console.warn("[orientation] offWindowResize failed", error);
    }
  }
  page._orientationResizeCallback = null;
}

function initOrientation(page, options = {}) {
  if (options.watch === false) {
    applyOrientationClass(page);
    return;
  }
  watchOrientation(page);
}

function cleanupOrientation(page) {
  unwatchOrientation(page);
}

module.exports = {
  getScreenInfo,
  watchOrientation,
  unwatchOrientation,
  applyOrientationClass,
  initOrientation,
  cleanupOrientation
};
