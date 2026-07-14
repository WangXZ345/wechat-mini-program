Component({
  options: {
    styleIsolation: "apply-shared"
  },
  properties: {
    title: { type: String, value: "无权限访问" },
    description: { type: String, value: "当前账号没有权限查看或操作该页面" }
  },
  methods: {
    goDashboard() {
      wx.navigateTo({ url: "/pages/admin/dashboard/index" });
    }
  }
});
