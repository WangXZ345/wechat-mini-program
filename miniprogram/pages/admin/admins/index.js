const { call, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");

const ROLE_OPTIONS = [
  { label: "客服", value: "customer_service" },
  { label: "财务", value: "finance" },
  { label: "采购", value: "procurement" },
  { label: "超级管理员", value: "super_admin" }
];

function emptyForm() {
  return {
    name: "",
    phone: "",
    openid: "",
    role: "customer_service"
  };
}

Page({
  data: {
    admins: [],
    roles: [],
    logs: [],
    permissionLogs: [],
    roleOptions: ROLE_OPTIONS,
    roleIndex: 0,
    editRoleIndex: 0,
    form: emptyForm(),
    editingAdminId: "",
    editingRole: "customer_service",
    loading: false
  },

  onLoad() {
    ensureAdmin("admin:view").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    this.setData({ loading: true });
    return Promise.all([
      call("getAdminUsers"),
      call("getAdminOperationLogs", { limit: 50 })
    ]).then(([usersData, logsData]) => {
      this.setData({
        admins: usersData.admins || [],
        roles: usersData.roles || [],
        logs: logsData.logs || [],
        permissionLogs: logsData.permissionLogs || []
      });
    }).catch((err) => toast(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onRoleChange(e) {
    const index = Number(e.detail.value || 0);
    this.setData({
      roleIndex: index,
      "form.role": this.data.roleOptions[index].value
    });
  },

  createAdmin() {
    const form = this.data.form;
    if (!form.name.trim()) return toast("请输入姓名");
    if (!form.openid.trim()) return toast("请输入 openid");
    call("createAdminUser", form).then(() => {
      toast("管理员已新增");
      this.setData({ form: emptyForm(), roleIndex: 0 });
      this.load();
    }).catch((err) => toast(err.message));
  },

  startEditRole(e) {
    const adminId = e.currentTarget.dataset.id;
    const admin = this.data.admins.find((item) => item._id === adminId || item.id === adminId);
    if (!admin) return;
    const roleIndex = Math.max(0, this.data.roleOptions.findIndex((item) => item.value === admin.role));
    this.setData({
      editingAdminId: adminId,
      editingRole: admin.role,
      editRoleIndex: roleIndex
    });
  },

  onEditRoleChange(e) {
    const index = Number(e.detail.value || 0);
    this.setData({
      editRoleIndex: index,
      editingRole: this.data.roleOptions[index].value
    });
  },

  saveRole() {
    if (!this.data.editingAdminId) return toast("请选择管理员");
    call("updateAdminRole", {
      adminId: this.data.editingAdminId,
      role: this.data.editingRole,
      reason: "后台管理员页面修改角色"
    }).then(() => {
      toast("角色已更新");
      this.setData({ editingAdminId: "" });
      this.load();
    }).catch((err) => toast(err.message));
  },

  toggleStatus(e) {
    const adminId = e.currentTarget.dataset.id;
    const disabled = e.currentTarget.dataset.disabled === "true";
    wx.showModal({
      title: disabled ? "禁用管理员" : "启用管理员",
      content: disabled ? "禁用后该管理员不能进入后台，确定继续吗？" : "确定启用该管理员吗？",
      confirmText: disabled ? "禁用" : "启用",
      success: (res) => {
        if (!res.confirm) return;
        call("disableAdminUser", { adminId, disabled }).then(() => {
          toast(disabled ? "已禁用" : "已启用");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  }
});
