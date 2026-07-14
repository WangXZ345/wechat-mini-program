const { call, toast } = require("../../../../utils/api");
const { ensureAdmin } = require("../../../../utils/auth");

Page({
  data: {
    records: [],
    detail: null,
    items: []
  },

  onLoad() {
    ensureAdmin("inventory:import").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("getImportHistory").then((data) => {
      this.setData({ records: data.records || [], detail: null, items: [] });
    }).catch((err) => toast(err.message));
  },

  showDetail(e) {
    const importRecordId = e.currentTarget.dataset.id;
    call("getImportDetail", { importRecordId }).then((data) => {
      this.setData({ detail: data.record, items: data.items || [] });
    }).catch((err) => toast(err.message));
  },

  backList() {
    this.setData({ detail: null, items: [] });
  }
});
