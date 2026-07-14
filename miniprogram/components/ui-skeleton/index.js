Component({
  options: {
    styleIsolation: "apply-shared"
  },
  properties: {
    count: { type: Number, value: 3 },
    showThumb: { type: Boolean, value: true }
  },
  data: {
    rows: [1, 2, 3]
  },
  observers: {
    count(value) {
      const size = Math.max(1, Number(value || 3));
      this.setData({ rows: Array.from({ length: size }, (_, index) => index + 1) });
    }
  }
});
