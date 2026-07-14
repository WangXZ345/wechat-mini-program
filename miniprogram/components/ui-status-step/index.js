Component({
  options: {
    styleIsolation: "apply-shared"
  },
  properties: {
    status: { type: String, value: "" }
  },
  data: {
    activeIndex: 0,
    steps: [
      { key: "submitted", label: "已提交" },
      { key: "review", label: "审核中" },
      { key: "payment", label: "待付款" },
      { key: "confirm", label: "待确认" },
      { key: "done", label: "已完成" }
    ]
  },
  observers: {
    status(value) {
      const indexMap = {
        pending_system: 0,
        auto_reviewing: 1,
        pending_admin: 1,
        approved_pending_payment: 2,
        pending_payment_confirm: 3,
        paid: 4
      };
      this.setData({ activeIndex: indexMap[value] || 0 });
    }
  }
});
