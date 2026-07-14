Component({
  options: {
    styleIsolation: "apply-shared"
  },
  properties: {
    icon: { type: String, value: "—" },
    title: { type: String, value: "暂无数据" },
    description: { type: String, value: "" },
    buttonText: { type: String, value: "" },
    customClass: { type: String, value: "" }
  },
  methods: {
    onAction() {
      this.triggerEvent("action");
    }
  }
});
