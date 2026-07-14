const cloud = require("wx-server-sdk");

const {
  buildStockStatusUpdate,
  syncStockAlertRecord
} = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

async function addInventoryLog(tx, productId, beforeStock, afterStock, changeAmount, reason, orderId, operatorId, alertInfo = {}) {
  const businessKey = alertInfo.businessKey || "";
  if (!businessKey) {
    throw new Error("库存日志缺少 businessKey，无法写入");
  }
  return tx.collection("inventory_logs").add({
    data: {
      businessKey,
      productId,
      beforeStock,
      afterStock,
      changeAmount,
      reason,
      relatedOrderId: orderId,
      operatorId: operatorId || "system",
      stockStatusBefore: alertInfo.stockStatusBefore || "",
      stockStatusAfter: alertInfo.stockStatusAfter || "",
      warningStock: alertInfo.warningStock,
      triggeredAlert: alertInfo.triggeredAlert === true,
      createdAt: db.serverDate()
    }
  });
}

async function includeApprovedOrder(tx, orderId, order, amount) {
  const todayDate = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const accounts = await tx.collection("customer_accounts").where({ userId: order.userId }).limit(1).get();
  const before = accounts.data[0] || {};
  if (accounts.data[0]) {
    const data = {
      totalOrderAmount: _.inc(amount),
      totalUnpaidAmount: _.inc(amount),
      unpaidAmount: _.inc(amount),
      todayOrderAmount: before.todayDate === todayDate ? _.inc(amount) : amount,
      todayDate,
      totalReceivableAmount: _.inc(amount),
      orderCount: _.inc(1),
      unpaidOrderCount: _.inc(1),
      lastOrderAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    await tx.collection("customer_accounts").doc(accounts.data[0]._id).update({ data });
  } else {
    await tx.collection("customer_accounts").add({
      data: {
        userId: order.userId,
        userOpenid: order.userOpenid || "",
        nickname: "",
        phone: "",
        totalOrderAmount: amount,
        totalPaidAmount: 0,
        totalUnpaidAmount: amount,
        unpaidAmount: amount,
        todayOrderAmount: amount,
        historyUnpaidAmount: 0,
        pendingConfirmAmount: 0,
        abnormalAmount: 0,
        abnormalCount: 0,
        orderCount: 1,
        paidOrderCount: 0,
        unpaidOrderCount: 1,
        partialPaidOrderCount: 0,
        lastOrderAt: db.serverDate(),
        lastPaymentAt: null,
        riskLevel: "normal",
        isSettled: false,
        adminRemark: "",
        adminNote: "",
        adminTags: [],
        todayDate,
        totalReceivableAmount: amount,
        paidAmount: 0,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }
  await tx.collection("account_logs").add({
    data: {
      userId: order.userId || "",
      userOpenid: order.userOpenid || "",
      relatedOrderId: orderId,
      relatedPaymentRecordId: "",
      changeType: "order_approved",
      beforeTotalOrderAmount: Number(before.totalOrderAmount || before.totalReceivableAmount || 0),
      afterTotalOrderAmount: Number(before.totalOrderAmount || before.totalReceivableAmount || 0) + amount,
      beforeTotalPaidAmount: Number(before.totalPaidAmount || before.paidAmount || 0),
      afterTotalPaidAmount: Number(before.totalPaidAmount || before.paidAmount || 0),
      beforeTotalUnpaidAmount: Number(before.totalUnpaidAmount || before.unpaidAmount || 0),
      afterTotalUnpaidAmount: Number(before.totalUnpaidAmount || before.unpaidAmount || 0) + amount,
      changeAmount: amount,
      operatorId: "system",
      operatorOpenid: "system",
      remark: "自动审核通过，计入客户账款",
      createdAt: db.serverDate()
    }
  });
}

async function getOrderItems(tx, orderId, order) {
  const res = await tx.collection("order_items").where({ orderId }).limit(100).get();
  if (res.data.length) return res.data;
  return [{
    _id: "",
    orderId,
    productId: order.productId,
    productName: order.productName,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    totalAmount: order.totalAmount
  }];
}

async function getCurrentRiskLevel(tx, order) {
  if (order.riskLevelSnapshot) return normalizeRiskLevel(order.riskLevelSnapshot);
  const filters = [];
  if (order.userId) filters.push({ userId: order.userId });
  if (order.userOpenid) filters.push({ userOpenid: order.userOpenid });
  for (const where of filters) {
    const res = await tx.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0] && res.data[0].riskLevel) return normalizeRiskLevel(res.data[0].riskLevel);
  }
  return "normal";
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

exports.main = async (event) => {
  const orderId = event.orderId;
  if (!orderId) return fail("缺少订单 ID");

  try {
    await ensureCollection("account_logs");
    await ensureCollection("stock_alert_records");
    const result = await db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(orderId).get()).data;
      if (!order) throw new Error("订单不存在");
      if (order.status !== "auto_reviewing") {
        return { skipped: true, status: order.status };
      }

      const riskLevel = await getCurrentRiskLevel(tx, order);
      if (riskLevel === "risk") {
        await tx.collection("orders").doc(orderId).update({
          data: { status: "pending_admin", reviewType: "manual", riskLevelSnapshot: riskLevel, updatedAt: db.serverDate() }
        });
        await tx.collection("admin_notifications").add({
          data: {
            type: "manual_order_review",
            orderId,
            userOpenid: order.userOpenid || "",
            isRead: false,
            createdAt: db.serverDate()
          }
        });
        return { skipped: true, status: "pending_admin", reason: "risk_customer" };
      }

      const items = await getOrderItems(tx, orderId, order);
      const checks = [];
      for (const item of items) {
        const product = (await tx.collection("products").doc(item.productId).get()).data;
        const quantity = Number(item.quantity || 0);
        const beforeStock = Number(product && product.stock || 0);
        const businessKey = `order_deduct:${orderId}:${item.productId}`;
        const existingLog = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
        const alreadyDeducted = Boolean(existingLog.data && existingLog.data[0]);
        const enough = alreadyDeducted || (!!product && product.isActive !== false && beforeStock >= quantity);
        checks.push({ item, product, quantity, beforeStock, enough, alreadyDeducted, businessKey });
      }

      if (checks.some((row) => !row.enough)) {
        await tx.collection("orders").doc(orderId).update({
          data: { status: "pending_admin", reviewType: "manual", updatedAt: db.serverDate() }
        });
        for (const row of checks) {
          if (!row.item._id) continue;
          await tx.collection("order_items").doc(row.item._id).update({
            data: { stockCheckStatus: row.enough ? "enough" : "insufficient" }
          });
        }
        return { skipped: true, status: "pending_admin" };
      }

      for (const row of checks) {
        if (row.alreadyDeducted) {
          if (row.item._id) {
            await tx.collection("order_items").doc(row.item._id).update({
              data: { stockCheckStatus: "enough" }
            });
          }
          continue;
        }
        const afterStock = row.beforeStock - row.quantity;
        const stockUpdate = buildStockStatusUpdate(row.product || {}, {
          stock: afterStock,
          now: db.serverDate()
        });
        await tx.collection("products").doc(row.item.productId).update({
          data: {
            ...stockUpdate,
            lastSoldAt: db.serverDate(),
            totalSales: _.inc(row.quantity)
          }
        });
        await syncStockAlertRecord({ db, store: tx }, row.item.productId, { ...row.product, ...stockUpdate }, stockUpdate.stockStatus, "system");
        if (row.item._id) {
          await tx.collection("order_items").doc(row.item._id).update({
            data: { stockCheckStatus: "enough" }
          });
        }
        await addInventoryLog(
          tx,
          row.item.productId,
          row.beforeStock,
          afterStock,
          -row.quantity,
          order.orderType === "cart" ? "cart_order_approved" : "order_approved",
          orderId,
          "system",
          {
            businessKey: row.businessKey,
            stockStatusBefore: (row.product && row.product.stockStatus) || "",
            stockStatusAfter: stockUpdate.stockStatus,
            warningStock: stockUpdate.warningStock,
            triggeredAlert: stockUpdate.stockStatus === "warning" || stockUpdate.stockStatus === "out_of_stock"
          }
        );
      }

      await tx.collection("orders").doc(orderId).update({
        data: {
          status: "approved_pending_payment",
          paymentStatus: "unpaid",
          paidAmount: 0,
          unpaidAmount: Number(order.totalAmount || 0),
          accountIncluded: true,
          settlementStatus: order.settlementStatus || "normal",
          approvedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      if (order.accountIncluded !== true) {
        await includeApprovedOrder(tx, orderId, order, Number(order.totalAmount || 0));
      }

      return { approved: true, status: "approved_pending_payment", userId: order.userId, userOpenid: order.userOpenid };
    });

    if (result.approved) {
      await cloud.callFunction({
        name: "recalculateCustomerAccount",
        data: { userId: result.userId, userOpenid: result.userOpenid }
      });
    }

    return ok(result);
  } catch (err) {
    return fail(err.message || "自动审核失败");
  }
};
