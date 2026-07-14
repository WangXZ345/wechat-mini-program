const { getAdminProfile } = require("../utils/auth");
const { initOrientation, cleanupOrientation } = require("../utils/orientation");

Component({
  data: {
    selected: 0,
    cartBadge: 0,
    visible: true,
    isLandscape: false,
    isWideScreen: false,
    list: [
      {
        pagePath: "/pages/index/index",
        text: "商品",
        icon: "bag"
      },
      {
        pagePath: "/pages/cart/index",
        text: "购物车",
        icon: "cart",
        badge: true
      },
      {
        pagePath: "/pages/order/list",
        text: "订单",
        icon: "order"
      },
      {
        pagePath: "/pages/profile/index",
        text: "我的",
        icon: "profile"
      }
    ]
  },

  lifetimes: {
    attached() {
      this.refreshVisibility();
      initOrientation(this);
    },

    detached() {
      cleanupOrientation(this);
    }
  },

  methods: {
    refreshVisibility() {
      getAdminProfile()
        .then((profile) => {
          this.setData({ visible: profile.showFrontendTabBar !== false });
        })
        .catch(() => this.setData({ visible: true }));
    },

    switchTab(e) {
      if (!this.data.visible) return;
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item || index === this.data.selected) return;
      wx.switchTab({ url: item.pagePath });
    },

    setSelected(selected) {
      this.setData({ selected: Number(selected || 0) });
      this.refreshVisibility();
    },

    setBadge(count) {
      const cartBadge = Math.max(0, Number(count || 0));
      this.setData({ cartBadge });
    }
  }
});
